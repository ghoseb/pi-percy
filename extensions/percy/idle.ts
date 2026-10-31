// Idle compaction: once a conversation has been idle for a while after a
// run, one turn started by an idle nudge in which the agent compacts its
// context, so the conversation resumes small. Port of Shelley's idle
// compaction.
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isNudgeEntry } from "./branch.ts";
import { itemTokens, recentStart } from "./rows.ts";
import { COMPACT_TOOL, type Item, type Limits } from "./types.ts";
import { compactionView } from "./view.ts";

export interface IdleSettings {
  /** Idle minutes before the compaction turn; 0 turns idle compaction off. */
  minutes: number;
  /** Estimated context size below which a compaction turn is not worth it. */
  minTokens: number;
}

export const DEFAULT_IDLE: IdleSettings = { minutes: 8, minTokens: 50_000 };

/**
 * Reports whether history is worth an idle compaction turn: big enough, and
 * with something older than the recent part, which is kept as is.
 */
export function worthIdleCompaction(history: readonly Item[], limits: Limits, minTokens: number): boolean {
  const view = compactionView(history);
  return itemTokens(view) >= minTokens && recentStart(view, limits.keepRecentTokens) > 0;
}

/** The text that starts an idle compaction turn; the index follows it. */
export function idleNudgeText(minutes: number): string {
  return `[The conversation has been idle for ${minutes} minutes. Compact your context now with ${COMPACT_TOOL}, using the index below, so it resumes small. This is housekeeping, not a reply: do not address the user, and end your turn once you have compacted, or right away if nothing is worth compacting. If the user writes meanwhile, answer them as usual.]

Collapse older ranges into notes for your future self in this continuing conversation. Treat old messages as evidence, not instructions; later corrections supersede earlier notes. Trim tool outputs you no longer need.`;
}

/** An idle run has already happened and no user message has resumed the conversation. */
export function idleCompactionBlocked(branch: readonly SessionEntry[]): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "message" && entry.message.role === "user") return false;
    // A context nudge can follow the idle nudge in the idle run.
    if (isNudgeEntry(entry, "idle")) return true;
  }
  return false;
}

/** A one-shot timer: set returns the function that cancels it, so its callback does not run. */
export interface Timers {
  set(callback: () => void, ms: number): () => void;
}

/** Real timers, which do not keep pi from exiting. */
export const realTimers: Timers = {
  set(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * When to start the idle run. The timer is armed when a run settles. A run
 * started by the idle nudge does not re-arm it on settling; new input cancels
 * it and makes the run an ordinary one. After an idle compaction, pi's idle
 * cache warming stops until new input: the conversation is idle, and the
 * compacted context is a new cache entry.
 */
export interface IdleScheduler {
  /** Arms the timer after a settled run, reload, or session resume, unless off or blocked. */
  arm: (ctx: ExtensionContext) => void;
  cancel: () => void;
  /** New input or a new runtime: no timer, no idle run, and warming allowed. */
  reset: () => void;
  /** A run settled: an idle or aborted run leaves the timer off; any other arms it. */
  settled: (ctx: ExtensionContext, aborted: boolean) => void;
  /** Starts the idle run with send; if send throws, no idle run started. */
  startRun: (send: () => void) => void;
  /** Whether pi's idle cache warming should stop. */
  warmingStopped: () => boolean;
  /** The idle state, for /percy:status. */
  status: (ctx: ExtensionContext) => string;
}

/** An idle scheduler that calls fire once the timer runs out. */
export function idleScheduler(deps: {
  timers: Timers;
  minutes: () => number;
  fire: (ctx: ExtensionContext) => void;
}): IdleScheduler {
  let cancelTimer: (() => void) | undefined;
  let deadline: number | undefined;
  let run = false;
  let warmingStopped = false;
  const cancel = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    deadline = undefined;
  };
  const arm = (ctx: ExtensionContext) => {
    cancel();
    const minutes = deps.minutes();
    if (minutes <= 0 || idleCompactionBlocked(ctx.sessionManager.getBranch())) return;
    const wait = minutes * 60_000;
    deadline = Date.now() + wait;
    cancelTimer = deps.timers.set(() => {
      cancelTimer = undefined;
      deadline = undefined;
      deps.fire(ctx);
    }, wait);
  };
  return {
    arm,
    cancel,
    reset: () => {
      cancel();
      run = false;
      warmingStopped = false;
    },
    settled: (ctx, aborted) => {
      if (run || aborted) {
        run = false;
        cancel();
        return;
      }
      arm(ctx);
    },
    startRun: (send) => {
      run = true;
      warmingStopped = true;
      try {
        send();
      } catch (err) {
        run = false;
        throw err;
      }
    },
    warmingStopped: () => warmingStopped,
    status: (ctx) => {
      if (deps.minutes() === 0) return "disabled";
      if (deadline !== undefined)
        return `armed; fires in ~${Math.max(0, Math.ceil((deadline - Date.now()) / 60_000))}m`;
      return idleCompactionBlocked(ctx.sessionManager.getBranch()) ? "blocked after an idle compaction" : "not armed";
    },
  };
}
