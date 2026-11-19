import assert from "node:assert/strict";
import { test } from "node:test";
import { compactableTokens, compactionUnits } from "../extensions/percy/units.ts";
import { DEFAULT_LIMITS, type Item } from "../extensions/percy/types.ts";
import { itemTokens } from "../extensions/percy/rows.ts";
import { assistant, call, note, oldHistory, output, user, x } from "./fixtures.ts";

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

test("compactable tokens count work units only", () => {
  const items = [
    user(1, x(4 * 3_000)),
    assistant(2, x(4 * 1_000)),
    assistant(3, x(4 * 500)),
    user(4, x(4 * 2_000)),
    assistant(5, "the recent part"),
  ];
  // Rows 2-3 are one unit of work; the user messages, however large, and the
  // recent part do not count.
  assert.equal(compactableTokens(items, limits(1)), 1_500);
  // A row before a system message stays as it is.
  assert.equal(compactableTokens(items, limits(1), [3]), 500);
  assert.equal(compactableTokens([assistant(1, "only recent")], limits(1)), 0);
});

test("merges join old notes and the user messages between them", () => {
  const { merges } = compactionUnits(oldHistory(), limits(1));
  // The young note s30.0 ends the first run; the second run holds only one
  // old note, so it is not offered. User message 10 follows the last note of
  // the first run, so it stays out.
  assert.deepEqual(
    merges.map((m) => [m.id, m.from, m.to, m.kind, m.notes, m.users, m.others]),
    [["m1", "1", "s10.1", "merge", 2, 2, 0]],
  );
  // Other work left between old notes joins the merge; a row after the last
  // note does not.
  const history = oldHistory();
  history.splice(3, 0, assistant(100, "a reply"));
  history.splice(5, 0, assistant(101, "a later reply"));
  assert.deepEqual(
    compactionUnits(history, limits(1)).merges.map((m) => [m.from, m.to, m.notes, m.users, m.others]),
    [["1", "s10.1", 2, 2, 1]],
  );
  assert.deepEqual(compactionUnits(oldHistory(), { ...limits(1), mergeAfterCompactions: 0 }).merges, []);
  // Merges keep to the collapse budget.
  const small = { ...limits(1), maxCollapseTokens: 30 };
  assert.ok(compactionUnits(oldHistory(), small).merges.every((m) => m.tokens <= 30));
});

test("a long run of old notes splits into merges that leave no row out", () => {
  const history: Item[] = [];
  for (let k = 0; k < 8; k++) {
    history.push(user(10 * k + 1, `request ${k} ${"x".repeat(40 * (k % 3))}`));
    history.push(note(10 * k + 2, 10 * k + 9, `s1.${k}`, `Did task ${k}.`, 12));
  }
  history.push(user(100, "now"), assistant(101, "the recent part"));
  const position = new Map(history.map((it, i) => [it.note ? it.note.id : String(it.from), i]));
  let split = 0;
  for (let budget = 20; budget <= 200; budget += 5) {
    const { merges } = compactionUnits(history, { ...limits(1), maxCollapseTokens: budget });
    for (let k = 1; k < merges.length; k++) {
      // Each merge starts right after the last one, unless that one ended a
      // run of fewer than two notes.
      const gap = position.get(merges[k]!.from)! - position.get(merges[k - 1]!.to)! - 1;
      assert.ok(gap === 0 || gap === 2, `budget ${budget}: gap ${gap} before ${merges[k]!.id}`);
      if (gap === 0) split++;
    }
  }
  assert.ok(split > 0);
});

test("compactable tokens count half of what merges cover", () => {
  const history = oldHistory();
  const merged = compactionUnits(history, limits(1)).merges[0]!.tokens;
  const without = compactableTokens(history, { ...limits(1), mergeAfterCompactions: 0 });
  assert.equal(compactableTokens(history, limits(1)), without + Math.floor(merged / 2));
  // Work inside a merge counts once, as a unit of its own.
  const reply = assistant(100, "a reply between old notes");
  history.splice(3, 0, reply);
  const merge = compactionUnits(history, limits(1)).merges[0]!;
  assert.equal(merge.others, 1);
  const work = compactableTokens(history, { ...limits(1), mergeAfterCompactions: 0 });
  assert.equal(compactableTokens(history, limits(1)), work + Math.floor((merge.tokens - itemTokens([reply])) / 2));
});
