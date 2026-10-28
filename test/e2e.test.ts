// End-to-end: pi-percy in a real pi session with a scripted faux model.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { RECORD_TYPE } from "../extensions/percy/branch.ts";
import { noteText, trimmedText } from "../extensions/percy/messages.ts";
import { dump, GREETING, type Harness, startHarness } from "./harness.ts";

/** Message number (branch position) of the first entry matching. */
function seqWhere(h: Harness, match: (e: SessionEntry) => boolean): number {
	const i = h.session.sessionManager.getBranch().findIndex(match);
	assert.ok(i >= 0, "no matching entry");
	return i + 1;
}

const isMessage = (role: string, text: string) => (e: SessionEntry) =>
	e.type === "message" && e.message.role === role && JSON.stringify(e.message).includes(text);
const isCall = (text: string) => (e: SessionEntry) =>
	e.type === "message" &&
	e.message.role === "assistant" &&
	e.message.content.some((c) => c.type === "toolCall" && JSON.stringify(c.arguments).includes(text));

const records = (h: Harness) =>
	h.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === RECORD_TYPE).length;

// Port of Shelley's TestCompactInPlaceEndToEnd: the index lists the view,
// invalid requests come back as tool errors, and a valid one compacts the
// history the rest of the same turn, and later turns, see.
let h: Harness;
before(async () => {
	h = await startHarness({ limits: { keepRecentTokens: 1 } });
});
after(() => h.dispose());

test("compact_in_place end to end", async () => {
	await h.send("hello");
	await h.call("echo", { text: "FIRST_OUTPUT" });
	await h.call("echo", { text: "SECOND_OUTPUT" });

	const helloSeq = seqWhere(h, isMessage("user", '"hello"'));
	const greetingSeq = seqWhere(h, isMessage("assistant", "Well, hi there!"));
	const firstCallSeq = seqWhere(h, isCall("FIRST_OUTPUT"));
	const firstResultSeq = seqWhere(h, isMessage("toolResult", "FIRST_OUTPUT"));

	await h.call("compact_in_place", { action: "index" });
	const index = h.lastToolResult();
	assert.equal(index.isError, false, index.text);
	assert.ok(index.text.startsWith("## Index"), index.text);
	assert.ok(index.text.includes("is kept as is and not listed"), index.text);
	assert.match(index.text, new RegExp(`^${helloSeq} +user\\* `, "m"));
	// The call and its output share a row, under the call's id.
	assert.match(index.text, new RegExp(`^${firstCallSeq} +assistant +\\d+ +echo "FIRST_OUTPUT" → \\d+$`, "m"));

	// Invalid requests come back as errors and record nothing.
	const invalid: [string, unknown][] = [
		["unknown id", [{ from: "999999", to: String(greetingSeq), note: "x" }]],
		["from comes after to", [{ from: String(greetingSeq), to: String(helloSeq), note: "x" }]],
		["note is not shorter", [{ from: String(greetingSeq), to: String(greetingSeq), note: "long ".repeat(100) }]],
		["only be collapsed on", [{ from: String(helloSeq), to: String(greetingSeq), note: "x" }]],
	];
	for (const [want, collapse] of invalid) {
		await h.call("compact_in_place", { action: "compact", collapse });
		const r = h.lastToolResult();
		assert.ok(r.isError && r.text.includes(want), `want ${want}, got ${r.text}`);
	}
	await h.call("compact_in_place", { action: "compact", trim: ["nope"] });
	assert.ok(h.lastToolResult().text.includes("trim nope: unknown id"));
	assert.equal(records(h), 0);

	// Ids may come as numbers.
	await h.call("compact_in_place", {
		action: "compact",
		trim: [firstCallSeq],
		collapse: [{ from: greetingSeq, to: greetingSeq, note: "GREETED" }],
	});
	const done = h.lastToolResult();
	assert.ok(!done.isError && done.text.startsWith("Compacted: 1 collapsed, 1 trimmed"), done.text);
	assert.equal(records(h), 1);

	// The request after the tool call, in the same turn, already sees the
	// compacted history, ending with the compact call's output.
	const check = (request: string[]) => {
		const all = request.join("\n");
		assert.equal(request[2], `assistant: ${noteText(greetingSeq, greetingSeq, "GREETED")}`, all);
		assert.ok(!all.includes(GREETING), all);
		assert.ok(all.includes(trimmedText(firstResultSeq)), all);
		assert.ok(!all.includes("toolResult: FIRST_OUTPUT"), all);
		assert.ok(all.includes("toolResult: SECOND_OUTPUT"), all);
		assert.equal(all.split("Compacted: 1 collapsed").length - 1, 1, all);
		// Earlier compact_in_place calls (the index, failed attempts) are
		// hidden; only the successful call remains, as a receipt.
		assert.ok(!all.includes("## Index") && !all.includes("unknown id"), all);
		assert.equal(all.split("toolCall(compact_in_place)").length - 1, 1, all);
	};
	check(dump(h.requests[h.requests.length - 1]!));

	// A later turn sees the same history.
	await h.send("after");
	check(dump(h.requests[h.requests.length - 1]!));

	// The originals are untouched in the session.
	const raw = h.session.sessionManager.getBranch()[firstResultSeq - 1]!;
	assert.ok(raw.type === "message" && JSON.stringify(raw.message).includes("FIRST_OUTPUT"));

	// The next index shows the note and the trimmed output.
	await h.call("compact_in_place", { action: "index" });
	const again = h.lastToolResult().text;
	assert.match(again, /^s\d+\.0 +note\* +\d+ +note "GREETED"$/m);
	assert.ok(again.includes('echo "FIRST_OUTPUT" → trimmed'), again);

	// recall shows the originals, by note id or message number.
	const noteId = /^(s\d+\.0) /m.exec(again)![1]!;
	await h.call("recall", { ids: [noteId, firstResultSeq] });
	const recalled = h.lastToolResult();
	assert.equal(recalled.isError, false, recalled.text);
	assert.ok(recalled.text.includes(`## Message ${greetingSeq} (assistant)\n${GREETING}`), recalled.text);
	assert.ok(recalled.text.includes(`## Message ${firstResultSeq} (echo output for #`), recalled.text);
	assert.ok(recalled.text.includes("FIRST_OUTPUT"), recalled.text);
	await h.call("recall", { ids: ["s999.0", "x"] });
	const bad = h.lastToolResult();
	assert.ok(bad.isError && bad.text.includes("s999.0: no such note") && bad.text.includes("x: not a message"), bad.text);
});

test("only one compaction per turn applies", async () => {
	const p = await startHarness({ limits: { keepRecentTokens: 1 } });
	try {
		await p.send("hello");
		await p.call("echo", { text: "OUT" });
		const greetingSeq = seqWhere(p, isMessage("assistant", "Well, hi there!"));
		const callSeq = seqWhere(p, isCall("OUT"));
		await p.calls([
			["compact_in_place", { action: "compact", collapse: [{ from: greetingSeq, to: greetingSeq, note: "GREETED" }] }],
			["compact_in_place", { action: "compact", trim: [callSeq] }],
		]);
		const [first, second] = p.toolResults().slice(-2);
		assert.ok(first && !first.isError && first.text.startsWith("Compacted: 1 collapsed"), JSON.stringify(first));
		assert.ok(second?.isError && second.text.includes("waiting to be applied"), JSON.stringify(second));
		assert.equal(records(p), 1);
		// The next request has the first compaction and not the second.
		const all = dump(p.requests[p.requests.length - 1]!).join("\n");
		assert.ok(all.includes(noteText(greetingSeq, greetingSeq, "GREETED")), all);
		assert.ok(all.includes("toolResult: OUT"), all);
	} finally {
		p.dispose();
	}
});

test("a compaction made just before an abort is applied", async () => {
	const a = await startHarness({ limits: { keepRecentTokens: 1 } });
	try {
		await a.send("hello");
		await a.call("echo", { text: "OUT" });
		const greetingSeq = seqWhere(a, isMessage("assistant", "Well, hi there!"));
		const callSeq = seqWhere(a, isCall("OUT"));
		// The stop tool aborts the run right after the compaction in its batch.
		await a.calls([
			["compact_in_place", { action: "compact", collapse: [{ from: greetingSeq, to: greetingSeq, note: "GREETED" }] }],
			["stop", {}],
		]);
		assert.equal(records(a), 1);
		await a.send("next");
		assert.ok(dump(a.requests[a.requests.length - 1]!).join("\n").includes(noteText(greetingSeq, greetingSeq, "GREETED")));
		// Nothing is left waiting: the next compaction goes through.
		await a.call("compact_in_place", { action: "compact", trim: [callSeq] });
		assert.equal(a.lastToolResult().isError, false, a.lastToolResult().text);
		assert.equal(a.notifications.filter((n) => n.message.includes("not applied")).length, 0);
	} finally {
		a.dispose();
	}
});
