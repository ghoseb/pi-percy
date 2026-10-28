// pi-percy: Shelley-style in-place context compaction for pi.
//
// The agent compacts its own context with compact_in_place: "index" lists the
// older part of the view, "compact" validates a request and queues its record
// and context edits, which the turn_end handler appends before the next model
// request. recall shows the originals. While compact_in_place is active, the
// turn_end handler also nudges the agent with the context size and the index
// (see nudge.ts), and a conversation left idle gets one compaction turn (see
// idle.ts). /compact-in-place asks the agent to compact; /compact-debug is a
// testing aid. Settings come from the "percy" key of pi's settings.json.
import { StringEnum } from "@earendil-works/pi-ai";
import {
	calculateContextTokens,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	getAgentDir,
	SettingsManager,
	type SessionBoundaryDraft,
	type SessionEntry,
	type TurnEndEvent,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { type BranchView, branchView, compactionDrafts, RECORD_TYPE, type StoredCompaction } from "./branch.ts";
import { DEBUG_USAGE, parseDebugCommand } from "./debug.ts";
import { idleNudgeText, worthIdleCompaction } from "./idle.ts";
import { compactIndex } from "./index-render.ts";
import { type NudgeSettings, nudgeDue, sizeLine } from "./nudge.ts";
import { renderOriginals, resolveIds } from "./recall.ts";
import { renderIndex, renderNudge, renderRecord } from "./render.ts";
import { itemTokens } from "./rows.ts";
import { DEFAULT_SETTINGS, loadSettings, type PercySettings } from "./settings.ts";
import { type AgentMessage, COMPACT_TOOL, NUDGE_TYPE, RECALL_TOOL } from "./types.ts";
import { compactRequest } from "./validate.ts";
import { applyCompaction, editsBetween } from "./view.ts";

/** Records the nudge settings a branch was last nudged with (see nudgeAfter). */
const NUDGE_SETTINGS_TYPE = "percy-nudge-settings";
/** An index shown by /compact-debug: rendered, not sent to the model. */
const INDEX_TYPE = "percy-index";

/** What /compact-in-place asks the agent, as Shelley's Compact in Place button does. */
export const COMPACT_REQUEST = "Compact your context in place.";

export interface PercyOptions {
	/** Overrides of the loaded settings, for tests. */
	settings?: {
		limits?: Partial<PercySettings["limits"]>;
		nudge?: Partial<PercySettings["nudge"]>;
		idle?: Partial<PercySettings["idle"]>;
	};
	/**
	 * pi's settings, read at session start: pi-percy's own (the "percy" key)
	 * and pi's compaction settings. Defaults to pi's settings.json files.
	 */
	piSettings?: (ctx: ExtensionContext) => PiSettings;
}

const COMPACT_DESCRIPTION = `Compact this conversation's context in place.
Call with action "index" first: it lists the older messages and explains what to do.
(Right after a "Context is Nk." nudge, which carries the index, you can skip it.)
Then call with action "compact" to collapse message ranges into short notes
and trim tool outputs. Originals stay in the session; ${RECALL_TOOL} shows them.`;

const RECALL_DESCRIPTION = `Show original messages that ${COMPACT_TOOL} collapsed into notes or trimmed.
Give message numbers, ranges like 12-20, or note ids like s30.1 (for the messages the note replaced).
Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; ask for fewer ids to see more.`;

const compactParameters = Type.Object({
	action: StringEnum(["index", "compact"] as const),
	trim: Type.Optional(
		Type.Array(Type.String(), { description: "compact: ids of index rows whose tool outputs to trim" }),
	),
	collapse: Type.Optional(
		Type.Array(
			Type.Object({
				from: Type.String(),
				to: Type.String(),
				note: Type.String({ description: "what still matters from the range" }),
			}),
			{ description: "compact: ranges of index ids (inclusive) to replace with a note" },
		),
	),
});

const recallParameters = Type.Object({
	ids: Type.Array(Type.String(), { description: "message numbers, ranges like 12-20, or note ids like s30.1" }),
});

function currentView(ctx: ExtensionContext): BranchView {
	const sm = ctx.sessionManager;
	return branchView(sm.getBranch(), sm.buildSessionProjection());
}

/** Models send ids as numbers or strings; the schema takes strings. */
function stringIds(args: unknown): unknown {
	if (args === null || typeof args !== "object") return args;
	const a = args as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "number" ? String(v) : v);
	return {
		...a,
		...(Array.isArray(a.trim) && { trim: a.trim.map(str) }),
		...(Array.isArray(a.ids) && { ids: a.ids.map(str) }),
		...(Array.isArray(a.collapse) && {
			collapse: a.collapse.map((c) =>
				c !== null && typeof c === "object" ? { ...c, from: str(c.from), to: str(c.to) } : c,
			),
		}),
	};
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** The context size a response reports, or undefined if it reports none. */
function contextTokens(m: AgentMessage): number | undefined {
	if (m.role !== "assistant") return undefined;
	const n = calculateContextTokens(m.usage);
	return n > 0 ? n : undefined;
}

/** The context size of the newest response on branch before entry id. */
function previousTokens(branch: readonly SessionEntry[], id: string): number | undefined {
	const end = branch.findIndex((e) => e.id === id);
	for (let i = (end < 0 ? branch.length : end) - 1; i >= 0; i--) {
		const e = branch[i]!;
		const n = e.type === "message" ? contextTokens(e.message) : undefined;
		if (n !== undefined) return n;
	}
	return undefined;
}

/** The nudge settings last recorded on branch, if any. */
function recordedNudge(branch: readonly SessionEntry[]): NudgeSettings | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i]!;
		if (e.type === "custom" && e.customType === NUDGE_SETTINGS_TYPE) return e.data as NudgeSettings;
	}
	return undefined;
}

/** What pi-percy reads from pi's SettingsManager. */
export type PiSettings = Pick<
	SettingsManager,
	"getSettings" | "drainErrors" | "getCompactionEnabled" | "getCompactionReserveTokens"
>;

function fileSettings(ctx: ExtensionContext): PiSettings {
	return SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
}

/**
 * Why the nudges come too late for model, if they do: pi's own compaction
 * starts at contextWindow - reserveTokens, and the agent should get at least
 * one nudge step of room before that.
 */
export function lateNudgeWarning(
	model: { provider: string; id: string; contextWindow: number },
	pi: PiSettings,
	nudge: NudgeSettings,
): string | undefined {
	if (!pi.getCompactionEnabled() || !(model.contextWindow > 0)) return undefined;
	const piCompactsAt = model.contextWindow - pi.getCompactionReserveTokens(model);
	if (nudge.at + nudge.step <= piCompactsAt) return undefined;
	return (
		`pi-percy: pi compacts ${model.provider}/${model.id} at ${piCompactsAt} tokens ` +
		`(a ${model.contextWindow} token window), less than one nudge step (${nudge.step}) after the first nudge at ` +
		`${nudge.at}. Lower percy.nudgeTokens to let the agent compact first.`
	);
}

function overlay(base: PercySettings, over: PercyOptions["settings"] = {}): PercySettings {
	return {
		limits: { ...base.limits, ...over.limits },
		nudge: { ...base.nudge, ...over.nudge },
		idle: { ...base.idle, ...over.idle },
	};
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createPercyExtension(options: PercyOptions = {}) {
	return function percy(pi: ExtensionAPI) {
		let settings = overlay(DEFAULT_SETTINGS, options.settings);
		let piSettings: PiSettings | undefined;
		// The model last warned about (see lateNudgeWarning), to warn once per switch.
		let warnedModel: string | undefined;
		const checkModel = (ctx: ExtensionContext, model = ctx.model) => {
			if (!model || !piSettings) return;
			const key = `${model.provider}/${model.id}`;
			const warning = lateNudgeWarning(model, piSettings, settings.nudge);
			if (warning && warnedModel !== key) ctx.ui.notify(warning, "warning");
			warnedModel = warning ? key : undefined;
		};

		// Drafts of compactions made this turn, by tool call id, and records
		// /compact-debug made since the last turn, until turn_end appends them.
		const pending = new Map<string, SessionBoundaryDraft[]>();
		let debugDrafts: SessionBoundaryDraft[] = [];

		// Idle compaction state. The timer is armed when a run settles. A run
		// started by the idle nudge does not re-arm it on settling; new input
		// cancels it and makes the run an ordinary one. After an idle
		// compaction, pi's idle cache warming stops until new input: the
		// conversation is idle, and the compacted context is a new cache entry.
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		let idleRun = false;
		let warmingStopped = false;
		const cancelIdle = () => {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		};

		pi.on("session_start", (_event, ctx) => {
			pending.clear();
			debugDrafts = [];
			cancelIdle();
			idleRun = false;
			warmingStopped = false;
			piSettings = (options.piSettings ?? fileSettings)(ctx);
			const loaded = loadSettings(piSettings);
			settings = overlay(loaded.settings, options.settings);
			for (const problem of loaded.problems) ctx.ui.notify(`pi-percy: ${problem}`, "warning");
			warnedModel = undefined;
			checkModel(ctx);
		});
		pi.on("model_select", (event, ctx) => checkModel(ctx, event.model));
		pi.on("session_shutdown", cancelIdle);
		pi.on("input", () => {
			cancelIdle();
			idleRun = false;
			warmingStopped = false;
		});
		pi.on("agent_start", cancelIdle);
		// turn_end applies a compaction right after its tool batch, also when the
		// run is aborted. Should a run end without that boundary, its drafts would
		// otherwise block every later compaction.
		pi.on("agent_end", (_event, ctx) => {
			if (pending.size === 0) return;
			pending.clear();
			ctx.ui.notify("pi-percy: a compaction was not applied: the run ended before its turn boundary", "warning");
		});
		pi.on("agent_settled", (event, ctx) => {
			cancelIdle();
			if (idleRun) {
				idleRun = false;
				return;
			}
			if (event.aborted || settings.idle.minutes <= 0) return;
			idleTimer = setTimeout(() => startIdleCompaction(ctx), settings.idle.minutes * 60_000);
			// An idle timer must not keep pi from exiting.
			idleTimer.unref?.();
		});
		pi.on("cache_warming_decision", () => (warmingStopped ? { action: "stop" } : undefined));

		/** Starts the idle compaction turn, if the conversation is still idle and worth it. */
		function startIdleCompaction(ctx: ExtensionContext) {
			idleTimer = undefined;
			try {
				if (!ctx.isIdle() || ctx.hasPendingMessages() || !pi.getActiveTools().includes(COMPACT_TOOL)) return;
				const view = currentView(ctx);
				if (!worthIdleCompaction(view.items, settings.limits, settings.idle.minTokens)) return;
				idleRun = true;
				warmingStopped = true;
				pi.sendMessage(
					{
						customType: NUDGE_TYPE,
						content: [
							{ type: "text", text: idleNudgeText(settings.idle.minutes) },
							{ type: "text", text: compactIndex(view.items, settings.limits) },
						],
						display: true,
						details: { idle: true },
					},
					{ triggerTurn: true },
				);
			} catch (err) {
				// A timer callback has no caller to report to, and an exception
				// here would take pi down.
				idleRun = false;
				const message = `pi-percy: idle compaction failed: ${errorText(err)}`;
				try {
					ctx.ui.notify(message, "error");
				} catch {
					console.error(message);
				}
			}
		}

		pi.registerTool({
			name: COMPACT_TOOL,
			label: "Compact in place",
			description: COMPACT_DESCRIPTION,
			promptSnippet: "Compact this conversation's context in place",
			parameters: compactParameters,
			prepareArguments: (args) => stringIds(args) as Static<typeof compactParameters>,
			executionMode: "sequential",
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				const view = currentView(ctx);
				if (params.action === "index") return text(compactIndex(view.items, settings.limits));
				if (pending.size > 0) {
					throw new Error("A compaction from this turn is waiting to be applied; compact again after the next response.");
				}
				const result = compactRequest(view.items, settings.limits, { trim: params.trim, collapse: params.collapse });
				pending.set(toolCallId, compactionDrafts(view, result.compaction, result.edits, result));
				return text(result.text);
			},
		});

		pi.registerTool({
			name: RECALL_TOOL,
			label: "Recall",
			description: RECALL_DESCRIPTION,
			promptSnippet: "Show original messages that compaction collapsed or trimmed",
			parameters: recallParameters,
			prepareArguments: (args) => stringIds(args) as Static<typeof recallParameters>,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const view = currentView(ctx);
				const spans = resolveIds(view, params.ids);
				const full = renderOriginals(view, spans);
				const t = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				if (!t.truncated) return text(full);
				return text(
					`${t.content}\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines ` +
						`(${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Ask for fewer ids to see the rest.]`,
				);
			},
		});

		pi.registerCommand("compact-in-place", {
			description: "Ask the agent to compact its context in place (optional: what to keep)",
			handler: async (args, ctx) => {
				if (!pi.getActiveTools().includes(COMPACT_TOOL)) pi.setActiveTools([...pi.getActiveTools(), COMPACT_TOOL]);
				const instructions = args.trim();
				const request = instructions ? `${COMPACT_REQUEST}\n\n${instructions}` : COMPACT_REQUEST;
				// Queued behind a running turn, as Shelley queues it.
				pi.sendUserMessage(request, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			},
		});

		pi.registerCommand("compact-debug", {
			description: `Testing aid for in-place compaction (${DEBUG_USAGE.replace("usage: ", "")})`,
			handler: async (args, ctx) => {
				try {
					const view = currentView(ctx);
					const command = parseDebugCommand(args, view.items);
					if (command.kind === "index") {
						pi.appendEntry(INDEX_TYPE, { index: compactIndex(view.items, settings.limits) });
						return;
					}
					// Commands cannot append context edits; turn_end does.
					const c = command.compaction;
					const after = applyCompaction(view.items, c, 0);
					const sizes = { tokensBefore: itemTokens(view.items), tokensAfter: itemTokens(after) };
					debugDrafts.push(...compactionDrafts(view, c, editsBetween(view.items, after), sizes));
					ctx.ui.notify("pi-percy: recorded; it applies after the next model response", "info");
				} catch (err) {
					ctx.ui.notify(`pi-percy: ${errorText(err)}`, "error");
				}
			},
		});

		pi.registerEntryRenderer<StoredCompaction>(RECORD_TYPE, (entry, { expanded }, theme) =>
			renderRecord(entry, expanded, theme),
		);
		pi.registerEntryRenderer<{ index: string }>(INDEX_TYPE, (entry, { expanded }, theme) =>
			renderIndex(entry, expanded, theme),
		);
		pi.registerMessageRenderer<{ idle?: boolean } | undefined>(NUDGE_TYPE, (message, { expanded, outputPad }, theme) =>
			renderNudge(message, expanded, outputPad, theme),
		);

		/**
		 * The entries to append after this turn's response for nudging: the
		 * nudge settings when they changed, and the nudge (the size line and
		 * the index) when one is due. A nudge reaches the model with the next
		 * request, in this turn or the next. When the settings changed since
		 * the branch was last nudged (or it never was), the previous response
		 * does not count, so lowering the threshold nudges right away.
		 */
		function nudgeAfter(event: TurnEndEvent, ctx: ExtensionContext): SessionBoundaryDraft[] {
			if (!pi.getActiveTools().includes(COMPACT_TOOL)) return [];
			const tokens = contextTokens(event.message);
			if (tokens === undefined) return [];
			const branch = ctx.sessionManager.getBranch();
			const { at, step } = settings.nudge;
			const recorded = recordedNudge(branch);
			const changed = recorded?.at !== at || recorded?.step !== step;
			const drafts: SessionBoundaryDraft[] = [];
			if (changed) drafts.push({ type: "custom", customType: NUDGE_SETTINGS_TYPE, data: { at, step } });
			const previous = changed ? undefined : previousTokens(branch, event.messageEntryId);
			if (nudgeDue(tokens, previous, settings.nudge)) {
				drafts.push({
					type: "custom_message",
					customType: NUDGE_TYPE,
					content: [
						{ type: "text", text: sizeLine(tokens) },
						{ type: "text", text: compactIndex(currentView(ctx).items, settings.limits) },
					],
					display: true,
				});
			}
			return drafts;
		}

		// Appends this turn's compactions, or else the nudge entries, before
		// the next model request. Right after a compaction the response's size
		// is from before it; the next response reports the new one.
		pi.on("turn_end", (event, ctx) => {
			const drafts = [...debugDrafts, ...event.toolResults.flatMap((r) => pending.get(r.toolCallId) ?? [])];
			pending.clear();
			debugDrafts = [];
			if (drafts.length === 0) drafts.push(...nudgeAfter(event, ctx));
			if (drafts.length === 0) return;
			return { entries: [...event.entries, ...drafts] };
		});
	};
}

export default createPercyExtension();
