// End-to-end: pi's own threshold compaction, the safety net, runs on the view
// pi-percy's edits made, and pi-percy keeps working after it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isNudgeEntry } from "../extensions/percy/branch.ts";
import { dump, startHarness } from "./harness.ts";

test("pi's compaction summarizes the compacted view", async () => {
  // pi compacts above 12k - 2k = 10k tokens of context.
  const h = await startHarness(
    { limits: { keepRecentTokens: 1 }, nudge: { at: 1e9 } },
    { contextWindow: 12_000, settings: { compaction: { reserveTokens: 2_000, keepRecentTokens: 500 } } },
  );
  try {
    await h.send("hello");
    await h.call("echo", { text: "AAAAAAAAAA", times: 1200 }); // ~3k tokens of output
    const branch = () => h.session.sessionManager.getBranch();
    // Message numbers are 1-based branch positions: the call is the entry
    // before the result.
    const resultSeq = branch().findIndex((e) => e.type === "message" && e.message.role === "toolResult") + 1;
    await h.call("compact_in_place", { action: "compact", trim: [String(resultSeq - 1)] });
    assert.equal(h.lastToolResult().isError, false, h.lastToolResult().text);
    for (const c of "BCD") await h.call("echo", { text: c.repeat(10), times: 1200 });

    assert.ok(
      branch().some((e) => e.type === "compaction"),
      "pi did not compact",
    );
    const summaryRequest = h.requests.find((r) => {
      const system = r[0];
      return system?.role === "system" && JSON.stringify(system.content).includes("context summarization assistant");
    });
    assert.ok(summaryRequest, "no summarization request");
    const sent = JSON.stringify(summaryRequest);
    assert.ok(sent.includes(`[Tool output compacted: message ${resultSeq}`), "summary lacks the trimmed placeholder");
    assert.ok(!sent.includes("A".repeat(20)), "summary saw the trimmed output");

    // pi-percy works on the view after pi's compaction, and recall still
    // reaches the original.
    await h.call("compact_in_place", { action: "index" });
    assert.equal(h.lastToolResult().isError, false, h.lastToolResult().text);
    // The index says which messages pi's summary replaced.
    const compaction = branch().find((e) => e.type === "compaction")!;
    const firstKept =
      branch().findIndex((e) => e.id === (compaction as { firstKeptEntryId: string }).firstKeptEntryId) + 1;
    assert.ok(
      h.lastToolResult().text.includes(`pi summary of messages 1-${firstKept - 1} (recall them for details)`),
      h.lastToolResult().text,
    );
    await h.call("recall", { ids: [resultSeq] });
    assert.ok(h.lastToolResult().text.includes("A".repeat(20)), h.lastToolResult().text);
  } finally {
    h.dispose();
  }
});

// pi's compaction keeps recent messages, which can hold a nudge whose index
// names the history pi then summarized. Its ids are wrong now: pi-percy leaves
// it out of the index and of every later request.
test("a nudge pi's compaction kept is no longer sent", async () => {
  const h = await startHarness(
    { limits: { keepRecentTokens: 1 }, nudge: { at: 6_000, step: 1e9 } },
    { contextWindow: 12_000, settings: { compaction: { reserveTokens: 2_000, keepRecentTokens: 6_000 } } },
  );
  try {
    const branch = () => h.session.sessionManager.getBranch();
    const compaction = () => branch().findLast((e) => e.type === "compaction");
    await h.send("hello");
    for (const c of "ABCDEF") {
      if (compaction()) break;
      await h.call("echo", { text: c.repeat(10), times: 1200 });
    }
    const pi = compaction();
    assert.ok(pi && pi.type === "compaction", "pi did not compact");
    const at = branch().indexOf(pi);
    const kept = branch().findIndex((e) => e.id === pi.firstKeptEntryId);
    const nudge = branch().findIndex((e, i) => i >= kept && i < at && isNudgeEntry(e));
    assert.ok(nudge >= 0, "pi's compaction kept no nudge");
    const before = h.requests.length;
    assert.ok(
      h.requests.some((r) => dump(r).join("\n").includes("Context is")),
      "the nudge was not sent before",
    );

    await h.call("compact_in_place", { action: "index" });
    const index = h.lastToolResult().text;
    assert.ok(!new RegExp(`^${nudge + 1} +custom`, "m").test(index), index);
    const after = h.requests.slice(before);
    assert.ok(after.length > 0);
    for (const r of after) assert.ok(!dump(r).join("\n").includes("Context is"), "the stale nudge was sent again");
  } finally {
    h.dispose();
  }
});
