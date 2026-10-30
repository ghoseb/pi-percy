// Idle compaction: once a conversation has been idle for a while after a
// run, one turn started by an idle nudge in which the agent compacts its
// context, so the conversation resumes small. Port of Shelley's idle
// compaction.
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
