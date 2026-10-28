// TUI rendering of pi-percy's session entries and messages, in the style of
// pi's own compaction message: a box on the custom-message background with a
// bold label, a one-line summary, and the details on expand.
import { type CustomEntry, getMarkdownTheme, keyText, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
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

function markdown(theme: Theme, text: string): Markdown {
	return new Markdown(text, 0, 0, getMarkdownTheme(), { color: (t: string) => theme.fg("customMessageText", t) });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A compaction record: what was collapsed and trimmed. */
export function renderRecord(entry: CustomEntry<StoredCompaction>, expanded: boolean, theme: Theme): Component {
	const r = entry.data;
	if (!r) return frame(theme, "compaction", 1, new Text(theme.fg("error", "empty compaction record"), 0, 0));
	const counts = `${plural(r.squishes.length, "range")} collapsed, ${plural(r.trims.length, "output")} trimmed`;
	const sizes = `~${r.tokensBefore.toLocaleString()} to ~${r.tokensAfter.toLocaleString()} tokens`;
	if (!expanded) return frame(theme, "compaction", 1, collapsed(theme, `Compacted in place from ${sizes}: ${counts}`));
	const lines = [`**Compacted in place from ${sizes}**`, ""];
	for (const s of r.squishes) {
		lines.push(`Messages ${s.fromSeq}-${s.toSeq}:`, "", ...s.summary.split("\n").map((l) => `> ${l}`), "");
	}
	if (r.trims.length > 0) lines.push(`Trimmed the output of ${r.trims.map((t) => `message ${t.seq}`).join(", ")}.`);
	return frame(theme, "compaction", 1, markdown(theme, lines.join("\n").trimEnd()));
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

/** The index shown by /compact-debug. */
export function renderIndex(entry: CustomEntry<{ index: string }>, expanded: boolean, theme: Theme): Component {
	const index = entry.data?.index ?? "";
	if (expanded) return frame(theme, "compaction index", 1, markdown(theme, index));
	const rows = (/```\n([\s\S]*?)```/.exec(index)?.[1] ?? "").split("\n").filter(Boolean).length - 1;
	return frame(theme, "compaction index", 1, collapsed(theme, rows > 0 ? `${plural(rows, "row")} to compact` : "Nothing to compact yet"));
}
