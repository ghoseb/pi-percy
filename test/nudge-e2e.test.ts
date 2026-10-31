// End-to-end: context-size nudges in a pi session with the faux model, whose
// usage pi-ai estimates from the request (about 900 tokens for a short one).
import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateContextTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { NUDGE_TYPE, TOGGLE_COMMAND } from "../extensions/percy/types.ts";
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

/** Roles and nudges on the branch, in order: "user:<text>", "assistant", "nudge", ... */
const order = (h: Harness) =>
  h.session.sessionManager.getBranch().flatMap((e) => {
    if (e.type === "custom_message" && e.customType === NUDGE_TYPE) return ["nudge"];
    if (e.type !== "message" || e.message.role === "system") return [];
    return [e.message.role === "user" ? `user:${dump([e.message])[0]!.slice(6, 30)}` : e.message.role];
  });

// Port of Shelley's TestCompactInPlaceNudge.
test("the agent is nudged once at the threshold, with the index", async () => {
  const h = await startHarness({ limits: { keepRecentTokens: 1 }, nudge: { at: 500, step: 1_000_000 } });
  try {
    await h.send("hello");
    // The nudge is taken before the next request: none yet, and no extra call.
    assert.equal(h.requests.length, 1);
    assert.equal(nudges(h).length, 0);
    const size = responseSizes(h).at(-1)!;

    await h.send("two");
    const [nudge] = nudges(h);
    assert.ok(nudge, "no nudge");
    const content = nudge.content as { type: string; text: string }[];
    assert.equal(content[0]!.text, `Context is ${Math.floor((size + 5000) / 10000) * 10}k.`);
    assert.ok(content[1]!.text.startsWith("## Index") && content[1]!.text.includes('text "hello"'), content[1]!.text);
    // As Shelley injects it: after the prompt, sent with its request.
    assert.deepEqual(order(h), ["user:hello", "assistant", "user:two", "nudge", "assistant"]);
    const request = lastRequest(h);
    assert.ok(request.includes("Context is") && request.includes("## Index"), request);

    await h.send("three");
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

test("a nudge follows a tool batch within the run", async () => {
  const h = await startHarness({ nudge: { at: 1, step: 1_000_000 } });
  try {
    await h.call("echo", { text: "x" });
    // The first response (the call) crosses the threshold; its nudge goes
    // with the tool result, before the run's next request.
    assert.deepEqual(order(h), ['user:call echo {"text":"x"}', "assistant", "toolResult", "nudge", "assistant"]);
    assert.ok(dump(h.requests[1]!).join("\n").includes("Context is"));
  } finally {
    h.dispose();
  }
});

test("a nudge due while a message is queued waits for the next request", async () => {
  let steered = false;
  const h: Harness = await startHarness(
    // One level: the reply to hello is below it, the call's response above.
    { nudge: { at: 1_500, step: 1_000_000 } },
    {
      // Steers while the call's request is in flight; answers it with a call.
      respond: async (messages) => {
        const last = dump([messages[messages.length - 1]!])[0]!;
        if (!steered && last.includes("call echo")) {
          steered = true;
          await h.session.steer("steered");
          return undefined;
        }
        if (last.includes("steered")) return { tool: "echo", args: { text: "y" } };
        return undefined;
      },
    },
  );
  try {
    await h.send("hello");
    await h.call("echo", { text: "x".repeat(4000) });
    const [hello, call, again] = responseSizes(h);
    assert.ok(hello! < 1_500 && call! >= 1_500 && again! >= call!, `sizes ${responseSizes(h).join(", ")}`);
    // The call's response crossed the level while "steered" was queued.
    // Shelley sends queued messages before the nudge; pi adds them after the
    // turn's entries, so the nudge waits for the next batch's request rather
    // than go between the tool result and the steered message.
    assert.deepEqual(order(h).slice(2), [
      'user:call echo {"text":"xxxxx',
      "assistant",
      "toolResult",
      "user:steered",
      "assistant",
      "toolResult",
      "nudge",
      "assistant",
    ]);
  } finally {
    h.dispose();
  }
});

test("no nudge right after a compaction; dropping below a level re-arms it", async () => {
  // Every response that grows the context crosses a level.
  const h = await startHarness({ limits: { keepRecentTokens: 1 }, nudge: { at: 1, step: 1 } });
  try {
    await h.send("hello");
    assert.equal(nudges(h).length, 0);
    await h.call("echo", { text: "x".repeat(8000) });
    // One with the prompt (for the reply to hello), one with the tool result.
    assert.equal(nudges(h).length, 2);

    // The call's message number (1-based) is the result's 0-based index.
    const callSeq = h.session.sessionManager
      .getBranch()
      .findIndex((e) => e.type === "message" && e.message.role === "toolResult");
    await h.call("compact_in_place", { action: "compact", trim: [String(callSeq)] });
    assert.equal(h.lastToolResult().isError, false, h.lastToolResult().text);
    // One with the prompt. The compact call's response grew the context, but
    // its size is from before the compaction: none with its result.
    assert.equal(nudges(h).length, 3, "nudged around the compaction");
    const sizes = responseSizes(h);
    assert.ok(sizes[sizes.length - 1]! < sizes[sizes.length - 2]!, `sizes ${sizes.join(", ")}`);

    // The reply after the compaction is below the level of the last decision.
    await h.send("more");
    assert.equal(nudges(h).length, 3, "nudged below the level");
    // Growing again from there crosses a level.
    await h.send("again");
    assert.equal(nudges(h).length, 4, "not re-armed");
  } finally {
    h.dispose();
  }
});

test("no nudges while compaction is toggled off", async () => {
  const h = await startHarness({ nudge: { at: 1, step: 1 } });
  try {
    await h.send(`/${TOGGLE_COMMAND}`);
    assert.ok(h.session.getActiveToolNames().includes("compact_in_place"));
    await h.send("hello");
    await h.send("again");
    assert.equal(nudges(h).length, 0);
  } finally {
    h.dispose();
  }
});

test("no nudges while compact_in_place is not active", async () => {
  const h = await startHarness({ nudge: { at: 1, step: 1 } });
  try {
    h.session.setActiveToolsByName(["echo", "recall"]);
    await h.send("hello");
    await h.send("again");
    assert.equal(nudges(h).length, 0);
    // pi-percy does not turn its tool back on.
    assert.ok(!h.session.getActiveToolNames().includes("compact_in_place"));
  } finally {
    h.dispose();
  }
});
