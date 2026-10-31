// pi-percy: Shelley-style in-place context compaction for pi.
//
// The agent compacts its own context with compact_in_place: "index" lists the
// older part of the view, "compact" validates a request and queues its record
// and context edits, which the turn_end handler appends before the next model
// request. recall shows the originals (see tools.ts). While compact_in_place
// is active and compaction is not toggled off, the agent is also nudged with
// the context size and the index before its next request (see nudge.ts), and
// a conversation left idle gets one compaction turn (see idle.ts). pi-percy
// never changes the active tools: a tool change is a system prompt change,
// which pi records mid-conversation. The commands are in commands.ts.
// Settings come from the "percy" key of pi's settings.json. This file holds
// pi-percy's state and wires it into pi's events.
import type { TextContent } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SettingsManager,
  type SessionBoundaryDraft,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  compactionSplitBy,
  currentView,
  isNudgeEntry,
  isRecordEntry,
  RECORD_TYPE,
  type StoredCompaction,
} from "./branch.ts";
import { registerCommands } from "./commands.ts";
import { INDEX_TYPE } from "./debug.ts";
import {
  idleCompactionBlocked,
  idleNudgeText,
  idleScheduler,
  realTimers,
  type Timers,
  worthIdleCompaction,
} from "./idle.ts";
import { compactIndex } from "./index-render.ts";
import { errorText } from "./messages.ts";
import {
  contextTokens,
  decideNudge,
  entryTokens,
  NUDGE_DEFERRED_TYPE,
  NUDGE_SETTINGS_TYPE,
  type NudgeSettings,
  sizeLine,
} from "./nudge.ts";
import { renderIndex, renderNudge, renderRecord } from "./render.ts";
import { DEFAULT_SETTINGS, loadSettings, type PercySettings } from "./settings.ts";
import { registerTools } from "./tools.ts";
import { COMPACT_TOOL, NUDGE_TYPE, type NudgeDetails } from "./types.ts";

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

export type { Timers } from "./idle.ts";

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

    // The compaction made this turn (one at most), and records
    // /percy:compact-debug made since the last turn, until turn_end appends them.
    let pendingCompaction: { toolCallId: string; drafts: SessionBoundaryDraft[] } | undefined;
    let debugDrafts: SessionBoundaryDraft[] = [];

    const idle = idleScheduler({
      timers: options.timers ?? realTimers,
      minutes: () => settings.idle.minutes,
      fire: startIdleCompaction,
    });

    pi.on("session_start", (_event, ctx) => {
      pendingCompaction = undefined;
      debugDrafts = [];
      idle.reset();
      piSettings = (options.piSettings ?? fileSettings)(ctx);
      const loaded = loadSettings(piSettings);
      settings = overlay(loaded.settings, options.settings);
      for (const problem of loaded.problems) ctx.ui.notify(`pi-percy: ${problem}`, "warning");
      warnedModel = undefined;
      checkModel(ctx);
      // A reload or resumed session starts a fresh idle interval. Do not treat
      // time before this extension runtime existed as idle time.
      idle.arm(ctx);
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
    pi.on("session_shutdown", idle.cancel);
    pi.on("input", idle.reset);
    pi.on("agent_start", idle.cancel);
    // turn_end applies a compaction right after its tool batch, also when the
    // run is aborted. Should a run end without that boundary, its drafts would
    // otherwise block every later compaction.
    pi.on("agent_end", (_event, ctx) => {
      if (!pendingCompaction) return;
      pendingCompaction = undefined;
      ctx.ui.notify("pi-percy: a compaction was not applied: the run ended before its turn boundary", "warning");
    });
    pi.on("agent_settled", (event, ctx) => idle.settled(ctx, event.aborted));
    pi.on("cache_warming_decision", () => (idle.warmingStopped() ? { action: "stop" } : undefined));

    /** Starts the idle compaction turn, if the conversation is still idle and worth it. */
    function startIdleCompaction(ctx: ExtensionContext) {
      try {
        if (!compacting() || !ctx.isIdle() || ctx.hasPendingMessages()) return;
        // The branch can have changed since the timer was armed (/tree).
        if (idleCompactionBlocked(ctx.sessionManager.getBranch())) return;
        const view = currentView(ctx);
        if (!worthIdleCompaction(view.items, settings.limits, settings.idle.minTokens)) return;
        idle.startRun(() =>
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
          ),
        );
      } catch (err) {
        // A timer callback has no caller to report to, and an exception
        // here would take pi down.
        const message = `pi-percy: idle compaction failed: ${errorText(err)}`;
        try {
          ctx.ui.notify(message, "error");
        } catch {
          console.error(message);
        }
      }
    }

    registerTools(pi, {
      settings: () => settings,
      compactionPending: () => pendingCompaction !== undefined,
      queueCompaction: (toolCallId, drafts) => (pendingCompaction = { toolCallId, drafts }),
    });

    registerCommands(pi, {
      settings: () => settings,
      recordDebug: (drafts) => debugDrafts.push(...drafts),
      compactionEnabled: () => compactionEnabled,
      toggleCompaction: () => (compactionEnabled = !compactionEnabled),
      idleStatus: idle.status,
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

    /** A context nudge: the size line and the index. */
    function nudgeContent(ctx: ExtensionContext, tokens: number): TextContent[] {
      const view = currentView(ctx);
      return [
        { type: "text", text: sizeLine(tokens) },
        { type: "text", text: compactIndex(view.items, settings.limits, view.systemBoundaries) },
      ];
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
      const { record, due } = decideNudge(branch, at < 0 ? branch.length : at, tokens, settings.nudge);
      if (due && queued) return [{ type: "custom", customType: NUDGE_DEFERRED_TYPE, data: {} }];
      return [
        ...(record ? [{ type: "custom" as const, customType: NUDGE_SETTINGS_TYPE, data: record }] : []),
        ...(due
          ? [
              {
                type: "custom_message" as const,
                customType: NUDGE_TYPE,
                content: nudgeContent(ctx, tokens),
                display: true,
              },
            ]
          : []),
      ];
    }

    // Appends this turn's compactions, or else the nudge entries, before
    // the next model request. Right after a compaction the response's size
    // is from before it; the next response reports the new one.
    pi.on("turn_end", (event, ctx) => {
      const compaction = pendingCompaction;
      const applied = compaction && event.toolResults.some((r) => r.toolCallId === compaction.toolCallId);
      const drafts = [...debugDrafts, ...(applied ? compaction.drafts : [])];
      pendingCompaction = undefined;
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
      const tokens = entryTokens(branch[index]!)!;
      const { record, due } = decideNudge(branch, index, tokens, settings.nudge);
      const nudge = due ? nudgeContent(ctx, tokens) : undefined;
      if (record) pi.appendEntry(NUDGE_SETTINGS_TYPE, record);
      if (nudge) return { message: { customType: NUDGE_TYPE, content: nudge, display: true } };
      return;
    });
  };
}

export default createPercyExtension();
