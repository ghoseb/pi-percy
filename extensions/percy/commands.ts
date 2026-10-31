// pi-percy's commands: ask the agent to compact, the debug aid, rewind,
// toggle, and status. Only the compact request makes a model request.
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { compactionDrafts, currentView, isRecordEntry } from "./branch.ts";
import { debugCompletions, DEBUG_USAGE, INDEX_TYPE, type IndexEntry, parseDebugCommand } from "./debug.ts";
import { worthIdleCompaction } from "./idle.ts";
import { buildIndex } from "./index-render.ts";
import { errorText } from "./messages.ts";
import { itemTokens } from "./rows.ts";
import type { PercySettings } from "./settings.ts";
import {
  COMPACT_COMMAND,
  COMPACT_TOOL,
  DEBUG_COMMAND,
  REWIND_COMMAND,
  STATUS_COMMAND,
  TOGGLE_COMMAND,
} from "./types.ts";
import { applyCompaction, editsBetween } from "./view.ts";

/** What /percy:compact-in-place asks the agent, as Shelley's Compact in Place button does. */
export const COMPACT_REQUEST = "Compact your context in place.";

/** What the commands read and change of pi-percy's state. */
export interface CommandDeps {
  settings: () => PercySettings;
  /** Queues a compaction's entries for turn_end to append. */
  recordDebug: (drafts: SessionBoundaryDraft[]) => void;
  compactionEnabled: () => boolean;
  toggleCompaction: () => void;
  idleStatus: (ctx: ExtensionContext) => string;
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand(COMPACT_COMMAND, {
    description: "Ask the agent to compact its context in place (optional: what to keep)",
    handler: (args, ctx) => {
      const instructions = args.trim();
      const request = instructions ? `${COMPACT_REQUEST}\n\n${instructions}` : COMPACT_REQUEST;
      // Queued behind a running turn, as Shelley queues it.
      pi.sendUserMessage(request, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      return Promise.resolve();
    },
  });

  pi.registerCommand(DEBUG_COMMAND, {
    description: `Testing aid for in-place compaction (${DEBUG_USAGE.replace("usage: ", "")})`,
    getArgumentCompletions: debugCompletions,
    handler: (args, ctx) => {
      try {
        const view = currentView(ctx);
        const command = parseDebugCommand(args, view.items, view.systemBoundaries);
        if (command.kind === "index") {
          const index = buildIndex(view.items, deps.settings().limits, view.systemBoundaries);
          pi.appendEntry<IndexEntry>(INDEX_TYPE, { index: index.text, rows: index.rows });
          return Promise.resolve();
        }
        // Commands cannot append context edits; turn_end does.
        const c = command.compaction;
        const after = applyCompaction(view.items, c);
        const sizes = { tokensBefore: itemTokens(view.items), tokensAfter: itemTokens(after) };
        deps.recordDebug(compactionDrafts(view, c, editsBetween(view.items, after), sizes));
        ctx.ui.notify("pi-percy: recorded; it applies after the next model response", "info");
      } catch (err) {
        ctx.ui.notify(`pi-percy: ${errorText(err)}`, "error");
      }
      return Promise.resolve();
    },
  });

  pi.registerCommand(REWIND_COMMAND, {
    description: "Rewind the active branch to before the newest pi-percy compaction",
    async handler(_args, ctx) {
      if (!ctx.isIdle()) {
        ctx.ui.notify("pi-percy: wait for the current turn to finish before rewinding compaction", "warning");
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const record = branch.findLast(isRecordEntry);
      if (!record?.parentId) {
        ctx.ui.notify("pi-percy: no compaction on this branch to undo", "warning");
        return;
      }
      const later = branch.length - branch.indexOf(record) - 1;
      const confirmed = await ctx.ui.confirm(
        "Rewind pi-percy compaction?",
        `This returns to before the newest compaction. ${later} later ${later === 1 ? "entry" : "entries"} stay on an alternate branch; use /tree to return.`,
      );
      if (!confirmed) return;
      const result = await ctx.navigateTree(record.parentId, { summarize: false });
      if (result.cancelled) {
        ctx.ui.notify("pi-percy: compaction rewind was cancelled", "warning");
        return;
      }
      ctx.ui.notify("pi-percy: rewound the branch to before the newest compaction", "info");
    },
  });

  pi.registerCommand(TOGGLE_COMMAND, {
    description: "Enable or disable pi-percy context compaction for this session",
    handler: (_args, ctx) => {
      deps.toggleCompaction();
      ctx.ui.notify(
        `pi-percy: compaction ${deps.compactionEnabled() ? "enabled" : "disabled"} for this session`,
        "info",
      );
      return Promise.resolve();
    },
  });

  pi.registerCommand(STATUS_COMMAND, {
    description: "Show pi-percy compaction status without a model request",
    handler: (_args, ctx) => {
      const settings = deps.settings();
      const view = currentView(ctx);
      const state = !pi.getActiveTools().includes(COMPACT_TOOL)
        ? `${COMPACT_TOOL} is not active`
        : deps.compactionEnabled()
          ? "enabled"
          : "disabled";
      const eligible = worthIdleCompaction(view.items, settings.limits, settings.idle.minTokens);
      ctx.ui.notify(
        [
          `pi-percy: ${state}`,
          `history: ~${itemTokens(view.items)} tokens`,
          `nudges: ~${settings.nudge.at} tokens, then every ~${settings.nudge.step}`,
          `idle: ${deps.idleStatus(ctx)}; ${eligible ? "eligible" : `requires ~${settings.idle.minTokens} tokens and older history`}`,
        ].join("\n"),
        "info",
      );
      return Promise.resolve();
    },
  });
}
