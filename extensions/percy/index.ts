// pi-percy: Shelley-style in-place context compaction for pi.
//
// The agent compacts its own context with compact_in_place: "index" lists the
// older part of the view, "compact" validates a request and queues its record
// and context edits, which the turn_end handler appends before the next model
// request. recall shows the originals. While compact_in_place is active and
// compaction is not toggled off, the agent is also nudged with the context
// size and the index before its next request (see nudge.ts), and a
// conversation left idle gets one compaction turn (see idle.ts). pi-percy
// never changes the active tools: a tool change is a system prompt change,
// which pi records mid-conversation. The compact-in-place command asks the
// agent to compact; the debug command is a testing aid. Settings come from
// the "percy" key of pi's settings.json.
import { StringEnum, type TextContent } from "@earendil-works/pi-ai";
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
import {
  type BranchView,
  branchView,
  compactionDrafts,
  compactionSplitBy,
  isNudgeEntry,
  isRecordEntry,
  RECORD_TYPE,
  type StoredCompaction,
} from "./branch.ts";
import { debugCompletions, DEBUG_USAGE, parseDebugCommand } from "./debug.ts";
import { idleNudgeText, worthIdleCompaction } from "./idle.ts";
import { compactIndex } from "./index-render.ts";
import { isPlainObject } from "./messages.ts";
import { type NudgeSettings, nudgeDue, sizeLine } from "./nudge.ts";
import { renderOriginals, resolveIds } from "./recall.ts";
import { renderCompactCall, renderCompactResult, renderIndex, renderNudge, renderRecord } from "./render.ts";
import { itemTokens } from "./rows.ts";
import { DEFAULT_SETTINGS, loadSettings, type PercySettings } from "./settings.ts";
import {
  type AgentMessage,
  COMPACT_COMMAND,
  COMPACT_TOOL,
  DEBUG_COMMAND,
  NUDGE_TYPE,
  type NudgeDetails,
  RECALL_TOOL,
  REWIND_COMMAND,
  STATUS_COMMAND,
  TOGGLE_COMMAND,
} from "./types.ts";
import { compactRequest } from "./validate.ts";
import { applyCompaction, editsBetween } from "./view.ts";

/** Records the nudge settings a branch was last nudged with (see nudgeDecision). */
const NUDGE_SETTINGS_TYPE = "percy-nudge-settings";
/** customType of the custom entry that marks a response whose nudge waits for a later request. */
const NUDGE_DEFERRED_TYPE = "percy-nudge-deferred";
/** An index shown by /percy:compact-debug: rendered, not sent to the model. */
const INDEX_TYPE = "percy-index";

/** What /percy:compact-in-place asks the agent, as Shelley's Compact in Place button does. */
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
  /** Schedules the idle timer. Defaults to setTimeout, for tests to fire it. */
  timers?: Timers;
}

/** A one-shot timer: set returns the function that cancels it. */
export interface Timers {
  set(callback: () => void, ms: number): () => void;
}

/** Real timers, which do not keep pi from exiting. */
const realTimers: Timers = {
  set(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

const COMPACT_DESCRIPTION = [
  "Selectively compact this conversation's older context.",
  "Use it when a context nudge supplies an index or the user asks to compact context.",
  'Call with action "index" first: it lists the older messages and explains what to do.',
  '(Right after a "Context is Nk." nudge, which carries the index, you can skip it.)',
  'Then call with action "compact", giving one or both of trim (tool-output rows) and collapse (message ranges with short notes).',
  "Prefer obsolete outputs, abandoned approaches, and completed tasks that are no longer current; retain only their task, final outcome, decision, and reason.",
  `Originals stay in the session; ${RECALL_TOOL} retrieves them.`,
].join(" ");

const COMPACT_PROMPT_GUIDELINES = [
  "Use compact_in_place only for context housekeeping after its context nudge or a user request; it does not replace completing the user's work.",
  'When compacting, use the provided index (or call action "index") and preserve decisions, paths, commands, ids, and later corrections in your notes.',
  "Prefer dead ends, superseded investigations, abandoned approaches, and completed tasks that are no longer current. Collapse the related user request on its own, then safe work ranges; retain one short note with the task, final outcome, decision, reason, and replacement. Trim large obsolete tool outputs.",
];

const RECALL_DESCRIPTION = [
  `Retrieve original messages from the current branch, including content hidden, collapsed, or trimmed by ${COMPACT_TOOL}.`,
  "Give message numbers, ranges like 12-20, or note ids like s30.1 (for the messages the note replaced).",
  `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; ask for fewer ids to see more.`,
].join(" ");

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
  collapseUnits: Type.Optional(
    Type.Array(
      Type.Object({ id: Type.String(), note: Type.String({ description: "what still matters from this safe unit" }) }),
      { description: "compact: safe unit ids from the index, each with a short note" },
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

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Models send ids as numbers or strings; the schema takes strings. */
function stringIds(args: unknown): unknown {
  if (!isPlainObject(args)) return args;
  const str = (v: unknown) => (typeof v === "number" ? String(v) : v);
  const strings = (v: unknown) => (isUnknownArray(v) ? v.map(str) : undefined);
  const collapse = isUnknownArray(args["collapse"])
    ? args["collapse"].map((c) => (isPlainObject(c) ? { ...c, from: str(c["from"]), to: str(c["to"]) } : c))
    : undefined;
  const collapseUnits = isUnknownArray(args["collapseUnits"])
    ? args["collapseUnits"].map((unit) => (isPlainObject(unit) ? { ...unit, id: str(unit["id"]) } : unit))
    : undefined;
  const trim = strings(args["trim"]);
  const ids = strings(args["ids"]);
  return {
    ...args,
    ...(trim === undefined ? {} : { trim }),
    ...(ids === undefined ? {} : { ids }),
    ...(collapse === undefined ? {} : { collapse }),
    ...(collapseUnits === undefined ? {} : { collapseUnits }),
  };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** The context size a response reports, or undefined if it reports none. */
function contextTokens(m: AgentMessage): number | undefined {
  if (m.role !== "assistant") return undefined;
  const n = calculateContextTokens(m.usage);
  return n > 0 ? n : undefined;
}

/** The context size an entry's response reports, if it is one that does. */
const entryTokens = (e: SessionEntry) => (e.type === "message" ? contextTokens(e.message) : undefined);

/**
 * The context size of the nudge decision before branch[end]: the newest
 * earlier response whose turn neither compacted nor deferred its nudge.
 * Shelley's nudger skips the decision right after a compaction, as the
 * response's size is from before it, so that decision leaves the level as it
 * was. A deferred nudge is still due, so its decision is not made yet.
 */
function decidedTokens(branch: readonly SessionEntry[], end: number): number | undefined {
  let undecided = false;
  for (let i = end - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (isRecordEntry(e) || (e.type === "custom" && e.customType === NUDGE_DEFERRED_TYPE)) undecided = true;
    const n = entryTokens(e);
    if (n === undefined) continue;
    if (!undecided) return n;
    undecided = false;
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
    // /percy:toggle-compaction: nudges and idle compaction for this runtime.
    let compactionEnabled = true;
    // Shelley nudges and compacts when idle only while compact_in_place is
    // enabled; in pi, while it is active.
    const compacting = () => compactionEnabled && pi.getActiveTools().includes(COMPACT_TOOL);
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
    // /percy:compact-debug made since the last turn, until turn_end appends them.
    const pending = new Map<string, SessionBoundaryDraft[]>();
    let debugDrafts: SessionBoundaryDraft[] = [];

    // Idle compaction state. The timer is armed when a run settles. A run
    // started by the idle nudge does not re-arm it on settling; new input
    // cancels it and makes the run an ordinary one. After an idle
    // compaction, pi's idle cache warming stops until new input: the
    // conversation is idle, and the compacted context is a new cache entry.
    const timers = options.timers ?? realTimers;
    let cancelIdleTimer: (() => void) | undefined;
    let idleDeadline: number | undefined;
    // Invalidates a callback that was queued as a timer was cancelled.
    let idleGeneration = 0;
    let idleRun = false;
    let warmingStopped = false;
    const cancelIdle = () => {
      idleGeneration++;
      cancelIdleTimer?.();
      cancelIdleTimer = undefined;
      idleDeadline = undefined;
    };

    /** An idle run has already happened and no user message has resumed the conversation. */
    function idleCompactionBlocked(ctx: ExtensionContext): boolean {
      const branch = ctx.sessionManager.getBranch();
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i]!;
        if (entry.type === "message" && entry.message.role === "user") return false;
        // A context nudge can follow the idle nudge in the idle run.
        if (isNudgeEntry(entry, "idle")) return true;
      }
      return false;
    }

    /** Arm idle compaction after a settled run, reload, or session resume. */
    function armIdle(ctx: ExtensionContext) {
      cancelIdle();
      if (settings.idle.minutes <= 0 || idleCompactionBlocked(ctx)) return;
      const generation = idleGeneration;
      const wait = settings.idle.minutes * 60_000;
      idleDeadline = Date.now() + wait;
      cancelIdleTimer = timers.set(() => startIdleCompaction(ctx, generation), wait);
    }

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
      // A reload or resumed session starts a fresh idle interval. Do not treat
      // time before this extension runtime existed as idle time.
      armIdle(ctx);
    });
    pi.on("model_select", (event, ctx) => checkModel(ctx, event.model));
    // A branch ending inside a compaction would hold half of it, which no
    // validation checked. pi lets an extension cancel a jump, not redirect it.
    pi.on("session_before_tree", (event, ctx) => {
      if (!compactionSplitBy(ctx.sessionManager.getEntries(), event.preparation.targetId)) return;
      ctx.ui.notify(
        "pi-percy: that entry is inside a compaction, which is one change. " +
          "Pick its last context edit to keep the compaction, or the entry before its record to go back before it.",
        "warning",
      );
      return { cancel: true };
    });
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
      armIdle(ctx);
    });
    pi.on("cache_warming_decision", () => (warmingStopped ? { action: "stop" } : undefined));

    /** Starts the idle compaction turn, if the conversation is still idle and worth it. */
    function startIdleCompaction(ctx: ExtensionContext, generation: number) {
      cancelIdleTimer = undefined;
      idleDeadline = undefined;
      try {
        if (generation !== idleGeneration) return;
        if (!compacting() || !ctx.isIdle() || ctx.hasPendingMessages()) return;
        // The branch can have changed since the timer was armed (/tree).
        if (idleCompactionBlocked(ctx)) return;
        const view = currentView(ctx);
        if (!worthIdleCompaction(view.items, settings.limits, settings.idle.minTokens)) return;
        idleRun = true;
        warmingStopped = true;
        pi.sendMessage(
          {
            customType: NUDGE_TYPE,
            content: [
              { type: "text", text: idleNudgeText(settings.idle.minutes) },
              { type: "text", text: compactIndex(view.items, settings.limits, view.systemBoundaries) },
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
      promptSnippet: "Selectively compact older conversation context",
      promptGuidelines: COMPACT_PROMPT_GUIDELINES,
      parameters: compactParameters,
      renderCall: (args, theme) => renderCompactCall(args, theme),
      renderResult: (result, options, theme, context) => renderCompactResult(result, options, theme, context.isError),
      prepareArguments: (args) => stringIds(args) as Static<typeof compactParameters>,
      executionMode: "sequential",
      execute(toolCallId, params, _signal, _onUpdate, ctx) {
        const view = currentView(ctx);
        if (params.action === "index")
          return Promise.resolve(text(compactIndex(view.items, settings.limits, view.systemBoundaries)));
        if (pending.size > 0) {
          throw new Error(
            "A compaction from this turn is waiting to be applied; compact again after the next response.",
          );
        }
        const input = {
          ...(params.trim === undefined ? {} : { trim: params.trim }),
          ...(params.collapse === undefined ? {} : { collapse: params.collapse }),
          ...(params.collapseUnits === undefined ? {} : { collapseUnits: params.collapseUnits }),
        };
        const result = compactRequest(view.items, settings.limits, input, { systemBoundaries: view.systemBoundaries });
        pending.set(toolCallId, compactionDrafts(view, result.compaction, result.edits, result));
        return Promise.resolve(text(result.text));
      },
    });

    pi.registerTool({
      name: RECALL_TOOL,
      label: "Recall",
      description: RECALL_DESCRIPTION,
      promptSnippet: "Retrieve original messages hidden or compacted by compact_in_place",
      parameters: recallParameters,
      prepareArguments: (args) => stringIds(args) as Static<typeof recallParameters>,
      execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const view = currentView(ctx);
        const spans = resolveIds(view, params.ids);
        const full = renderOriginals(view, spans);
        const t = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        if (!t.truncated) return Promise.resolve(text(full));
        return Promise.resolve(
          text(
            `${t.content}\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines ` +
              `(${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Ask for fewer ids to see the rest.]`,
          ),
        );
      },
    });

    pi.registerCommand(COMPACT_COMMAND, {
      description: "Ask the agent to compact its context in place (optional: what to keep)",
      handler: (args, ctx) => {
        const instructions = args.trim();
        const request = instructions ? `${COMPACT_REQUEST}\n\n${instructions}` : COMPACT_REQUEST;
        // Queued behind a running turn, as Shelley queues it.
        pi.sendUserMessage(request, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
        return Promise.resolve();
      },
    });

    pi.registerCommand(DEBUG_COMMAND, {
      description: `Testing aid for in-place compaction (${DEBUG_USAGE.replace("usage: ", "")})`,
      getArgumentCompletions: debugCompletions,
      handler: (args, ctx) => {
        try {
          const view = currentView(ctx);
          const command = parseDebugCommand(args, view.items, view.systemBoundaries);
          if (command.kind === "index") {
            pi.appendEntry(INDEX_TYPE, { index: compactIndex(view.items, settings.limits, view.systemBoundaries) });
            return Promise.resolve();
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
        return Promise.resolve();
      },
    });

    pi.registerCommand(REWIND_COMMAND, {
      description: "Rewind the active branch to before the newest pi-percy compaction",
      async handler(_args, ctx) {
        if (!ctx.isIdle()) {
          ctx.ui.notify("pi-percy: wait for the current turn to finish before rewinding compaction", "warning");
          return;
        }
        const branch = ctx.sessionManager.getBranch();
        const record = branch.findLast(isRecordEntry);
        if (!record?.parentId) {
          ctx.ui.notify("pi-percy: no compaction on this branch to undo", "warning");
          return;
        }
        const later = branch.length - branch.indexOf(record) - 1;
        const confirmed = await ctx.ui.confirm(
          "Rewind pi-percy compaction?",
          `This returns to before the newest compaction. ${later} later ${later === 1 ? "entry" : "entries"} stay on an alternate branch; use /tree to return.`,
        );
        if (!confirmed) return;
        const result = await ctx.navigateTree(record.parentId, { summarize: false });
        if (result.cancelled) {
          ctx.ui.notify("pi-percy: compaction rewind was cancelled", "warning");
          return;
        }
        ctx.ui.notify("pi-percy: rewound the branch to before the newest compaction", "info");
      },
    });

    pi.registerCommand(TOGGLE_COMMAND, {
      description: "Enable or disable pi-percy context compaction for this session",
      handler: (_args, ctx) => {
        compactionEnabled = !compactionEnabled;
        ctx.ui.notify(`pi-percy: compaction ${compactionEnabled ? "enabled" : "disabled"} for this session`, "info");
        return Promise.resolve();
      },
    });

    pi.registerCommand(STATUS_COMMAND, {
      description: "Show pi-percy compaction status without a model request",
      handler: (_args, ctx) => {
        const view = currentView(ctx);
        const state = !pi.getActiveTools().includes(COMPACT_TOOL)
          ? `${COMPACT_TOOL} is not active`
          : compactionEnabled
            ? "enabled"
            : "disabled";
        const idle =
          settings.idle.minutes === 0
            ? "disabled"
            : idleDeadline === undefined
              ? idleCompactionBlocked(ctx)
                ? "blocked after an idle compaction"
                : "not armed"
              : `armed; fires in ~${Math.max(0, Math.ceil((idleDeadline - Date.now()) / 60_000))}m`;
        const eligible = worthIdleCompaction(view.items, settings.limits, settings.idle.minTokens);
        ctx.ui.notify(
          [
            `pi-percy: ${state}`,
            `history: ~${itemTokens(view.items)} tokens`,
            `nudges: ~${settings.nudge.at} tokens, then every ~${settings.nudge.step}`,
            `idle: ${idle}; ${eligible ? "eligible" : `requires ~${settings.idle.minTokens} tokens and older history`}`,
          ].join("\n"),
          "info",
        );
        return Promise.resolve();
      },
    });

    pi.registerEntryRenderer<StoredCompaction>(RECORD_TYPE, (entry, { expanded }, theme) =>
      renderRecord(entry, expanded, theme),
    );
    pi.registerEntryRenderer<{ index: string }>(INDEX_TYPE, (entry, { expanded }, theme) =>
      renderIndex(entry, expanded, theme),
    );
    pi.registerMessageRenderer<NudgeDetails>(NUDGE_TYPE, (message, { expanded, outputPad }, theme) =>
      renderNudge(message, expanded, outputPad, theme),
    );

    /**
     * The nudge decision after the response at branch[index], of tokens
     * context: Shelley's contextNudger, taken before each model request.
     * Returns the nudge settings to record when they changed, and the nudge
     * (the size line and the index) when one is due. When the settings
     * changed since the branch was last nudged (or it never was), the earlier
     * responses do not count, so lowering the threshold nudges right away.
     */
    function nudgeDecision(
      ctx: ExtensionContext,
      branch: readonly SessionEntry[],
      index: number,
      tokens: number,
    ): { record?: NudgeSettings; nudge?: TextContent[] } {
      const { at, step } = settings.nudge;
      const recorded = recordedNudge(branch);
      const changed = recorded?.at !== at || recorded?.step !== step;
      const previous = changed ? undefined : decidedTokens(branch, index);
      const decision: { record?: NudgeSettings; nudge?: TextContent[] } = changed ? { record: { at, step } } : {};
      if (nudgeDue(tokens, previous, settings.nudge)) {
        const view = currentView(ctx);
        decision.nudge = [
          { type: "text", text: sizeLine(tokens) },
          { type: "text", text: compactIndex(view.items, settings.limits, view.systemBoundaries) },
        ];
      }
      return decision;
    }

    /**
     * The nudge entries for the request that follows this turn's response in
     * the same run: one follows a tool batch, or a final reply when messages
     * are queued for this run. Shelley sends queued messages before the nudge,
     * but pi adds them after these entries, so a nudge due while messages are
     * queued waits for the next decision: it marks the response as deferred.
     */
    function nudgeAfter(event: TurnEndEvent, ctx: ExtensionContext): SessionBoundaryDraft[] {
      // Messages from the user or extensions (ctx.hasPendingMessages() counts only the user's).
      const queued = event.context.pendingMessages.length > 0;
      if (!compacting() || (event.toolResults.length === 0 && !queued)) return [];
      const tokens = contextTokens(event.message);
      if (tokens === undefined) return [];
      const branch = ctx.sessionManager.getBranch();
      const at = branch.findIndex((e) => e.id === event.messageEntryId);
      const { record, nudge } = nudgeDecision(ctx, branch, at < 0 ? branch.length : at, tokens);
      if (nudge && queued) return [{ type: "custom", customType: NUDGE_DEFERRED_TYPE, data: {} }];
      return [
        ...(record ? [{ type: "custom" as const, customType: NUDGE_SETTINGS_TYPE, data: record }] : []),
        ...(nudge ? [{ type: "custom_message" as const, customType: NUDGE_TYPE, content: nudge, display: true }] : []),
      ];
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

    // The nudge for a final reply goes with the next run's first request,
    // after its prompt, as Shelley injects it. pi records a prompt change
    // before the prompt, so a nudge never separates it from the prompt.
    pi.on("before_agent_start", (_event, ctx) => {
      if (!compacting()) return;
      const branch = ctx.sessionManager.getBranch();
      const index = branch.findLastIndex((e) => entryTokens(e) !== undefined);
      if (index < 0) return;
      // Decided at its turn's end: a nudge was sent, or the turn compacted.
      const later = branch.slice(index + 1);
      if (later.some((e) => isNudgeEntry(e, "context") || isRecordEntry(e))) return;
      const { record, nudge } = nudgeDecision(ctx, branch, index, entryTokens(branch[index]!)!);
      if (record) pi.appendEntry(NUDGE_SETTINGS_TYPE, record);
      if (nudge) return { message: { customType: NUDGE_TYPE, content: nudge, display: true } };
      return;
    });
  };
}

export default createPercyExtension();
