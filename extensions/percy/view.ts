// Applying a compaction to the model's view, and the context edits that make
// pi show that view.
import { hasToolCall, isEditable, isToolResult, noteText, toolCalls, trimmedText, withText } from "./messages.ts";
import { type AgentMessage, type Compaction, COMPACT_TOOL, type Edit, type Item, NUDGE_TYPE } from "./types.ts";

/**
 * Applies c, recorded as record number recordSeq, to items and returns the
 * view pi will show once c's edits are in (see editsBetween). items is not
 * modified. Throws if c does not fit the view.
 */
export function applyCompaction(items: readonly Item[], c: Compaction, recordSeq: number): Item[] {
  const out = [...items];
  for (const t of c.trims) {
    const i = out.findIndex((it) => !it.note && it.from === t.seq);
    if (i < 0) throw new Error(`trim: no message ${t.seq} in context`);
    const it = out[i]!;
    const m = it.message;
    if (m.role !== "toolResult" || m.toolCallId !== t.toolCallId) {
      throw new Error(`trim: message ${t.seq} has no tool result for ${t.toolCallId}`);
    }
    out[i] = { ...it, message: withText(m, trimmedText(t.seq)) };
  }
  c.squishes.forEach((s, n) => {
    const i = out.findIndex((it) => it.from === s.from);
    const j = out.findIndex((it) => it.to === s.to);
    if (i < 0 || j < 0 || j < i) {
      throw new Error(`squish: range ${s.from}-${s.to} does not align with messages in context`);
    }
    if (isToolResult(out[i]!.message)) {
      throw new Error(`squish: range ${s.from}-${s.to} starts with a tool result whose call precedes it`);
    }
    if (hasToolCall(out[j]!.message)) {
      throw new Error(`squish: range ${s.from}-${s.to} ends with a tool call whose result follows it`);
    }
    const fixed = out.slice(i, j + 1).find((it) => !isEditable(it.message));
    if (fixed) throw new Error(`squish: range ${s.from}-${s.to} covers ${fixed.from}, which is not editable`);
    // The first message carries the note: pi replaces its content.
    out.splice(i, j - i + 1, {
      from: s.from,
      to: s.to,
      note: { id: `s${recordSeq}.${n}`, summary: s.summary },
      message: withText(out[i]!.message, noteText(s.from, s.to, s.summary)),
    });
  });
  return hideItems(out, c.hiddenSeqs, c.hiddenToolCallIds);
}

/**
 * Whether pi-ai sends m to the provider. It drops errored and aborted
 * assistant responses (transformMessages) and user-side messages without text
 * or images (the Anthropic converter); convertToLlm drops bash executions
 * excluded from context.
 */
function sentToProvider(m: AgentMessage): boolean {
  switch (m.role) {
    case "assistant":
      return m.stopReason !== "error" && m.stopReason !== "aborted";
    case "bashExecution":
      return m.excludeFromContext !== true;
    case "user":
    case "custom":
      return typeof m.content === "string"
        ? m.content.trim().length > 0
        : m.content.some((c) => c.type === "image" || (c.type === "text" && c.text.trim().length > 0));
    default:
      return true;
  }
}

/** A retained system message that the provider would receive between two assistant messages. */
export interface SystemBoundaryViolation {
  system: number;
  before: Item;
  after: Item;
}

/**
 * Checks Pi's retained mid-conversation system messages against what pi-ai
 * sends. pi-ai holds a later system message back and emits it directly before
 * the next assistant message, so the provider sees it after whatever message
 * precedes that assistant. Anthropic rejects a system message that follows an
 * assistant message. So a system message is invalid exactly when the sent
 * messages on both sides of it are assistant messages: nothing user-side sits
 * between it and the next assistant message, and the message before it is an
 * assistant message. A note whose carrier is an assistant message counts as
 * one, at its carrier's position (from). A system message with no assistant
 * message after it is valid: the next request appends a user-side message.
 * System messages are not compactable, so branchView records their positions
 * separately from its editable items.
 */
export function systemBoundaryViolations(
  items: readonly Item[],
  systemBoundaries: readonly number[],
): SystemBoundaryViolation[] {
  const sent = items.filter((item) => sentToProvider(item.message));
  return systemBoundaries.flatMap((system) => {
    const next = sent.findIndex((item) => item.from > system);
    if (next <= 0) return [];
    const before = sent[next - 1]!;
    const after = sent[next]!;
    if (before.message.role !== "assistant" || after.message.role !== "assistant") return [];
    return [{ system, before, after }];
  });
}

export function systemBoundaryProblems(items: readonly Item[], systemBoundaries: readonly number[]): string[] {
  return systemBoundaryViolations(items, systemBoundaries).map(
    ({ system, before, after }) =>
      `system message ${system} would sit between assistant messages ${before.from}-${before.to} and ` +
      `${after.from}-${after.to}; keep a user message, tool result, or nudge next to that system message`,
  );
}

/**
 * Hide compaction evidence when it does not leave a retained system message
 * between two assistant messages (see systemBoundaryViolations). A tool change
 * between turns persists a system message right before the next user-side
 * message, which can be a percy nudge; retaining that one nudge is safer than
 * producing a provider-invalid request. Candidates apply in the same order as
 * hideItems.
 */
export function safeCompactionEvidence(
  items: readonly Item[],
  evidence: ReturnType<typeof compactionEvidence>,
  systemBoundaries: readonly number[],
): ReturnType<typeof compactionEvidence> {
  let view = [...items];
  const seqs: number[] = [];
  const toolCallIds: string[] = [];
  for (const seq of evidence.seqs) {
    const next = hideItems(view, [seq], []);
    if (systemBoundaryProblems(next, systemBoundaries).length > 0) continue;
    view = next;
    seqs.push(seq);
  }
  for (const toolCallId of evidence.toolCallIds) {
    const next = hideItems(view, [], [toolCallId]);
    if (systemBoundaryProblems(next, systemBoundaries).length > 0) continue;
    view = next;
    toolCallIds.push(toolCallId);
  }
  return { seqs, toolCallIds };
}

/**
 * Drops the original messages seqs, and the tool calls toolCallIds with their
 * results, from items. An assistant message left without tool calls goes: it
 * was about the call. items is not modified.
 */
export function hideItems(items: readonly Item[], seqs: readonly number[], toolCallIds: readonly string[]): Item[] {
  let out = [...items];
  for (const seq of seqs) {
    const i = out.findIndex((it) => !it.note && it.from === seq);
    if (i < 0) throw new Error(`hide: no message ${seq} in context`);
    out.splice(i, 1);
  }
  for (const id of toolCallIds) {
    let found = 0;
    out = out.flatMap((it) => {
      const m = it.message;
      if (m.role === "toolResult" && m.toolCallId === id) {
        found++;
        return [];
      }
      if (m.role === "assistant" && m.content.some((c) => c.type === "toolCall" && c.id === id)) {
        found++;
        const content = m.content.filter((c) => !(c.type === "toolCall" && c.id === id));
        if (!content.some((c) => c.type === "toolCall")) return [];
        return [{ ...it, message: { ...m, content } }];
      }
      return [it];
    });
    if (found !== 2) throw new Error(`hide: tool call ${id} and its result are not both in context`);
  }
  return out;
}

/**
 * The edits that turn view before into view after (see applyCompaction): an
 * item of before is keyed by its message number, which for a note is its
 * carrier's. Items gone from after are omitted; items whose content changed
 * get the new content.
 */
export function editsBetween(before: readonly Item[], after: readonly Item[]): Edit[] {
  const kept = new Map(after.map((it) => [it.from, it]));
  const known = new Set(before.map((it) => it.from));
  for (const it of after) {
    if (!known.has(it.from)) throw new Error(`edits: message ${it.from} is not in the view`);
  }
  const edits: Edit[] = [];
  for (const it of before) {
    const now = kept.get(it.from);
    if (now && sameContent(now.message, it.message)) continue;
    if (!isEditable(it.message)) throw new Error(`edits: message ${it.from} is not editable`);
    edits.push({ seq: it.from, replacement: now ? { content: contentOf(now.message) } : null });
  }
  return edits;
}

function contentOf(m: AgentMessage): Exclude<Edit["replacement"], null>["content"] {
  switch (m.role) {
    case "user":
    case "assistant":
    case "toolResult":
    case "custom":
      return m.content;
    default:
      throw new Error(`a ${m.role} message is not editable`);
  }
}

function sameContent(a: AgentMessage, b: AgentMessage): boolean {
  return a === b || ("content" in a && "content" in b && JSON.stringify(a.content) === JSON.stringify(b.content));
}

/**
 * Returns the context nudges in items, and the compact_in_place calls whose
 * results are in items: the evidence of compacting, which a compaction hides.
 */
export function compactionEvidence(items: readonly Item[]): { seqs: number[]; toolCallIds: string[] } {
  const seqs: number[] = [];
  const results = new Set<string>();
  for (const it of items) {
    if (it.note) continue;
    const m = it.message;
    if (m.role === "custom" && m.customType === NUDGE_TYPE) seqs.push(it.from);
    if (m.role === "toolResult") results.add(m.toolCallId);
  }
  const toolCallIds: string[] = [];
  for (const it of items) {
    for (const c of toolCalls(it.message)) {
      if (c.name === COMPACT_TOOL && results.has(c.id)) toolCallIds.push(c.id);
    }
  }
  return { seqs, toolCallIds };
}

/**
 * Returns history as the agent can compact it: without the evidence of
 * compacting, which the compaction hides anyway, and without the
 * compact_in_place call now running, which has no output yet. Neither moves
 * the recent part while the agent works.
 */
export function compactionView(history: readonly Item[]): Item[] {
  const { seqs, toolCallIds } = compactionEvidence(history);
  return hideItems(history, seqs, toolCallIds).flatMap((it) => {
    const m = it.message;
    if (m.role !== "assistant" || !m.content.some((c) => c.type === "toolCall" && c.name === COMPACT_TOOL)) return [it];
    // Like hideItems, remove only the call; a message left without a call goes.
    const content = m.content.filter((c) => !(c.type === "toolCall" && c.name === COMPACT_TOOL));
    if (!content.some((c) => c.type === "toolCall")) return [];
    return [{ ...it, message: { ...m, content } }];
  });
}
