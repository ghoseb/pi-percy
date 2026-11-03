// End-to-end: pi-percy in a real pi session with a scripted faux model.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isRecordEntry } from "../extensions/percy/branch.ts";
import { noteText, trimmedText } from "../extensions/percy/messages.ts";
import { RETRY_GUIDANCE } from "../extensions/percy/validate.ts";
import { dump, GREETING, type Harness, startHarness } from "./harness.ts";

/** Message number (branch position) of the first entry matching. */
function seqWhere(h: Harness, match: (e: SessionEntry) => boolean): number {
  const i = h.session.sessionManager.getBranch().findIndex(match);
  assert.ok(i >= 0, "no matching entry");
  return i + 1;
}

const isMessage = (role: string, text: string) => (e: SessionEntry) =>
  e.type === "message" && e.message.role === role && JSON.stringify(e.message).includes(text);
const isCall = (text: string) => (e: SessionEntry) =>
  e.type === "message" &&
  e.message.role === "assistant" &&
  e.message.content.some((c) => c.type === "toolCall" && JSON.stringify(c.arguments).includes(text));

const records = (h: Harness) => h.session.sessionManager.getBranch().filter(isRecordEntry).length;

// Port of Shelley's TestCompactInPlaceEndToEnd: the index lists the view,
// invalid requests come back as tool errors, and a valid one compacts the
// history the rest of the same turn, and later turns, see.
let h: Harness;
before(async () => {
  h = await startHarness({ limits: { keepRecentTokens: 1 } });
});
after(() => h.dispose());

test("compact_in_place end to end", async () => {
  await h.send("hello");
  await h.call("echo", { text: "FIRST_OUTPUT" });
  await h.call("echo", { text: "SECOND_OUTPUT" });

  const helloSeq = seqWhere(h, isMessage("user", '"hello"'));
  const greetingSeq = seqWhere(h, isMessage("assistant", "Well, hi there!"));
  const firstCallSeq = seqWhere(h, isCall("FIRST_OUTPUT"));
  const firstResultSeq = seqWhere(h, isMessage("toolResult", "FIRST_OUTPUT"));

  await h.call("compact_in_place", { action: "index" });
  const index = h.lastToolResult();
  assert.equal(index.isError, false, index.text);
  assert.ok(index.text.startsWith("## Index"), index.text);
  assert.ok(index.text.includes("is kept as is and not listed"), index.text);
  assert.match(index.text, new RegExp(`^${helloSeq} +user\\* `, "m"));
  // The call and its output share a row, under the call's id.
  assert.match(index.text, new RegExp(`^${firstCallSeq} +assistant +\\d+ +echo "FIRST_OUTPUT" → \\d+$`, "m"));
  const listed = index.text.split("```")[1]!.trim().split("\n").length - 1;
  assert.ok(listed > 0);
  assert.deepEqual(index.details, { kind: "index", rows: listed });

  // Invalid requests come back as errors and record nothing.
  const invalid: [string, unknown][] = [
    ["unknown id", [{ from: "999999", to: String(greetingSeq), note: "x" }]],
    ["from comes after to", [{ from: String(greetingSeq), to: String(helloSeq), note: "x" }]],
    ["note is not shorter", [{ from: String(greetingSeq), to: String(greetingSeq), note: "long ".repeat(100) }]],
    ["only be collapsed on", [{ from: String(helloSeq), to: String(greetingSeq), note: "x" }]],
  ];
  for (const [want, collapse] of invalid) {
    await h.call("compact_in_place", { action: "compact", collapse });
    const r = h.lastToolResult();
    assert.ok(r.isError && r.text.includes(want), `want ${want}, got ${r.text}`);
  }
  await h.call("compact_in_place", { action: "compact", trim: ["nope"] });
  const rejected = h.lastToolResult();
  assert.equal(rejected.text, `trim nope: unknown id; use ids from the index. ${RETRY_GUIDANCE}`);
  assert.deepEqual(rejected.details, { kind: "rejected", problems: ["trim nope: unknown id; use ids from the index"] });
  assert.equal(records(h), 0);

  // Ids may come as numbers.
  await h.call("compact_in_place", {
    action: "compact",
    trim: [firstCallSeq],
    collapse: [{ from: greetingSeq, to: greetingSeq, note: "GREETED" }],
  });
  const done = h.lastToolResult();
  assert.ok(!done.isError && done.text.startsWith("Compacted: 1 collapsed, 1 trimmed"), done.text);
  const [, tokensBefore, tokensAfter] = /history ~(\d+) -> ~(\d+) tokens/.exec(done.text)!;
  assert.deepEqual(done.details, {
    kind: "compacted",
    tokensBefore: Number(tokensBefore),
    tokensAfter: Number(tokensAfter),
    collapsed: 1,
    trimmed: 1,
  });
  assert.equal(records(h), 1);

  // The request after the tool call, in the same turn, already sees the
  // compacted history, ending with the compact call's output.
  const check = (request: string[]) => {
    const all = request.join("\n");
    assert.equal(request[2], `assistant: ${noteText(greetingSeq, greetingSeq, "GREETED")}`, all);
    assert.ok(!all.includes(GREETING), all);
    assert.ok(all.includes(trimmedText(firstResultSeq)), all);
    assert.ok(!all.includes("toolResult: FIRST_OUTPUT"), all);
    assert.ok(all.includes("toolResult: SECOND_OUTPUT"), all);
    assert.equal(all.split("Compacted: 1 collapsed").length - 1, 1, all);
    // Earlier compact_in_place calls (the index, failed attempts) are
    // hidden; only the successful call remains, as a receipt.
    assert.ok(!all.includes("## Index") && !all.includes("unknown id"), all);
    assert.equal(all.split("toolCall(compact_in_place)").length - 1, 1, all);
  };
  check(dump(h.requests[h.requests.length - 1]!));

  // A later turn sees the same history.
  await h.send("after");
  check(dump(h.requests[h.requests.length - 1]!));

  // The originals are untouched in the session.
  const raw = h.session.sessionManager.getBranch()[firstResultSeq - 1]!;
  assert.ok(raw.type === "message" && JSON.stringify(raw.message).includes("FIRST_OUTPUT"));

  // The next index folds the small note with the small user messages around
  // it, and shows the trimmed output.
  await h.call("compact_in_place", { action: "index" });
  const again = h.lastToolResult().text;
  assert.match(again, /^\d+-\d+ +\* +\d+ +\d+ rows: 1 note, \d+ user messages$/m);
  assert.ok(again.includes('echo "FIRST_OUTPUT" → trimmed'), again);

  // Recalling the fold's span reads the originals behind it.
  const fold = /^(\d+-\d+) +\* /m.exec(again)![1]!;
  await h.call("recall", { ids: [fold] });
  assert.ok(h.lastToolResult().text.includes(GREETING), h.lastToolResult().text);

  // Search finds the note; recall shows the originals, by note id or message number.
  await h.call("recall", { query: "GREETED", role: "note" });
  const noteId = /^(s\d+\.0) /m.exec(h.lastToolResult().text)![1]!;
  await h.call("recall", { ids: [noteId, firstResultSeq] });
  const recalled = h.lastToolResult();
  assert.equal(recalled.isError, false, recalled.text);
  assert.ok(recalled.text.includes(`## Message ${greetingSeq} (assistant)\n${GREETING}`), recalled.text);
  assert.ok(recalled.text.includes(`## Message ${firstResultSeq} (echo output for #`), recalled.text);
  assert.ok(recalled.text.includes("FIRST_OUTPUT"), recalled.text);

  // A direct range works as well, including both collapsed and trimmed rows.
  await h.call("recall", { ids: [`${greetingSeq}-${firstResultSeq}`] });
  const range = h.lastToolResult();
  assert.equal(range.isError, false, range.text);
  assert.ok(
    range.text.includes(`## Message ${greetingSeq} (assistant)
${GREETING}`),
    range.text,
  );
  assert.ok(range.text.includes("FIRST_OUTPUT"), range.text);

  // Search finds the trimmed output and the note, and names their ids.
  await h.call("recall", { query: "first_output" });
  const found = h.lastToolResult();
  assert.equal(found.isError, false, found.text);
  assert.ok(found.text.includes(`${firstResultSeq} (echo output for #`), found.text);
  await h.call("recall", { query: "greeted", role: "note" });
  assert.ok(h.lastToolResult().text.includes(`${noteId} (note for `), h.lastToolResult().text);
  // A search range may run past the last message.
  await h.call("recall", { query: "first_output", range: `${firstResultSeq}-999999` });
  assert.ok(h.lastToolResult().text.includes(`${firstResultSeq} (echo output for #`), h.lastToolResult().text);
  // A numeric query is searched as text.
  await h.call("recall", { query: 404 });
  const numeric = h.lastToolResult();
  assert.ok(!numeric.isError && numeric.text.includes('"404"'), numeric.text);

  await h.call("recall", { ids: [noteId], query: "x" });
  assert.ok(h.lastToolResult().isError && h.lastToolResult().text.includes("not both"), h.lastToolResult().text);
  await h.call("recall", {});
  assert.ok(h.lastToolResult().isError && h.lastToolResult().text.includes("give ids"), h.lastToolResult().text);

  await h.call("recall", { ids: ["s999.0", "x"] });
  const bad = h.lastToolResult();
  assert.ok(
    bad.isError && bad.text.includes("s999.0: no such note") && bad.text.includes("x: not a message"),
    bad.text,
  );
});

test("only one compaction per turn applies", async () => {
  const p = await startHarness({ limits: { keepRecentTokens: 1 } });
  try {
    await p.send("hello");
    await p.call("echo", { text: "OUT" });
    const greetingSeq = seqWhere(p, isMessage("assistant", "Well, hi there!"));
    const callSeq = seqWhere(p, isCall("OUT"));
    await p.calls([
      ["compact_in_place", { action: "compact", collapse: [{ from: greetingSeq, to: greetingSeq, note: "GREETED" }] }],
      ["compact_in_place", { action: "compact", trim: [callSeq] }],
    ]);
    const [first, second] = p.toolResults().slice(-2);
    assert.ok(first && !first.isError && first.text.startsWith("Compacted: 1 collapsed"), JSON.stringify(first));
    assert.ok(second?.isError && second.text.includes("waiting to be applied"), JSON.stringify(second));
    assert.equal(records(p), 1);
    // The next request has the first compaction and not the second.
    const all = dump(p.requests[p.requests.length - 1]!).join("\n");
    assert.ok(all.includes(noteText(greetingSeq, greetingSeq, "GREETED")), all);
    assert.ok(all.includes("toolResult: OUT"), all);
  } finally {
    p.dispose();
  }
});

test("a compaction made just before an abort is applied", async () => {
  const a = await startHarness({ limits: { keepRecentTokens: 1 } });
  try {
    await a.send("hello");
    await a.call("echo", { text: "OUT" });
    const greetingSeq = seqWhere(a, isMessage("assistant", "Well, hi there!"));
    const callSeq = seqWhere(a, isCall("OUT"));
    // The stop tool aborts the run right after the compaction in its batch.
    await a.calls([
      ["compact_in_place", { action: "compact", collapse: [{ from: greetingSeq, to: greetingSeq, note: "GREETED" }] }],
      ["stop", {}],
    ]);
    assert.equal(records(a), 1);
    await a.send("next");
    assert.ok(
      dump(a.requests[a.requests.length - 1]!)
        .join("\n")
        .includes(noteText(greetingSeq, greetingSeq, "GREETED")),
    );
    // Nothing is left waiting: the next compaction goes through.
    await a.call("compact_in_place", { action: "compact", trim: [callSeq] });
    assert.equal(a.lastToolResult().isError, false, a.lastToolResult().text);
    assert.equal(a.notifications.filter((n) => n.message.includes("not applied")).length, 0);
  } finally {
    a.dispose();
  }
});

/** A tool that calls another tool, as a codemode script does. */
const scriptTool: ExtensionFactory = (pi) => {
  pi.registerTool({
    name: "script",
    label: "Script",
    description: "Call a tool from inside a tool",
    parameters: Type.Object({ tool: Type.String(), args: Type.Any() }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const outcome = await ctx.executeTool(params.tool, params.args, signal ? { signal } : {});
      const text = outcome.result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      const structured = outcome.result.structuredContent;
      const data = structured === undefined ? "" : `\nstructured: ${JSON.stringify(structured)}`;
      return {
        content: [{ type: "text", text: `${outcome.isError ? "error" : "ok"}: ${text}${data}` }],
        details: undefined,
      };
    },
  });
};

test("scripts can recall but cannot compact", async () => {
  const s = await startHarness({ limits: { keepRecentTokens: 1 } }, { extensions: [scriptTool] });
  try {
    await s.send("hello");
    await s.call("echo", { text: "OUT" });
    const greetingSeq = seqWhere(s, isMessage("assistant", "Well, hi there!"));
    assert.ok(s.session.getActiveToolNames().includes("compact_in_place"), "still declared to the model");

    await s.call("script", {
      tool: "compact_in_place",
      args: { action: "compact", collapse: [{ from: String(greetingSeq), to: String(greetingSeq), note: "GREETED" }] },
    });
    const compacted = s.lastToolResult().text;
    assert.ok(compacted.startsWith("error: "), compacted);
    assert.ok(!compacted.includes("Compacted:"), compacted);
    await s.send("next");
    assert.equal(records(s), 0);
    const sent = dump(s.requests[s.requests.length - 1]!).join("\n");
    assert.ok(!sent.includes(noteText(greetingSeq, greetingSeq, "GREETED")), sent);

    await s.call("script", { tool: "recall", args: { ids: [String(greetingSeq)] } });
    const recalled = s.lastToolResult().text;
    assert.ok(recalled.startsWith("ok: ") && recalled.includes("Well, hi there!"), recalled);
    // Scripts also get recall's results as data.
    const data = (t: string) => JSON.parse(t.slice(t.indexOf("\nstructured: ") + "\nstructured: ".length)) as unknown;
    assert.deepEqual(data(recalled), {
      messages: [{ id: greetingSeq, header: "assistant", text: "Well, hi there! What shall we work on today?" }],
    });
    await s.call("script", { tool: "recall", args: { query: "hi there", role: "assistant" } });
    const found = data(s.lastToolResult().text) as {
      search: { total: number; offset: number; hits: { id: string }[] };
    };
    assert.deepEqual([found.search.total, found.search.offset, found.search.hits[0]!.id], [1, 0, String(greetingSeq)]);

    // Hints for permission extensions: recall only reads; compaction only adds entries.
    const hints = (name: string) => s.session.getAllTools().find((t) => t.name === name)?.annotations;
    assert.deepEqual(hints("recall"), { readOnlyHint: true, openWorldHint: false });
    assert.equal(hints("compact_in_place")?.destructiveHint, false);
  } finally {
    s.dispose();
  }
});
