// Context-size nudges: the agent is told the context size once it reaches a
// threshold, and again every step beyond, with the index so it can compact
// right away.
//
// Port of Shelley's contextNudger, without state of its own: a nudge is due
// when a response's level is above the level of the response before it on
// the branch. Dropping below a level (after a compaction) re-arms it, and a
// resumed or re-branched session does not repeat a nudge.

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
