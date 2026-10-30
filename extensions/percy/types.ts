// Core data model of in-place compaction. Pure: no pi runtime imports.
//
// The model's view of a conversation is a list of items, built by the adapter
// from pi's session projection (context edits applied). An original message
// is an item spanning just its own message number; a note from a compaction
// spans the whole range of message numbers it replaced, and is carried by the
// first message of that range, whose content pi replaced with the note.
// Message numbers are stable ordinals along the session branch; the adapter
// maps them to and from pi entry ids.
import type { ContextEditableContent, ContextEvent } from "@earendil-works/pi-coding-agent";

/**
 * A message as pi's context event carries it, including pi-coding-agent's
 * custom roles (custom, bashExecution, branchSummary, compactionSummary).
 * Taken from pi-coding-agent rather than pi-agent-core so it uses the copy of
 * pi-agent-core that pi-coding-agent augments.
 */
export type AgentMessage = ContextEvent["messages"][number];

export interface Note {
  /** "s<record number>.<squish index>" */
  id: string;
  summary: string;
}

export interface Item {
  from: number;
  to: number;
  message: AgentMessage;
  /**
   * Set on a note that replaced messages from..to. Its carrier, the message
   * whose content the note replaced, is message from.
   */
  note?: Note;
}

/**
 * A change to message seq's contribution to model context, realized as a pi
 * context_edit entry: null omits the message, otherwise content replaces its
 * content (pi keeps its role).
 */
export interface Edit {
  seq: number;
  replacement: { content: ContextEditableContent } | null;
}

/** Replaces the items spanning from..to (inclusive) with one note. */
export interface Squish {
  from: number;
  to: number;
  summary: string;
}

/** Replaces the content of the tool result in message seq with a pointer. */
export interface Trim {
  seq: number;
  toolCallId: string;
}

/**
 * One in-place compaction record. Records apply in order, each to the view
 * the ones before it left; within a record, trims apply first, then squishes,
 * then hides.
 */
export interface Compaction {
  squishes: Squish[];
  trims: Trim[];
  /** Original messages to drop (context nudges). */
  hiddenSeqs: number[];
  /** Tool calls to drop with their results (earlier compact_in_place calls). */
  hiddenToolCallIds: string[];
}

export interface Limits {
  /** Budget of recent history that is kept as is and cannot be compacted. */
  keepRecentTokens: number;
  /** Most history one collapse may cover, unless it is a single row. */
  maxCollapseTokens: number;
}

export const DEFAULT_LIMITS: Limits = { keepRecentTokens: 20_000, maxCollapseTokens: 20_000 };

/** A collapse as the agent asks for it, by index ids. */
export interface Collapse {
  from: string;
  to: string;
  note: string;
}

/** The compact action's input, ids already normalized to strings. */
export interface CompactInput {
  trim?: string[];
  collapse?: Collapse[];
}

export const COMPACT_TOOL = "compact_in_place";
export const RECALL_TOOL = "recall";
/** customType of context nudges (size and idle), hidden by compacting. */
export const NUDGE_TYPE = "percy-nudge";

export function emptyCompaction(): Compaction {
  return { squishes: [], trims: [], hiddenSeqs: [], hiddenToolCallIds: [] };
}
