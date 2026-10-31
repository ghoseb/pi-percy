// The bridge between a pi session branch and the core view: message numbers,
// stored compaction records, and the session entries that realize a
// compaction.
import type {
  CustomEntry,
  CustomMessageEntry,
  SessionBoundaryDraft,
  SessionEntry,
  SessionProjection,
} from "@earendil-works/pi-coding-agent";
import { noteText, onlyText } from "./messages.ts";
import { type Compaction, type Edit, type Item, type NudgeDetails, NUDGE_TYPE } from "./types.ts";

/** customType of the custom entry that records a compaction. */
export const RECORD_TYPE = "percy-compaction";

/** Reports whether e records a compaction. */
export function isRecordEntry(e: SessionEntry): e is CustomEntry<StoredCompaction> {
  return e.type === "custom" && e.customType === RECORD_TYPE;
}

/**
 * Reports whether e is a nudge of the given kind, or of either kind when none
 * is given. An idle nudge says so in its details.
 */
export function isNudgeEntry(e: SessionEntry, kind?: "context" | "idle"): e is CustomMessageEntry<NudgeDetails> {
  if (e.type !== "custom_message" || e.customType !== NUDGE_TYPE) return false;
  const idle = (e.details as NudgeDetails)?.idle === true;
  return kind === undefined || idle === (kind === "idle");
}

/**
 * A compaction as stored in a custom entry: by entry id. Message numbers
 * (seq) and sizes are kept for display; numbers are stable branch positions.
 */
export interface StoredCompaction {
  squishes: { from: string; to: string; fromSeq: number; toSeq: number; summary: string }[];
  trims: { entry: string; seq: number; toolCallId: string }[];
  hiddenEntries: string[];
  hiddenToolCallIds: string[];
  tokensBefore: number;
  tokensAfter: number;
}

/** The model's view of a branch, with the numbering that names its messages. */
export interface BranchView {
  items: Item[];
  /** Branch positions of system messages that must retain a non-assistant predecessor. */
  systemBoundaries: readonly number[];
  /**
   * Message number of each entry on the branch: its 1-based position, not
   * counting label entries. pi's fork and clone drop labels from the path
   * they copy (re-adding them at its end) and keep every other entry and its
   * id, so the numbers survive them.
   */
  seqOf: ReadonlyMap<string, number>;
  /** Entry on the branch by message number. */
  entryAt: (seq: number) => SessionEntry | undefined;
  /** How many numbered entries the branch has. */
  count: number;
  /** The squishes of the compaction recorded as entry seq. */
  recordAt: (seq: number) => StoredCompaction | undefined;
}

/**
 * Builds the view of a branch from pi's projection of it (context edits
 * applied). Messages carrying a recorded note are marked as notes spanning the
 * range they replaced. System messages are left out: they are not compactable.
 */
export function branchView(branch: readonly SessionEntry[], projection: SessionProjection): BranchView {
  const seqOf = new Map<string, number>();
  const numbered = branch.filter((e) => e.type !== "label");
  numbered.forEach((e, i) => seqOf.set(e.id, i + 1));
  const seq = (id: string): number => {
    const n = seqOf.get(id);
    if (n === undefined) throw new Error(`entry ${id} is not on the branch`);
    return n;
  };

  // The latest note recorded for each carrier.
  const notes = new Map<string, { from: number; to: number; id: string; summary: string }>();
  const records = new Map<number, StoredCompaction>();
  numbered.forEach((e, i) => {
    if (!isRecordEntry(e)) return;
    const record = e.data!;
    records.set(i + 1, record);
    record.squishes.forEach((s, n) => {
      notes.set(s.from, { from: seq(s.from), to: seq(s.to), id: `s${i + 1}.${n}`, summary: s.summary });
    });
  });

  const items: Item[] = [];
  const systemBoundaries: number[] = [];
  for (const { sourceEntry, messages } of projection.entries) {
    for (const message of messages) {
      if (message.role === "system") {
        systemBoundaries.push(seq(sourceEntry.id));
        continue;
      }
      const note = notes.get(sourceEntry.id);
      // The carrier shows the note while its edit is in effect.
      if (note && onlyText(message) === noteText(note.from, note.to, note.summary)) {
        items.push({ from: note.from, to: note.to, note: { id: note.id, summary: note.summary }, message });
      } else {
        const n = seq(sourceEntry.id);
        items.push({ from: n, to: n, message });
      }
    }
  }
  return {
    items,
    systemBoundaries,
    seqOf,
    count: numbered.length,
    entryAt: (n) => numbered[n - 1],
    recordAt: (n) => records.get(n),
  };
}

/**
 * The compaction that a /tree jump to targetId would split: the target is its
 * record or one of its context edits before the last. A compaction is one
 * change, so a branch holds all of its edits or none of them. Returns the
 * entry before its record and its last edit, the places to jump to instead.
 * entries are the session's, from any branch.
 */
export function compactionSplitBy(
  entries: readonly SessionEntry[],
  targetId: string,
): { before: string | null; last: string } | undefined {
  const byId = new Map(entries.map((e) => [e.id, e]));
  // pi appends a compaction's record and edits as one chain.
  const nextEdit = new Map<string, string>();
  for (const e of entries) {
    if (e.type === "context_edit" && e.parentId !== null && !nextEdit.has(e.parentId)) nextEdit.set(e.parentId, e.id);
  }
  let record = byId.get(targetId);
  while (record?.type === "context_edit") record = record.parentId === null ? undefined : byId.get(record.parentId);
  if (!record || !isRecordEntry(record) || !nextEdit.has(targetId)) return undefined;
  let last = targetId;
  for (let next = nextEdit.get(last); next !== undefined; next = nextEdit.get(last)) last = next;
  return { before: record.parentId, last };
}

/**
 * The session entries that realize a compaction of view: its record, then its
 * context edits. They are appended at the next turn boundary.
 */
export function compactionDrafts(
  view: BranchView,
  compaction: Compaction,
  edits: readonly Edit[],
  sizes: { tokensBefore: number; tokensAfter: number },
): SessionBoundaryDraft[] {
  const id = (n: number): string => {
    const e = view.entryAt(n);
    if (!e) throw new Error(`no entry for message ${n}`);
    return e.id;
  };
  const stored: StoredCompaction = {
    squishes: compaction.squishes.map((s) => ({
      from: id(s.from),
      to: id(s.to),
      fromSeq: s.from,
      toSeq: s.to,
      summary: s.summary,
    })),
    trims: compaction.trims.map((t) => ({ entry: id(t.seq), seq: t.seq, toolCallId: t.toolCallId })),
    hiddenEntries: compaction.hiddenSeqs.map(id),
    hiddenToolCallIds: compaction.hiddenToolCallIds,
    ...sizes,
  };
  return [
    { type: "custom", customType: RECORD_TYPE, data: stored },
    ...edits.map((e): SessionBoundaryDraft => ({
      type: "context_edit",
      targetId: id(e.seq),
      replacement: e.replacement,
    })),
  ];
}
