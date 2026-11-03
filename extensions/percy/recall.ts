// The recall tool's core: original messages by id, as they were before any
// compaction.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BranchView } from "./branch.ts";

/**
 * Resolves the ids the agent asks for: message numbers ("12"), ranges
 * ("12-20"), or note ids ("s30.1", for the range the note replaced). Returns
 * the inclusive spans in request order. Throws with every bad id at once.
 */
export function resolveIds(view: BranchView, ids: readonly string[]): [number, number][] {
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
      const to = range[2] === undefined ? from : Number(range[2]);
      if (from < 1 || to > view.count) problems.push(`${id}: messages are numbered 1-${view.count}`);
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
  const seen = new Set<number>();
  const parts: string[] = [];
  for (const [from, to] of spans) {
    for (let n = from; n <= to; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const entry = view.entryAt(n);
      const text = entry && renderEntry(entry);
      if (text !== undefined) parts.push(`## Message ${n} ${text}`);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : "Those ids hold no messages.";
}

type Block = { type: string; text?: string; thinking?: string; name?: string; id?: string; arguments?: unknown };

/**
 * Content without thinking blocks. Recall never returns reasoning traces: a
 * provider can refuse a request that feeds old reasoning back to the model, and
 * what matters from old work is in its text, tool calls and outputs. Undefined
 * when the content held only thinking.
 */
function renderContent(content: string | readonly Block[]): string | undefined {
  if (typeof content === "string") return content;
  const blocks = content.filter((c) => c.type !== "thinking");
  if (blocks.length === 0 && content.length > 0) return undefined;
  return blocks
    .map((c) => {
      switch (c.type) {
        case "text":
          return c.text ?? "";
        case "toolCall":
          return `[tool call ${c.name}#${c.id}] ${JSON.stringify(c.arguments)}`;
        default:
          return `[${c.type}]`;
      }
    })
    .join("\n");
}

/** "(header)\n<content>", or undefined when the content held only thinking. */
function withHeader(header: string, content: string | readonly Block[]): string | undefined {
  const text = renderContent(content);
  return text === undefined ? undefined : `(${header})\n${text}`;
}

/** "(role)\n<content>" for an entry that holds a message, else undefined. */
function renderEntry(entry: SessionEntry): string | undefined {
  switch (entry.type) {
    case "message": {
      const m = entry.message;
      switch (m.role) {
        case "user":
        case "assistant":
          return withHeader(m.role, m.content);
        case "toolResult":
          return withHeader(`${m.toolName} output for #${m.toolCallId}${m.isError ? ", error" : ""}`, m.content);
        case "bashExecution":
          return `(user bash)\n$ ${m.command}\n${m.output}`;
        default:
          return undefined;
      }
    }
    case "custom_message":
      return withHeader(entry.customType, entry.content);
    case "compaction":
    case "branch_summary":
      return `(summary)\n${entry.summary}`;
    default:
      return undefined;
  }
}
