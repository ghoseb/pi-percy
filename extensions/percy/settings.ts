// pi-percy's settings: the "percy" key of pi's settings.json files, as pi's
// SettingsManager merges them (a trusted project's over the agent
// directory's, key by key).
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_IDLE, type IdleSettings } from "./idle.ts";
import { DEFAULT_NUDGE, type NudgeSettings } from "./nudge.ts";
import { DEFAULT_LIMITS, type Limits } from "./types.ts";

export interface PercySettings {
  limits: Limits;
  nudge: NudgeSettings;
  idle: IdleSettings;
  minCompactionSavingsTokens: number;
}

export const DEFAULT_SETTINGS: PercySettings = {
  limits: DEFAULT_LIMITS,
  nudge: DEFAULT_NUDGE,
  idle: DEFAULT_IDLE,
  minCompactionSavingsTokens: 50_000,
};

/** The keys of the "percy" object, and where each lands. */
const KEYS = {
  nudgeTokens: (s: PercySettings, n: number) => (s.nudge = { ...s.nudge, at: n }),
  nudgeStepTokens: (s: PercySettings, n: number) => (s.nudge = { ...s.nudge, step: n }),
  keepRecentTokens: (s: PercySettings, n: number) => (s.limits = { ...s.limits, keepRecentTokens: n }),
  maxCollapseTokens: (s: PercySettings, n: number) => (s.limits = { ...s.limits, maxCollapseTokens: n }),
  idleMinutes: (s: PercySettings, n: number) => (s.idle = { ...s.idle, minutes: n }),
  idleMinTokens: (s: PercySettings, n: number) => (s.idle = { ...s.idle, minTokens: n }),
  minCompactionSavingsTokens: (s: PercySettings, n: number) => (s.minCompactionSavingsTokens = n),
} as const;

/** Keys whose value must be positive; the others may be 0. */
const POSITIVE = new Set(["nudgeTokens", "nudgeStepTokens", "maxCollapseTokens"]);

/**
 * Applies one "percy" object (from source, for messages) to base. Returns the
 * result and a problem per key it could not use; those keep their value.
 */
export function applySettings(
  base: PercySettings,
  value: unknown,
  source: string,
): { settings: PercySettings; problems: string[] } {
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

/**
 * Reads the settings from pi's merged settings over the defaults. Problems
 * include the files pi could not load.
 */
export function loadSettings(manager: Pick<SettingsManager, "getSettings" | "drainErrors">): {
  settings: PercySettings;
  problems: string[];
} {
  const value = (manager.getSettings() as Record<string, unknown>)["percy"];
  const applied = applySettings(DEFAULT_SETTINGS, value, "settings.json");
  const unread = manager.drainErrors().map((e) => `${e.path ?? `${e.scope} settings`}: ${e.error.message}`);
  return { settings: applied.settings, problems: [...unread, ...applied.problems] };
}
