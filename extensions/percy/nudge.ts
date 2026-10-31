// Context-size nudges: the agent is told the context size once it reaches a
// threshold, and again every step beyond, with the index so it can compact
// right away.
//
// Port of Shelley's contextNudger, without state of its own. Shelley decides
// before each model request: a nudge is due when the last response's level
// is above the level at the previous decision, which is skipped right after
// a compaction. Dropping below a level (after a compaction) re-arms it, and a
// resumed or re-branched session does not repeat a nudge.

import { calculateContextTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecordEntry } from "./branch.ts";
import type { AgentMessage } from "./types.ts";

/** Records the nudge settings a branch was last nudged with (see decideNudge). */
export const NUDGE_SETTINGS_TYPE = "percy-nudge-settings";
/** customType of the custom entry that marks a response whose nudge waits for a later request. */
export const NUDGE_DEFERRED_TYPE = "percy-nudge-deferred";

export interface NudgeSettings {
  /** Context size of the first nudge, in tokens. */
  at: number;
  /** Distance between later nudges, in tokens. */
  step: number;
}

export const DEFAULT_NUDGE: NudgeSettings = { at: 200_000, step: 50_000 };

/** -1 below the threshold, then 0, 1, ... for each step beyond it. */
export function nudgeLevel(tokens: number, s: NudgeSettings): number {
  return tokens < s.at ? -1 : Math.floor((tokens - s.at) / s.step);
}

/**
 * Reports whether a response of `tokens` context calls for a nudge, given the
 * context of the response before it (undefined if there is none).
 */
export function nudgeDue(tokens: number, previous: number | undefined, s: NudgeSettings): boolean {
  return nudgeLevel(tokens, s) > (previous === undefined ? -1 : nudgeLevel(previous, s));
}

/** The nudge's first line, the size rounded to the nearest 10k. */
export function sizeLine(tokens: number): string {
  return `Context is ${Math.floor((tokens + 5000) / 10000) * 10}k.`;
}

/** The context size a response reports, or undefined if it reports none. */
export function contextTokens(m: AgentMessage): number | undefined {
  if (m.role !== "assistant") return undefined;
  const n = calculateContextTokens(m.usage);
  return n > 0 ? n : undefined;
}

/** The context size an entry's response reports, if it is one that does. */
export const entryTokens = (e: SessionEntry) => (e.type === "message" ? contextTokens(e.message) : undefined);

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

export interface NudgeDecision {
  /** The nudge settings to record, when they changed since the branch was last nudged. */
  record?: NudgeSettings;
  /** Whether a nudge is due. */
  due: boolean;
}

/**
 * The nudge decision after the response at branch[index], of tokens context:
 * Shelley's contextNudger, taken before each model request. When the
 * settings changed since the branch was last nudged (or it never was), the
 * earlier responses do not count, so lowering the threshold nudges right away.
 */
export function decideNudge(
  branch: readonly SessionEntry[],
  index: number,
  tokens: number,
  s: NudgeSettings,
): NudgeDecision {
  const recorded = recordedNudge(branch);
  const changed = recorded?.at !== s.at || recorded?.step !== s.step;
  const previous = changed ? undefined : decidedTokens(branch, index);
  const due = nudgeDue(tokens, previous, s);
  return changed ? { record: { at: s.at, step: s.step }, due } : { due };
}
