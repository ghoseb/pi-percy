import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { compactionUnits } from "../extensions/percy/units.ts";
import { renderOriginals, resolveIds, searchOriginals } from "../extensions/percy/recall.ts";
import { buildCompaction } from "../extensions/percy/validate.ts";
import {
  applyCompaction,
  compactionEvidence,
  compactionView,
  editsBetween,
  safeCompactionEvidence,
  systemBoundaryProblems,
  systemBoundaryViolations,
} from "../extensions/percy/view.ts";
import { type AgentMessage, DEFAULT_LIMITS, type Item } from "../extensions/percy/types.ts";
import type { BranchView } from "../extensions/percy/branch.ts";
import { anthropicWire, misplacedSystemMessages } from "./anthropic-wire.ts";
import { assistant, assistantMessage, call, nudge, output, user } from "./fixtures.ts";
import { session, view } from "./sessions.ts";

/** A test-only projection of pi context edits, independent of applyCompaction. */
function projectEdits(items: readonly Item[], edits: ReturnType<typeof editsBetween>): Item[] {
  const bySeq = new Map(edits.map((edit) => [edit.seq, edit.replacement]));
  return items.flatMap((item) => {
    const replacement = bySeq.get(item.from);
    if (replacement === null) return [];
    if (replacement === undefined) return [item];
    return [{ ...item, message: { ...item.message, content: replacement.content } as Item["message"] }];
  });
}

function visible(items: readonly Item[]): unknown[] {
  return items.map((item) => ({
    role: item.message.role,
    content: "content" in item.message ? item.message.content : undefined,
  }));
}

// Every unit advertised to the model must be directly usable by the existing
// validator. This exercises the unit splitter at many token boundaries.
test("every generated safe unit validates and produces editable changes", () => {
  fc.assert(
    fc.property(fc.array(fc.string({ minLength: 8, maxLength: 400 }), { minLength: 1, maxLength: 40 }), (texts) => {
      const items: Item[] = [
        ...texts.map((text, index) => assistant(index + 1, text)),
        user(texts.length + 1, "recent"),
      ];
      const limits = { ...DEFAULT_LIMITS, keepRecentTokens: 1 };
      const units = compactionUnits(items, limits);
      for (const unit of units.units) {
        const compaction = buildCompaction(items, limits, {
          collapse: [{ from: unit.from, to: unit.to, note: "x" }],
        });
        const after = applyCompaction(items, compaction, 1);
        const edits = editsBetween(items, after);
        assert.ok(edits.every((edit) => edit.seq <= texts.length));
      }
    }),
    { numRuns: 2_000 },
  );
});

// Round-trip: edits persisted from a compaction must recreate its provider-
// visible messages, even when the carrier keeps a user or assistant role.
test("generated context edits reproduce the compacted visible messages", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.boolean(), fc.string({ minLength: 8, maxLength: 400 })), { minLength: 1, maxLength: 30 }),
      (messages) => {
        const items: Item[] = [
          ...messages.map(([isUser, text], index) => (isUser ? user(index + 1, text) : assistant(index + 1, text))),
          user(messages.length + 1, "recent"),
        ];
        const limits = { ...DEFAULT_LIMITS, keepRecentTokens: 1 };
        for (const unit of compactionUnits(items, limits).units) {
          const compaction = buildCompaction(items, limits, {
            collapse: [{ from: unit.from, to: unit.to, note: "x" }],
          });
          const after = applyCompaction(items, compaction, 1);
          assert.deepEqual(visible(projectEdits(items, editsBetween(items, after))), visible(after));
        }
      },
    ),
    { numRuns: 2_000 },
  );
});

// Idempotence: completed compaction evidence is removed once, never causing
// later projection passes to remove ordinary conversation messages.
test("hiding generated compaction evidence is idempotent", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 80 }), (isNudge) => {
      const items: Item[] = isNudge.map((value, index) =>
        value ? nudge(index + 1) : index % 2 === 0 ? assistant(index + 1, "work") : user(index + 1, "task"),
      );
      assert.deepEqual(visible(compactionView(compactionView(items))), visible(compactionView(items)));
    }),
    { numRuns: 2_000 },
  );
});

// Recall equivalence: a note id always names exactly the raw span recorded
// for that note, the same span a caller could request explicitly.
test("generated note ids resolve to their recorded original range", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 0, max: 50 }), (from, width) => {
      const to = from + width;
      const record = 9;
      const view = {
        count: to,
        seqOf: new Map([
          ["from", from],
          ["to", to],
        ]),
        recordAt: (seq: number) =>
          seq === record
            ? ({ squishes: [{ from: "from", to: "to" }] } as ReturnType<BranchView["recordAt"]>)
            : undefined,
      } as unknown as BranchView;
      assert.deepEqual(resolveIds(view, [`s${record}.0`]), [[from, to]]);
      assert.deepEqual(resolveIds(view, [`${from}-${to}`]), [[from, to]]);
    }),
    { numRuns: 2_000 },
  );
});

// Safety: hiding a nudge next to a retained system boundary must never leave
// that system message between two assistant messages, which Anthropic rejects.
test("generated evidence hiding preserves system boundaries", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), (assistantBeforeSystem, nudgeAfterSystem) => {
      const first = assistantBeforeSystem ? assistant(1, "old reply") : user(1, "old request");
      // The system message sits right before or right after the nudge.
      const items = [first, nudge(nudgeAfterSystem ? 3 : 2), assistant(4, "next reply")];
      const boundaries = [nudgeAfterSystem ? 2 : 3];
      const evidence = safeCompactionEvidence(items, compactionEvidence(items), boundaries);
      const after = applyCompaction(
        items,
        { squishes: [], trims: [], hiddenSeqs: evidence.seqs, hiddenToolCallIds: [] },
        1,
      );
      assert.deepEqual(systemBoundaryProblems(after, boundaries), []);
    }),
    { numRuns: 2_000 },
  );
});

// Fidelity: percy's system-boundary rule must agree with what pi-ai actually
// sends to Anthropic. Generated histories mix user-side messages (some empty,
// which pi-ai drops), nudges, replies (some errored, which pi-ai drops), tool
// calls with results, and system messages, also between a call and its
// result. A user message ends each history, as the next request appends one.
type Piece = "user" | "emptyUser" | "nudge" | "reply" | "errorReply" | "tool" | "toolWithSystem" | "system";
const PIECES: Piece[] = ["user", "emptyUser", "nudge", "reply", "errorReply", "tool", "toolWithSystem", "system"];

function history(pieces: readonly Piece[]): { messages: AgentMessage[]; items: Item[]; boundaries: number[] } {
  const messages: AgentMessage[] = [];
  const items: Item[] = [];
  const boundaries: number[] = [];
  const add = (make: (seq: number) => Item) => {
    const it = make(messages.length + 1);
    messages.push(it.message);
    items.push(it);
  };
  const system = () => {
    messages.push({ role: "system", content: "Changed prompt.", timestamp: messages.length + 1 });
    boundaries.push(messages.length);
  };
  add((n) => user(n, "start"));
  pieces.forEach((piece, i) => {
    const id = `t${i}`;
    switch (piece) {
      case "user":
        return add((n) => user(n, "more"));
      case "emptyUser":
        return add((n) => user(n, "  "));
      case "nudge":
        return add((n) => nudge(n));
      case "reply":
        return add((n) => assistant(n, "reply"));
      case "errorReply":
        return add((n) => {
          const it = assistant(n, "partial");
          return { ...it, message: { ...it.message, stopReason: "error" } as Item["message"] };
        });
      case "tool":
        add((n) => call(n, id));
        return add((n) => output(n, id, "out"));
      case "toolWithSystem":
        add((n) => call(n, id));
        system();
        return add((n) => output(n, id, "out"));
      case "system":
        return system();
    }
  });
  add((n) => user(n, "next request"));
  return { messages, items, boundaries };
}

test("generated system boundaries match pi-ai's Anthropic request", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 12 }), async (pieces) => {
      const { messages, items, boundaries } = history(pieces);
      const percy = systemBoundaryViolations(items, boundaries).length > 0;
      const wire = misplacedSystemMessages(await anthropicWire(messages)).length > 0;
      assert.equal(percy, wire, `percy ${percy}, wire ${wire}: ${pieces.join(" ")}`);
    }),
    { numRuns: 1_000 },
  );
});

/** Words that never appear in recall's headers ("user", "bash output for #t1", ...). */
const WORDS = ["alpha", "Beta", "GAMMA", "delta", "epsilon"] as const;
const THINKING_ONLY = "zeta";

const searchMessage = fc.oneof(
  fc.record({ kind: fc.constant("user" as const), text: fc.array(fc.constantFrom(...WORDS), { maxLength: 4 }) }),
  fc.record({
    kind: fc.constant("assistant" as const),
    text: fc.array(fc.constantFrom(...WORDS), { maxLength: 4 }),
    thinking: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("tool" as const),
    tool: fc.constantFrom("bash", "read"),
    args: fc.array(fc.constantFrom(...WORDS), { maxLength: 3 }),
    out: fc.array(fc.constantFrom(...WORDS), { maxLength: 3 }),
  }),
);

test("generated searches find exactly the messages whose recalled text holds the query", () => {
  fc.assert(
    fc.property(
      fc.array(searchMessage, { minLength: 1, maxLength: 25 }),
      fc.constantFrom(...WORDS, THINKING_ONLY),
      fc.boolean(),
      (messages, word, upper) => {
        const items: Item[] = [];
        messages.forEach((m, i) => {
          if (m.kind === "user") items.push(user(0, m.text.join(" ")));
          else if (m.kind === "assistant") {
            const content = [{ type: "text" as const, text: m.text.join(" ") }];
            items.push(
              m.thinking
                ? assistantMessage(0, { type: "thinking", thinking: THINKING_ONLY }, ...content)
                : assistantMessage(0, ...content),
            );
          } else {
            items.push(call(0, `t${i}`, m.tool, { arg: m.args.join(" ") }));
            items.push(output(0, `t${i}`, m.out.join(" "), m.tool));
          }
        });
        const v = view(session(items));
        const query = upper ? word.toUpperCase() : word;
        const hits = searchOriginals(v, { query, limit: 100 }).hits.map((h) => Number(h.id));
        const expected: number[] = [];
        for (let n = v.count; n >= 1; n--) {
          const recalled = renderOriginals(v, [[n, n]]);
          const body = recalled.slice(recalled.indexOf("\n") + 1);
          if (recalled.startsWith("## Message") && body.toLowerCase().includes(word.toLowerCase())) expected.push(n);
        }
        assert.deepEqual(hits, expected);
      },
    ),
    { numRuns: 1_000 },
  );
});
