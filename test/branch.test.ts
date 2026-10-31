// The branch adapter against a real pi SessionManager, without an agent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type SessionBoundaryDraft, SessionManager } from "@earendil-works/pi-coding-agent";
import { branchView, compactionDrafts, compactionSplitBy } from "../extensions/percy/branch.ts";
import { noteText, trimmedText } from "../extensions/percy/messages.ts";
import { renderOriginals, resolveIds } from "../extensions/percy/recall.ts";
import { COMPACT_TOOL, DEFAULT_LIMITS, emptyCompaction, type Item, NUDGE_TYPE } from "../extensions/percy/types.ts";
import { compactRequest } from "../extensions/percy/validate.ts";
import { applyCompaction, editsBetween } from "../extensions/percy/view.ts";
import { anthropicWire, misplacedSystemMessages } from "./anthropic-wire.ts";
import { assistant, call, compactCall, output, spans, textOf, user, x } from "./fixtures.ts";

type Appendable = Parameters<SessionManager["appendMessage"]>[0];
const limits = { ...DEFAULT_LIMITS, keepRecentTokens: 1 };

function session(items: Item[]): SessionManager {
  const sm = SessionManager.inMemory("/tmp");
  for (const it of items) sm.appendMessage(it.message as Appendable);
  return sm;
}

const view = (sm: SessionManager) => branchView(sm.getBranch(), sm.buildSessionProjection());

/** Appends drafts the way pi does at a turn boundary. */
function commit(sm: SessionManager, drafts: SessionBoundaryDraft[]) {
  for (const d of drafts) {
    if (d.type === "custom") sm.appendCustomEntry(d.customType, d.data);
    else if (d.type === "context_edit") sm.appendContextEdit(d.targetId, d.replacement);
    else throw new Error(`unexpected draft ${d.type}`);
  }
}

/** Compacts sm's current view with input and commits it. */
function compact(sm: SessionManager, input: Parameters<typeof compactRequest>[2]) {
  const v = view(sm);
  const r = compactRequest(v.items, limits, input);
  commit(sm, compactionDrafts(v, r.compaction, r.edits, r));
}

const base = () => [
  user(0, "do it"),
  assistant(0, `Plan: ${x(400)}`),
  call(0, "a", "bash", { command: "make" }),
  output(0, "a", x(800)),
  assistant(0, "built"),
  user(0, "next"),
];

test("compactionSplitBy: a jump may not end a branch inside a compaction", () => {
  const sm = session(base());
  const before = sm.getLeafId();
  compact(sm, { trim: ["3"], collapse: [{ from: "2", to: "2", note: "Planned the build." }] });
  sm.appendMessage(assistant(0, "after").message as Appendable);
  const branch = sm.getBranch();
  const record = branch.findIndex((e) => e.type === "custom");
  const group = branch.slice(record, branch.length - 1);
  assert.ok(group.length >= 3 && group.slice(1).every((e) => e.type === "context_edit"), "a record and its edits");
  const last = group.at(-1)!.id;
  for (const e of group.slice(0, -1)) {
    assert.deepEqual(compactionSplitBy(sm.getEntries(), e.id), { before, last }, e.type);
  }
  for (const e of [...branch.slice(0, record), group.at(-1)!, branch.at(-1)!]) {
    assert.equal(compactionSplitBy(sm.getEntries(), e.id), undefined, e.type);
  }
  // A branch continued from inside the compaction, as older pi-percy allowed:
  // the edits after the target, on their own branch, still complete it.
  sm.branch(group[1]!.id);
  sm.appendMessage(assistant(0, "elsewhere").message as Appendable);
  assert.deepEqual(compactionSplitBy(sm.getEntries(), group[1]!.id), { before, last });
});

test("message numbers are branch positions", () => {
  const sm = session(base());
  assert.equal(spans(view(sm).items), "1-1 2-2 3-3 4-4 5-5 6-6");
});

test("a committed compaction shows as notes and trimmed outputs", () => {
  const sm = session(base());
  compact(sm, { trim: ["3"], collapse: [{ from: "2", to: "2", note: "planned" }] });
  const v = view(sm);
  // Entries 7 (record) and 8-9 (edits) add no messages.
  assert.equal(spans(v.items), "1-1 2-2 3-3 4-4 5-5 6-6");
  assert.deepEqual(v.items[1]!.note, { id: "s7.0", summary: "planned" });
  assert.equal(textOf(v.items[1]!.message), noteText(2, 2, "planned"));
  assert.equal(textOf(v.items[3]!.message), trimmedText(4));

  // A note may be collapsed again on its own: the carrier gets the new note.
  compact(sm, { collapse: [{ from: "s7.0", to: "s7.0", note: "p" }] });
  assert.deepEqual(view(sm).items[1]!.note, { id: "s10.0", summary: "p" });

  // A collapse enclosing a note (as /percy:compact-debug may record) omits the
  // note's carrier along with the rest of the range.
  const v2 = view(sm);
  const enclosing = { ...emptyCompaction(), squishes: [{ from: 2, to: 5, summary: "built it" }] };
  commit(
    sm,
    compactionDrafts(v2, enclosing, editsBetween(v2.items, applyCompaction(v2.items, enclosing, 0)), {
      tokensBefore: 0,
      tokensAfter: 0,
    }),
  );
  const again = view(sm);
  assert.equal(spans(again.items), "1-1 2-5 6-6");
  assert.deepEqual(again.items[1]!.note, { id: "s12.0", summary: "built it" });

  // recall resolves note ids to the range they replaced, and shows originals.
  const spansOf = resolveIds(again, ["s12.0"]);
  assert.deepEqual(spansOf, [[2, 5]]);
  const recalled = renderOriginals(again, spansOf);
  assert.ok(recalled.includes(`## Message 2 (assistant)\nPlan: `), recalled);
  assert.ok(recalled.includes(`## Message 3 (assistant)\n[tool call bash#a] {"command":"make"}`), recalled);
  assert.ok(recalled.includes(`## Message 4 (bash output for #a)\n${x(800)}`), recalled);
  assert.throws(
    () => resolveIds(again, ["0", "9-8", "99"]),
    /0: messages are numbered[\s\S]*9-8: the range ends before[\s\S]*99: messages/,
  );
});

test("edits and notes are branch-relative", () => {
  const sm = session(base());
  const leaf = sm.getLeafId()!;
  compact(sm, { collapse: [{ from: "2", to: "2", note: "planned" }] });
  sm.branch(leaf);
  const v = view(sm);
  assert.equal(v.items[1]!.note, undefined);
  assert.ok(textOf(v.items[1]!.message).startsWith("Plan: "));
});

test("a carrier edited by someone else is no longer a note", () => {
  const sm = session(base());
  compact(sm, { collapse: [{ from: "2", to: "2", note: "planned" }] });
  sm.appendContextEdit(sm.getBranch()[1]!.id, { content: [{ type: "text", text: "rewritten" }] });
  const v = view(sm);
  assert.equal(v.items[1]!.note, undefined);
  assert.equal(textOf(v.items[1]!.message), "rewritten");
});

test("after a pi compaction the view starts with its summary", () => {
  const sm = session(base());
  const kept = sm.getBranch()[4]!.id;
  sm.appendCompaction("SUMMARY", kept, 1000);
  const v = view(sm);
  assert.equal(v.items[0]!.message.role, "compactionSummary");
  assert.equal(spans(v.items), "7-7 5-5 6-6");
});

test("system messages are left out of the view", () => {
  const sm = SessionManager.inMemory("/tmp");
  sm.appendMessage({ role: "system", content: "You are pi.", timestamp: 1 });
  sm.appendMessage(user(0, "hi").message as Appendable);
  const v = view(sm);
  assert.equal(spans(v.items), "2-2");
  assert.deepEqual(v.systemBoundaries, [1]);
});

const roles = (sm: SessionManager) =>
  sm.buildSessionProjection().entries.flatMap((entry) => entry.messages.map((message) => message.role));

const projected = (sm: SessionManager) => sm.buildSessionProjection().entries.flatMap((entry) => entry.messages);

test("compaction hides a nudge before a system message when a user message follows it", async () => {
  const sm = SessionManager.inMemory("/tmp");
  sm.appendMessage(assistant(0, x(400)).message as Appendable);
  sm.appendCustomMessageEntry(NUDGE_TYPE, "Context is 200k.", true);
  sm.appendMessage({ role: "system", content: "New system instructions.", timestamp: 3 });
  sm.appendMessage(user(0, "current request").message as Appendable);
  const v = view(sm);
  assert.deepEqual(v.systemBoundaries, [3]);
  const result = compactRequest(
    v.items,
    limits,
    { collapse: [{ from: "1", to: "1", note: "old work" }] },
    v.systemBoundaries,
  );
  // pi-ai sends the system message right before the next assistant message,
  // after the user message, so the nudge is not needed there.
  assert.deepEqual(result.compaction.hiddenSeqs, [2]);
  commit(sm, compactionDrafts(v, result.compaction, result.edits, result));
  assert.deepEqual(roles(sm), ["assistant", "system", "user"]);
  assert.deepEqual(misplacedSystemMessages(await anthropicWire(projected(sm))), []);
});

// Minimized form of the corrupted pi-percy session: a tool toggle between
// turns persisted a system message after the final reply, a nudge and a
// compact_in_place call followed, and a later compaction hid both, leaving
// the system message between two assistant messages.
test("compaction keeps the nudge between a system message and the next assistant message", async () => {
  const sm = session([user(0, "do it"), assistant(0, `Done: ${x(400)}`)]);
  sm.appendMessage({ role: "system", content: "Tools changed.", timestamp: 3 });
  sm.appendCustomMessageEntry(NUDGE_TYPE, "Context is 200k.", true);
  for (const it of [
    compactCall(0, "c1", { action: "compact" }),
    output(0, "c1", "Compacted.", COMPACT_TOOL),
    assistant(0, `After compacting: ${x(400)}`),
    user(0, "next"),
    assistant(0, "ok"),
  ])
    sm.appendMessage(it.message as Appendable);
  const v = view(sm);
  assert.deepEqual(v.systemBoundaries, [3]);
  const result = compactRequest(
    v.items,
    limits,
    { collapse: [{ from: "7", to: "7", note: "after compacting" }] },
    v.systemBoundaries,
  );
  // Hiding the nudge would leave 2 (assistant) → system → 5 (assistant).
  // Hiding only the earlier compact_in_place call is safe.
  assert.deepEqual(result.compaction.hiddenSeqs, []);
  assert.deepEqual(result.compaction.hiddenToolCallIds, ["c1"]);
  commit(sm, compactionDrafts(v, result.compaction, result.edits, result));
  assert.deepEqual(roles(sm), ["user", "assistant", "system", "custom", "assistant", "user", "assistant"]);
  assert.deepEqual(misplacedSystemMessages(await anthropicWire(projected(sm))), []);
});

test("a system message between an assistant and a user message is valid", async () => {
  const sm = SessionManager.inMemory("/tmp");
  sm.appendMessage(assistant(0, x(400)).message as Appendable);
  sm.appendMessage({ role: "system", content: "New system instructions.", timestamp: 2 });
  sm.appendMessage(user(0, "current request").message as Appendable);
  const v = view(sm);
  assert.deepEqual(v.systemBoundaries, [2]);
  assert.deepEqual(misplacedSystemMessages(await anthropicWire(projected(sm))), []);
  assert.doesNotThrow(() =>
    compactRequest(v.items, limits, { collapse: [{ from: "1", to: "1", note: "old work" }] }, v.systemBoundaries),
  );
});

test("compaction refuses while a system message sits between two assistant messages", async () => {
  const sm = SessionManager.inMemory("/tmp");
  sm.appendMessage(user(0, "do it").message as Appendable);
  sm.appendMessage(assistant(0, x(400)).message as Appendable);
  sm.appendMessage({ role: "system", content: "Misplaced system instructions.", timestamp: 3 });
  sm.appendMessage(assistant(0, "more").message as Appendable);
  sm.appendMessage(user(0, "current request").message as Appendable);
  const v = view(sm);
  assert.deepEqual(misplacedSystemMessages(await anthropicWire(projected(sm))).length, 1);
  assert.throws(
    () => compactRequest(v.items, limits, { collapse: [{ from: "2", to: "2", note: "old work" }] }, v.systemBoundaries),
    /system message 3 would sit between assistant messages 2-2 and 4-4/,
  );
});

test("message numbers and notes survive a fork of a branch with labels", () => {
  const sm = session(base());
  // A label in the middle of the branch: fork moves labels to the end.
  sm.appendLabelChange(sm.getBranch()[1]!.id, "plan");
  sm.appendMessage(assistant(0, `More: ${x(400)}`).message as Appendable);
  sm.appendMessage(user(0, "go on").message as Appendable);
  compact(sm, { trim: ["3"], collapse: [{ from: "7", to: "7", note: "more" }] });
  const before = view(sm);
  const notes = (v: typeof before) => v.items.filter((it) => it.note).map((it) => `${it.note!.id}:${it.from}-${it.to}`);
  assert.deepEqual(notes(before), ["s9.0:7-7"]);

  sm.createBranchedSession(sm.getLeafId()!);
  assert.ok(sm.getBranch().findIndex((e) => e.type === "label") > 8, "fork did not move the label");
  const after = view(sm);
  assert.equal(spans(after.items), spans(before.items));
  assert.deepEqual(notes(after), notes(before));
  assert.equal(textOf(after.items[3]!.message), trimmedText(4));
  // recall finds the same originals by the same numbers.
  assert.equal(
    renderOriginals(after, resolveIds(after, ["2-4"])),
    renderOriginals(before, resolveIds(before, ["2-4"])),
  );
});
