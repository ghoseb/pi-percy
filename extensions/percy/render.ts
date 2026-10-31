// TUI rendering of pi-percy's session entries and messages, in the style of
// pi's own compaction message: a box on the custom-message background with a
// bold label, a one-line summary, and the details on expand.
import {
  type CustomEntry,
  getMarkdownTheme,
  keyText,
  type MessageRenderer,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  type Component,
  Markdown,
  MouseRegion,
  Spacer,
  Text,
  TruncatedText,
} from "@earendil-works/pi-tui";
import type { StoredCompaction } from "./branch.ts";

type CustomMessage<T = unknown> = Parameters<MessageRenderer<T>>[0];

function frame(theme: Theme, label: string, outputPad: number, body: Component): Box {
  const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m[${label}]\x1b[22m`), 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(body);
  return box;
}

function collapsed(theme: Theme, summary: string): Text {
  return new Text(
    theme.fg("customMessageText", `${summary} (`) +
      theme.fg("dim", keyText("app.tools.expand")) +
      theme.fg("customMessageText", " to expand)"),
    0,
    0,
  );
}

/**
 * Pi's built-in compaction card expands with both Ctrl+O and a left click.
 * Entry renderers receive the Ctrl+O state from pi; retain a local state too
 * so this card has the same mouse affordance.
 */
function expandableFrame(
  theme: Theme,
  label: string,
  outputPad: number,
  expanded: boolean,
  summary: string,
  details: () => Component,
): Box {
  const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
  let isExpanded = expanded;
  const update = () => {
    box.clear();
    const content = new Container();
    content.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m[${label}]\x1b[22m`), 0, 0));
    content.addChild(new Spacer(1));
    content.addChild(isExpanded ? details() : collapsed(theme, summary));
    box.addChild(
      new MouseRegion(content, (event) => {
        if (event.type !== "click" || event.button !== "left") return undefined;
        isExpanded = !isExpanded;
        update();
        return { handled: true };
      }),
    );
  };
  update();
  return box;
}

function markdown(theme: Theme, text: string): Markdown {
  return new Markdown(text, 0, 0, getMarkdownTheme(), { color: (t: string) => theme.fg("customMessageText", t) });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A concise status line in place of Pi's generic tool-call argument dump. */
export function renderCompactCall(args: unknown, theme: Theme): Component {
  const input = isRecord(args) ? args : {};
  const action = input["action"] === "index" ? "index" : "compact";
  const counts: [number, string][] = [
    [arrayLength(input["collapse"]), "range"],
    [arrayLength(input["collapseUnits"]), "unit"],
    [arrayLength(input["trim"]), "tool output"],
  ];
  const details =
    action === "index"
      ? "index"
      : counts
          .filter(([n]) => n > 0)
          .map(([n, word]) => plural(n, word))
          .join(", ") || "compact";
  return new TruncatedText(
    theme.fg("toolTitle", theme.bold("compact in place")) + theme.fg("dim", ` ${details}`),
    0,
    0,
  );
}

function toolResultText(result: { content: unknown }): string {
  if (typeof result.content === "string") return result.content;
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((block) =>
      isRecord(block) && block["type"] === "text" && typeof block["text"] === "string" ? block["text"] : "",
    )
    .join("\n");
}

function expandableResult(
  theme: Theme,
  summary: string,
  details: string,
  expanded: boolean,
  color: "warning" | "success",
): Component {
  if (expanded) return new Text(theme.fg(color, details), 0, 0);
  return new TruncatedText(
    theme.fg(color, `${summary} (`) + theme.fg("dim", keyText("app.tools.expand")) + theme.fg(color, " to expand)"),
    0,
    0,
  );
}

/** A terse tool-result row; full validation text remains on the expanded TUI view and in LLM context. */
export function renderCompactResult(
  result: { content: unknown },
  options: ToolRenderResultOptions,
  theme: Theme,
  isError: boolean,
): Component {
  const output = toolResultText(result);
  if (isError) {
    const count = /^(\d+) problems:/.exec(output)?.[1];
    const summary =
      count === undefined ? "Nothing compacted" : `Nothing compacted: ${plural(Number(count), "problem")}`;
    return expandableResult(theme, summary, output, options.expanded, "warning");
  }
  if (output.startsWith("## Index")) {
    const rows = (/```\n([\s\S]*?)```/.exec(output)?.[1] ?? "").split("\n").filter(Boolean).length - 1;
    const summary = rows > 0 ? `Index: ${plural(rows, "row")} to compact` : "Index: nothing to compact yet";
    return expandableResult(theme, summary, output, options.expanded, "success");
  }
  return new TruncatedText(theme.fg("success", output), 0, 0);
}

/** A compaction record: what was collapsed and trimmed. */
export function renderRecord(entry: CustomEntry<StoredCompaction>, expanded: boolean, theme: Theme): Component {
  const r = entry.data;
  if (!r) return frame(theme, "compaction", 1, new Text(theme.fg("error", "empty compaction record"), 0, 0));
  const tokenBefore = r.tokensBefore.toLocaleString();
  const counts = `${plural(r.squishes.length, "range")} collapsed, ${plural(r.trims.length, "tool output")} trimmed`;
  const lines = [
    `**Compacted from ${tokenBefore} tokens**`,
    "",
    `Context now uses about ${r.tokensAfter.toLocaleString()} tokens: ${counts}.`,
  ];
  for (const s of r.squishes) {
    lines.push("", `Messages ${s.fromSeq}-${s.toSeq}:`, "", ...s.summary.split("\n").map((l) => `> ${l}`));
  }
  if (r.trims.length > 0) lines.push("", `Trimmed the output of ${r.trims.map((t) => `message ${t.seq}`).join(", ")}.`);
  return expandableFrame(theme, "compaction", 1, expanded, `Compacted from ${tokenBefore} tokens`, () =>
    markdown(theme, lines.join("\n")),
  );
}

function textOf(content: CustomMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n\n");
}

/** A context nudge: the size or idle line, and the index it carried. */
export function renderNudge(
  message: CustomMessage<{ idle?: boolean } | undefined>,
  expanded: boolean,
  outputPad: number,
  theme: Theme,
): Component {
  const text = textOf(message.content);
  if (expanded) return frame(theme, "context", outputPad, markdown(theme, text));
  const first = text.split("\n")[0] ?? "";
  const summary = message.details?.idle
    ? `${/idle for [\d.]+ minutes/.exec(first)?.[0] ?? "Idle"}: asked the agent to compact`
    : `${first.replace(/\.$/, "")}: sent the agent the compaction index`;
  return frame(theme, "context", outputPad, collapsed(theme, summary.charAt(0).toUpperCase() + summary.slice(1)));
}

/** The index shown by /percy:compact-debug. */
export function renderIndex(entry: CustomEntry<{ index: string }>, expanded: boolean, theme: Theme): Component {
  const index = entry.data?.index ?? "";
  if (expanded) return frame(theme, "compaction index", 1, markdown(theme, index));
  const rows = (/```\n([\s\S]*?)```/.exec(index)?.[1] ?? "").split("\n").filter(Boolean).length - 1;
  return frame(
    theme,
    "compaction index",
    1,
    collapsed(theme, rows > 0 ? `${plural(rows, "row")} to compact` : "Nothing to compact yet"),
  );
}
