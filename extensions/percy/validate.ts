// Turning the agent's compact request into a record: the "linter".
import { isEditable, isToolResult, isTrimmedOutput } from "./messages.ts";
import { indexOfRow, itemTokens, orphanCall, orphanOutput, type Row, recentStart, rowId, splitRows } from "./rows.ts";
import { aloneRows, compactionUnits } from "./units.ts";
import {
  type Collapse,
  type Compaction,
  type CompactInput,
  type Edit,
  emptyCompaction,
  type Item,
  type Limits,
  type Trim,
} from "./types.ts";
import {
  applyCompaction,
  compactionEvidence,
  compactionView,
  editsBetween,
  safeCompactionEvidence,
  systemBoundaryProblems,
} from "./view.ts";

export const RETRY_GUIDANCE =
  "Nothing was compacted; fix only the reported problems and send the whole request again. " +
  "Preserve existing notes verbatim unless a note itself is invalid or a corrected range changes what it must summarize. " +
  "Do not shorten notes to fix IDs or ranges.";

/**
 * The error for a rejected request: its problems, all at once, then how to
 * retry. One problem reads as a sentence; several as a list.
 */
/** A request with problems, so nothing was compacted. Its message is the reply to the agent. */
export class CompactionProblems extends Error {
  readonly problems: string[];
  constructor(problems: readonly string[]) {
    super(
      problems.length === 1
        ? `${problems[0]}. ${RETRY_GUIDANCE}`
        : `${problems.length} problems:\n- ${problems.join("\n- ")}\n\n${RETRY_GUIDANCE}`,
    );
    this.name = "CompactionProblems";
    this.problems = [...problems];
  }
}

/** The trims of a row's tool outputs not trimmed yet. */
export function rowTrims(row: Row): Trim[] {
  const trims: Trim[] = [];
  for (const it of row) {
    const m = it.message;
    if (m.role === "toolResult" && !isTrimmedOutput(m)) trims.push({ seq: it.from, toolCallId: m.toolCallId });
  }
  return trims;
}

/** Lists the ranges of rows[i..j] between the rows that collapse only alone. */
function suggestRanges(rows: readonly Row[], alone: readonly boolean[], i: number, j: number): string {
  const ranges: string[] = [];
  let start = -1;
  for (let k = i; k <= j + 1; k++) {
    if (k <= j && !alone[k]) {
      if (start < 0) start = k;
    } else if (start >= 0) {
      let end = k - 1;
      while (start <= end && orphanOutput(rows[start]!)) start++;
      while (start <= end && orphanCall(rows[end]!)) end--;
      if (start <= end) {
        let r = rowId(rows[start]!);
        if (start < end) r += `-${rowId(rows[end]!)}`;
        ranges.push(r);
      }
      start = -1;
    }
  }
  return ranges.join(", ");
}

/** A collapse to check: a range the agent gave, or the range of a unit it selected. */
type CollapseRequest = Collapse & { unit?: string };

/**
 * Turns the agent's request into a record, validating it against the
 * compaction view of history and its recent part. Throws with every problem
 * at once: the given problems (found earlier in the same request), then the
 * trims', then the collapses'.
 */
export function buildCompaction(
  history: readonly Item[],
  limits: Limits,
  input: { trim?: readonly string[]; collapse?: readonly CollapseRequest[] },
  problems: readonly string[] = [],
): Compaction {
  const trim = input.trim ?? [];
  const collapse = input.collapse ?? [];
  if (trim.length === 0 && collapse.length === 0 && problems.length === 0) {
    throw new Error("nothing to compact: give trim and/or collapse");
  }
  const items = compactionView(history);
  const { rows, recentRow: recent } = splitRows(items, recentStart(items, limits.keepRecentTokens));
  const alone = aloneRows(rows);
  const c = emptyCompaction();
  const found = [...problems];

  const trimmed: number[] = [];
  for (const id of trim) {
    const problem = (text: string) => found.push(`trim ${id}: ${text}`);
    const r = indexOfRow(rows, id);
    if (r < 0) problem("unknown id; use ids from the index");
    else if (r >= recent) problem("in the recent part, which is kept as is");
    else if (trimmed.includes(r)) problem("listed twice");
    else if (!rows[r]!.some((it) => isToolResult(it.message))) problem("has no tool output");
    else if (rowTrims(rows[r]!).length === 0) problem("already trimmed");
    else {
      trimmed.push(r);
      c.trims.push(...rowTrims(rows[r]!));
    }
  }

  const spans: { i: number; j: number }[] = [];
  for (const col of collapse) {
    const name = col.unit === undefined ? "collapse" : `collapse unit ${col.unit}`;
    const range = col.unit === undefined ? `${col.from}-${col.to}` : `(${col.from}-${col.to})`;
    const problem = (text: string) => found.push(`${name} ${range}: ${text}`);
    const i = indexOfRow(rows, col.from);
    const j = indexOfRow(rows, col.to);
    if (i < 0 || j < 0) {
      problem("unknown id; use ids from the index");
      continue;
    }
    if (j < i) {
      problem("from comes after to");
      continue;
    }
    if (j >= recent) {
      problem(`reaches into the recent part (from ${rowId(rows[recent]!)} on), which is kept as is`);
      continue;
    }
    if (orphanOutput(rows[i]!)) {
      problem(`${rowId(rows[i]!)} is a tool output without its call; start the range after it`);
      continue;
    }
    if (orphanCall(rows[j]!)) {
      problem(`${rowId(rows[j]!)} is a tool call without its output; end the range before it`);
      continue;
    }
    if (spans.some((s) => i <= s.j && s.i <= j)) {
      problem("overlaps another collapse");
      continue;
    }
    const fixed = rows
      .slice(i, j + 1)
      .flat()
      .find((it) => !isEditable(it.message));
    if (fixed) {
      problem(`covers ${fixed.from}, which cannot be compacted (user bash runs and summaries stay as they are)`);
      continue;
    }
    // A row that can only be collapsed on its own may not share a range.
    const k = alone.slice(i, j + 1).indexOf(true);
    if (k >= 0 && j > i) {
      const r = suggestRanges(rows, alone, i, j);
      const instead = r ? `collapse e.g. ${r} instead` : "collapse each of those rows on its own";
      problem(`covers ${rowId(rows[i + k]!)}, which can only be collapsed on its own; ${instead}`);
      continue;
    }
    // The range is sound; whatever else is wrong with it, it is taken.
    spans.push({ i, j });
    let tokens = 0;
    for (const row of rows.slice(i, j + 1)) tokens += itemTokens(row);
    if (col.note.trim() === "") {
      problem("note is empty");
      continue;
    }
    if (tokens > limits.maxCollapseTokens && j > i) {
      problem(
        `covers ~${tokens} tokens; at most ~${limits.maxCollapseTokens} per collapse unless it is a single row, so split it`,
      );
      continue;
    }
    if (Math.floor((col.note.length + 3) / 4) >= tokens) {
      problem(`note is not shorter than the ~${tokens} tokens it replaces`);
      continue;
    }
    const last = rows[j]![rows[j]!.length - 1]!;
    c.squishes.push({ from: rows[i]![0]!.from, to: last.to, summary: col.note });
  }

  if (found.length > 0) throw new CompactionProblems(found);
  // Squishes apply in order, each to the view the previous ones left; they
  // are disjoint, so order them as they appear.
  c.squishes.sort((a, b) => a.from - b.from);
  return c;
}

export interface CompactResult {
  compaction: Compaction;
  /** The context edits that realize compaction. */
  edits: Edit[];
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  remainingUnits: number;
  /** The tool's reply to the agent. */
  text: string;
}

/**
 * Validates the agent's request against history and returns the record to
 * store. The record also hides the evidence of compacting: the nudges, and the
 * earlier calls of compact_in_place (the running call stays, as a receipt).
 * systemBoundaries are the positions of pi's system messages, which the
 * compaction must not leave between assistant messages.
 */
export function compactRequest(
  history: readonly Item[],
  limits: Limits,
  input: CompactInput,
  systemBoundaries: readonly number[] = [],
): CompactResult {
  const unitSelections = input.collapseUnits ?? [];
  const available = compactionUnits(history, limits, systemBoundaries);
  const units = new Map(available.units.map((unit) => [unit.id, unit]));
  const unitProblems: string[] = [];
  const seenUnits = new Set<string>();
  const selected = unitSelections.flatMap(({ id, note }): CollapseRequest[] => {
    if (seenUnits.has(id)) {
      unitProblems.push(`collapse unit ${id}: listed twice`);
      return [];
    }
    seenUnits.add(id);
    const unit = units.get(id);
    if (!unit) {
      unitProblems.push(`collapse unit ${id}: unknown id; use ids from the index`);
      return [];
    }
    return [{ from: unit.from, to: unit.to, note, unit: id }];
  });
  const compaction = buildCompaction(
    history,
    limits,
    {
      ...(input.trim === undefined ? {} : { trim: input.trim }),
      collapse: [...(input.collapse ?? []), ...selected],
    },
    unitProblems,
  );
  const beforeHidingEvidence = applyCompaction(history, compaction);
  const evidence = safeCompactionEvidence(
    beforeHidingEvidence,
    compactionEvidence(beforeHidingEvidence),
    systemBoundaries,
  );
  compaction.hiddenSeqs = evidence.seqs;
  compaction.hiddenToolCallIds = evidence.toolCallIds;
  const after = applyCompaction(history, compaction);
  const systemProblems = systemBoundaryProblems(after, systemBoundaries);
  if (systemProblems.length > 0) throw new CompactionProblems(systemProblems);
  const tokensBefore = itemTokens(history);
  const tokensAfter = itemTokens(after);
  const tokensSaved = tokensBefore - tokensAfter;
  const remainingUnits = compactionUnits(after, limits, systemBoundaries).units.length;
  return {
    compaction,
    edits: editsBetween(history, after),
    tokensBefore,
    tokensAfter,
    tokensSaved,
    remainingUnits,
    text:
      `Compacted: ${compaction.squishes.length} collapsed, ${compaction.trims.length} trimmed; ` +
      `history ~${tokensBefore} -> ~${tokensAfter} tokens (saved ~${tokensSaved}). ` +
      `${remainingUnits} safe collapse units remain.`,
  };
}
