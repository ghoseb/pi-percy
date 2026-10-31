import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { compactionUnits } from "../extensions/percy/units.ts";
import { buildCompaction } from "../extensions/percy/validate.ts";
import { applyCompaction, editsBetween } from "../extensions/percy/view.ts";
import { DEFAULT_LIMITS, type Item } from "../extensions/percy/types.ts";
import { assistant, user } from "./fixtures.ts";

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
