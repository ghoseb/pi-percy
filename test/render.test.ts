// The TUI renderers, rendered with a theme that adds no colors (pi does not
// export its theme instance); initTheme sets up the Markdown theme.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { type CustomEntry, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { StoredCompaction } from "../extensions/percy/branch.ts";
import { renderCompactCall, renderIndex, renderNudge, renderRecord } from "../extensions/percy/render.ts";
import { NUDGE_TYPE } from "../extensions/percy/types.ts";

before(() => initTheme("dark"));

/** Numbers as the renderers format them, in this machine's locale. */
const n = (x: number) => x.toLocaleString();

const t = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as Theme;

const plain = (lines: string[]) =>
  lines
    // eslint-disable-next-line no-control-regex -- ANSI escape sequences
    .map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07]*\x07/g, "").trim())
    .filter(Boolean)
    .join("\n");

function entry<T>(customType: string, data: T): CustomEntry<T> {
  return { type: "custom", id: "e1", parentId: null, timestamp: new Date(0).toISOString(), customType, data };
}

const record: StoredCompaction = {
  squishes: [{ from: "a", to: "b", fromSeq: 5, toSeq: 9, summary: "Built the parser.\nTests pass." }],
  trims: [{ entry: "c", seq: 12, toolCallId: "t1" }],
  hiddenEntries: [],
  hiddenToolCallIds: [],
  tokensBefore: 120_000,
  tokensAfter: 80_000,
};

test("a compact call shows its action and counts, not its raw arguments", () => {
  const compact = plain(
    renderCompactCall(
      {
        action: "compact",
        collapse: [
          { from: "1357", to: "1419", note: "A long summary that must not appear in the tool row." },
          { from: "1422", to: "1429", note: "Another summary." },
        ],
        trim: ["1437", "1459"],
      },
      t,
    ).render(200),
  );
  assert.equal(compact, "compact_in_place 2 ranges, 2 tool outputs");
  assert.doesNotMatch(compact, /1357|summary/);
  assert.equal(plain(renderCompactCall({ action: "index" }, t).render(200)), "compact_in_place index");
  assert.equal(plain(renderCompactCall({ action: "compact" }, t).render(200)), "compact_in_place compact");
});

test("a compaction record, like pi's compaction message", () => {
  const collapsed = plain(renderRecord(entry("percy-compaction", record), false, t).render(200));
  assert.match(collapsed, new RegExp(`^\\[compaction\\]\\nCompacted from ${n(120_000)} tokens \\(.* to expand\\)$`));
  const expanded = plain(renderRecord(entry("percy-compaction", record), true, t).render(200));
  for (const want of [
    `Compacted from ${n(120_000)} tokens`,
    `Context now uses about ${n(80_000)} tokens: 1 range collapsed, 1 tool output trimmed.`,
    "Messages 5-9:",
    "Built the parser.",
    "Tests pass.",
    "Trimmed the output of message 12.",
  ]) {
    assert.ok(expanded.includes(want), `${want}\n${expanded}`);
  }
});

test("a compaction card expands with a left click, like pi's card", () => {
  const card = renderRecord(entry("percy-compaction", record), false, t);
  card.render(200); // Establish Box's mouse layout before dispatching the click.
  const result = card.handleMouse?.({
    type: "click",
    button: "left",
    x: 1,
    y: 1,
    screenX: 1,
    screenY: 1,
    width: 200,
    height: 4,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.equal(result?.handled, true);
  assert.match(plain(card.render(200)), new RegExp(`Compacted from ${n(120_000)} tokens`));
  assert.match(plain(card.render(200)), /Context now uses about/);
});

test("nudges show their first line, and the index on expand", () => {
  const message = (content: string[], idle?: boolean) => ({
    role: "custom" as const,
    customType: NUDGE_TYPE,
    content: content.map((text) => ({ type: "text" as const, text })),
    display: true,
    details: idle ? { idle } : undefined,
    timestamp: 0,
  });
  const size = message(["Context is 210k.", "## Index\n\nrows"]);
  assert.match(
    plain(renderNudge(size, false, 1, t).render(200)),
    /^\[context\]\nContext is 210k: sent the agent the compaction index \(.* to expand\)$/,
  );
  assert.ok(plain(renderNudge(size, true, 1, t).render(200)).includes("Index"));
  const idle = message(["[The conversation has been idle for 8 minutes. Compact ...]", "## Index"], true);
  assert.match(
    plain(renderNudge(idle, false, 1, t).render(200)),
    /^\[context\]\nIdle for 8 minutes: asked the agent to compact \(/,
  );
});

test("the /compact-debug index counts its rows", () => {
  const index =
    '## Index\n\nintro\n\n```\nid  role  tokens  content\n1   user* 2       text "x"\n2   user* 2       text "y"\n```\n';
  assert.match(
    plain(renderIndex(entry("percy-index", { index }), false, t).render(200)),
    /^\[compaction index\]\n2 rows to compact \(/,
  );
  const empty = "## Index\n\n2 messages, ~3 tokens.\nAll of it is recent, so nothing can be compacted yet.\n";
  assert.match(
    plain(renderIndex(entry("percy-index", { index: empty }), false, t).render(200)),
    /Nothing to compact yet/,
  );
});
