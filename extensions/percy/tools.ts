// pi-percy's tools: compact_in_place, with which the agent compacts its own
// context, and recall, which shows the originals.
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  type SessionBoundaryDraft,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { compactionDrafts, currentView } from "./branch.ts";
import { buildIndex } from "./index-render.ts";
import { isPlainObject } from "./messages.ts";
import { renderOriginals, resolveIds } from "./recall.ts";
import { renderCompactCall, renderCompactResult } from "./render.ts";
import type { PercySettings } from "./settings.ts";
import { COMPACT_TOOL, type CompactDetails, RECALL_TOOL } from "./types.ts";
import { CompactionProblems, compactRequest } from "./validate.ts";

const COMPACT_DESCRIPTION = [
  "Selectively compact this conversation's older context.",
  "Use it when a context nudge supplies an index or the user asks to compact context.",
  'Call with action "index" first: it lists the older messages and explains what to do.',
  '(Right after a "Context is Nk." nudge, which carries the index, you can skip it.)',
  'Then call with action "compact", giving one or both of trim (tool-output rows) and collapse (message ranges with short notes).',
  "Prefer obsolete outputs, abandoned approaches, and completed tasks that are no longer current; retain only their task, final outcome, decision, and reason.",
  `Originals stay in the session; ${RECALL_TOOL} retrieves them.`,
].join(" ");

const COMPACT_PROMPT_GUIDELINES = [
  "Use compact_in_place only for context housekeeping after its context nudge or a user request; it does not replace completing the user's work.",
  'When compacting, use the provided index (or call action "index") and preserve decisions, paths, commands, ids, and later corrections in your notes.',
  "Prefer dead ends, superseded investigations, abandoned approaches, and completed tasks that are no longer current. Collapse the related user request on its own, then safe work ranges; retain one short note with the task, final outcome, decision, reason, and replacement. Trim large obsolete tool outputs.",
];

const RECALL_DESCRIPTION = [
  `Retrieve original messages from the current branch, including content hidden, collapsed, or trimmed by ${COMPACT_TOOL}.`,
  "Give message numbers, ranges like 12-20, or note ids like s30.1 (for the messages the note replaced).",
  `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; ask for fewer ids to see more.`,
].join(" ");

const compactParameters = Type.Object({
  action: StringEnum(["index", "compact"] as const),
  trim: Type.Optional(
    Type.Array(Type.String(), { description: "compact: ids of index rows whose tool outputs to trim" }),
  ),
  collapse: Type.Optional(
    Type.Array(
      Type.Object({
        from: Type.String(),
        to: Type.String(),
        note: Type.String({ description: "what still matters from the range" }),
      }),
      { description: "compact: ranges of index ids (inclusive) to replace with a note" },
    ),
  ),
  collapseUnits: Type.Optional(
    Type.Array(
      Type.Object({ id: Type.String(), note: Type.String({ description: "what still matters from this safe unit" }) }),
      { description: "compact: safe unit ids from the index, each with a short note" },
    ),
  ),
});

const recallParameters = Type.Object({
  ids: Type.Array(Type.String(), { description: "message numbers, ranges like 12-20, or note ids like s30.1" }),
});

// The tool arguments that are lists of ids, and those that are lists of
// objects with id fields.
const ID_LISTS = ["trim", "ids"];
const ID_FIELDS: Record<string, readonly string[]> = { collapse: ["from", "to"], collapseUnits: ["id"] };

/** Models send ids as numbers or strings; the schemas take strings. */
export function stringIds(args: unknown): unknown {
  if (!isPlainObject(args)) return args;
  const str = (v: unknown) => (typeof v === "number" ? String(v) : v);
  const out: Record<string, unknown> = { ...args };
  for (const name of ID_LISTS) {
    const list = args[name];
    if (Array.isArray(list)) out[name] = list.map(str);
  }
  for (const [name, fields] of Object.entries(ID_FIELDS)) {
    const list = args[name];
    if (!Array.isArray(list)) continue;
    out[name] = list.map((v: unknown) =>
      isPlainObject(v) ? { ...v, ...Object.fromEntries(fields.map((f) => [f, str(v[f])])) } : v,
    );
  }
  return out;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
const result = (t: string, details: CompactDetails) => ({ content: [{ type: "text" as const, text: t }], details });

/** What the tools read and change of pi-percy's state. */
export interface ToolDeps {
  settings: () => PercySettings;
  /** Whether a compaction from this turn waits for turn_end to append it. */
  compactionPending: () => boolean;
  /** Queues a compaction's entries for turn_end to append. */
  queueCompaction: (toolCallId: string, drafts: SessionBoundaryDraft[]) => void;
}

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
  pi.registerTool({
    name: COMPACT_TOOL,
    label: "Compact in place",
    description: COMPACT_DESCRIPTION,
    promptSnippet: "Selectively compact older conversation context",
    promptGuidelines: COMPACT_PROMPT_GUIDELINES,
    parameters: compactParameters,
    renderCall: (args, theme) => renderCompactCall(args, theme),
    renderResult: (result, options, theme, context) => renderCompactResult(result, options, theme, context.isError),
    prepareArguments: (args) => stringIds(args) as Static<typeof compactParameters>,
    executionMode: "sequential",
    execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const view = currentView(ctx);
      if (params.action === "index") {
        const index = buildIndex(view.items, deps.settings().limits, view.systemBoundaries);
        return Promise.resolve(result(index.text, { kind: "index", rows: index.rows }));
      }
      if (deps.compactionPending()) {
        throw new Error("A compaction from this turn is waiting to be applied; compact again after the next response.");
      }
      const input = {
        ...(params.trim === undefined ? {} : { trim: params.trim }),
        ...(params.collapse === undefined ? {} : { collapse: params.collapse }),
        ...(params.collapseUnits === undefined ? {} : { collapseUnits: params.collapseUnits }),
      };
      let compacted;
      try {
        compacted = compactRequest(view.items, deps.settings().limits, input, view.systemBoundaries);
      } catch (err) {
        if (!(err instanceof CompactionProblems)) throw err;
        return Promise.resolve({ ...result(err.message, { kind: "rejected", problems: err.problems }), isError: true });
      }
      const { compaction, tokensBefore, tokensAfter } = compacted;
      deps.queueCompaction(toolCallId, compactionDrafts(view, compaction, compacted.edits, compacted));
      return Promise.resolve(
        result(compacted.text, {
          kind: "compacted",
          tokensBefore,
          tokensAfter,
          collapsed: compaction.squishes.length,
          trimmed: compaction.trims.length,
        }),
      );
    },
  });

  pi.registerTool({
    name: RECALL_TOOL,
    label: "Recall",
    description: RECALL_DESCRIPTION,
    promptSnippet: "Retrieve original messages hidden or compacted by compact_in_place",
    parameters: recallParameters,
    prepareArguments: (args) => stringIds(args) as Static<typeof recallParameters>,
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const view = currentView(ctx);
      const spans = resolveIds(view, params.ids);
      const full = renderOriginals(view, spans);
      const t = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      if (!t.truncated) return Promise.resolve(text(full));
      return Promise.resolve(
        text(
          `${t.content}\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines ` +
            `(${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Ask for fewer ids to see the rest.]`,
        ),
      );
    },
  });
}
