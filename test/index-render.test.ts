import assert from "node:assert/strict";
import { test } from "node:test";
import { compactIndex, quoteStart, readableToolInput } from "../extensions/percy/index-render.ts";
import { trimmedText } from "../extensions/percy/messages.ts";
import { type Compaction, DEFAULT_LIMITS, emptyCompaction, type Item, type Limits } from "../extensions/percy/types.ts";
import { applyCompaction } from "../extensions/percy/view.ts";
import { assistant, assistantMessage, call, compactCall, nudge, output, toolCall, user, x } from "./fixtures.ts";

const limits = (keepRecentTokens: number): Limits => ({ ...DEFAULT_LIMITS, keepRecentTokens });

/** The table of an index, from its header line to the closing fence. */
function table(index: string): string {
  const start = index.indexOf("```\n");
  assert.ok(start >= 0, index);
  return index.slice(start + 4);
}

function rowIds(index: string): string[] {
  return [...table(index).matchAll(/^(\S+) /gm)].map((m) => m[1]!).filter((id) => id !== "id");
}

// Port of Shelley's TestCompactIndexRows: a tool call shares a row with its
// outputs, under the call's id. Inputs read like commands, and outputs show
// their size or that they are trimmed.
test("index rows", () => {
  const history: Item[] = [
    user(1, "do it"),
    assistantMessage(
      2,
      { type: "thinking", thinking: "hmm" },
      toolCall("a", "bash", { command: "cd /x && ls\n  -la", slow_ok: false }),
    ),
    // Output that merely starts like a trimmed one is not trimmed.
    output(3, "a", `[Tool output compacted, says the log]${x(363)}`),
    // Parallel calls; one output is trimmed already.
    assistantMessage(
      4,
      toolCall("b", "bash", { command: "make" }),
      toolCall("c", "browser", {
        action: "navigate",
        url: "http://localhost/",
        expression: "",
        await: false,
        timeout: 0,
        tabs: [1],
      }),
    ),
    output(5, "b", trimmedText(5)),
    output(6, "c", "page", "browser"),
    assistant(7, "done"),
    user(8, x(4 * 15_000)),
  ];
  assert.equal(
    table(compactIndex(history, limits(1))),
    "id  role       tokens  content\n" +
      '1   user*      2       text "do it"\n' +
      '2   assistant  114     thinking, bash "cd /x && ls -la slow_ok=false" → 100\n' +
      '4   assistant  47      bash "make" → trimmed, browser "navigate http://localhost/ await=false timeout=0" → 1\n' +
      '7   assistant  1       text "done"\n' +
      "```\n",
  );
});

test("index header", () => {
  const history = [user(1, "do it"), assistant(2, "ok"), user(3, x(4 * 25_000))];
  const index = compactIndex(history, limits(20_000));
  assert.ok(index.startsWith("## Index\n\n3 messages, ~25003 tokens.\n"), index);
  assert.ok(index.includes("The recent part, from 3 on (1 messages, ~25000 tokens), is kept as is and not listed."));
  assert.ok(index.includes("A range may not cover more than ~20k tokens"));
  assert.ok(index.includes("recall tool"));
  // All recent: nothing to list.
  assert.equal(
    compactIndex(history.slice(0, 2), limits(20_000)),
    "## Index\n\n2 messages, ~3 tokens.\nAll of it is recent, so nothing can be compacted yet.\n",
  );
});

// From Shelley's TestBuildCompactionOrphans.
test("index shows orphaned calls and outputs", () => {
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
  const index = compactIndex(items, limits(20_000));
  assert.match(index, /^4 .*bash → no output$/m);
  assert.match(index, /^6 +tool .*bash output → 1$/m);
});

// Port of Shelley's TestIndexSkipsEvidenceOfEarlierAttempts.
test("index skips the evidence of earlier attempts", () => {
  const history = [
    user(1, "do it"),
    call(2, "a"),
    output(3, "a", "small"),
    nudge(4),
    compactCall(5, "index"),
    output(6, "index", "index", "compact_in_place"),
    user(7, "go on"),
    assistant(8, x(4 * 15_000)),
    user(9, "and on"),
  ];
  // The work, then not the recent part from 9.
  assert.deepEqual(rowIds(compactIndex(history, limits(1))), ["1", "2", "7", "8"]);
});

// From Shelley's TestCompactDebugEndToEnd: the index reflects the compacted
// view, notes with whitespace collapsed.
test("index shows notes and trimmed outputs", () => {
  const history = [
    user(1, "hello"),
    assistant(2, "Well, hi there!"),
    user(3, "bash: echo compact-me-please"),
    call(4, "c", "bash", { command: "echo compact-me-please" }),
    output(5, "c", "compact-me-please\n"),
    assistant(6, "done"),
    user(7, x(4 * 25_000)),
  ];
  const records: Compaction[] = [
    { ...emptyCompaction(), trims: [{ seq: 5, toolCallId: "c" }] },
    { ...emptyCompaction(), squishes: [{ from: 1, to: 2, summary: "The user  said hello." }] },
  ];
  const view = records.reduce((items, c, n) => applyCompaction(items, c, 8 + n), history);
  const index = compactIndex(view, limits(20_000));
  assert.match(index, /^s9\.0 +note\* +\d+ +note "The user said hello."$/m);
  assert.ok(index.includes('bash "echo compact-me-please" → trimmed'), index);
});

// Port of Shelley's TestCompactIndexReadabilityGuidance.
test("index asks for readable notes", () => {
  const index = compactIndex([assistant(1, "Finished the benchmark."), assistant(2, "Next task.")], limits(1));
  for (const want of [
    "readable sentences or bullets with normal whitespace",
    "words, numbers, and units clearly separated",
    "not by removing spaces or joining words",
    "When an approach was abandoned or replaced",
    "Preserve one short note with the final decision",
    "When a task is complete and later work has moved on",
    "Preserve one short note that states the completed task",
    "Do not retain intermediate failed attempts unless they constrain current work",
  ]) {
    assert.ok(index.includes(want), want);
  }
});

// Port of Shelley's TestReadableToolInput, for pi's parsed arguments.
test("readableToolInput", () => {
  const cases: [unknown, string][] = [
    [{ command: "cd /x && ls", slow_ok: false }, "cd /x && ls slow_ok=false"],
    [{ a: { b: 1 }, c: [1], d: null, e: "", n: 2.5 }, "n=2.5"],
    ["text", '"text"'],
    [null, "null"],
    [undefined, ""],
    [[1, 2], "[1,2]"],
  ];
  for (const [input, want] of cases) assert.equal(readableToolInput(input), want, JSON.stringify(input));
});

test("quoteStart collapses whitespace and cuts at 60 characters", () => {
  assert.equal(quoteStart("  a\n\tb  c "), '"a b c"');
  assert.equal(quoteStart(x(70)), `"${x(60)}…"`);
  assert.equal(quoteStart("é".repeat(61)), `"${"é".repeat(60)}…"`);
});
