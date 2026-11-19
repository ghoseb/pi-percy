// Builders of view items in pi's message shapes, numbered like the session
// branch numbers them.
import { noteText } from "../extensions/percy/messages.ts";
import { COMPACT_TOOL, type AgentMessage, type Item, NUDGE_TYPE } from "../extensions/percy/types.ts";

type Assistant = Extract<AgentMessage, { role: "assistant" }>;
type Block = Assistant["content"][number];
type Args = Extract<Block, { type: "toolCall" }>["arguments"];

function item(seq: number, message: AgentMessage): Item {
  return { from: seq, to: seq, message };
}

export function user(seq: number, text: string): Item {
  return item(seq, { role: "user", content: [{ type: "text", text }], timestamp: seq });
}

/**
 * A note from an earlier compaction, written age compactions ago, covering
 * messages from-to; its carrier keeps the role of a user message.
 */
export function note(from: number, to: number, id: string, summary: string, age = 0): Item {
  return {
    from,
    to,
    note: { id, summary, age },
    message: { role: "user", content: [{ type: "text", text: noteText(from, to, summary) }], timestamp: from },
  };
}

/** Old history as long sessions leave it: user messages and the notes of the work they asked for. */
export function oldHistory(): Item[] {
  return [
    user(1, "build the parser"),
    note(2, 5, "s10.0", "Built the parser.", 12),
    user(6, "add tests"),
    note(7, 9, "s10.1", "Added parser tests.", 12),
    user(10, "fix the lexer"),
    note(11, 12, "s30.0", "Fixed the lexer.", 3),
    user(13, "rename it"),
    note(14, 15, "s10.2", "Renamed the parser.", 12),
    user(16, "now the docs"),
    assistant(17, "the recent part"),
  ];
}

export function assistantMessage(seq: number, ...content: Block[]): Item {
  return item(seq, {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: seq,
  });
}

export function assistant(seq: number, text: string): Item {
  return assistantMessage(seq, { type: "text", text });
}

export function toolCall(id: string, name = "bash", args: Args = {}): Block {
  return { type: "toolCall", id, name, arguments: args };
}

export function call(seq: number, id: string, name = "bash", args: Args = {}): Item {
  return assistantMessage(seq, toolCall(id, name, args));
}

export function compactCall(seq: number, id: string, args: Args = {}): Item {
  return call(seq, id, COMPACT_TOOL, args);
}

export function output(seq: number, id: string, text: string, toolName = "bash"): Item {
  return item(seq, {
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: seq,
  });
}

export function nudge(seq: number, text = "Context is 160k."): Item {
  return item(seq, { role: "custom", customType: NUDGE_TYPE, content: text, display: true, timestamp: seq });
}

export function custom(seq: number, customType: string, text: string): Item {
  return item(seq, { role: "custom", customType, content: text, display: true, timestamp: seq });
}

/** "from-to" of each item, space separated. */
export function spans(items: readonly Item[]): string {
  return items.map((it) => `${it.from}-${it.to}`).join(" ");
}

/** The text of a message, for assertions. */
export function textOf(m: AgentMessage): string {
  switch (m.role) {
    case "user":
    case "custom":
    case "toolResult":
      return typeof m.content === "string"
        ? m.content
        : m.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("");
    case "assistant":
      return m.content
        .map((c) =>
          c.type === "text" ? c.text : c.type === "toolCall" ? `toolCall(${c.name}#${c.id})` : `[${c.type}]`,
        )
        .join(" ");
    default:
      return "";
  }
}

export const x = (n: number) => "x".repeat(n);
