// The recall tool's core: original messages by id, as they were before any
// compaction, and search over them and the compaction notes.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import vm from "node:vm";
import { type BranchView, isNudgeEntry, isRecordEntry } from "./branch.ts";
import { COMPACT_TOOL, RECALL_TOOL } from "./types.ts";

/**
 * Resolves the ids the agent asks for: message numbers ("12"), ranges
 * ("12-20"), or note ids ("s30.1", for the range the note replaced). Returns
 * the inclusive spans in request order. Throws with every bad id at once.
 * With clampEnd, a range that runs past the last message ends there, as a
 * search filter may; a range must still start on the branch.
 */
export function resolveIds(view: BranchView, ids: readonly string[], clampEnd = false): [number, number][] {
  if (ids.length === 0) throw new Error("give ids: message numbers, ranges like 12-20, or note ids like s30.1");
  const spans: [number, number][] = [];
  const problems: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    const note = /^s(\d+)\.(\d+)$/.exec(id);
    const range = /^(\d+)(?:-(\d+))?$/.exec(id);
    if (note) {
      const squish = view.recordAt(Number(note[1]))?.squishes[Number(note[2])];
      const from = squish && view.seqOf.get(squish.from);
      const to = squish && view.seqOf.get(squish.to);
      if (from === undefined || to === undefined) problems.push(`${id}: no such note`);
      else spans.push([from, to]);
    } else if (range) {
      const from = Number(range[1]);
      const end = range[2] === undefined ? from : Number(range[2]);
      const to = clampEnd ? Math.min(end, view.count) : end;
      if (from < 1 || from > view.count || to > view.count)
        problems.push(`${id}: messages are numbered 1-${view.count}`);
      else if (to < from) problems.push(`${id}: the range ends before it starts`);
      else spans.push([from, to]);
    } else {
      problems.push(`${id}: not a message number, range, or note id`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return spans;
}

/** Renders the original messages in spans, each message once. */
export function renderOriginals(view: BranchView, spans: readonly [number, number][]): string {
  const parts = originals(view, spans).map((m) => `## Message ${m.id} (${m.header})\n${m.text}`);
  return parts.length > 0 ? parts.join("\n\n") : "Those ids hold no messages.";
}

/** An original message as recall returns it. */
export interface Original {
  /** Message number. */
  id: number;
  /** "user", "assistant", "bash output for #id", and so on. */
  header: string;
  /** Text, tool calls and tool output; never thinking. */
  text: string;
}

/** The original messages in spans, each message once, in request order. */
export function originals(view: BranchView, spans: readonly [number, number][]): Original[] {
  const seen = new Set<number>();
  const out: Original[] = [];
  for (const [from, to] of spans) {
    for (let n = from; n <= to; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const entry = view.entryAt(n);
      const message = entry && entryMessage(entry);
      if (message) out.push({ id: n, header: message.header, text: message.parts.map((p) => p.text).join("\n") });
    }
  }
  return out;
}

/** Who a part of a message speaks as, as the model saw it. pi sends custom messages and user bash runs as user messages. */
export type PartRole = "user" | "assistant" | "tool" | "summary";

/** One searchable piece of a message: a text block, one tool call, or a tool output. */
interface Part {
  role: PartRole;
  /** The tool a tool call or output belongs to. */
  tool?: string;
  /** The id of that tool call. */
  callId?: string;
  text: string;
}

/** A message as recall shows it: a header and its parts, without thinking. */
interface EntryMessage {
  header: string;
  parts: Part[];
}

type Block = { type: string; text?: string; thinking?: string; name?: string; id?: string; arguments?: unknown };

/**
 * Parts of content, without thinking blocks. Recall never returns reasoning
 * traces: a provider can refuse a request that feeds old reasoning back to the
 * model, and what matters from old work is in its text, tool calls and
 * outputs. Undefined when the content held only thinking.
 */
function contentParts(
  content: string | readonly Block[],
  role: PartRole,
  call?: { tool: string; callId: string },
): Part[] | undefined {
  const part = (text: string, partCall = call): Part =>
    partCall === undefined ? { role, text } : { role, tool: partCall.tool, callId: partCall.callId, text };
  if (typeof content === "string") return [part(content)];
  const blocks = content.filter((c) => c.type !== "thinking");
  if (blocks.length === 0 && content.length > 0) return undefined;
  return blocks.map((c) => {
    switch (c.type) {
      case "text":
        return part(c.text ?? "");
      case "toolCall":
        return part(`[tool call ${c.name}#${c.id}] ${JSON.stringify(c.arguments)}`, {
          tool: c.name ?? "",
          callId: c.id ?? "",
        });
      default:
        return part(`[${c.type}]`);
    }
  });
}

function withHeader(header: string, parts: Part[] | undefined): EntryMessage | undefined {
  return parts === undefined ? undefined : { header, parts };
}

/** The message an entry holds, as recall shows it, else undefined. */
function entryMessage(entry: SessionEntry): EntryMessage | undefined {
  switch (entry.type) {
    case "message": {
      const m = entry.message;
      switch (m.role) {
        case "user":
          return withHeader("user", contentParts(m.content, "user"));
        case "assistant":
          return withHeader("assistant", contentParts(m.content, "assistant"));
        case "toolResult":
          return withHeader(
            `${m.toolName} output for #${m.toolCallId}${m.isError ? ", error" : ""}`,
            contentParts(m.content, "tool", { tool: m.toolName, callId: m.toolCallId }),
          );
        case "bashExecution":
          return withHeader("user bash", [{ role: "user", text: `$ ${m.command}\n${m.output}` }]);
        default:
          return undefined;
      }
    }
    case "custom_message":
      return withHeader(entry.customType, contentParts(entry.content, "user"));
    case "compaction":
    case "branch_summary":
      return withHeader("summary", [{ role: "summary", text: entry.summary }]);
    default:
      return undefined;
  }
}

/** What a search looks for, and where. */
export interface SearchQuery {
  query: string;
  /** Treat query as a JavaScript regular expression. */
  regex?: boolean;
  caseSensitive?: boolean;
  /** Only parts from this role; "note" searches only compaction notes. */
  role?: PartRole | "note";
  /** Only calls to this tool and its outputs. */
  tool?: string;
  /** Inclusive message numbers; a note is in range when the messages it replaced overlap it. */
  range?: [number, number];
  limit?: number;
  offset?: number;
  oldestFirst?: boolean;
  /** Tool calls to skip as well: those running this search, such as the script that called recall. */
  callers?: readonly string[];
}

/** One message or note that matched. */
export interface SearchHit {
  /** Message number, or note id like s30.1. Pass it to recall to read it. */
  id: string;
  kind: "message" | "note";
  /** The message's recall header, or "note for 12-20". */
  header: string;
  /** For a note, the message range it replaced. */
  range?: [number, number];
  matches: number;
  snippet: string;
}

export interface SearchResult {
  /** Matching messages and notes, before paging. */
  total: number;
  offset: number;
  hits: SearchHit[];
}

export const SEARCH_LIMITS = { defaultLimit: 20, maxLimit: 100, timeoutMs: 2000, snippetBefore: 40, snippetAfter: 80 };

/** pi-percy's own tools: their calls and outputs repeat notes and old messages, so search skips them. */
const PERCY_TOOLS: ReadonlySet<string> = new Set([COMPACT_TOOL, RECALL_TOOL]);

/** A message or note to search, and its texts that pass the filters. */
interface Candidate {
  hit: Omit<SearchHit, "matches" | "snippet">;
  texts: string[];
}

function inRange(range: [number, number] | undefined, from: number, to: number): boolean {
  return range === undefined || (from <= range[1] && to >= range[0]);
}

/**
 * Ids of the tool calls that called pi-percy's tools themselves, like a
 * codemode script that ran recall: pi records such calls in the result's
 * nestedCalls. Their code and output repeat notes and old messages too, so
 * search skips them, other work in the same call included. A call still
 * running has no result yet: recall names it in SearchQuery.callers.
 */
function callsOfPercyTools(view: BranchView): Set<string> {
  const ids = new Set<string>();
  for (let n = 1; n <= view.count; n++) {
    const entry = view.entryAt(n)!;
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const m = entry.message;
    if (m.nestedCalls?.calls.some((c) => PERCY_TOOLS.has(c.name))) ids.add(m.toolCallId);
  }
  return ids;
}

/**
 * The messages and notes on the branch that a search may match, in branch
 * order; a note sorts at its compaction record. Nudges and pi-percy's own
 * tools are left out.
 */
function candidates(view: BranchView, q: SearchQuery): Candidate[] {
  const skipped = callsOfPercyTools(view);
  for (const id of q.callers ?? []) skipped.add(id);
  const out: Candidate[] = [];
  for (let n = 1; n <= view.count; n++) {
    const entry = view.entryAt(n)!;
    if (isNudgeEntry(entry)) continue;
    if (isRecordEntry(entry)) {
      if (q.tool !== undefined || (q.role !== undefined && q.role !== "note")) continue;
      view.recordAt(n)?.squishes.forEach((s, i) => {
        const from = view.seqOf.get(s.from);
        const to = view.seqOf.get(s.to);
        if (from === undefined || to === undefined || !inRange(q.range, from, to)) return;
        out.push({
          hit: { id: `s${n}.${i}`, kind: "note", header: `note for ${from}-${to}`, range: [from, to] },
          texts: [s.summary],
        });
      });
      continue;
    }
    if (q.role === "note" || !inRange(q.range, n, n)) continue;
    const message = entryMessage(entry);
    if (!message) continue;
    const texts = message.parts
      .filter(
        (p) =>
          !(p.tool !== undefined && PERCY_TOOLS.has(p.tool)) &&
          !(p.callId !== undefined && skipped.has(p.callId)) &&
          (q.role === undefined || p.role === q.role) &&
          (q.tool === undefined || p.tool === q.tool),
      )
      .map((p) => p.text);
    if (texts.length > 0) out.push({ hit: { id: String(n), kind: "message", header: message.header }, texts });
  }
  return out;
}

/** Thrown when a search cannot run: a bad query, or a regex that ran out of time. */
export class SearchError extends Error {}

/**
 * Per candidate: undefined when it does not match, else [matches, text index,
 * match index, match length] of its first match. Runs in a vm context with a
 * timeout, because a regex can backtrack for longer than any session lasts.
 */
const MATCH_SCRIPT = `
  const re = new RegExp(source, flags);
  const out = [];
  for (const texts of docs) {
    let count = 0, first;
    for (let t = 0; t < texts.length; t++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(texts[t])) !== null) {
        if (first === undefined) first = [t, m.index, m[0].length];
        count++;
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    out.push(count === 0 ? undefined : [count, ...first]);
  }
  out;
`;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findMatches(
  docs: string[][],
  q: SearchQuery,
  timeoutMs: number,
): ([number, number, number, number] | undefined)[] {
  const source = q.regex ? q.query : escapeRegex(q.query);
  const flags = q.caseSensitive ? "g" : "gi";
  try {
    return vm.runInNewContext(MATCH_SCRIPT, { docs, source, flags }, { timeout: timeoutMs }) as (
      [number, number, number, number] | undefined
    )[];
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new SearchError(
        `the search took longer than ${timeoutMs / 1000} s; narrow it with range, role or tool${q.regex ? ", or use plain text or a simpler regex" : ""}`,
      );
    }
    // Errors from the vm context are not instances of this realm's Error.
    const message = (e as { message?: unknown }).message;
    throw new SearchError(`invalid regex: ${typeof message === "string" ? message : String(e)}`);
  }
}

/** One line of text around a match, whitespace collapsed. */
function snippet(text: string, at: number, length: number): string {
  const from = Math.max(0, at - SEARCH_LIMITS.snippetBefore);
  const to = Math.min(text.length, at + length + SEARCH_LIMITS.snippetAfter);
  const middle = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${middle}${to < text.length ? "…" : ""}`;
}

/** Problems with a query that can never match or cannot run, all at once. */
function queryProblems(q: SearchQuery): string[] {
  const problems: string[] = [];
  if (q.query.length === 0) problems.push("query: give text to search for");
  if (q.tool !== undefined && q.role !== undefined && q.role !== "assistant" && q.role !== "tool") {
    problems.push(`tool with role ${q.role}: only assistant tool calls and tool outputs belong to a tool`);
  }
  const limit = q.limit ?? SEARCH_LIMITS.defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMITS.maxLimit) {
    problems.push(`limit: give a whole number from 1 to ${SEARCH_LIMITS.maxLimit}`);
  }
  const offset = q.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) problems.push("offset: give a whole number from 0");
  return problems;
}

/**
 * Searches the current branch's messages and compaction notes for q, as recall
 * would show them: without thinking, nudges, or pi-percy's own tool calls and
 * outputs. Hits are newest first unless q.oldestFirst. Throws SearchError.
 */
export function searchOriginals(view: BranchView, q: SearchQuery, timeoutMs = SEARCH_LIMITS.timeoutMs): SearchResult {
  const problems = queryProblems(q);
  if (problems.length > 0) throw new SearchError(problems.join("\n"));
  const found = candidates(view, q);
  const matches = findMatches(
    found.map((c) => c.texts),
    q,
    timeoutMs,
  );
  const hits: SearchHit[] = [];
  found.forEach((c, i) => {
    const m = matches[i];
    if (!m) return;
    const [count, t, at, length] = m;
    hits.push({ ...c.hit, matches: count, snippet: snippet(c.texts[t]!, at, length) });
  });
  if (!q.oldestFirst) hits.reverse();
  const offset = q.offset ?? 0;
  const page = hits.slice(offset, offset + (q.limit ?? SEARCH_LIMITS.defaultLimit));
  return { total: hits.length, offset, hits: page };
}

/** A search result as text for the model. */
export function renderSearch(q: SearchQuery, r: SearchResult): string {
  const what = `${q.regex ? "/" : '"'}${q.query}${q.regex ? "/" : '"'}`;
  if (r.total === 0) return `No messages or notes match ${what}.`;
  const matching = r.total === 1 ? "1 message or note matches" : `${r.total} messages or notes match`;
  if (r.hits.length === 0) return `${matching} ${what}; offset ${r.offset} is past the last.`;
  const order = q.oldestFirst ? "oldest first" : "newest first";
  const shown = `${r.offset + 1}-${r.offset + r.hits.length} of ${r.total}`;
  const lines = r.hits.map((h) => `${h.id} (${h.header}${h.matches > 1 ? `, ${h.matches} matches` : ""}) ${h.snippet}`);
  const more = r.offset + r.hits.length < r.total ? ` Use offset ${r.offset + r.hits.length} for more.` : "";
  return [`${matching} ${what} (${order}, ${shown}):`, ...lines, `Recall these ids to read them in full.${more}`].join(
    "\n",
  );
}
