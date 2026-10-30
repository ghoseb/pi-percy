// End-to-end: context-size nudges in a pi session with the faux model, whose
// usage pi-ai estimates from the request (about 900 tokens for a short one).
import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateContextTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { NUDGE_TYPE } from "../extensions/percy/types.ts";
import { dump, type Harness, startHarness } from "./harness.ts";

const nudges = (h: Harness) =>
  h.session.sessionManager
    .getBranch()
    .filter(
      (e): e is Extract<SessionEntry, { type: "custom_message" }> =>
        e.type === "custom_message" && e.customType === NUDGE_TYPE,
    );

const nudgeText = (e: Extract<SessionEntry, { type: "custom_message" }>) =>
  typeof e.content === "string" ? e.content : e.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

/** Context sizes the responses on the branch report, oldest first. */
const responseSizes = (h: Harness) =>
  h.session.sessionManager
    .getBranch()
    .flatMap((e) =>
      e.type === "message" && e.message.role === "assistant" ? [calculateContextTokens(e.message.usage)] : [],
    );

const lastRequest = (h: Harness) => dump(h.requests[h.requests.length - 1]!).join("\n");

// Port of Shelley's TestCompactInPlaceNudge.
test("the agent is nudged once at the threshold, with the index", async () => {
  const h = await startHarness({ limits: { keepRecentTokens: 1 }, nudge: { at: 500, step: 1_000_000 } });
  try {
    await h.send("hello");
    // The nudge after a final reply waits for the next request: no extra call.
    assert.equal(h.requests.length, 1);
    const [nudge] = nudges(h);
    assert.ok(nudge, "no nudge");
    const content = nudge.content as { type: string; text: string }[];
    assert.match(content[0]!.text, /^Context is \d+k\.$/);
    assert.ok(content[1]!.text.startsWith("## Index") && content[1]!.text.includes('text "hello"'), content[1]!.text);

    await h.send("two");
    const request = lastRequest(h);
    assert.ok(request.includes("Context is") && request.includes("## Index"), request);
    assert.equal(nudges(h).length, 1, "nudged again below the next step");

    // The agent can compact from the nudge's index, and the compaction hides
    // the nudge from the model.
    const row = nudgeText(nudge)
      .split("\n")
      .find((l) => l.includes('text "hello"'));
    assert.ok(row, nudgeText(nudge));
    const id = row.split(/\s+/)[0]!;
    await h.call("compact_in_place", { action: "compact", collapse: [{ from: id, to: id, note: "h" }] });
    assert.equal(h.lastToolResult().isError, false, h.lastToolResult().text);
    assert.ok(!lastRequest(h).includes("Context is"), lastRequest(h));
    assert.equal(nudges(h).length, 1);
  } finally {
    h.dispose();
  }
});

test("no nudge right after a compaction; dropping below a level re-arms it", async () => {
  // Every response that grows the context crosses a level.
  const h = await startHarness({ limits: { keepRecentTokens: 1 }, nudge: { at: 1, step: 1 } });
  try {
    await h.send("hello");
    await h.call("echo", { text: "x".repeat(8000) });
    const before = nudges(h).length;
    assert.equal(before, 3, "one nudge per growing response");

    // The call's message number (1-based) is the result's 0-based index.
    const callSeq = h.session.sessionManager
      .getBranch()
      .findIndex((e) => e.type === "message" && e.message.role === "toolResult");
    await h.call("compact_in_place", { action: "compact", trim: [String(callSeq)] });
    assert.equal(h.lastToolResult().isError, false, h.lastToolResult().text);
    // The compact call's response grew the context, but its size is from
    // before the compaction; the response after it is smaller.
    const sizes = responseSizes(h);
    assert.ok(sizes[sizes.length - 1]! < sizes[sizes.length - 2]!, `sizes ${sizes.join(", ")}`);
    assert.equal(nudges(h).length, before, "nudged around the compaction");

    await h.send("more");
    assert.equal(nudges(h).length, before + 1, "not re-armed");
  } finally {
    h.dispose();
  }
});

test("no nudges while compact_in_place is off", async () => {
  const h = await startHarness({ nudge: { at: 1, step: 1 } });
  try {
    h.session.setActiveToolsByName(["echo", "recall"]);
    await h.send("hello");
    await h.send("again");
    assert.equal(nudges(h).length, 0);
  } finally {
    h.dispose();
  }
});
