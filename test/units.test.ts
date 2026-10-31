import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionUnits } from "../extensions/percy/units.ts";
import { DEFAULT_LIMITS, type Item } from "../extensions/percy/types.ts";
import { assistant, call, output, user, x } from "./fixtures.ts";

const limits = (keepRecentTokens: number) => ({ ...DEFAULT_LIMITS, keepRecentTokens });

test("compaction units preserve protected rows and tool boundaries", () => {
  const items: Item[] = [
    user(1, "do it"),
    call(2, "a"),
    output(3, "a", "old output"),
    assistant(4, "done"),
    user(5, "next task"),
    assistant(6, "worked"),
    {
      from: 7,
      to: 7,
      message: {
        role: "bashExecution",
        command: "pwd",
        output: "/tmp",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 7,
      },
    },
    assistant(8, "finished"),
    user(9, x(400)),
  ];
  const result = compactionUnits(items, limits(1));
  assert.deepEqual(
    result.units.map((unit) => [unit.id, unit.from, unit.to, unit.kind]),
    [
      ["u1", "1", "1", "single"],
      ["u2", "2", "4", "range"],
      ["u3", "5", "5", "single"],
      ["u4", "6", "6", "single"],
      ["u5", "8", "8", "single"],
    ],
  );
  assert.deepEqual(result.protectedRows, [{ id: "7", reason: "cannot be compacted" }]);
});

test("compaction units split work at the configured collapse budget", () => {
  const items = [assistant(1, x(4 * 12_000)), assistant(2, x(4 * 12_000)), assistant(3, x(4 * 25_000))];
  const result = compactionUnits(items, limits(1));
  assert.deepEqual(
    result.units.map((unit) => [unit.from, unit.to, unit.tokens]),
    [
      ["1", "1", 12_000],
      ["2", "2", 12_000],
    ],
  );
});

test("compaction units protect a row before a system message", () => {
  const items = [assistant(1, "old work"), assistant(2, "must remain"), assistant(3, x(400))];
  const result = compactionUnits(items, limits(1), [3]);
  assert.deepEqual(
    result.units.map((unit) => [unit.from, unit.to]),
    [["1", "1"]],
  );
  assert.deepEqual(result.protectedRows, [{ id: "2", reason: "precedes a system message" }]);
});
