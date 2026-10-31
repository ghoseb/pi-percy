// Helpers over pi's AgentMessage shapes, the texts compaction puts in the
// view in place of what it removed, and the text of an error for a notice.
import { type AgentMessage, NUDGE_TYPE, RECALL_TOOL } from "./types.ts";

type ToolCall = Extract<Extract<AgentMessage, { role: "assistant" }>["content"][number], { type: "toolCall" }>;

export function toolCalls(m: AgentMessage): ToolCall[] {
  if (m.role !== "assistant") return [];
  return m.content.filter((c): c is ToolCall => c.type === "toolCall");
}

/** Reports whether value is an object and not an array or null, as tool-call arguments are. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasToolCall(m: AgentMessage): boolean {
  return toolCalls(m).length > 0;
}

export function isToolResult(m: AgentMessage): boolean {
  return m.role === "toolResult";
}

/** The content of a user or custom message: text, or text and image blocks. */
export type MessageContent = Extract<AgentMessage, { role: "custom" }>["content"];

/** content as text: its blocks joined by separator, each image as "[image]". */
export function contentText(content: MessageContent, separator: string): string {
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? c.text : "[image]")).join(separator);
}

/** The text of a message whose content is a single text block, else undefined. */
export function onlyText(m: AgentMessage): string | undefined {
  if (!("content" in m)) return undefined;
  const c = m.content;
  if (typeof c === "string") return c;
  return c.length === 1 && c[0]?.type === "text" ? c[0].text : undefined;
}

/** Reports whether m is a nudge, context or idle. */
export function isNudgeMessage(m: AgentMessage): boolean {
  return m.role === "custom" && m.customType === NUDGE_TYPE;
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
  const text = m.role === "toolResult" ? onlyText(m) : undefined;
  if (text === undefined) return false;
  const match = /^\[Tool output compacted: message (\d+); /.exec(text);
  return match !== null && text === trimmedText(Number(match[1]));
}

/** The message of an exception, for a notice. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
