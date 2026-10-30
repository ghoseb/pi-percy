// End-to-end: pi's own threshold compaction, the safety net, runs on the view
// pi-percy's edits made, and pi-percy keeps working after it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startHarness } from "./harness.ts";

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
    await h.call("recall", { ids: [resultSeq] });
    assert.ok(h.lastToolResult().text.includes("A".repeat(20)), h.lastToolResult().text);
  } finally {
    h.dispose();
  }
});
