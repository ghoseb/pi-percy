// Safe, model-selectable units from the flat compaction index. The validator
// remains the final authority; these units remove routine boundary arithmetic
// from the model's normal compaction requests.
import { isEditable } from "./messages.ts";
import { itemTokens, orphanCall, orphanOutput, recentStart, rowId, splitRows, type Row } from "./rows.ts";
import { compactionView } from "./view.ts";
import type { Item, Limits } from "./types.ts";

export interface CompactionUnit {
  /** Stable only for this index response. */
  id: string;
  from: string;
  to: string;
  tokens: number;
  /** A protected row that is valid only as its own collapse. */
  kind: "single" | "range";
}

export interface ProtectedRow {
  id: string;
  reason: string;
}

export interface CompactionUnits {
  units: CompactionUnit[];
  protectedRows: ProtectedRow[];
}

/** Whether a row must be collapsed by itself to preserve its meaning. */
export function collapsesAlone(item: Item): boolean {
  if (item.note) return true;
  return (
    item.message.role === "user" || item.message.role === "branchSummary" || item.message.role === "compactionSummary"
  );
}

/** For each row, whether it may be collapsed only by itself. */
export function aloneRows(rows: readonly Row[]): boolean[] {
  return rows.map((row) => row.length === 1 && collapsesAlone(row[0]!));
}

function fixedReason(row: Row, systemBoundaries: readonly number[]): string | undefined {
  const fixed = row.find((item) => !isEditable(item.message));
  if (fixed) return "cannot be compacted";
  const last = row[row.length - 1]!;
  if (systemBoundaries.includes(last.to + 1)) return "precedes a system message";
  return undefined;
}

function appendChunks(
  rows: readonly Row[],
  from: number,
  to: number,
  maxTokens: number,
  add: (from: number, to: number) => void,
  protect: (row: number, reason: string) => void,
) {
  let start = from;
  while (start <= to && orphanOutput(rows[start]!)) {
    protect(start, "is a tool output without its call");
    start++;
  }
  while (to >= start && orphanCall(rows[to]!)) {
    protect(to, "is a tool call without its output");
    to--;
  }

  while (start <= to) {
    let end = start;
    let tokens = 0;
    while (end <= to) {
      const next = itemTokens(rows[end]!);
      if (end > start && tokens + next > maxTokens) break;
      tokens += next;
      end++;
    }
    end--;
    // A following chunk can start with an orphaned call, but this one must
    // not end with it.
    while (end > start && orphanCall(rows[end]!)) end--;
    if (orphanCall(rows[end]!)) {
      protect(end, "is a tool call without its output");
      start = end + 1;
      continue;
    }
    add(start, end);
    start = end + 1;
  }
}

/**
 * Divide the non-recent portion of history into legal collapse candidates.
 * A unit never crosses a user/note/summary row, a fixed row, a system
 * boundary, or the configured collapse budget.
 */
export function compactionUnits(
  history: readonly Item[],
  limits: Limits,
  systemBoundaries: readonly number[] = [],
): CompactionUnits {
  const items = compactionView(history);
  const { rows, recentRow } = splitRows(items, recentStart(items, limits.keepRecentTokens));
  const alone = aloneRows(rows);
  const units: CompactionUnit[] = [];
  const protectedRows: ProtectedRow[] = [];
  const protect = (row: number, reason: string) => protectedRows.push({ id: rowId(rows[row]!), reason });
  const add = (from: number, to: number) => {
    const first = rows[from]!;
    const last = rows[to]!;
    units.push({
      id: `u${units.length + 1}`,
      from: rowId(first),
      to: rowId(last),
      tokens: itemTokens(rows.slice(from, to + 1).flat()),
      kind: from === to ? "single" : "range",
    });
  };

  for (let i = 0; i < recentRow;) {
    const reason = fixedReason(rows[i]!, systemBoundaries);
    if (reason) {
      protect(i, reason);
      i++;
      continue;
    }
    if (alone[i]) {
      add(i, i);
      i++;
      continue;
    }
    const start = i;
    while (i < recentRow && !alone[i] && fixedReason(rows[i]!, systemBoundaries) === undefined) i++;
    appendChunks(rows, start, i - 1, limits.maxCollapseTokens, add, protect);
  }
  return { units, protectedRows };
}
