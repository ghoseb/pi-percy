import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RECORD_TYPE } from "../extensions/percy/branch.ts";
import {
  decideNudge,
  DEFAULT_NUDGE,
  entryTokens,
  NUDGE_DEFERRED_TYPE,
  NUDGE_SETTINGS_TYPE,
  type NudgeSettings,
  nudgeDue,
  nudgeLevel,
  sizeLine,
} from "../extensions/percy/nudge.ts";
import { assistant } from "./fixtures.ts";

test("nudge levels", () => {
  assert.equal(nudgeLevel(199_999, DEFAULT_NUDGE), -1);
  assert.equal(nudgeLevel(200_000, DEFAULT_NUDGE), 0);
  assert.equal(nudgeLevel(249_999, DEFAULT_NUDGE), 0);
  assert.equal(nudgeLevel(250_000, DEFAULT_NUDGE), 1);
});

// Port of the sequence in Shelley's TestContextNudger: each response is
// compared with the one before it.
test("nudges fire on crossing a level, and re-arm after dropping below", () => {
  assert.equal(nudgeDue(260_000, 260_000, DEFAULT_NUDGE), false, "a resumed session does not repeat its level");
  assert.equal(nudgeDue(260_000, undefined, DEFAULT_NUDGE), true, "the first response may be due");
  const steps: [number, string][] = [
    [290_000, ""],
    [302_000, "Context is 300k."],
    [320_000, ""],
    [90_000, ""], // compacted: re-arms
    [199_000, ""],
    [203_000, "Context is 200k."],
    [410_000, "Context is 410k."],
  ];
  let previous = 260_000;
  for (const [tokens, want] of steps) {
    assert.equal(nudgeDue(tokens, previous, DEFAULT_NUDGE) ? sizeLine(tokens) : "", want, `at ${tokens}`);
    previous = tokens;
  }
});

test("size line rounds to the nearest 10k", () => {
  assert.equal(sizeLine(204_999), "Context is 200k.");
  assert.equal(sizeLine(205_000), "Context is 210k.");
  assert.equal(sizeLine(0), "Context is 0k.");
});

type Step = number | "compacted" | "deferred" | NudgeSettings;

/**
 * A branch of responses (their context sizes), records, deferral marks and
 * recorded settings, and the decision for its newest response.
 */
function decide(steps: Step[], s: NudgeSettings) {
  const sm = SessionManager.inMemory("/tmp");
  for (const step of steps) {
    if (step === "compacted") sm.appendCustomEntry(RECORD_TYPE, {});
    else if (step === "deferred") sm.appendCustomEntry(NUDGE_DEFERRED_TYPE, {});
    else if (typeof step === "object") sm.appendCustomEntry(NUDGE_SETTINGS_TYPE, step);
    else {
      const m = assistant(0, "reply").message;
      if (m.role !== "assistant") throw new Error("not an assistant message");
      m.usage.totalTokens = step;
      sm.appendMessage(m);
    }
  }
  const branch = sm.getBranch();
  const index = branch.findLastIndex((e) => entryTokens(e) !== undefined);
  return decideNudge(branch, index, entryTokens(branch[index]!)!, s);
}

const S: NudgeSettings = { at: 1000, step: 500 };

test("decideNudge: the first nudge, at the threshold", () => {
  assert.deepEqual(decide([S, 600, 900], S), { due: false });
  assert.deepEqual(decide([S, 900, 1100], S), { due: true });
  assert.deepEqual(decide([S, 1100, 1200], S), { due: false }, "already nudged at this level");
});

test("decideNudge: one nudge per level step", () => {
  assert.deepEqual(decide([S, 1100, 1400], S), { due: false });
  assert.deepEqual(decide([S, 1100, 1500], S), { due: true });
  assert.deepEqual(decide([S, 1100, 2100], S), { due: true });
  assert.deepEqual(decide([S, 1600, 700, 1100], S), { due: true }, "dropping below a level re-arms it");
});

test("decideNudge: a compacting turn's response is not decided", () => {
  // The turn that compacted at 1600 sent no nudge; its size is from before
  // the compaction. The next response is compared with the one before it.
  assert.deepEqual(decide([S, 1100, 1600, "compacted", 1650], S), { due: true });
  assert.deepEqual(decide([S, 1600, 1700, "compacted", 1650], S), { due: false });
});

test("decideNudge: a deferred response is not decided", () => {
  // Its nudge waited for a queued message, so it is still due.
  assert.deepEqual(decide([S, 1100, 1600, "deferred", 1650], S), { due: true });
  assert.deepEqual(decide([S, 1100, 1600, 1650], S), { due: false });
});

test("decideNudge: changed settings are recorded, and nudge again", () => {
  assert.deepEqual(decide([1100, 1200], S), { record: S, due: true }, "never recorded");
  assert.deepEqual(decide([600, 700], S), { record: S, due: false });
  const lower = { at: 500, step: 500 };
  assert.deepEqual(decide([S, 600, 700], lower), { record: lower, due: true }, "a lowered threshold nudges now");
  const finer = { at: 1000, step: 100 };
  assert.deepEqual(decide([S, 1100, 1200], finer), { record: finer, due: true });
  assert.deepEqual(decide([S, 1100, finer, 1150], finer), { due: false }, "the newest record counts");
});
