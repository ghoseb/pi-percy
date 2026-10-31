// The message list pi-ai's Anthropic converter sends for a context, captured
// with a fake client, and the check Anthropic applies to its system messages.
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { getModel } from "@earendil-works/pi-ai/compat";
import { type Message, normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "../extensions/percy/types.ts";

export interface WireMessage {
  role: string;
  content: unknown;
  output_config?: unknown;
}

const MODEL = getModel("anthropic", "claude-opus-5-5");

/**
 * The messages pi-ai sends to Anthropic for messages (pi's context, without
 * the leading system prompt, which this adds).
 */
export function anthropicWire(messages: readonly AgentMessage[]): Promise<WireMessage[]> {
  return anthropicRequest(normalizeContext({ systemPrompt: "You are pi.", messages: convertToLlm([...messages]) }));
}

/** The messages pi-ai sends to Anthropic for a request a provider received. */
export function anthropicRequestWire(messages: readonly Message[]): Promise<WireMessage[]> {
  return anthropicRequest(normalizeContext({ messages: [...messages] }));
}

async function anthropicRequest(context: TranscriptContext): Promise<WireMessage[]> {
  let captured: WireMessage[] | undefined;
  const client = {
    beta: {
      messages: {
        create: (params: { messages: WireMessage[] }) => {
          captured = params.messages;
          throw new Error("captured");
        },
      },
    },
  };
  const events = stream(MODEL, context, { client: client as never, effort: "high" });
  // Drained: the fake client ends the stream with an error after capturing.
  for await (const event of events) void event;
  if (!captured) throw new Error("pi-ai sent no request");
  return captured;
}

/** A system message with content; directive-only ones are accepted anywhere. */
const contentSystem = (m: WireMessage) =>
  m.role === "system" && Array.isArray(m.content) && (m.content as unknown[]).length > 0;

/**
 * Wire indices of system messages that Anthropic rejects: a run of system
 * messages must follow a user message.
 */
export function misplacedSystemMessages(wire: readonly WireMessage[]): number[] {
  const bad: number[] = [];
  wire.forEach((m, i) => {
    if (!contentSystem(m)) return;
    let j = i - 1;
    while (j >= 0 && wire[j]!.role === "system") j--;
    if (j >= 0 && wire[j]!.role !== "user") bad.push(i);
  });
  return bad;
}
