// pi-percy: Shelley-style in-place context compaction for pi.
//
// The agent compacts its own context with compact_in_place: "index" lists the
// older part of the view, "compact" validates a request and queues its record
// and context edits, which the turn_end handler appends before the next model
// request. recall shows the originals.
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	type SessionBoundaryDraft,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { type BranchView, branchView, compactionDrafts } from "./branch.ts";
import { compactIndex } from "./index-render.ts";
import { renderOriginals, resolveIds } from "./recall.ts";
import { COMPACT_TOOL, DEFAULT_LIMITS, type Limits, RECALL_TOOL } from "./types.ts";
import { compactRequest } from "./validate.ts";

export interface PercyOptions {
	limits?: Partial<Limits>;
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

export function createPercyExtension(options: PercyOptions = {}) {
	const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };

	return function percy(pi: ExtensionAPI) {
		// Drafts of compactions made this turn, by tool call id, until turn_end
		// appends them.
		const pending = new Map<string, SessionBoundaryDraft[]>();
		pi.on("session_start", () => pending.clear());

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
				if (params.action === "index") return text(compactIndex(view.items, limits));
				if (pending.size > 0) {
					throw new Error("A compaction from this turn is waiting to be applied; compact again after the next response.");
				}
				const result = compactRequest(view.items, limits, { trim: params.trim, collapse: params.collapse });
				pending.set(toolCallId, compactionDrafts(view, result.compaction, result.edits));
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
				const spans = resolveIds(view, params.ids, ctx.sessionManager.getBranch().length);
				const full = renderOriginals(view, spans);
				const t = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				if (!t.truncated) return text(full);
				return text(
					`${t.content}\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines ` +
						`(${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Ask for fewer ids to see the rest.]`,
				);
			},
		});

		// Appends this turn's compactions before the next model request.
		pi.on("turn_end", (event) => {
			const drafts = event.toolResults.flatMap((r) => pending.get(r.toolCallId) ?? []);
			pending.clear();
			if (drafts.length === 0) return;
			return { entries: [...event.entries, ...drafts] };
		});
	};
}

export default createPercyExtension();
