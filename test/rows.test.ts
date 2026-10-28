import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens, itemId, recentStart, splitRows } from "../extensions/percy/rows.ts";
import type { Item } from "../extensions/percy/types.ts";
import { compactionView } from "../extensions/percy/view.ts";
import { assistant, assistantMessage, call, compactCall, nudge, output, toolCall, user, x } from "./fixtures.ts";

/** The id of the first row of the recent part of history. */
function recentId(history: Item[], keepRecentTokens: number): string {
	const view = compactionView(history);
	const r = recentStart(view, keepRecentTokens);
	assert.ok(r < view.length, `recent start ${r} of ${view.length}`);
	return itemId(view[r]!);
}

test("estimateTokens follows pi's chars/4", () => {
	assert.equal(estimateTokens(user(1, "do it").message), 2);
	// name (4) + JSON.stringify({"command":"ls"}) (16) = 20 chars.
	assert.equal(estimateTokens(call(1, "a", "bash", { command: "ls" }).message), 5);
	assert.equal(estimateTokens(output(1, "a", x(400)).message), 100);
});

// Port of Shelley's TestRecentPartIgnoresCompacting: the recent part starts
// where it did before the agent began compacting, however much the index
// output, the nudge and the running compact call add.
test("recent part ignores the evidence of compacting", () => {
	const big = x(4 * 15_000); // ~15k tokens
	const history = [
		user(1, "do it"),
		call(2, "a"),
		output(3, "a", big),
		call(4, "b"),
		output(5, "b", big),
		assistant(6, "done"),
		user(7, big + big),
		call(8, "c"),
		output(9, "c", "out"),
		assistant(10, "ok"),
	];
	assert.equal(recentId(history, 20_000), "7");
	const compacting = [
		...history,
		nudge(11),
		compactCall(12, "index"),
		output(13, "index", big, "compact_in_place"),
		compactCall(14, "compact", { text: big }),
	];
	assert.equal(recentId(compacting, 20_000), "7");
	// A single tool output that fills the budget stays with its call.
	const huge = [...history.slice(0, 6), call(7, "d"), output(8, "d", x(4 * 25_000)), compactCall(9, "compact")];
	assert.equal(recentId(huge, 20_000), "7");
});

// Port of Shelley's TestRecentPartHoldsWithParallelCalls: the running call
// shares its message with another call; when they finish that message is
// still there, so the recent part must not start later than while they ran.
test("recent part holds with parallel calls", () => {
	const parallel = assistantMessage(3, toolCall("a", "bash", { text: x(4 * 15_000) }), toolCall("index", "compact_in_place"));
	const running = [user(1, "do it"), assistant(2, "ok"), parallel];
	const done = [...running, output(4, "a", "out"), output(5, "index", "index", "compact_in_place")];
	assert.equal(recentId(running, 10_000), "3");
	assert.equal(recentId(done, 10_000), "3");
});

test("splitRows groups a call with all of its tool results", () => {
	const items = [
		user(1, "go"),
		assistantMessage(2, toolCall("a"), toolCall("b")),
		output(3, "a", "A"),
		output(4, "b", "B"),
		call(5, "lost"),
		assistant(6, "done"),
		output(7, "late", "late"),
	];
	const { rows, recentRow } = splitRows(items, 5);
	assert.deepEqual(
		rows.map((r) => r.map((it) => it.from)),
		[[1], [2, 3, 4], [5], [6], [7]],
	);
	assert.equal(recentRow, 3);
});
