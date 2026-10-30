// End-to-end: the commands, and nudge settings changing between runs of a
// session.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { RECORD_TYPE } from "../extensions/percy/branch.ts";
import { COMPACT_REQUEST } from "../extensions/percy/index.ts";
import { noteText } from "../extensions/percy/messages.ts";
import { NUDGE_TYPE } from "../extensions/percy/types.ts";
import { dump, GREETING, type Harness, startHarness } from "./harness.ts";

const ofType = (h: Harness, type: string, customType: string) =>
  h.session.sessionManager
    .getBranch()
    .filter((e: SessionEntry) => e.type === type && "customType" in e && e.customType === customType);

const lastRequest = (h: Harness) => dump(h.requests[h.requests.length - 1]!).join("\n");

async function until(cond: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("/compact-in-place asks the agent to compact, turning the tool on", async () => {
  const h = await startHarness();
  try {
    h.session.setActiveToolsByName(["echo", "recall"]);
    await h.send("hello");
    await h.send("/compact-in-place keep the plan");
    // The command sends the request; its run starts after the command returns.
    await until(() => h.requests.length === 2 && h.session.isIdle, "the request's run");
    assert.ok(h.session.getActiveToolNames().includes("compact_in_place"));
    assert.ok(lastRequest(h).includes(`user: ${COMPACT_REQUEST}\n\nkeep the plan`), lastRequest(h));
  } finally {
    h.dispose();
  }
});

// Port of Shelley's TestCompactDebugEndToEnd, for the parts that differ in pi:
// a command cannot append context edits, so the record applies at the next
// turn boundary.
test("/compact-debug shows the index and records squishes and trims", async () => {
  const h = await startHarness({ limits: { keepRecentTokens: 1 } });
  try {
    await h.send("hello");
    await h.call("echo", { text: "compact-me-please" });
    const branch = h.session.sessionManager.getBranch();
    const seq = (match: (e: SessionEntry) => boolean) => branch.findIndex(match) + 1;
    const greetingSeq = seq((e) => e.type === "message" && JSON.stringify(e.message).includes("Well, hi there!"));
    const callSeq = seq(
      (e) => e.type === "message" && e.message.role === "assistant" && JSON.stringify(e.message).includes("toolCall"),
    );

    await h.send("/compact-debug");
    const [index] = ofType(h, "custom", "percy-index");
    assert.ok(index?.type === "custom" && (index.data as { index: string }).index.startsWith("## Index"));

    // Invalid requests record nothing.
    await h.send("/compact-debug trim nope");
    await h.send(`/compact-debug squish ${callSeq}-${callSeq} x`);
    await h.send("/compact-debug squish nope");

    await h.send(`/compact-debug trim ${callSeq}`);
    await h.send(`/compact-debug squish ${greetingSeq}-${greetingSeq} The user  said hello.`);
    assert.equal(ofType(h, "custom", RECORD_TYPE).length, 0, "applied before a turn boundary");
    await h.send("first");
    const records = ofType(h, "custom", RECORD_TYPE);
    assert.equal(records.length, 2);
    const squish = records[1]!.type === "custom" ? (records[1].data as { squishes: { summary: string }[] }) : undefined;
    assert.equal(squish?.squishes[0]?.summary, "The user  said hello.");

    await h.send("second");
    const request = lastRequest(h);
    assert.ok(request.includes(noteText(greetingSeq, greetingSeq, "The user  said hello.")), request);
    assert.ok(!request.includes(GREETING), request);
    assert.ok(request.includes("[Tool output compacted"), request);
  } finally {
    h.dispose();
  }
});

// Port of Shelley's TestCompactInPlaceNudgeThresholdChange: a session resumed
// under new nudge settings is nudged once if it is past the new threshold.
test("changing the nudge threshold nudges once at the new threshold", async () => {
  const off = { at: 1e9, step: 1e6 };
  const low = { at: 500, step: 1e6 }; // a short exchange is ~900 tokens
  let sm: SessionManager | undefined;
  const run = async (nudge: typeof off, prompts: string[]) => {
    const h = await startHarness({ nudge }, sm === undefined ? {} : { sessionManager: sm });
    sm = h.session.sessionManager;
    try {
      for (const p of prompts) await h.send(p);
      return ofType(h, "custom_message", NUDGE_TYPE).length;
    } finally {
      h.dispose();
    }
  };
  assert.equal(await run(off, ["hello", "two"]), 0);
  assert.equal(await run(low, ["lowered"]), 1, "lowering the threshold did not nudge");
  assert.equal(await run(low, ["again", "and again"]), 1, "nudged again at the same level");
  assert.equal(await run(off, ["raised"]), 1, "nudged below a raised threshold");
  assert.equal(await run(low, ["lowered again"]), 2, "lowering again did not nudge");
});
