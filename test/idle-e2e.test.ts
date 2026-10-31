// End-to-end: idle compaction in a pi session with the faux model. Idle
// minutes are fractions here (0.002 minutes = 120ms).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { RECORD_TYPE } from "../extensions/percy/branch.ts";
import { NUDGE_TYPE } from "../extensions/percy/types.ts";
import { dump, type Harness, startHarness } from "./harness.ts";

const IDLE = { minutes: 0.002, minTokens: 1 };
const RESUMED_IDLE = { minutes: 0.01, minTokens: 1 };

async function until(cond: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const idleNudges = (h: Harness) =>
  h.session.sessionManager
    .getBranch()
    .filter(
      (e: SessionEntry) =>
        e.type === "custom_message" && e.customType === NUDGE_TYPE && (e.details as { idle?: boolean })?.idle === true,
    );

const records = (h: Harness) =>
  h.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === RECORD_TYPE);

function lastText(messages: Message[]): string {
  const m = messages[messages.length - 1];
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

/** Answers the idle nudge by trimming the echo output listed in its index. */
function compactOnIdle(messages: Message[]) {
  const text = lastText(messages);
  if (!text.includes("has been idle")) return undefined;
  const row = text.split("\n").find((l) => /\becho "/.test(l) && !l.includes("→ trimmed"));
  if (!row) return "Nothing to compact.";
  return { tool: "compact_in_place", args: { action: "compact", trim: [row.split(/\s+/)[0]!] } };
}

test("an idle conversation gets one compaction turn", async () => {
  const h = await startHarness(
    { limits: { keepRecentTokens: 1 }, nudge: { at: 1e9 }, idle: IDLE, minCompactionSavingsTokens: 0 },
    { respond: compactOnIdle },
  );
  try {
    await h.send("hello");
    await h.call("echo", { text: "OUTPUT ", times: 300 });
    await until(() => records(h).length === 1 && h.session.isIdle, "the idle compaction");
    assert.equal(idleNudges(h).length, 1);

    // The idle turn compacted, and the compaction hid its nudge.
    const request = dump(h.requests[h.requests.length - 1]!).join("\n");
    assert.ok(!request.includes("has been idle"), request);
    assert.ok(request.includes("[Tool output compacted"), request);

    // Its end does not arm another one.
    await sleep(400);
    assert.equal(idleNudges(h).length, 1, "the idle turn re-armed idle compaction");

    // New input does.
    await h.send("back");
    await until(() => idleNudges(h).length === 2 && h.session.isIdle, "the second idle nudge");
  } finally {
    h.dispose();
  }
});

test("a resumed session waits a fresh idle interval", async () => {
  const first = await startHarness({ limits: { keepRecentTokens: 1 }, nudge: { at: 1e9 }, idle: { minutes: 0 } });
  let manager: SessionManager | undefined;
  try {
    await first.send("hello");
    await first.call("echo", { text: "OUTPUT ", times: 300 });
    // Simulate a session loaded with a persisted system-prompt delta after an
    // assistant response. The idle custom turn must not send it mid-history.
    first.session.sessionManager.appendMessage({
      role: "system",
      content: "Changed system prompt.",
      timestamp: Date.now(),
    });
    const old = new Date(Date.now() - 60_000).toISOString();
    for (const entry of first.session.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role !== "system") entry.timestamp = old;
    }
    manager = first.session.sessionManager;
  } finally {
    first.dispose();
  }

  if (!manager) throw new Error("the initial session did not create a session manager");
  const resumed = await startHarness(
    { limits: { keepRecentTokens: 1 }, nudge: { at: 1e9 }, idle: RESUMED_IDLE },
    { sessionManager: manager },
  );
  try {
    await sleep(100);
    assert.equal(idleNudges(resumed).length, 0, "the old session started compaction immediately");
    await until(() => idleNudges(resumed).length === 1 && resumed.session.isIdle, "the resumed idle compaction turn");
    assert.equal(resumed.requests.length, 1);
    const request = resumed.requests[0]!;
    assert.equal(request[0]?.role, "system");
    assert.equal(request.filter((message) => message.role === "system").length, 1);
  } finally {
    resumed.dispose();
  }
});

test("a small context gets no idle compaction turn", async () => {
  const h = await startHarness({ limits: { keepRecentTokens: 1 }, idle: { ...IDLE, minTokens: 1_000_000 } });
  try {
    await h.send("hello");
    await sleep(400);
    assert.equal(idleNudges(h).length, 0);
    assert.equal(h.requests.length, 1);
  } finally {
    h.dispose();
  }
});

test("no idle compaction while compact_in_place is off", async () => {
  const h = await startHarness({ limits: { keepRecentTokens: 1 }, idle: IDLE });
  try {
    h.session.setActiveToolsByName(["echo", "recall"]);
    await h.send("hello");
    await h.send("again");
    await sleep(400);
    assert.equal(idleNudges(h).length, 0);
  } finally {
    h.dispose();
  }
});

test("a new run replaces the pending idle compaction", async () => {
  const h = await startHarness({ limits: { keepRecentTokens: 1 }, idle: { ...IDLE, minutes: 0.005 } }); // 300ms
  try {
    await h.send("hello");
    await sleep(150);
    // Input arrives before the timer fires; the run it starts is busy
    // when the old timer would have fired, and settles later.
    await h.send("again");
    const requests = h.requests.length;
    await sleep(200);
    assert.equal(idleNudges(h).length, 0, "the first timer fired");
    await until(() => idleNudges(h).length === 1 && h.session.isIdle, "the re-armed idle nudge");
    assert.ok(h.requests.length > requests);
  } finally {
    h.dispose();
  }
});
