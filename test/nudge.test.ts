import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_NUDGE, nudgeDue, nudgeLevel, sizeLine } from "../extensions/percy/nudge.ts";

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
