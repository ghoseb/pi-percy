// Real pi sessions for tests, without an agent: messages appended directly,
// and compactions committed the way pi does at a turn boundary.
import { type SessionBoundaryDraft, SessionManager } from "@earendil-works/pi-coding-agent";
import { branchView, compactionDrafts } from "../extensions/percy/branch.ts";
import { DEFAULT_LIMITS, type Item } from "../extensions/percy/types.ts";
import { compactRequest } from "../extensions/percy/validate.ts";

export type Appendable = Parameters<SessionManager["appendMessage"]>[0];

/** Limits that leave no recent part, so every message can be compacted. */
export const limits = { ...DEFAULT_LIMITS, keepRecentTokens: 1 };

/** An in-memory session holding items' messages. */
export function session(items: Item[]): SessionManager {
  const sm = SessionManager.inMemory("/tmp");
  for (const it of items) sm.appendMessage(it.message as Appendable);
  return sm;
}

export const view = (sm: SessionManager) => branchView(sm.getBranch(), sm.buildSessionProjection());

/** Appends drafts the way pi does at a turn boundary. */
export function commit(sm: SessionManager, drafts: SessionBoundaryDraft[]) {
  for (const d of drafts) {
    if (d.type === "custom") sm.appendCustomEntry(d.customType, d.data);
    else if (d.type === "context_edit") sm.appendContextEdit(d.targetId, d.replacement);
    else throw new Error(`unexpected draft ${d.type}`);
  }
}

/** Compacts sm's current view with input and commits it. */
export function compact(sm: SessionManager, input: Parameters<typeof compactRequest>[2]) {
  const v = view(sm);
  const r = compactRequest(v.items, limits, input);
  commit(sm, compactionDrafts(v, r.compaction, r.edits, r));
}
