// Token estimates, the recent part, and the rows of the index.
import { hasToolCall, isToolResult } from "./messages.ts";
import type { AgentMessage, Item } from "./types.ts";

/** pi's estimate for an image block, in characters. */
const IMAGE_CHARS = 4800;

function contentChars(content: string | readonly { type: string; text?: string }[]): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) chars += block.text.length;
		else if (block.type === "image") chars += IMAGE_CHARS;
	}
	return chars;
}

/** Port of pi's estimateTokens: characters / 4, rounded up. */
export function estimateTokens(m: AgentMessage): number {
	let chars = 0;
	switch (m.role) {
		case "user":
		case "custom":
		case "toolResult":
			chars = contentChars(m.content);
			break;
		case "assistant":
			for (const block of m.content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
			}
			break;
		case "bashExecution":
			chars = m.command.length + m.output.length;
			break;
		case "branchSummary":
		case "compactionSummary":
			chars = m.summary.length;
			break;
	}
	return Math.ceil(chars / 4);
}

export function itemTokens(items: readonly Item[]): number {
	let n = 0;
	for (const it of items) n += estimateTokens(it.message);
	return n;
}

/**
 * Port of pi's findCutPoint on a flat message list: the index of the first
 * message kept verbatim, about keepRecentTokens of the newest history. The cut
 * never lands on a tool result, so kept history never starts with an orphaned
 * one. If a tool result alone fills the budget, it stays with its call.
 */
export function findCutPoint(messages: readonly AgentMessage[], keepRecentTokens: number): number {
	const cutPoints: number[] = [];
	messages.forEach((m, i) => {
		if (!isToolResult(m)) cutPoints.push(i);
	});
	if (cutPoints.length === 0) return 0;
	let cut = cutPoints[0]!;
	let accumulated = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		accumulated += estimateTokens(messages[i]!);
		if (accumulated >= keepRecentTokens) {
			cut = cutPoints.find((c) => c >= i) ?? cutPoints[cutPoints.length - 1]!;
			break;
		}
	}
	return cut;
}

/** The index of the first item of the recent part, which is kept as is. */
export function recentStart(items: readonly Item[], keepRecentTokens: number): number {
	return findCutPoint(
		items.map((it) => it.message),
		keepRecentTokens,
	);
}

export type Row = Item[];

/**
 * Groups items into the index's rows, and returns the index of the first row
 * of the recent part, which starts at items[recent]. A message with tool calls
 * shares a row with the tool results that follow it, so a range of rows cannot
 * split a call from its output. The recent part never starts at a tool result,
 * so no row straddles it.
 */
export function splitRows(items: readonly Item[], recent: number): { rows: Row[]; recentRow: number } {
	const rows: Row[] = [];
	const group = (part: readonly Item[]) => {
		for (let k = 0; k < part.length; ) {
			let end = k + 1;
			if (hasToolCall(part[k]!.message)) {
				while (end < part.length && isToolResult(part[end]!.message)) end++;
			}
			rows.push(part.slice(k, end));
			k = end;
		}
	};
	group(items.slice(0, recent));
	const recentRow = rows.length;
	group(items.slice(recent));
	return { rows, recentRow };
}

/** An item's id in the index: its message number, or its note id. */
export function itemId(it: Item): string {
	return it.note ? it.note.id : String(it.from);
}

/** A row's id in the index: that of its first item. */
export function rowId(row: Row): string {
	return itemId(row[0]!);
}

export function indexOfRow(rows: readonly Row[], id: string): number {
	return rows.findIndex((row) => rowId(row) === id);
}

// Rows keep calls with their outputs, but a call can lack its output (pi
// stopped while it ran), or an output its call. A range may not start at such
// an output or end at such a call: it would leave the call, or the output,
// behind.
export function orphanOutput(row: Row): boolean {
	return isToolResult(row[0]!.message);
}

export function orphanCall(row: Row): boolean {
	return hasToolCall(row[row.length - 1]!.message);
}
