import assert from "node:assert/strict";
import { test } from "node:test";
import { noteText, trimmedText } from "../extensions/percy/messages.ts";
import { type Compaction, emptyCompaction, type Item } from "../extensions/percy/types.ts";
import {
  applyCompaction,
  compactionEvidence,
  compactionView,
  editsBetween,
  hideItems,
} from "../extensions/percy/view.ts";
import {
  assistant,
  assistantMessage,
  call,
  compactCall,
  nudge,
  output,
  spans,
  textOf,
  toolCall,
  user,
} from "./fixtures.ts";

const squish = (from: number, to: number, summary: string): Compaction => ({
  ...emptyCompaction(),
  squishes: [{ from, to, summary }],
});
const trim = (seq: number, toolCallId: string): Compaction => ({ ...emptyCompaction(), trims: [{ seq, toolCallId }] });

// Port of Shelley's TestApplyInPlaceCompaction.
test("applyCompaction squishes, trims, and validates ranges", () => {
  const base = [
    user(1, "hi"),
    assistant(2, "hello"),
    call(3, "t1"),
    output(4, "t1", "lots of output"),
    assistant(6, "done"),
  ];

  const got = applyCompaction(base, squish(2, 4, "ran bash"), 7);
  assert.equal(spans(got), "1-1 2-4 6-6");
  const note = got[1]!;
  assert.deepEqual(note.note, { id: "s7.0", summary: "ran bash" });
  // The first message of the range carries the note, keeping its role.
  assert.equal(note.message.role, "assistant");
  assert.equal(note.message.timestamp, 2);
  assert.equal(textOf(note.message), noteText(2, 4, "ran bash"));
  assert.equal(spans(base), "1-1 2-2 3-3 4-4 6-6", "input modified");

  // A later squish may enclose an earlier note but not cut into it.
  assert.equal(spans(applyCompaction(got, squish(1, 6, "all"), 8)), "1-6");
  assert.throws(() => applyCompaction(got, squish(3, 6, "x"), 8));

  const bad: Record<string, Compaction> = {
    "unknown start": squish(5, 6, "x"),
    reversed: squish(6, 1, "x"),
    "ends with tool call": squish(1, 3, "x"),
    "starts with result": squish(4, 6, "x"),
    "trim without result": trim(2, "t1"),
    "trim other result": trim(4, "t2"),
    "trim unknown": trim(5, "t1"),
  };
  for (const [name, c] of Object.entries(bad)) {
    assert.throws(() => applyCompaction(base, c, 7), Error, name);
  }

  const trimmed = applyCompaction(base, trim(4, "t1"), 7);
  const result = trimmed[3]!.message;
  assert.equal(result.role, "toolResult");
  assert.equal(textOf(result), trimmedText(4));
  assert.equal(textOf(base[3]!.message), "lots of output", "trim modified input");
});

test("applyCompaction numbers notes by record and squish index", () => {
  const base = [user(1, "a"), assistant(2, "b"), user(3, "c"), assistant(4, "d")];
  const c: Compaction = {
    ...emptyCompaction(),
    squishes: [
      { from: 1, to: 2, summary: "first" },
      { from: 3, to: 4, summary: "second" },
    ],
  };
  assert.deepEqual(
    applyCompaction(base, c, 9).map((it) => it.note?.id),
    ["s9.0", "s9.1"],
  );
});

// Port of Shelley's TestHideItems. In pi each tool result is its own message.
test("hideItems drops nudges and tool calls with their results", () => {
  const calling = (seq: number, ...ids: string[]) =>
    assistantMessage(seq, { type: "text", text: "calling" }, ...ids.map((id) => toolCall(id)));
  const items = [
    user(1, "go"),
    calling(2, "compact"),
    output(3, "compact", "index"),
    nudge(4),
    calling(5, "compact2", "bash"),
    output(6, "compact2", "index"),
    output(7, "bash", "out"),
  ];
  const got = hideItems(items, [4], ["compact", "compact2"]);
  const shape = got.map((it) => `${it.from}:${it.message.role === "assistant" ? it.message.content.length : 1}`);
  // The parallel bash call and its result stay; so does the text beside it.
  assert.equal(shape.join(" "), "1:1 5:2 7:1");
  const fifth = items[4]!.message;
  assert.equal(fifth.role === "assistant" && fifth.content.length, 3, "input message modified");
  for (const ids of [["missing"], ["compact", "compact"]]) {
    assert.throws(() => hideItems(items, [], ids), Error, ids.join(","));
  }
  assert.throws(() => hideItems(items, [99], []));
});

test("editsBetween turns a compaction into context edits", () => {
  const base = [
    user(1, "hi"),
    assistant(2, "hello"),
    call(3, "t1"),
    output(4, "t1", "lots of output"),
    assistant(5, "done"),
    call(6, "t2"),
    output(7, "t2", "more output"),
    nudge(8),
    assistantMessage(9, toolCall("compact", "compact_in_place"), toolCall("t3")),
    output(10, "compact", "index"),
    output(11, "t3", "three"),
  ];
  const c: Compaction = {
    squishes: [{ from: 2, to: 5, summary: "ran bash" }],
    trims: [{ seq: 7, toolCallId: "t2" }],
    hiddenSeqs: [8],
    hiddenToolCallIds: ["compact"],
  };
  const edits = editsBetween(base, applyCompaction(base, c, 12));
  assert.deepEqual(edits, [
    // The carrier gets the note; the rest of the range goes.
    { seq: 2, replacement: { content: [{ type: "text", text: noteText(2, 5, "ran bash") }] } },
    { seq: 3, replacement: null },
    { seq: 4, replacement: null },
    { seq: 5, replacement: null },
    { seq: 7, replacement: { content: [{ type: "text", text: trimmedText(7) }] } },
    { seq: 8, replacement: null },
    // A message keeping another call loses only the hidden one.
    { seq: 9, replacement: { content: [toolCall("t3")] } },
    { seq: 10, replacement: null },
  ]);
  // A later squish enclosing a note omits the note's carrier, and nothing
  // it already covered.
  const once = applyCompaction(base, c, 12);
  const again = applyCompaction(once, { ...emptyCompaction(), squishes: [{ from: 1, to: 7, summary: "all" }] }, 13);
  assert.deepEqual(
    editsBetween(once, again).map((e) => [e.seq, e.replacement === null ? "omit" : "replace"]),
    [
      [1, "replace"],
      [2, "omit"],
      [6, "omit"],
      [7, "omit"],
    ],
  );
});

test("messages pi cannot edit are not compacted", () => {
  const bash: Item = {
    from: 2,
    to: 2,
    message: {
      role: "bashExecution",
      command: "ls",
      output: "x",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 2,
    },
  };
  const base = [user(1, "hi"), bash, assistant(3, "ok")];
  assert.throws(() => applyCompaction(base, squish(2, 3, "x"), 4), /covers 2, which is not editable/);
  assert.throws(() => editsBetween(base, [base[0]!, base[2]!]), /message 2 is not editable/);
});

test("compactionEvidence finds nudges and finished compact calls", () => {
  const items = [
    user(1, "go"),
    nudge(2),
    compactCall(3, "index"),
    output(4, "index", "## Index"),
    call(5, "bash"),
    output(6, "bash", "out"),
    compactCall(7, "running"),
  ];
  assert.deepEqual(compactionEvidence(items), { seqs: [2], toolCallIds: ["index"] });
  // The view also drops the running call, which has no output yet.
  assert.equal(spans(compactionView(items)), "1-1 5-5 6-6");
});
