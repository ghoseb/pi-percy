// recall's search against real pi sessions, without an agent.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderOriginals,
  renderSearch,
  resolveIds,
  searchOriginals,
  type SearchQuery,
} from "../extensions/percy/recall.ts";
import { COMPACT_TOOL, NUDGE_TYPE, RECALL_TOOL } from "../extensions/percy/types.ts";
import { assistant, assistantMessage, call, output, user, x } from "./fixtures.ts";
import { compact, session, view } from "./sessions.ts";

/**
 * 1 user, 2 assistant with thinking, 3 bash call, 4 bash output, 5 nudge,
 * 6-7 a compact_in_place call and output, 8-9 a recall call and output,
 * 10 assistant; then a compaction of 2-4 recorded as entry 11 (note s11.0).
 */
function widgetSession() {
  const sm = session([
    user(0, "Deploy the Widget service"),
    assistantMessage(0, { type: "thinking", thinking: "widget reasoning" }, { type: "text", text: "I will deploy it" }),
    call(0, "a", "bash", { command: "deploy widget --prod" }),
    output(0, "a", `widget deployed ${x(400)}`),
  ]);
  sm.appendCustomMessageEntry(NUDGE_TYPE, "Context is 200k. widget index", true, {});
  sm.appendMessage(call(0, "c", COMPACT_TOOL, { action: "compact", note: "widget" }).message as never);
  sm.appendMessage(output(0, "c", "Compacted widget", COMPACT_TOOL).message as never);
  sm.appendMessage(call(0, "r", RECALL_TOOL, { ids: ["4"] }).message as never);
  sm.appendMessage(output(0, "r", "## Message 4 widget deployed", RECALL_TOOL).message as never);
  sm.appendMessage(assistant(0, "Done with the WIDGET").message as never);
  compact(sm, { collapse: [{ from: "2", to: "3", note: "Deployed widget, commit abc123" }] });
  return sm;
}

const search = (q: Partial<SearchQuery> & { query: string }) => searchOriginals(view(widgetSession()), q);
const ids = (q: Partial<SearchQuery> & { query: string }) => search(q).hits.map((h) => h.id);

test("search matches messages and notes, newest first, ignoring case", () => {
  const r = search({ query: "widget" });
  assert.deepEqual(
    r.hits.map((h) => h.id),
    ["s11.0", "10", "4", "3", "1"],
  );
  assert.equal(r.total, 5);
  const note = r.hits[0]!;
  assert.deepEqual([note.kind, note.header, note.range], ["note", "note for 2-4", [2, 4]]);
  assert.equal(r.hits[1]!.snippet, "Done with the WIDGET");
  assert.deepEqual(ids({ query: "widget", oldestFirst: true }), ["1", "3", "4", "10", "s11.0"]);
  assert.deepEqual(ids({ query: "WIDGET", caseSensitive: true }), ["10"]);
});

test("search skips thinking, nudges, and pi-percy's own tools", () => {
  assert.deepEqual(ids({ query: "reasoning" }), []);
  assert.deepEqual(ids({ query: "index" }), []);
  assert.deepEqual(ids({ query: "Compacted" }), []);
  assert.deepEqual(ids({ query: "## Message" }), []);
  // The text of a message with thinking is still searched.
  assert.deepEqual(ids({ query: "deploy it" }), ["2"]);
});

test("search skips tool calls that called recall, by their recorded nested calls", () => {
  const sm = widgetSession();
  const script = (id: string, code: string, out: string, nested: string[]) => {
    sm.appendMessage(call(0, id, "codemode", { code }).message as never);
    sm.appendMessage({
      ...(output(0, id, out, "codemode").message as object),
      nestedCalls: { calls: nested.map((name, i) => ({ id: `${id}/${i + 1}`, name, status: "ok" })), complete: true },
    } as never);
  };
  script("k1", "await tools.recall({ query: 'widget' })", "4 (bash output) widget deployed", ["recall", "read"]);
  script("k2", "await tools.read({ path: 'widget.md' })", "widget notes", ["read"]);
  const v = view(sm);
  const hits = searchOriginals(v, { query: "widget", tool: "codemode" }).hits.map((h) => h.id);
  // Only the script that did not call recall: its call and output.
  assert.deepEqual(hits, [String(v.count), String(v.count - 1)]);
});

test("role and tool narrow the search", () => {
  assert.deepEqual(ids({ query: "widget", role: "note" }), ["s11.0"]);
  assert.deepEqual(ids({ query: "widget", role: "user" }), ["1"]);
  assert.deepEqual(ids({ query: "widget", tool: "bash" }), ["4", "3"]);
  assert.deepEqual(ids({ query: "widget", tool: "bash", role: "assistant" }), ["3"]);
  assert.deepEqual(ids({ query: "widget", tool: "bash", role: "tool" }), ["4"]);
  // A tool's calls are searched by their arguments, not the assistant's text.
  assert.deepEqual(ids({ query: "deploy it", tool: "bash" }), []);
  assert.throws(() => search({ query: "widget", tool: "bash", role: "user" }), /only assistant tool calls/);
});

test("range limits messages, and notes by the messages they replaced", () => {
  const v = view(widgetSession());
  assert.deepEqual(
    searchOriginals(v, { query: "widget", range: [3, 4] }).hits.map((h) => h.id),
    ["s11.0", "4", "3"],
  );
  assert.deepEqual(
    searchOriginals(v, { query: "widget", range: resolveIds(v, ["9-10"])[0]! }).hits.map((h) => h.id),
    ["10"],
  );
  // As a search filter, a range may run past the last message; it must still start on the branch.
  assert.deepEqual(resolveIds(v, ["9-500"], true), [[9, v.count]]);
  assert.throws(() => resolveIds(v, ["9-500"]), new RegExp(`messages are numbered 1-${v.count}$`));
  assert.throws(() => resolveIds(v, ["500-600"], true), new RegExp(`messages are numbered 1-${v.count}$`));
});

test("search pages through hits", () => {
  const q = { query: "widget", limit: 2 };
  const first = search(q);
  assert.deepEqual([first.total, first.hits.map((h) => h.id)], [5, ["s11.0", "10"]]);
  assert.match(renderSearch(q, first), /\(newest first, 1-2 of 5\):[\s\S]*Use offset 2 for more\.$/);
  assert.deepEqual(ids({ ...q, offset: 4 }), ["1"]);
  assert.match(renderSearch({ ...q, offset: 9 }, search({ ...q, offset: 9 })), /offset 9 is past the last/);
  assert.equal(
    renderSearch({ query: "nothing" }, search({ query: "nothing" })),
    'No messages or notes match "nothing".',
  );
  assert.throws(() => search({ query: "w", limit: 0 }), /limit/);
  assert.throws(() => search({ query: "" }), /query/);
});

test("search lines name the ids to recall", () => {
  const q = { query: "widget", tool: "bash" };
  assert.equal(
    renderSearch(q, search(q)),
    [
      '2 messages or notes match "widget" (newest first, 1-2 of 2):',
      `4 (bash output for #a) widget deployed ${x(80 - " deployed ".length)}…`,
      '3 (assistant) [tool call bash#a] {"command":"deploy widget --prod"}',
      "Recall these ids to read them in full.",
    ].join("\n"),
  );
});

test("regex search, bad regexes, and regexes that never finish", () => {
  assert.deepEqual(ids({ query: "commit [0-9a-f]{6}", regex: true }), ["s11.0"]);
  // Special characters are plain text without regex.
  assert.deepEqual(ids({ query: "--prod" }), ["3"]);
  assert.deepEqual(ids({ query: "[0-9a-f]{6}" }), []);
  assert.throws(() => search({ query: "(", regex: true }), /invalid regex/);
  const sm = session([user(0, `${"a".repeat(40)}!`)]);
  const started = Date.now();
  assert.throws(() => searchOriginals(view(sm), { query: "(a+)+$", regex: true }, 100), /took longer than 0.1 s/);
  assert.ok(Date.now() - started < 2000, "stopped by the timeout");
});

test("every hit holds the query, and recall shows it", () => {
  const v = view(widgetSession());
  for (const query of ["widget", "deploy", "abc123", "prod"]) {
    for (const hit of searchOriginals(v, { query }).hits) {
      const recalled = renderOriginals(v, resolveIds(v, [hit.id]));
      const searchable = hit.kind === "note" ? v.recordAt(11)!.squishes[0]!.summary : recalled;
      assert.ok(searchable.toLowerCase().includes(query), `${hit.id}: ${searchable}`);
    }
  }
});
