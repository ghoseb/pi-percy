// Model-based property test: random sequences of what can happen in a pi
// session with pi-percy (prompts, tool batches, provider errors, aborts,
// external tool and prompt changes, toggles, idle runs, compactions, recall,
// messages queued or steered while a run is going, resume, reload, /tree
// jumps with and without branch summaries, and pi's own compaction: manual,
// at its threshold, and after a context overflow) on a real session with the
// faux model. After
// every action, the session must be consistent: what pi would send next and
// every request it sent are valid for Anthropic, pi-percy changed neither the
// tools nor the system prompt, the session file resumes to the same context,
// and pi-percy's records, nudges, and idle runs keep their rules.
//
// PERCY_PBT_RUNS sets the number of runs (default 1000, about 30s); PERCY_PBT_SEED replays
// a seed, and PERCY_PBT_ACTIONS (a JSON counterexample) one sequence.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionFactory,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import fc from "fast-check";
import { Type } from "typebox";
import { branchView, isNudgeEntry, isRecordEntry, type StoredCompaction } from "../extensions/percy/branch.ts";
import type { Timers } from "../extensions/percy/index.ts";
import { resolveIds } from "../extensions/percy/recall.ts";
import { TOGGLE_COMMAND } from "../extensions/percy/types.ts";
import { systemBoundaryViolations } from "../extensions/percy/view.ts";
import { anthropicRequestWire, anthropicWire, misplacedSystemMessages, type WireMessage } from "./anthropic-wire.ts";
import { type Harness, startHarness } from "./harness.ts";

/** Counts of what the runs exercised, printed with PERCY_PBT_STATS. */
const stats = new Map<string, number>();
const count = (what: string, n = 1) => stats.set(what, (stats.get(what) ?? 0) + n);

const RUNS = Number(process.env["PERCY_PBT_RUNS"] ?? 1000);
const SEED = process.env["PERCY_PBT_SEED"] === undefined ? undefined : Number(process.env["PERCY_PBT_SEED"]);

/** How the agent answers a nudge or a compaction prompt. */
type Answer = "valid" | "invalid" | "ignore";

/**
 * What happens while a run is going: a user message steered or queued as a
 * follow-up, an extension's custom message delivered either way, an external
 * tool change, or the toggle command.
 */
type QueueMode = "steer" | "followUp" | "customSteer" | "customFollowUp" | "externalTools" | "toggle";

type Action =
  | { kind: "prompt"; text: "hello" | "more" }
  | { kind: "tools"; sizes: number[] }
  | { kind: "fail" }
  | { kind: "abort" }
  | { kind: "externalTools" }
  | { kind: "externalPrompt" }
  | { kind: "toggle" }
  | { kind: "idle"; answer: Answer; seed: number }
  | { kind: "compact"; answer: Answer; seed: number }
  | { kind: "recall"; seed: number }
  | { kind: "resume" }
  | { kind: "reload" }
  | { kind: "tree"; seed: number; summarize: boolean }
  | { kind: "queue"; modes: QueueMode[]; during: "tool" | "model" }
  | { kind: "piCompact" }
  | { kind: "overflow" };

const answer = fc.constantFrom<Answer>("valid", "valid", "invalid", "ignore");
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("prompt"), text: fc.constantFrom("hello", "more") }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("tools"),
      // Big outputs take the context past pi's compaction threshold.
      sizes: fc.array(fc.oneof(fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1000, max: 4000 })), {
        minLength: 1,
        maxLength: 3,
      }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("fail") }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("abort") }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("externalTools") }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("externalPrompt") }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("toggle") }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("idle"), answer, seed: fc.nat() }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("compact"), answer, seed: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("recall"), seed: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("resume") }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("reload") }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("tree"), seed: fc.nat(), summarize: fc.boolean() }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("queue"),
      modes: fc.array(
        fc.constantFrom<QueueMode>("steer", "followUp", "customSteer", "customFollowUp", "externalTools", "toggle"),
        { minLength: 1, maxLength: 3 },
      ),
      during: fc.constantFrom("tool", "model"),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("piCompact") }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("overflow") }) },
);

/** State outside the session that survives resume: the user's setup. */
interface World {
  dir: string;
  sessionDir: string;
  external: { section: boolean };
  timer: { callback: () => void } | undefined;
  /** How the agent answers the next idle nudge, and the seed for its choice. */
  idleAnswer: { answer: Answer; seed: number };
  /** The running harness, for queueing into its session. */
  h: Harness | undefined;
  /** What to queue during the next model request. */
  queueOnRequest: QueueMode[] | undefined;
  /** Whether the next model request fails with a context overflow. */
  overflow: boolean;
  /** Texts queued so far, each unique. */
  queued: string[];
  /** Where /tree jumps left the leaf: the user chose to continue from there. */
  treeLeaves: Set<string>;
  /** The external extension's API, set when it loads. */
  pi?: ExtensionAPI;
}

/** A tool and a prompt section that someone other than pi-percy changes. */
const externalExtension =
  (world: World): ExtensionFactory =>
  (pi) => {
    pi.registerTool({
      name: "extra",
      label: "Extra",
      description: "An external tool",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "extra" }], details: undefined }),
    });
    pi.registerCommand("ext-tools", {
      description: "Toggle the extra tool",
      handler: () => {
        const active = pi.getActiveTools();
        pi.setActiveTools(active.includes("extra") ? active.filter((t) => t !== "extra") : [...active, "extra"]);
        return Promise.resolve();
      },
    });
    pi.registerCommand("ext-prompt", {
      description: "Toggle the external prompt section",
      handler: () => {
        world.external.section = !world.external.section;
        return Promise.resolve();
      },
    });
    pi.on("before_agent_start", (event) => {
      if (!world.external.section) return;
      event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, external: "Be external." };
    });
    pi.registerTool({
      name: "queue",
      label: "Queue",
      description: "Queue messages while the run is going",
      parameters: Type.Object({ modes: Type.Array(Type.String()) }),
      async execute(_id, params) {
        await queue(world, params.modes as QueueMode[], pi);
        return { content: [{ type: "text", text: "queued" }], details: undefined };
      },
    });
    world.pi = pi;
  };

/** Does what modes say to the running session, as a user or another extension would. */
async function queue(world: World, modes: readonly QueueMode[], pi: ExtensionAPI) {
  const session = world.h!.session;
  for (const mode of modes) {
    const text = `queued ${world.queued.length + 1}`;
    switch (mode) {
      case "steer":
        world.queued.push(text);
        await session.steer(text);
        break;
      case "followUp":
        world.queued.push(text);
        await session.followUp(text);
        break;
      case "customSteer":
      case "customFollowUp":
        world.queued.push(text);
        pi.sendMessage(
          { customType: "external-note", content: text, display: true },
          { deliverAs: mode === "customSteer" ? "steer" : "followUp" },
        );
        break;
      case "externalTools": {
        const active = pi.getActiveTools();
        pi.setActiveTools(active.includes("extra") ? active.filter((t) => t !== "extra") : [...active, "extra"]);
        break;
      }
      case "toggle":
        await session.prompt(`/${TOGGLE_COMMAND}`);
        break;
    }
  }
}

/** The idle timer, fired only by the idle action. */
const manualTimers = (world: World): Timers => ({
  set(callback) {
    const timer = { callback };
    world.timer = timer;
    return () => {
      if (world.timer === timer) world.timer = undefined;
    };
  },
});

// --- The agent: parses an index and picks a compaction, as an agent would.

interface ParsedIndex {
  rows: { id: string; output: boolean }[];
  units: string[];
}

function parseIndex(text: string): ParsedIndex | undefined {
  const table = /```\nid +role +tokens +content\n([\s\S]*?)```/.exec(text);
  if (!table) return undefined;
  const rows = table[1]!
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => ({ id: l.split(/\s+/)[0]!, output: /→ \d+/.test(l) }));
  const units = [...text.matchAll(/^(u\d+): /gm)].map((m) => m[1]!);
  return { rows, units };
}

/** A pseudo-random generator from a seed, for replayable choices. */
function chooser(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
  return {
    pick: <T>(xs: readonly T[]): T | undefined => xs[Math.floor(next() * xs.length)],
    some: <T>(xs: readonly T[]): T[] => xs.filter(() => next() < 0.4),
  };
}

/** The compact_in_place arguments the agent sends for an index, or undefined to not compact. */
function compactArgs(text: string, how: Answer, seed: number): Record<string, unknown> | undefined {
  if (how === "ignore") return undefined;
  const index = parseIndex(text);
  const c = chooser(seed);
  if (how === "invalid") {
    const row = index && c.pick(index.rows);
    return c.pick([
      { action: "compact", collapse: [{ from: "99999", to: "99999", note: "gone" }] },
      { action: "compact", trim: ["s0.0"] },
      ...(row ? [{ action: "compact", collapse: [{ from: row.id, to: row.id, note: "" }] }] : []),
      ...(row ? [{ action: "compact", trim: [row.id, row.id] }] : []),
    ]);
  }
  if (!index) return undefined;
  const trim = c.some(index.rows.filter((r) => r.output).map((r) => r.id));
  const units = c.some(index.units);
  // A row trimmed and also collapsed is a problem: collapse only when not trimming.
  const collapseUnits = trim.length === 0 ? units.map((id) => ({ id, note: `note for ${id}` })) : [];
  if (trim.length === 0 && collapseUnits.length === 0) return undefined;
  return {
    action: "compact",
    ...(trim.length > 0 ? { trim } : {}),
    ...(collapseUnits.length > 0 ? { collapseUnits } : {}),
  };
}

const textOf = (m: Message) =>
  typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

/**
 * Answers a request: queues what world.queueOnRequest says while it is in
 * flight, fails with a context overflow when world.overflow says so, and
 * answers the idle nudge as world.idleAnswer says.
 */
const respond = (world: World) => async (messages: Message[]) => {
  const modes = world.queueOnRequest;
  world.queueOnRequest = undefined;
  if (modes) await queue(world, modes, world.pi!);
  if (world.overflow) {
    world.overflow = false;
    return { error: "prompt is too long: 200000 tokens > 199999 maximum" };
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !textOf(last).includes("has been idle")) return undefined;
  const args = compactArgs(textOf(last), world.idleAnswer.answer, world.idleAnswer.seed);
  return args ? { tool: "compact_in_place", args } : "Nothing to compact.";
};

// --- Invariants.

/** Wire indices of tool calls without their results in the next message. */
function unpairedToolUses(wire: readonly WireMessage[]): string[] {
  const bad: string[] = [];
  wire.forEach((m, i) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return;
    const next = wire[i + 1];
    const results = new Set(
      Array.isArray(next?.content)
        ? (next.content as { type: string; tool_use_id?: string }[])
            .filter((b) => b.type === "tool_result")
            .map((b) => b.tool_use_id)
        : [],
    );
    for (const b of m.content as { type: string; id?: string }[]) {
      if (b.type === "tool_use" && !results.has(b.id)) bad.push(`${i}:${b.id}`);
    }
  });
  return bad;
}

function checkWire(wire: WireMessage[], what: string) {
  assert.deepEqual(misplacedSystemMessages(wire), [], `${what}: a system message Anthropic rejects`);
  assert.deepEqual(unpairedToolUses(wire), [], `${what}: a tool call without its result`);
}

const names = (tools: unknown) => ((tools ?? []) as { name: string }[]).map((t) => t.name);

interface Checked {
  requests: number;
}

async function checkSession(h: Harness, world: World, checked: Checked) {
  assert.deepEqual(h.errors, [], "extension errors");
  assert.deepEqual(
    h.notifications.filter((n) => n.type === "error"),
    [],
    "error notifications",
  );
  const sm = h.session.sessionManager;
  const branch = sm.getBranch();
  const projection = sm.buildSessionProjection();

  // 1. What pi sends next, and every request sent, are valid for Anthropic.
  // Every run starts with a new user or custom message.
  const next: Message = { role: "user", content: [{ type: "text", text: "next" }], timestamp: 0 };
  checkWire(await anthropicWire([...projection.messages, next]), "the next request");
  for (; checked.requests < h.requests.length; checked.requests++) {
    checkWire(await anthropicRequestWire(h.requests[checked.requests]!), `request ${checked.requests}`);
  }

  // 2. pi-percy changes neither the tools nor the system prompt: after the
  // first system message, only the external tool and section change.
  const systems = branch.flatMap((e) => (e.type === "message" && e.message.role === "system" ? [e.message] : []));
  for (const m of systems.slice(1)) {
    const tools = [
      ...names((m as { toolsAdded?: unknown }).toolsAdded),
      ...names((m as { toolsRemoved?: unknown }).toolsRemoved),
    ];
    const sections = Object.keys((m as { sections?: object }).sections ?? {});
    assert.ok(
      tools.every((t) => t === "extra") && sections.every((s) => s === "external"),
      `an unexpected system message: tools ${tools.join(",")} sections ${sections.join(",")}`,
    );
  }

  // 3. The session file resumes to the same context.
  const file = sm.getSessionFile();
  const leaf = sm.getLeafId();
  if (file && leaf && sm.getEntries().some((e) => e.type === "message" && e.message.role === "assistant")) {
    const reopened = SessionManager.open(file, world.sessionDir);
    reopened.branch(leaf);
    // As JSON: the file drops undefined fields.
    const json = (x: unknown) => JSON.parse(JSON.stringify(x)) as unknown;
    assert.deepEqual(
      json(reopened.buildSessionProjection().messages),
      json(projection.messages),
      "the file resumes differently",
    );
  }

  // 4. pi-percy's view: no system message between assistant messages, and
  // every note resolves to the range it summarizes.
  const view = branchView(branch, projection);
  assert.deepEqual(systemBoundaryViolations(view.items, view.systemBoundaries), [], "pi-percy sees a bad boundary");
  for (const it of view.items) {
    if (!it.note) continue;
    assert.deepEqual(resolveIds(view, [it.note.id]), [[it.from, it.to]], `note ${it.note.id}`);
  }

  // 5. Nudges and idle runs: no context nudge between a compaction and the
  // next response, and at most one idle nudge per user message.
  let afterRecord = false;
  let idleSinceUser = 0;
  for (const e of branch) {
    if (isRecordEntry(e)) afterRecord = true;
    if (e.type === "message" && e.message.role === "assistant") afterRecord = false;
    if (e.type === "message" && e.message.role === "user") idleSinceUser = 0;
    if (isNudgeEntry(e, "idle")) idleSinceUser++;
    else if (isNudgeEntry(e, "context")) {
      assert.ok(!afterRecord, `context nudge ${e.id} right after a compaction`);
    }
    assert.ok(idleSinceUser <= 1, "a second idle run without new input");
  }

  // 6. As in Shelley, a context nudge goes in right before a model request:
  // the next message is the model's response, never a user or extension
  // message. pi adds its system deltas and its own compaction right before a
  // request, so those can come between, and a /tree jump to one of them
  // continues the branch from there.
  branch.forEach((e, i) => {
    if (!isNudgeEntry(e, "context")) return;
    const rest = branch.slice(i);
    const n = rest.findIndex(
      (x, k) =>
        k > 0 &&
        ((x.type === "message" && x.message.role !== "system") ||
          x.type === "custom_message" ||
          x.type === "branch_summary"),
    );
    const next = rest[n];
    if (!next || rest.slice(0, n).some((x) => world.treeLeaves.has(x.id))) return;
    const what =
      next.type === "message" ? next.message.role : next.type === "custom_message" ? next.customType : next.type;
    assert.equal(what, "assistant", `context nudge ${e.id} is followed by ${what}, not the model's response`);
  });
}

// --- Running the actions.

const SETTINGS = {
  limits: { keepRecentTokens: 60 },
  nudge: { at: 300, step: 400 },
  idle: { minutes: 1, minTokens: 1 },
};

async function start(world: World, sessionManager: SessionManager): Promise<Harness> {
  world.h = await startHarness(SETTINGS, {
    dir: world.dir,
    sessionManager,
    extensions: [externalExtension(world)],
    timers: manualTimers(world),
    respond: respond(world),
    // pi compacts above 16k - 4k = 12k tokens of context.
    contextWindow: 16_000,
    settings: { retry: { enabled: false }, compaction: { reserveTokens: 4_000, keepRecentTokens: 1_000 } },
  });
  return world.h;
}

const sleep = () => new Promise((r) => setImmediate(r));

async function settle(h: Harness) {
  for (let i = 0; i < 3; i++) {
    await sleep();
    await h.session.waitForIdle();
  }
}

const records = (branch: readonly SessionEntry[]) => branch.filter(isRecordEntry);

/** Runs one action; returns the harness to use next (resume replaces it). */
async function run(h: Harness, world: World, a: Action): Promise<Harness> {
  switch (a.kind) {
    case "prompt":
      await h.send(a.text);
      return h;
    case "tools":
      if (a.sizes.length === 1) await h.call("echo", { text: "word ", times: a.sizes[0] });
      else await h.calls(a.sizes.map((n) => ["echo", { text: "word ", times: n }]));
      return h;
    case "fail":
      await h.send("fail");
      return h;
    case "abort":
      await h.call("stop", {});
      return h;
    case "externalTools":
      await h.send("/ext-tools");
      return h;
    case "externalPrompt":
      await h.send("/ext-prompt");
      return h;
    case "toggle":
      await h.send(`/${TOGGLE_COMMAND}`);
      return h;
    case "idle": {
      world.idleAnswer = { answer: a.answer, seed: a.seed };
      const timer = world.timer;
      world.timer = undefined;
      count(timer ? "idle timer fired" : "idle timer not armed");
      timer?.callback();
      await settle(h);
      return h;
    }
    case "compact": {
      await h.call("compact_in_place", { action: "index" });
      const index = h.lastToolResult().text;
      const args = compactArgs(index, a.answer, a.seed);
      if (!args) return h;
      const before = records(h.session.sessionManager.getBranch()).length;
      await h.call("compact_in_place", args);
      const result = h.lastToolResult();
      const after = records(h.session.sessionManager.getBranch());
      count(result.isError ? "compaction rejected" : "compaction accepted");
      if (result.isError) {
        assert.equal(after.length, before, `a rejected compaction left a record: ${result.text}`);
      } else {
        assert.equal(after.length, before + 1, `an accepted compaction left no record: ${result.text}`);
        const data = (after[after.length - 1] as { data: StoredCompaction }).data;
        assert.ok(data.tokensAfter <= data.tokensBefore, `a compaction grew the context: ${result.text}`);
      }
      return h;
    }
    case "recall": {
      const sm = h.session.sessionManager;
      const view = branchView(sm.getBranch(), sm.buildSessionProjection());
      const notes = view.items.flatMap((it) => (it.note ? [it.note.id] : []));
      const id = chooser(a.seed).pick(notes);
      if (!id) return h;
      await h.call("recall", { ids: [id] });
      count("recalls");
      assert.equal(h.lastToolResult().isError, false, h.lastToolResult().text);
      return h;
    }
    case "resume": {
      const file = h.session.sessionManager.getSessionFile();
      if (!file || !h.session.sessionManager.getEntries().some((e) => e.type === "message")) return h;
      h.dispose();
      world.timer = undefined;
      count("resumes");
      return start(world, SessionManager.open(file, world.sessionDir));
    }
    case "reload":
      await h.session.reload();
      return h;
    case "queue": {
      const from = world.queued.length;
      if (a.during === "tool") await h.call("queue", { modes: a.modes });
      else {
        world.queueOnRequest = a.modes;
        await h.send("more");
      }
      await settle(h);
      // Every queued message reaches the branch, once.
      const texts = h.session.sessionManager
        .getBranch()
        .flatMap((e) =>
          e.type === "message" && e.message.role === "user"
            ? [textOf(e.message)]
            : e.type === "custom_message" && typeof e.content === "string"
              ? [e.content]
              : [],
        );
      for (const text of world.queued.slice(from)) {
        assert.equal(texts.filter((t) => t === text).length, 1, `"${text}" on the branch`);
      }
      count(`queued during the ${a.during}`, world.queued.length - from);
      return h;
    }
    case "piCompact":
      try {
        await h.session.compact();
        count("pi compactions");
      } catch (err) {
        count(`pi compaction refused: ${(err as Error).message.slice(0, 40)}`);
      }
      return h;
    case "overflow": {
      const compactions = () => h.session.sessionManager.getBranch().filter((e) => e.type === "compaction").length;
      const before = compactions();
      world.overflow = true;
      await h.send("more");
      await settle(h);
      count(compactions() > before ? "overflows compacted by pi" : "overflows not compacted");
      return h;
    }
    case "tree": {
      const sm = h.session.sessionManager;
      const target = chooser(a.seed).pick(sm.getEntries().filter((e) => e.id !== sm.getLeafId()));
      if (!target) return h;
      await h.session.navigateTree(target.id, { summarize: a.summarize });
      // With a summary, pi adds it after the point jumped to.
      const leaf = sm.getLeafEntry();
      const at = leaf?.type === "branch_summary" ? leaf.parentId : leaf?.id;
      if (at) world.treeLeaves.add(at);
      count(a.summarize ? "tree jumps with a summary" : "tree jumps");
      return h;
    }
  }
}

// The sequence that corrupted a real session: a tool change while idle, then
// an idle run whose compaction hid its own nudge, leaving the system message
// between two assistant messages.
const ORIGINAL_BUG: Action[] = [
  { kind: "tools", sizes: [300] },
  { kind: "tools", sizes: [300] },
  { kind: "prompt", text: "more" },
  { kind: "externalTools" },
  { kind: "idle", answer: "valid", seed: 1 },
  { kind: "prompt", text: "more" },
];

/** The branch, one line per entry, for PERCY_PBT_DUMP. */
function describeBranch(h: Harness): string {
  const brief = (x: unknown) => JSON.stringify(x)?.slice(0, 100) ?? "";
  return h.session.sessionManager
    .getBranch()
    .map((e) => {
      const what =
        e.type === "message"
          ? `${e.message.role} ${brief((e.message as { content?: unknown }).content)}`
          : e.type === "custom_message"
            ? `${e.customType} ${brief(e.content)}`
            : e.type === "custom"
              ? e.customType
              : e.type === "context_edit"
                ? `-> ${e.targetId} ${brief(e.replacement)}`
                : "";
      return `${e.id} ${e.type} ${what}`;
    })
    .join("\n");
}

/** Runs actions on a new session, checking it after each one. */
async function runActions(actions: readonly Action[]) {
  const dir = mkdtempSync(join(tmpdir(), "percy-model-"));
  const world: World = {
    dir,
    sessionDir: join(dir, "sessions"),
    external: { section: false },
    timer: undefined,
    idleAnswer: { answer: "ignore", seed: 0 },
    h: undefined,
    queueOnRequest: undefined,
    overflow: false,
    queued: [],
    treeLeaves: new Set(),
  };
  let h = await start(world, SessionManager.create(dir, world.sessionDir));
  const checked: Checked = { requests: 0 };
  try {
    for (const [i, a] of actions.entries()) {
      const next = await run(h, world, a);
      if (next !== h) checked.requests = 0;
      h = next;
      try {
        await checkSession(h, world, checked);
      } catch (err) {
        const branch = process.env["PERCY_PBT_DUMP"] ? `\n${describeBranch(h)}` : "";
        throw new Error(`after action ${i} ${JSON.stringify(a)}: ${(err as Error).message}${branch}`, { cause: err });
      }
    }
    const branch = h.session.sessionManager.getBranch();
    count("actions", actions.length);
    count("requests checked", checked.requests);
    count("pi compactions on final branch", branch.filter((e) => e.type === "compaction").length);
    count("branch summaries on final branch", branch.filter((e) => e.type === "branch_summary").length);
    count("records on final branch", records(branch).length);
    count("idle nudges on final branch", branch.filter((e) => isNudgeEntry(e, "idle")).length);
    count("context nudges on final branch", branch.filter((e) => isNudgeEntry(e, "context")).length);
    count(
      "system messages on final branch",
      branch.filter((e) => e.type === "message" && e.message.role === "system").length,
    );
  } finally {
    h.dispose();
  }
}

test("a pi-percy session stays consistent under any sequence of actions", { timeout: 600_000 }, async () => {
  const replay = process.env["PERCY_PBT_ACTIONS"];
  if (replay) return runActions(JSON.parse(replay) as Action[]);
  await fc.assert(fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 30, size: "max" }), runActions), {
    numRuns: RUNS,
    ...(SEED === undefined ? {} : { seed: SEED }),
    endOnFailure: false,
    examples: [[ORIGINAL_BUG]],
  });
  if (process.env["PERCY_PBT_STATS"]) console.log(Object.fromEntries(stats));
});
