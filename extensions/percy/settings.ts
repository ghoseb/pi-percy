// pi-percy's settings: the "percy" key of pi's settings.json files. Project
// settings (<cwd>/.pi/settings.json, honored only for trusted projects)
// override agent-directory settings (~/.pi/agent/settings.json).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_IDLE, type IdleSettings } from "./idle.ts";
import { DEFAULT_NUDGE, type NudgeSettings } from "./nudge.ts";
import { DEFAULT_LIMITS, type Limits } from "./types.ts";

export interface PercySettings {
	limits: Limits;
	nudge: NudgeSettings;
	idle: IdleSettings;
}

export const DEFAULT_SETTINGS: PercySettings = { limits: DEFAULT_LIMITS, nudge: DEFAULT_NUDGE, idle: DEFAULT_IDLE };

/** The keys of the "percy" object, and where each lands. */
const KEYS = {
	nudgeTokens: (s: PercySettings, n: number) => (s.nudge = { ...s.nudge, at: n }),
	nudgeStepTokens: (s: PercySettings, n: number) => (s.nudge = { ...s.nudge, step: n }),
	keepRecentTokens: (s: PercySettings, n: number) => (s.limits = { ...s.limits, keepRecentTokens: n }),
	maxCollapseTokens: (s: PercySettings, n: number) => (s.limits = { ...s.limits, maxCollapseTokens: n }),
	idleMinutes: (s: PercySettings, n: number) => (s.idle = { ...s.idle, minutes: n }),
	idleMinTokens: (s: PercySettings, n: number) => (s.idle = { ...s.idle, minTokens: n }),
} as const;

/** Keys whose value must be positive; the others may be 0. */
const POSITIVE = new Set(["nudgeTokens", "nudgeStepTokens", "maxCollapseTokens"]);

/**
 * Applies one "percy" object (from source, for messages) to base. Returns the
 * result and a problem per key it could not use; those keep their value.
 */
export function applySettings(base: PercySettings, value: unknown, source: string): { settings: PercySettings; problems: string[] } {
	const settings = { ...base };
	const problems: string[] = [];
	if (value === undefined) return { settings, problems };
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return { settings, problems: [`${source}: "percy" must be an object`] };
	}
	for (const [key, v] of Object.entries(value)) {
		const apply = KEYS[key as keyof typeof KEYS];
		if (!apply) {
			problems.push(`${source}: unknown setting percy.${key} (known: ${Object.keys(KEYS).join(", ")})`);
		} else if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (POSITIVE.has(key) && v === 0)) {
			problems.push(`${source}: percy.${key} must be a ${POSITIVE.has(key) ? "positive" : "non-negative"} number`);
		} else {
			apply(settings, v);
		}
	}
	return { settings, problems };
}

/** The "percy" value of a settings file, or undefined if it has none. */
function readPercy(path: string): { value: unknown } | { problem: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { value: undefined };
		return { problem: `${path}: ${(err as Error).message}` };
	}
	try {
		return { value: (JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>)?.percy };
	} catch (err) {
		return { problem: `${path}: ${(err as Error).message}` };
	}
}

/**
 * Loads settings from the agent directory's settings.json and, for a trusted
 * project, the project's, over the defaults.
 */
export function loadSettings(agentDir: string, cwd: string, projectTrusted: boolean, configDirName: string) {
	let settings = DEFAULT_SETTINGS;
	const problems: string[] = [];
	const paths = [join(agentDir, "settings.json"), ...(projectTrusted ? [join(cwd, configDirName, "settings.json")] : [])];
	for (const path of paths) {
		const read = readPercy(path);
		if ("problem" in read) {
			problems.push(read.problem);
			continue;
		}
		const applied = applySettings(settings, read.value, path);
		settings = applied.settings;
		problems.push(...applied.problems);
	}
	return { settings, problems };
}
