// /compact-debug, a testing aid: show the index, or record a squish or trim
// directly, without the validation compact_in_place applies. Port of
// Shelley's /compact-debug.
import { indexOfRow, splitRows } from "./rows.ts";
import { type Compaction, emptyCompaction, type Item } from "./types.ts";
import { rowTrims } from "./validate.ts";
import { applyCompaction, compactionView } from "./view.ts";

export const DEBUG_USAGE = "usage: /compact-debug | /compact-debug squish <from>-<to> <summary> | /compact-debug trim <id>";

export type DebugCommand = { kind: "index" } | { kind: "record"; compaction: Compaction };

/**
 * Parses /compact-debug's arguments against history (the current view). A
 * squish takes message numbers; a trim takes an index row id. Throws with the
 * usage, or with why the record does not fit the view.
 */
export function parseDebugCommand(args: string, history: readonly Item[]): DebugCommand {
	const fields = args.trim().split(/\s+/).filter(Boolean);
	if (fields.length === 0) return { kind: "index" };
	const c = emptyCompaction();
	if (fields[0] === "squish" && fields.length >= 3) {
		const range = /^(\d+)-(\d+)$/.exec(fields[1]!);
		if (!range) throw new Error(DEBUG_USAGE);
		// Keep the summary verbatim, inner whitespace included.
		const summary = args.trim().slice(args.trim().indexOf(fields[1]!) + fields[1]!.length).trim();
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
	applyCompaction(history, c, 0); // throws if it does not fit
	return { kind: "record", compaction: c };
}
