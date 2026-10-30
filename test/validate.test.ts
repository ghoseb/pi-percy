import assert from "node:assert/strict";
import { test } from "node:test";
import { trimmedText } from "../extensions/percy/messages.ts";
import { recentStart } from "../extensions/percy/rows.ts";
import { type CompactInput, type Collapse, DEFAULT_LIMITS, type Item, type Limits } from "../extensions/percy/types.ts";
import { buildCompaction, collapsesAlone, compactRequest, RETRY_GUIDANCE } from "../extensions/percy/validate.ts";
import { applyCompaction } from "../extensions/percy/view.ts";
import { assistant, call, compactCall, custom, nudge, output, spans, textOf, user, x } from "./fixtures.ts";

const limits = (keepRecentTokens: number): Limits => ({ ...DEFAULT_LIMITS, keepRecentTokens });
const col = (from: string, to: string, note = "n"): Collapse => ({ from, to, note });

/** The error message buildCompaction throws, or "" if it does not. */
function problem(history: Item[], keep: number, input: CompactInput): string {
  try {
    buildCompaction(history, limits(keep), input);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

// Port of Shelley's TestBuildCompaction.
test("buildCompaction validates the request", () => {
  const big = x(4 * 15_000); // ~15k tokens
  const items = [
    user(1, "do it"),
    call(2, "a"),
    output(3, "a", x(4 * 25_000)),
    assistant(4, big),
    assistant(5, "a"),
    user(6, "also this"),
    user(7, "and that"),
    assistant(8, "b"),
    assistant(9, "c"),
    assistant(10, big + big),
  ];
  // The recent part is the last message.
  assert.equal(recentStart(items, 20_000), 9);
  const cases: Record<string, CompactInput> = {
    "nothing to compact": {},
    "recent part": { collapse: [col("9", "10")] },
    "at most": { collapse: [col("2", "4")] },
    overlaps: { collapse: [col("8", "9"), col("9", "9")] },
    "note is empty": { collapse: [col("8", "9", "")] },
    // The user's messages may only be collapsed on their own.
    "collapse 5-8: covers 6, which can only be collapsed on its own; collapse e.g. 5, 8 instead": {
      collapse: [col("5", "8")],
    },
    "collapse 6-7: covers 6, which can only be collapsed on its own; collapse each of those rows on its own": {
      collapse: [col("6", "7")],
    },
  };
  for (const [want, input] of Object.entries(cases)) {
    assert.ok(problem(items, 20_000, input).includes(want), `want ${JSON.stringify(want)}`);
  }
  // Every problem is reported at once, and nothing is compacted.
  const all = problem(items, 20_000, { trim: ["nope"], collapse: [col("99", "2"), col("2", "4")] });
  assert.ok(
    all.startsWith(
      "3 problems:\n" +
        "- trim nope: unknown id; use ids from the index\n" +
        "- collapse 99-2: unknown id; use ids from the index\n" +
        "- collapse 2-4: covers ~",
    ),
    all,
  );
  // Over the limit is fine for one row, here a tool call and its output,
  // and a user message may be collapsed on its own.
  const c = buildCompaction(items, limits(20_000), {
    collapse: [col("8", "9"), col("2", "2"), col("6", "6"), col("1", "1")],
  });
  assert.equal(c.squishes.map((s) => `${s.from}-${s.to}`).join(" "), "1-1 2-3 6-6 8-9");
});

// Port of Shelley's TestBuildCompactionKeepsCallsWithOutputs: a range covers
// whole rows, so it cannot split a tool call from its output; the output's own
// number is not an id in the index.
test("buildCompaction keeps calls with their outputs", () => {
  const out = x(400);
  const items = [
    user(1, "do it"),
    call(2, "a"),
    output(3, "a", out),
    call(4, "b"),
    output(5, "b", out),
    assistant(6, "done"),
    assistant(7, x(4 * 25_000)),
  ];
  assert.equal(
    problem(items, 20_000, { collapse: [col("3", "6"), col("2", "3"), col("4", "4", "")] }),
    "3 problems:\n" +
      "- collapse 3-6: unknown id; use ids from the index\n" +
      "- collapse 2-3: unknown id; use ids from the index\n" +
      "- collapse 4-4: note is empty\n\n" +
      RETRY_GUIDANCE,
  );
  const c = buildCompaction(items, limits(20_000), { collapse: [col("2", "2"), col("4", "6")] });
  assert.deepEqual(
    c.squishes.map((s) => [s.from, s.to]),
    [
      [2, 3],
      [4, 6],
    ],
  );
});

// Port of Shelley's TestBuildCompactionOrphans: a call can lack its output,
// or an output its call. A range may cover such a row, but not end at the call
// or start at the output.
test("buildCompaction handles orphaned calls and outputs", () => {
  const items = [
    user(1, "do it"),
    call(2, "a"),
    output(3, "a", "ok"),
    call(4, "lost"),
    assistant(5, x(400)),
    output(6, "late", "late"),
    assistant(7, "done"),
    assistant(8, x(4 * 25_000)),
  ];
  assert.equal(
    problem(items, 20_000, { collapse: [col("2", "4"), col("6", "7")] }),
    "2 problems:\n" +
      "- collapse 2-4: 4 is a tool call without its output; end the range before it\n" +
      "- collapse 6-7: 6 is a tool output without its call; start the range after it\n\n" +
      RETRY_GUIDANCE,
  );
  // Suggestions around a row that can only be collapsed on its own leave the
  // orphans out at the ends.
  const withUser = [...items.slice(0, 4), user(10, "back"), ...items.slice(4)];
  assert.ok(
    problem(withUser, 20_000, { collapse: [col("2", "5")] }).includes(
      "covers 10, which can only be collapsed on its own; collapse e.g. 2, 5 instead",
    ),
  );
  // Otherwise they go with the range.
  for (const r of [col("2", "5"), col("4", "6"), col("5", "7")]) {
    const c = buildCompaction(items, limits(20_000), { collapse: [r] });
    assert.doesNotThrow(() => applyCompaction(items, c, 9), `${r.from}-${r.to}`);
  }
});

// Port of Shelley's TestBuildCompactionTrimsOnlyOlderOutputs.
test("buildCompaction trims only older outputs, by the call's id", () => {
  const history = [
    user(1, "do it"),
    call(2, "a"),
    output(3, "a", "old"),
    call(4, "t"),
    output(5, "t", trimmedText(5)),
    call(6, "b"),
    output(7, "b", "new"),
  ];
  // The recent part is the last call and its output.
  const c = buildCompaction(history, limits(1), { trim: ["2"] });
  assert.deepEqual(c.trims, [{ seq: 3, toolCallId: "a" }]);
  const cases: Record<string, string> = {
    "6": "in the recent part, which is kept as is",
    "4": "already trimmed",
    "1": "has no tool output",
    "3": "unknown id",
  };
  for (const [id, want] of Object.entries(cases)) {
    assert.ok(problem(history, 1, { trim: [id] }).includes(`trim ${id}: ${want}`), id);
  }
  assert.ok(problem(history, 1, { trim: ["2", "2"] }).includes("trim 2: listed twice"));
});

// Port of Shelley's TestBuildCompactionRetryPreservesNotes.
test("retry guidance asks to preserve notes", () => {
  const note = "Repeated push: everything up to date.\nIndex size 256: 12,906 ns → 6,237 ns.";
  const items = [assistant(1, `${note}\n`.repeat(20)), assistant(2, "Next task.")];
  for (const trim of [undefined, ["missing"]]) {
    const err = problem(items, 1, {
      ...(trim === undefined ? {} : { trim }),
      collapse: [col("missing", "1", note)],
    });
    for (const want of [
      "fix only the reported problems",
      "Preserve existing notes verbatim",
      "unless a note itself is invalid",
      "Do not shorten notes to fix IDs or ranges",
    ]) {
      assert.ok(err.includes(want), want);
    }
    const c = buildCompaction(items, limits(1), { collapse: [col("1", "1", note)] });
    assert.equal(c.squishes[0]?.summary, note);
  }
});

test("user bash runs and summaries cannot be compacted", () => {
  const bash: Item = {
    from: 3,
    to: 3,
    message: {
      role: "bashExecution",
      command: "make",
      output: x(400),
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 3,
    },
  };
  const summary: Item = {
    from: 1,
    to: 1,
    message: { role: "compactionSummary", summary: x(400), tokensBefore: 1, timestamp: 1 },
  };
  const items = [summary, assistant(2, x(400)), bash, assistant(4, x(400)), assistant(5, "Next task.")];
  assert.ok(problem(items, 1, { collapse: [col("2", "4")] }).includes("covers 3, which cannot be compacted"));
  assert.ok(problem(items, 1, { collapse: [col("1", "1")] }).includes("covers 1, which cannot be compacted"));
  assert.doesNotThrow(() => buildCompaction(items, limits(1), { collapse: [col("2", "2"), col("4", "4")] }));
});

test("a note must be shorter than what it replaces", () => {
  const items = [assistant(1, "short"), assistant(2, "Next task.")];
  assert.ok(problem(items, 1, { collapse: [col("1", "1", "long ".repeat(100))] }).includes("note is not shorter"));
  assert.ok(problem(items, 1, { collapse: [col("2", "1")] }).includes("from comes after to"));
});

// Port of Shelley's TestCollapsesAlone, for pi's message roles.
test("collapsesAlone: user messages, notes and summaries", () => {
  const summary = (role: "compactionSummary" | "branchSummary"): Item => ({
    from: 1,
    to: 1,
    message:
      role === "compactionSummary"
        ? { role, summary: "s", tokensBefore: 1, timestamp: 1 }
        : { role, summary: "s", fromId: "e1", timestamp: 1 },
  });
  const bash: Item = {
    from: 1,
    to: 1,
    message: {
      role: "bashExecution",
      command: "ls",
      output: "",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    },
  };
  const cases: [string, Item, boolean][] = [
    ["user", user(1, "fix it"), true],
    ["note", { ...user(1, "x"), note: { id: "s5.0", summary: "earlier" } }, true],
    ["compaction summary", summary("compactionSummary"), true],
    ["branch summary", summary("branchSummary"), true],
    ["assistant", assistant(1, "done"), false],
    ["tool output", output(1, "a", "out"), false],
    ["extension message", custom(1, "subagent-result", "found it"), false],
    ["user bash", bash, false],
  ];
  for (const [name, it, want] of cases) assert.equal(collapsesAlone(it), want, name);
});

// From Shelley's TestCompactInPlaceEndToEnd and compactMidTurn: the record
// also hides the evidence of compacting; the running call stays as a receipt.
test("compactRequest hides the evidence of compacting", () => {
  const history = [
    user(1, "do it"),
    call(2, "a"),
    output(3, "a", "small"),
    nudge(4),
    compactCall(5, "index"),
    output(6, "index", "## Index", "compact_in_place"),
    user(7, "go on"),
    assistant(8, x(400)),
    user(9, "and on"),
    compactCall(10, "running"),
  ];
  const r = compactRequest(history, limits(1), { collapse: [col("2", "2")] });
  assert.deepEqual(r.compaction.squishes, [{ from: 2, to: 3, summary: "n" }]);
  assert.deepEqual(r.compaction.hiddenSeqs, [4]);
  assert.deepEqual(r.compaction.hiddenToolCallIds, ["index"]);
  assert.deepEqual(
    r.edits.map((e) => [e.seq, e.replacement === null ? "omit" : "replace"]),
    [
      [2, "replace"],
      [3, "omit"],
      [4, "omit"],
      [5, "omit"],
      [6, "omit"],
    ],
  );
  const after = applyCompaction(history, r.compaction, 11);
  assert.equal(spans(after), "1-1 2-3 7-7 8-8 9-9 10-10");
  assert.equal(textOf(after[5]!.message), "toolCall(compact_in_place#running)");
  assert.match(r.text, /^Compacted: 1 collapsed, 0 trimmed; history ~\d+ -> ~\d+ tokens\.$/);
  assert.ok(r.tokensAfter < r.tokensBefore);
});
