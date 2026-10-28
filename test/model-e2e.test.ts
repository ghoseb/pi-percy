// The warning when a model's window leaves the nudges too little room before
// pi's own compaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { lateNudgeWarning } from "../extensions/percy/index.ts";
import { DEFAULT_NUDGE } from "../extensions/percy/nudge.ts";
import { startHarness } from "./harness.ts";

const model = (contextWindow: number) => ({ provider: "faux", id: "m", contextWindow });

test("lateNudgeWarning compares the nudges with pi's compaction point", () => {
	const pi = SettingsManager.inMemory({});
	// pi compacts at window - 16384: 983,616 for 1M, 183,616 for 200k.
	assert.equal(lateNudgeWarning(model(1_000_000), pi, DEFAULT_NUDGE), undefined);
	const warning = lateNudgeWarning(model(200_000), pi, DEFAULT_NUDGE);
	assert.ok(warning?.includes("pi compacts faux/m at 183616 tokens"), String(warning));
	assert.ok(warning?.includes("Lower percy.nudgeTokens"), String(warning));
	// One step of room is enough.
	assert.equal(lateNudgeWarning(model(266_384), pi, DEFAULT_NUDGE), undefined);
	assert.ok(lateNudgeWarning(model(266_383), pi, DEFAULT_NUDGE));
	// pi's per-model reserve counts, and no compaction means no warning.
	const reserved = SettingsManager.inMemory({ compaction: { modelOverrides: { "faux/m": { reserveTokens: 800_000 } } } });
	assert.ok(lateNudgeWarning(model(1_000_000), reserved, DEFAULT_NUDGE));
	assert.equal(lateNudgeWarning(model(200_000), SettingsManager.inMemory({ compaction: { enabled: false } }), DEFAULT_NUDGE), undefined);
});

test("selecting a model whose window is too small for the nudges warns once", async () => {
	const warnings = (h: Awaited<ReturnType<typeof startHarness>>) =>
		h.notifications.filter((n) => n.type === "warning" && n.message.includes("percy.nudgeTokens"));
	const small = await startHarness({}, { contextWindow: 200_000 });
	try {
		assert.equal(warnings(small).length, 1);
		await small.send("hello");
		assert.equal(warnings(small).length, 1, "warned again without a model switch");
	} finally {
		small.dispose();
	}
	const big = await startHarness({}, { contextWindow: 1_000_000 });
	try {
		assert.equal(warnings(big).length, 0);
	} finally {
		big.dispose();
	}
});
