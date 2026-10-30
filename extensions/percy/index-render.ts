// The index the agent compacts from.
import { isTrimmedOutput } from "./messages.ts";
import { estimateTokens, itemId, itemTokens, type Row, recentStart, rowId, splitRows } from "./rows.ts";
import { COMPACT_TOOL, type Item, type Limits, RECALL_TOOL } from "./types.ts";
import { aloneRows } from "./validate.ts";
import { compactionView } from "./view.ts";

function guidance(maxCollapseTokens: number): string {
  const selection = [
    "Look for dead ends, out-of-date tool outputs (superseded file reads, old build and test logs), side quests, and finished subprojects.",
    "Collapse each into a short note that keeps what still matters: decisions, findings, paths, commands, and ids.",
    "Write readable sentences or bullets with normal whitespace. Keep words, numbers, and units clearly separated.",
    "Shorten by dropping obsolete details, not by removing spaces or joining words.",
    "When an approach was abandoned or replaced, remove its request, exploration, implementation attempts, tests, and logs from active context.",
    "Preserve one short note with the final decision, why it changed, and what now applies.",
    "When a task is complete and later work has moved on, compact its request, implementation, tests, and logs in the same way.",
    "Preserve one short note that states the completed task, its outcome, and any durable decision or path.",
    "Do not retain intermediate failed attempts unless they constrain current work.",
    "Trim tool outputs you no longer need. Big tool inputs and outputs are most of the context, so focus there.",
    `Compacting only a little is fine; when unsure, leave it. Originals stay retrievable by id with the ${RECALL_TOOL} tool.`,
  ].join(" ");
  const request = [
    `Then call ${COMPACT_TOOL} with action "compact": trim lists ids of rows whose tool outputs you no longer need, and collapse lists {from, to, note} ranges of ids from the table.`,
    `A range may not cover more than ~${Math.floor(maxCollapseTokens / 1000)}k tokens unless it is a single row.`,
    "Rows marked * are messages from the user, notes from earlier compactions, and summaries: they carry the task and its rules, so a range may not cover one unless it is just that row.",
  ].join(" ");
  return `${selection}\n\n${request}`;
}

const TABLE_INTRO = [
  "One row per message, oldest first, except that a tool call and its outputs share a row.",
  "id is the message number (of the call, for a shared row), or s<n>.<i> for a note from an earlier compaction.",
  "tokens are estimated; `→ N` gives the tokens of a call's output, or says it is trimmed or missing.",
].join(" ");

/** Renders the index of history the agent compacts from. */
export function compactIndex(history: readonly Item[], limits: Limits): string {
  const items = compactionView(history);
  const recent = recentStart(items, limits.keepRecentTokens);
  let out = `## Index\n\n${items.length} messages, ~${itemTokens(items)} tokens.\n`;
  if (recent === 0) return `${out}All of it is recent, so nothing can be compacted yet.\n`;
  const kept = items.slice(recent);
  out += `The recent part, from ${itemId(items[recent]!)} on (${kept.length} messages, ~${itemTokens(kept)} tokens), is kept as is and not listed.\n`;
  out += `\n${guidance(limits.maxCollapseTokens)}\n\n${TABLE_INTRO}\n\n\`\`\`\n`;

  const { rows, recentRow } = splitRows(items, recent);
  const alone = aloneRows(rows);
  const table: string[][] = [["id", "role", "tokens", "content"]];
  rows.slice(0, recentRow).forEach((row, i) => {
    table.push([rowId(row), roleOf(row) + (alone[i] ? "*" : ""), String(itemTokens(row)), describeRow(row)]);
  });
  return `${out}${tabulate(table)}\`\`\`\n`;
}

/** Aligns all columns but the last, two spaces apart, like Go's tabwriter. */
function tabulate(table: string[][]): string {
  const widths = [0, 1, 2].map((c) => Math.max(...table.map((r) => r[c]!.length)));
  return table.map((r) => r.map((cell, c) => (c < 3 ? cell.padEnd(widths[c]! + 2) : cell)).join("") + "\n").join("");
}

function roleOf(row: Row): string {
  const it = row[0]!;
  if (it.note) return "note";
  switch (it.message.role) {
    case "assistant":
      return "assistant";
    case "toolResult":
      return "tool";
    case "custom":
      return "custom";
    case "branchSummary":
    case "compactionSummary":
      return "summary";
    default:
      return "user";
  }
}

/** Lists a row's blocks, each tool call with the size of its output. */
export function describeRow(row: Row): string {
  const first = row[0]!;
  if (first.note) return `note ${quoteStart(first.note.summary)}`;
  const outputs = new Map<string, string>();
  for (const it of row) {
    const m = it.message;
    if (m.role === "toolResult") {
      outputs.set(m.toolCallId, isTrimmedOutput(m) ? "→ trimmed" : `→ ${estimateTokens(m)}`);
    }
  }
  const called = new Set<string>();
  const parts: string[] = [];
  const describeContent = (content: string | readonly { type: string; text?: string }[]) => {
    if (typeof content === "string") parts.push(`text ${quoteStart(content)}`);
    else for (const c of content) parts.push(c.type === "image" ? "image" : `text ${quoteStart(c.text ?? "")}`);
  };
  for (const it of row) {
    const m = it.message;
    switch (m.role) {
      case "user":
        describeContent(m.content);
        break;
      case "assistant":
        for (const c of m.content) {
          if (c.type === "text") parts.push(`text ${quoteStart(c.text)}`);
          else if (c.type === "thinking") parts.push("thinking");
          else if (c.type === "toolCall") {
            called.add(c.id);
            const input = readableToolInput(c.arguments);
            parts.push(`${c.name}${input ? ` ${quoteStart(input)}` : ""} ${outputs.get(c.id) ?? "→ no output"}`);
          }
        }
        break;
      case "toolResult":
        if (!called.has(m.toolCallId)) parts.push(`${m.toolName || "tool"} output ${outputs.get(m.toolCallId)}`);
        break;
      case "bashExecution":
        parts.push(`user bash ${quoteStart(m.command)} → ${Math.ceil(m.output.length / 4)}`);
        break;
      case "custom":
        parts.push(`${m.customType} ${quoteStart(textOf(m.content))}`);
        break;
      case "branchSummary":
      case "compactionSummary":
        parts.push(`summary ${quoteStart(m.summary)}`);
        break;
    }
  }
  return parts.join(", ");
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "image" ? "[image]" : (c.text ?? ""))).join(" ");
}

/**
 * Renders a tool call's arguments the way one would type them: the values of
 * its fields in order, strings as they are and other scalars as key=value,
 * leaving out empty strings, nulls, and nested objects and arrays. Arguments
 * that are not an object are shown as JSON.
 */
export function readableToolInput(args: unknown): string {
  if (args === undefined) return "";
  if (args === null || typeof args !== "object" || Array.isArray(args)) return JSON.stringify(args);
  const fields: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      if (value !== "") fields.push(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      fields.push(`${key}=${value}`);
    }
  }
  return fields.join(" ");
}

/** Quotes the start of s on one line. */
export function quoteStart(s: string): string {
  const runes = Array.from(s.split(/\s+/).filter(Boolean).join(" "));
  const n = 60;
  return `"${runes.length > n ? `${runes.slice(0, n).join("")}…` : runes.join("")}"`;
}
