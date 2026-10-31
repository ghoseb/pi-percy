// End-to-end: the commands, and nudge settings changing between runs of a
// session.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { isNudgeEntry, isRecordEntry } from "../extensions/percy/branch.ts";
import { COMPACT_REQUEST } from "../extensions/percy/commands.ts";
import type { IndexEntry } from "../extensions/percy/debug.ts";
import { noteText } from "../extensions/percy/messages.ts";
import {
  COMPACT_COMMAND,
  DEBUG_COMMAND,
  REWIND_COMMAND,
  STATUS_COMMAND,
  TOGGLE_COMMAND,
} from "../extensions/percy/types.ts";
import { anthropicRequestWire, misplacedSystemMessages } from "./anthropic-wire.ts";
import { dump, GREETING, type Harness, startHarness } from "./harness.ts";

const ofType = (h: Harness, type: string, customType: string) =>
  h.session.sessionManager
    .getBranch()
    .filter((e: SessionEntry) => e.type === type && "customType" in e && e.customType === customType);

const records = (h: Harness) => h.session.sessionManager.getBranch().filter(isRecordEntry);

const lastRequest = (h: Harness) => dump(h.requests[h.requests.length - 1]!).join("\n");

async function until(cond: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("/percy:compact-in-place asks the agent to compact without changing tools", async () => {
  const h = await startHarness();
  try {
    await h.send("hello");
    // A pi-percy command must also send a valid request when a loaded
    // session has a system prompt delta after an assistant message.
    h.session.sessionManager.appendMessage({
      role: "system",
      content: "Changed system prompt.",
      timestamp: Date.now(),
    });
    await h.send(`/${COMPACT_COMMAND} keep the plan`);
    // The command sends the request; its run starts after the command returns.
    await until(() => h.requests.length === 2 && h.session.isIdle, "the request's run");
    assert.ok(h.session.getActiveToolNames().includes("compact_in_place"));
    assert.ok(lastRequest(h).includes(`user: ${COMPACT_REQUEST}\n\nkeep the plan`), lastRequest(h));
    assert.deepEqual(misplacedSystemMessages(await anthropicRequestWire(h.requests[1]!)), []);
  } finally {
    h.dispose();
  }
});

test("/percy:toggle-compaction controls compaction for this session", async () => {
  const h = await startHarness();
  try {
    assert.ok(h.session.getActiveToolNames().includes("compact_in_place"));
    await h.send(`/${TOGGLE_COMMAND}`);
    assert.ok(h.session.getActiveToolNames().includes("compact_in_place"));
    assert.match(h.notifications.at(-1)?.message ?? "", /compaction disabled/);

    await h.send(`/${TOGGLE_COMMAND}`);
    assert.ok(h.session.getActiveToolNames().includes("compact_in_place"));
    assert.match(h.notifications.at(-1)?.message ?? "", /compaction enabled/);
  } finally {
    h.dispose();
  }
});

test("/percy:status reports state without a model request", async () => {
  const h = await startHarness({ idle: { minutes: 1, minTokens: 1 } });
  try {
    await h.send("hello");
    const requests = h.requests.length;
    await h.send(`/${STATUS_COMMAND}`);
    assert.equal(h.requests.length, requests);
    const status = h.notifications.at(-1)?.message ?? "";
    assert.match(status, /pi-percy: enabled/);
    assert.match(status, /history: ~\d+ tokens/);
    assert.match(status, /idle: armed; fires in ~\d+m/);
  } finally {
    h.dispose();
  }
});

test("a /tree jump into the middle of a compaction is cancelled", async () => {
  const h = await startHarness({ limits: { keepRecentTokens: 1 } });
  try {
    await h.call("echo", { text: "word ", times: 400 });
    await h.send("hello");
    const branch = h.session.sessionManager.getBranch();
    const seqOf = (match: (e: SessionEntry) => boolean) => String(branch.findIndex(match) + 1);
    const greeting = seqOf((e) => JSON.stringify(e).includes(GREETING));
    // Trim the echo call's output, and collapse the greeting: several edits.
    await h.call("compact_in_place", {
      action: "compact",
      trim: [seqOf((e) => e.type === "message" && e.message.role === "assistant")],
      collapse: [{ from: greeting, to: greeting, note: "greeted" }],
    });
    assert.equal(h.lastToolResult().isError, false, h.lastToolResult().text);
    const after = h.session.sessionManager.getBranch();
    const record = after.findIndex(isRecordEntry);
    const end = after.findIndex((e, i) => i > record && e.type !== "context_edit");
    const edits = after.slice(record + 1, end < 0 ? undefined : end);
    assert.ok(edits.length >= 2, "a compaction with several edits");
    const leaf = h.session.sessionManager.getLeafId();

    for (const target of [after[record]!, edits[0]!]) {
      const result = await h.session.navigateTree(target.id);
      assert.equal(result.cancelled, true, target.type);
      assert.equal(h.session.sessionManager.getLeafId(), leaf);
    }
    assert.match(h.notifications.at(-1)?.message ?? "", /inside a compaction/);
    assert.equal((await h.session.navigateTree(edits.at(-1)!.id)).cancelled, false, "its last edit");
    assert.equal((await h.session.navigateTree(after[record]!.parentId!)).cancelled, false, "before its record");
  } finally {
    h.dispose();
  }
});

test("/percy:rewind-compaction returns to before the newest compaction without a model request", async () => {
  const h = await startHarness({ limits: { keepRecentTokens: 1 } });
  try {
    await h.send("hello");
    const greeting = h.session.sessionManager
      .getBranch()
      .findIndex((entry) => entry.type === "message" && JSON.stringify(entry.message).includes(GREETING));
    await h.call("compact_in_place", {
      action: "compact",
      collapse: [{ from: String(greeting + 1), to: String(greeting + 1), note: "greeted" }],
    });
    const record = h.session.sessionManager.getBranch().findLast(isRecordEntry);
    assert.ok(record?.parentId, "compaction was not recorded");
    const requests = h.requests.length;

    await h.send(`/${REWIND_COMMAND}`);
    assert.equal(h.session.sessionManager.getLeafId(), record.parentId);
    assert.equal(h.session.sessionManager.getBranch().filter(isRecordEntry).length, 0);
    assert.equal(h.requests.length, requests, "undo must not request a model response");
    assert.match(h.notifications.at(-1)?.message ?? "", /rewound the branch/);
  } finally {
    h.dispose();
  }
});

test("/percy:rewind-compaction leaves the branch unchanged when declined", async () => {
  const h = await startHarness({ limits: { keepRecentTokens: 1 } }, { confirm: false });
  try {
    await h.send("hello");
    const greeting = h.session.sessionManager
      .getBranch()
      .findIndex((entry) => entry.type === "message" && JSON.stringify(entry.message).includes(GREETING));
    await h.call("compact_in_place", {
      action: "compact",
      collapse: [{ from: String(greeting + 1), to: String(greeting + 1), note: "greeted" }],
    });
    const leaf = h.session.sessionManager.getLeafId();
    const requests = h.requests.length;
    await h.send(`/${REWIND_COMMAND}`);
    assert.equal(h.session.sessionManager.getLeafId(), leaf);
    assert.equal(h.requests.length, requests);
  } finally {
    h.dispose();
  }
});

// Port of Shelley's TestCompactDebugEndToEnd, for the parts that differ in pi:
// a command cannot append context edits, so the record applies at the next
// turn boundary.
test("/percy:compact-debug shows the index and records squishes and trims", async () => {
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

    await h.send(`/${DEBUG_COMMAND}`);
    const [index] = ofType(h, "custom", "percy-index");
    assert.ok(index?.type === "custom");
    const data = index.data as IndexEntry;
    assert.ok(data.index.startsWith("## Index"));
    assert.equal(data.rows, data.index.split("```")[1]!.trim().split("\n").length - 1);

    // Invalid requests record nothing.
    await h.send(`/${DEBUG_COMMAND} trim nope`);
    await h.send(`/${DEBUG_COMMAND} squish ${callSeq}-${callSeq} x`);
    await h.send(`/${DEBUG_COMMAND} squish nope`);

    await h.send(`/${DEBUG_COMMAND} trim ${callSeq}`);
    await h.send(`/${DEBUG_COMMAND} squish ${greetingSeq}-${greetingSeq} The user  said hello.`);
    assert.equal(records(h).length, 0, "applied before a turn boundary");
    await h.send("first");
    const recorded = records(h);
    assert.equal(recorded.length, 2);
    assert.equal(recorded[1]!.data?.squishes[0]?.summary, "The user  said hello.");

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
      return h.session.sessionManager.getBranch().filter((e) => isNudgeEntry(e)).length;
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

// A tool change is a system prompt change, which pi records as a system
// message mid-conversation. pi-percy's nudges, compactions, idle turns and
// commands must leave the prompt the session started with.
test("pi-percy never changes the system prompt or the tools", async () => {
  const h = await startHarness({
    limits: { keepRecentTokens: 1 },
    nudge: { at: 1, step: 1 },
    idle: { minutes: 0.002, minTokens: 1 },
  });
  try {
    await h.send("hello");
    await h.call("echo", { text: "OUTPUT ", times: 300 });
    await h.send(`/${TOGGLE_COMMAND}`);
    await h.send(`/${TOGGLE_COMMAND}`);
    const before = h.requests.length;
    await h.send(`/${COMPACT_COMMAND}`);
    await until(() => h.requests.length > before && h.session.isIdle, "the compact request's run");
    // The call's message number (1-based) is the result's 0-based index.
    const callSeq = h.session.sessionManager
      .getBranch()
      .findIndex((e: SessionEntry) => e.type === "message" && e.message.role === "toolResult");
    await h.call("compact_in_place", { action: "compact", trim: [String(callSeq)] });
    assert.equal(h.lastToolResult().isError, false, h.lastToolResult().text);
    await until(
      () => h.session.sessionManager.getBranch().some((e) => isNudgeEntry(e, "idle")),
      "an idle compaction turn",
    );
    await until(() => h.session.isIdle, "the idle run");
    assert.ok(records(h).length >= 1, "a compaction applied");
    const systems = h.session.sessionManager
      .getBranch()
      .filter((e: SessionEntry) => e.type === "message" && e.message.role === "system");
    assert.equal(systems.length, 1, "only the initial system message");
    for (const request of h.requests) assert.equal(request.filter((m) => m.role === "system").length, 1);
  } finally {
    h.dispose();
  }
});
