import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applySettings, DEFAULT_SETTINGS, loadSettings } from "../extensions/percy/settings.ts";

test("applySettings maps keys and reports what it cannot use", () => {
	const { settings, problems } = applySettings(
		DEFAULT_SETTINGS,
		{
			nudgeTokens: 150_000,
			nudgeStepTokens: 25_000,
			keepRecentTokens: 0,
			maxCollapseTokens: 10_000,
			idleMinutes: 0,
			idleMinTokens: 40_000,
		},
		"s.json",
	);
	assert.deepEqual(problems, []);
	assert.deepEqual(settings, {
		limits: { keepRecentTokens: 0, maxCollapseTokens: 10_000 },
		nudge: { at: 150_000, step: 25_000 },
		idle: { minutes: 0, minTokens: 40_000 },
	});

	const bad = applySettings(DEFAULT_SETTINGS, { nudgeTokens: 0, idleMinutes: -1, maxCollapseTokens: "x", nope: 1 }, "s.json");
	assert.deepEqual(bad.settings, DEFAULT_SETTINGS);
	assert.equal(bad.problems.length, 4);
	assert.ok(bad.problems[0]!.includes("percy.nudgeTokens must be a positive number"), String(bad.problems[0]));
	assert.ok(bad.problems[1]!.includes("percy.idleMinutes must be a non-negative number"), String(bad.problems[1]));
	assert.ok(bad.problems[3]!.includes("unknown setting percy.nope"), String(bad.problems[3]));

	assert.deepEqual(applySettings(DEFAULT_SETTINGS, undefined, "s.json"), { settings: DEFAULT_SETTINGS, problems: [] });
	assert.deepEqual(applySettings(DEFAULT_SETTINGS, [1], "s.json").problems, ['s.json: "percy" must be an object']);
});

test("loadSettings layers the project's settings over the agent directory's", () => {
	const root = mkdtempSync(join(tmpdir(), "percy-settings-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	// A BOM, as Windows editors write, is fine.
	writeFileSync(join(agentDir, "settings.json"), `\uFEFF${JSON.stringify({ theme: "dark", percy: { nudgeTokens: 150_000, idleMinutes: 3 } })}`);
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ percy: { idleMinutes: 0 } }));

	const trusted = loadSettings(agentDir, cwd, true, ".pi");
	assert.deepEqual(trusted.problems, []);
	assert.equal(trusted.settings.nudge.at, 150_000);
	assert.equal(trusted.settings.idle.minutes, 0);

	// An untrusted project's settings are not read.
	assert.equal(loadSettings(agentDir, cwd, false, ".pi").settings.idle.minutes, 3);

	// Missing files are fine; broken ones are reported and skipped.
	assert.deepEqual(loadSettings(join(root, "none"), join(root, "none"), true, ".pi"), { settings: DEFAULT_SETTINGS, problems: [] });
	writeFileSync(join(cwd, ".pi", "settings.json"), "{ broken");
	const broken = loadSettings(agentDir, cwd, true, ".pi");
	assert.equal(broken.settings.idle.minutes, 3);
	assert.equal(broken.problems.length, 1);
	assert.ok(broken.problems[0]!.startsWith(join(cwd, ".pi", "settings.json")), String(broken.problems[0]));
});
