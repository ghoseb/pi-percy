// Turning the agent's compact request into a record: the "linter".
import { isEditable, isToolResult, isTrimmedOutput } from "./messages.ts";
import { indexOfRow, itemTokens, orphanCall, orphanOutput, type Row, recentStart, rowId, splitRows } from "./rows.ts";
import { aloneRows, compactionUnits } from "./units.ts";
import {
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
 * Reports whether a collapse may cover it only on its own: a message from the
 * user, a note from an earlier compaction, or a summary pi wrote. They carry
 * the task and its rules, and the agent tends to fold them into notes that
 * keep little of them.
 */
export { collapsesAlone } from "./units.ts";

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

/**
 * Turns the agent's request into a record, validating it against the
 * compaction view of history and its recent part. Throws with every problem
 * at once.
 */
export function buildCompaction(history: readonly Item[], limits: Limits, input: CompactInput): Compaction {
  const trim = input.trim ?? [];
  const collapse = input.collapse ?? [];
  if (trim.length === 0 && collapse.length === 0) {
    throw new Error("nothing to compact: give trim and/or collapse");
  }
  const items = compactionView(history);
  const { rows, recentRow: recent } = splitRows(items, recentStart(items, limits.keepRecentTokens));
  const alone = aloneRows(rows);
  const c = emptyCompaction();
  const problems: string[] = [];

  const trimmed: number[] = [];
  for (const id of trim) {
    const problem = (text: string) => problems.push(`trim ${id}: ${text}`);
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
    const problem = (text: string) => problems.push(`collapse ${col.from}-${col.to}: ${text}`);
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

  if (problems.length === 1) throw new Error(`${problems[0]}. ${RETRY_GUIDANCE}`);
  if (problems.length > 1) {
    throw new Error(`${problems.length} problems:\n- ${problems.join("\n- ")}\n\n${RETRY_GUIDANCE}`);
  }
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

export interface CompactionConstraints {
  /** Retained Pi system-message positions, which compaction must not make invalid. */
  systemBoundaries?: readonly number[];
  /** Minimum estimated saving required before an automatic rewrite. */
  minSavingsTokens?: number;
}

/**
 * Validates the agent's request against history and returns the record to
 * store. The record also hides the evidence of compacting: the nudges, and the
 * earlier calls of compact_in_place (the running call stays, as a receipt).
 */
export function compactRequest(
  history: readonly Item[],
  limits: Limits,
  input: CompactInput,
  constraints: CompactionConstraints = {},
): CompactResult {
  const unitSelections = input.collapseUnits ?? [];
  const available = compactionUnits(history, limits, constraints.systemBoundaries);
  const units = new Map(available.units.map((unit) => [unit.id, unit]));
  const unitProblems: string[] = [];
  const seenUnits = new Set<string>();
  const selected = unitSelections.flatMap(({ id, note }) => {
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
    return [{ from: unit.from, to: unit.to, note }];
  });
  if (unitProblems.length === 1) throw new Error(`${unitProblems[0]}. ${RETRY_GUIDANCE}`);
  if (unitProblems.length > 1)
    throw new Error(`${unitProblems.length} problems:\n- ${unitProblems.join("\n- ")}\n\n${RETRY_GUIDANCE}`);
  const compaction = buildCompaction(history, limits, {
    ...(input.trim === undefined ? {} : { trim: input.trim }),
    collapse: [...(input.collapse ?? []), ...selected],
  });
  const beforeHidingEvidence = applyCompaction(history, compaction, 0);
  const evidence = safeCompactionEvidence(
    beforeHidingEvidence,
    compactionEvidence(beforeHidingEvidence),
    constraints.systemBoundaries ?? [],
  );
  compaction.hiddenSeqs = evidence.seqs;
  compaction.hiddenToolCallIds = evidence.toolCallIds;
  const after = applyCompaction(history, compaction, 0);
  const systemProblems = systemBoundaryProblems(after, constraints.systemBoundaries ?? []);
  if (systemProblems.length === 1) throw new Error(`${systemProblems[0]}. ${RETRY_GUIDANCE}`);
  if (systemProblems.length > 1)
    throw new Error(`${systemProblems.length} problems:\n- ${systemProblems.join("\n- ")}\n\n${RETRY_GUIDANCE}`);
  const tokensBefore = itemTokens(history);
  const tokensAfter = itemTokens(after);
  const tokensSaved = tokensBefore - tokensAfter;
  if (constraints.minSavingsTokens !== undefined && tokensSaved < constraints.minSavingsTokens) {
    throw new Error(
      `This compaction saves only ~${tokensSaved} tokens; automatic compaction requires at least ~${constraints.minSavingsTokens}. ` +
        `Select more safe units from the index and send one combined request. ${RETRY_GUIDANCE}`,
    );
  }
  const remainingUnits = compactionUnits(after, limits, constraints.systemBoundaries).units.length;
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
