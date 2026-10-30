// The bridge between a pi session branch and the core view: message numbers,
// stored compaction records, and the session entries that realize a
// compaction.
import type { SessionBoundaryDraft, SessionEntry, SessionProjection } from "@earendil-works/pi-coding-agent";
import { noteText } from "./messages.ts";
import type { AgentMessage, Compaction, Edit, Item } from "./types.ts";

/** customType of the custom entry that records a compaction. */
export const RECORD_TYPE = "percy-compaction";

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
    if (e.type !== "custom" || e.customType !== RECORD_TYPE) return;
    const record = e.data as StoredCompaction;
    records.set(i + 1, record);
    record.squishes.forEach((s, n) => {
      notes.set(s.from, { from: seq(s.from), to: seq(s.to), id: `s${i + 1}.${n}`, summary: s.summary });
    });
  });

  const items: Item[] = [];
  for (const { sourceEntry, messages } of projection.entries) {
    for (const message of messages) {
      if (message.role === "system") continue;
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
  return { items, seqOf, count: numbered.length, entryAt: (n) => numbered[n - 1], recordAt: (n) => records.get(n) };
}

/** The text of a message whose content is a single text block, else undefined. */
function onlyText(m: AgentMessage): string | undefined {
  if (!("content" in m)) return undefined;
  const c = m.content;
  if (typeof c === "string") return c;
  return c.length === 1 && c[0]?.type === "text" ? c[0].text : undefined;
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
