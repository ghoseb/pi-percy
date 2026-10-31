// /percy:compact-debug, a testing aid: show the index, or record a squish or trim
// directly, without the validation compact_in_place applies. Port of
// Shelley's /compact-debug.
import { indexOfRow, splitRows } from "./rows.ts";
import { DEBUG_COMMAND, type Compaction, emptyCompaction, type Item } from "./types.ts";
import { rowTrims } from "./validate.ts";
import { applyCompaction, compactionView, systemBoundaryProblems } from "./view.ts";

export const DEBUG_USAGE = `usage: /${DEBUG_COMMAND} [index] | /${DEBUG_COMMAND} squish <from>-<to> <summary> | /${DEBUG_COMMAND} trim <id>`;

const DEBUG_COMPLETIONS = [
  { value: "index", label: "index", description: "Show the compaction index without changing context" },
  {
    value: "squish ",
    label: "squish <from>-<to> <summary>",
    description: "Record a test collapse of one message range",
  },
  { value: "trim ", label: "trim <id>", description: "Record test trimming for one tool-output row" },
] as const;

/** TUI completion items for the first /percy:compact-debug argument. */
export function debugCompletions(argumentPrefix: string) {
  // Pi replaces the whole argument prefix with a selected value. Once the
  // command is complete, leave ranges, ids, and summaries to normal editing.
  if (/\s/.test(argumentPrefix.trimStart())) return null;
  const prefix = argumentPrefix.trimStart();
  const items = DEBUG_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
  return items.length > 0 ? items : null;
}

export type DebugCommand = { kind: "index" } | { kind: "record"; compaction: Compaction };

/**
 * Parses /percy:compact-debug's arguments against history (the current view). A
 * squish takes message numbers; a trim takes an index row id. Throws with the
 * usage, or with why the record does not fit the view.
 */
export function parseDebugCommand(
  args: string,
  history: readonly Item[],
  systemBoundaries: readonly number[] = [],
): DebugCommand {
  const fields = args.trim().split(/\s+/).filter(Boolean);
  if (fields.length === 0 || (fields[0] === "index" && fields.length === 1)) return { kind: "index" };
  const c = emptyCompaction();
  if (fields[0] === "squish" && fields.length >= 3) {
    const range = /^(\d+)-(\d+)$/.exec(fields[1]!);
    if (!range) throw new Error(DEBUG_USAGE);
    // Keep the summary verbatim, inner whitespace included.
    const summary = args
      .trim()
      .slice(args.trim().indexOf(fields[1]!) + fields[1]!.length)
      .trim();
    c.squishes.push({ from: Number(range[1]), to: Number(range[2]), summary });
  } else if (fields[0] === "trim" && fields.length === 2) {
    const view = compactionView(history);
    const { rows } = splitRows(view, view.length);
    const r = indexOfRow(rows, fields[1]!);
    if (r < 0) throw new Error(`no index row ${fields[1]}`);
    c.trims = rowTrims(rows[r]!);
    if (c.trims.length === 0) throw new Error(`no tool output to trim in ${fields[1]}`);
  } else {
    throw new Error(DEBUG_USAGE);
  }
  const after = applyCompaction(history, c); // throws if it does not fit
  const systemProblems = systemBoundaryProblems(after, systemBoundaries);
  if (systemProblems.length > 0) throw new Error(systemProblems.join("\n"));
  return { kind: "record", compaction: c };
}
