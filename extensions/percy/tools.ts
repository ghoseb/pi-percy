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
import { type BranchView, compactionDrafts, currentView } from "./branch.ts";
import { buildIndex } from "./index-render.ts";
import { isPlainObject } from "./messages.ts";
import { originals, renderOriginals, renderSearch, resolveIds, SEARCH_LIMITS, searchOriginals } from "./recall.ts";
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
  `Retrieve original messages from the current branch, word for word, including content hidden, collapsed, or trimmed by ${COMPACT_TOOL}.`,
  "Every message on the current branch can be recalled, including history before a compaction summary; it is not lost.",
  "Give ids (message numbers, ranges like 12-20, or note ids like s30.1 for the messages the note replaced) to read messages, or query to search them.",
  'Search when you do not know the message number: it returns one line per matching message or compaction note, newest first, and you then recall the ids you need. It matches plain text without regard to case unless regex or caseSensitive is set; role narrows it to user, assistant, tool, summary or note text, and tool to calls to that tool and its outputs. Tool call arguments are searched as recall shows them, one "name: value" line per argument with strings as written.',
  "Recall when you need exact text that a note or summary did not keep (commands, ids, error messages, measured numbers, the user's exact wording of a decision), when a note is vague or contradicts the current state, before you claim an earlier check passed when a note only says it did, or when the source exists nowhere else (deleted files, old command output).",
  "Do not recall when the source still exists: read the file or run the command again, because the current state is better than an old copy.",
  "Do not recall to re-check a decision that a note already records.",
  `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; ask for fewer ids to see more. Thinking is never returned or searched.`,
].join(" ");

const RECALL_PROMPT_GUIDELINES = [
  "Use recall for exact details that compaction notes or summaries dropped before you rely on them; when the file or command output still exists, read or run it again instead.",
  "To find an old message whose number you do not know, search with recall query, then recall the ids it returns.",
];

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
  ids: Type.Optional(
    Type.Array(Type.String(), { description: "message numbers, ranges like 12-20, or note ids like s30.1" }),
  ),
  query: Type.Optional(Type.String({ description: "search: text to find; give ids or query, not both" })),
  regex: Type.Optional(Type.Boolean({ description: "search: query is a JavaScript regular expression" })),
  caseSensitive: Type.Optional(Type.Boolean({ description: "search: match case (default: ignore case)" })),
  role: Type.Optional(StringEnum(["user", "assistant", "tool", "summary", "note"] as const)),
  tool: Type.Optional(Type.String({ description: "search: only calls to this tool and its outputs" })),
  range: Type.Optional(
    Type.String({
      description: "search: only these messages, like 30000-34000; a range past the last message ends there",
    }),
  ),
  limit: Type.Optional(Type.Integer({ description: `search: hits to show (default ${SEARCH_LIMITS.defaultLimit})` })),
  offset: Type.Optional(Type.Integer({ description: "search: hits to skip, for the next page" })),
  oldestFirst: Type.Optional(Type.Boolean({ description: "search: oldest hits first (default: newest first)" })),
});

/**
 * What scripts such as codemode receive from recall instead of its text: the
 * messages read by ids, untruncated, or a page of search hits.
 */
const recallOutput = Type.Object({
  messages: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Integer({ description: "message number" }),
        header: Type.String({ description: "user, assistant, <tool> output for #<call id>, ..." }),
        text: Type.String({ description: "text, tool calls and tool output; never thinking" }),
      }),
      { description: "ids: the messages read, in full" },
    ),
  ),
  search: Type.Optional(
    Type.Object(
      {
        total: Type.Integer({ description: "matching messages and notes, all pages" }),
        offset: Type.Integer(),
        hits: Type.Array(
          Type.Object({
            id: Type.String({ description: "message number or note id; pass it to recall ids" }),
            kind: StringEnum(["message", "note"] as const),
            header: Type.String(),
            range: Type.Optional(
              Type.Array(Type.Integer(), { description: "note: first and last message it replaced" }),
            ),
            matches: Type.Integer(),
            snippet: Type.String(),
          }),
        ),
      },
      { description: "query: this page of hits" },
    ),
  ),
});

// The tool arguments that are ids or text, lists of ids, and lists of
// objects with id fields.
const ID_SCALARS = ["query", "range"];
const ID_LISTS = ["trim", "ids"];
const ID_FIELDS: Record<string, readonly string[]> = { collapse: ["from", "to"], collapseUnits: ["id"] };

/** Models send ids as numbers or strings; the schemas take strings. */
export function stringIds(args: unknown): unknown {
  if (!isPlainObject(args)) return args;
  const str = (v: unknown) => (typeof v === "number" ? String(v) : v);
  const out: Record<string, unknown> = { ...args };
  for (const name of ID_SCALARS) if (name in args) out[name] = str(args[name]);
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

/** Runs a recall search; a range takes the forms ids take. */
/**
 * The tool calls running a nested call: pi names a call from inside another
 * tool <parent id>/<n>, so "a/1/2" runs inside "a/1", which runs inside "a".
 */
export function callersOf(toolCallId: string): string[] {
  const parts = toolCallId.split("/");
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

function search(view: BranchView, params: Static<typeof recallParameters>, toolCallId: string) {
  const range = params.range === undefined ? undefined : resolveIds(view, [params.range], true)[0];
  const q = {
    query: params.query ?? "",
    ...(params.regex === undefined ? {} : { regex: params.regex }),
    ...(params.caseSensitive === undefined ? {} : { caseSensitive: params.caseSensitive }),
    ...(params.role === undefined ? {} : { role: params.role }),
    ...(params.tool === undefined ? {} : { tool: params.tool }),
    ...(range === undefined ? {} : { range }),
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    ...(params.offset === undefined ? {} : { offset: params.offset }),
    ...(params.oldestFirst === undefined ? {} : { oldestFirst: params.oldestFirst }),
    callers: callersOf(toolCallId),
  };
  const r = searchOriginals(view, q);
  const structuredContent: Static<typeof recallOutput> = { search: r };
  return {
    content: [{ type: "text" as const, text: renderSearch(q, r) }],
    details: undefined,
    structuredContent,
  };
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
    // Only the model may call it. A compaction is applied when its own tool
    // result ends the turn, and pi-percy hides that call and result afterwards.
    // A call from another tool, such as a codemode script, has neither: it
    // would report a compaction that is never applied.
    exposure: "model-only",
    // It only appends entries; the originals stay in the session for recall.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: RECALL_DESCRIPTION,
    outputSchema: recallOutput,
    promptSnippet: "Retrieve original messages hidden or compacted by compact_in_place",
    promptGuidelines: RECALL_PROMPT_GUIDELINES,
    parameters: recallParameters,
    prepareArguments: (args) => stringIds(args) as Static<typeof recallParameters>,
    execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const view = currentView(ctx);
      if (params.query !== undefined) {
        if (params.ids !== undefined) throw new Error("give ids or query, not both");
        return Promise.resolve(search(view, params, toolCallId));
      }
      if (params.ids === undefined) throw new Error("give ids to read messages, or query to search them");
      const spans = resolveIds(view, params.ids);
      const structuredContent: Static<typeof recallOutput> = { messages: originals(view, spans) };
      const full = renderOriginals(view, spans);
      const t = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      const shown = t.truncated
        ? `${t.content}\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines ` +
          `(${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Ask for fewer ids to see the rest.]`
        : full;
      return Promise.resolve({ ...text(shown), structuredContent });
    },
  });
}
