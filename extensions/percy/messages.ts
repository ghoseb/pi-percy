// Helpers over pi's AgentMessage shapes, and the texts compaction puts in
// the view in place of what it removed.
import { type AgentMessage, RECALL_TOOL } from "./types.ts";

type ToolCall = Extract<Extract<AgentMessage, { role: "assistant" }>["content"][number], { type: "toolCall" }>;

export function toolCalls(m: AgentMessage): ToolCall[] {
  if (m.role !== "assistant") return [];
  return m.content.filter((c): c is ToolCall => c.type === "toolCall");
}

export function hasToolCall(m: AgentMessage): boolean {
  return toolCalls(m).length > 0;
}

export function isToolResult(m: AgentMessage): boolean {
  return m.role === "toolResult";
}

const EDITABLE_ROLES = ["user", "assistant", "toolResult", "custom"] as const;

/** A message whose contribution to model context pi can edit. */
export type EditableMessage = Extract<AgentMessage, { role: (typeof EDITABLE_ROLES)[number] }>;

/**
 * Reports whether pi can edit m's contribution to model context: user,
 * assistant, tool result and custom messages. User bash runs and pi's
 * summaries are not editable, so they cannot be compacted.
 */
export function isEditable(m: AgentMessage): m is EditableMessage {
  return (EDITABLE_ROLES as readonly string[]).includes(m.role);
}

/**
 * m with its content replaced by text, as pi projects a content replacement:
 * the role and metadata stay.
 */
export function withText(m: AgentMessage, text: string): AgentMessage {
  if (!isEditable(m)) throw new Error(`a ${m.role} message is not editable`);
  return { ...m, content: [{ type: "text", text }] };
}

/** What the model sees in place of squished messages. */
export function noteText(from: number, to: number, summary: string): string {
  return `[Messages ${from}-${to} compacted; ${RECALL_TOOL} shows them. Summary:]\n${summary}`;
}

const TRIMMED_PREFIX = "[Tool output compacted";

/** What the model sees in place of a trimmed tool output. */
export function trimmedText(seq: number): string {
  return `${TRIMMED_PREFIX}: message ${seq}; ${RECALL_TOOL} shows it]`;
}

/**
 * Reports whether m is a tool result trimmed by a compaction: its content is
 * exactly a placeholder trimmedText made. Real output may start like one.
 */
export function isTrimmedOutput(m: AgentMessage): boolean {
  if (m.role !== "toolResult" || m.content.length !== 1) return false;
  const c = m.content[0];
  if (c?.type !== "text") return false;
  const match = /^\[Tool output compacted: message (\d+); /.exec(c.text);
  return match !== null && c.text === trimmedText(Number(match[1]));
}
