// An in-process pi session with pi-percy loaded and pi's faux provider as the
// model, for end-to-end tests. The faux model is scripted on the last message
// of each request: a user message "call <tool> <json args>" makes it call that
// tool, and "calls [[tool, args], ...]" makes parallel calls; "hello" gets
// GREETING; "fail" gets a provider error; anything else gets the reply "ok".
// A summarization request (pi's compaction or branch summary) gets a summary.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPercyExtension, type PercyOptions, type Timers } from "../extensions/percy/index.ts";

export const GREETING = "Well, hi there! What shall we work on today?";

// Tool call ids are unique across harnesses, as a provider's are: a resumed
// session continues with new ids.
let calls = 0;

export interface Harness {
  session: AgentSession;
  /** Every request the model received, in order. */
  requests: Message[][];
  /** Notifications extensions showed. */
  notifications: { message: string; type?: string }[];
  /** Errors extensions raised (handler failures, invalid boundary entries). */
  errors: string[];
  /** Sends a prompt and waits for the run to settle. */
  send(text: string): Promise<void>;
  /** Sends "call <tool> <args>" and waits. */
  call(tool: string, args: unknown): Promise<void>;
  /** Sends "calls [[tool, args], ...]": parallel calls in one message. */
  calls(list: [string, unknown][]): Promise<void>;
  /** The texts of all tool results, oldest first. */
  toolResults(): { text: string; isError: boolean }[];
  /** The text of the newest tool result, and whether it is an error. */
  lastToolResult(): { text: string; isError: boolean };
  dispose(): void;
}

function textOf(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? `toolCall(${c.name})` : ""))
    .join("");
}

function parseJsonObject(input: string): JsonObject {
  const value: unknown = JSON.parse(input);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tool arguments must be a JSON object");
  }
  return value as JsonObject;
}

/** A tool that returns its text argument, for building up history. */
const echoTool: ExtensionFactory = (pi) => {
  pi.registerTool({
    name: "echo",
    label: "Echo",
    description: "Return the text, repeated times times",
    parameters: Type.Object({ text: Type.String(), times: Type.Optional(Type.Number()) }),
    execute(_id, params) {
      return Promise.resolve({
        content: [{ type: "text", text: params.text.repeat(params.times ?? 1) }],
        details: undefined,
      });
    },
  });
  // Aborts the run, as Escape does.
  pi.registerTool({
    name: "stop",
    label: "Stop",
    description: "Abort the run",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute(_id, _params, _signal, _onUpdate, ctx) {
      ctx.abort();
      return Promise.resolve({ content: [{ type: "text", text: "stopped" }], details: undefined });
    },
  });
};

/**
 * pi-ai's faux usage counts the uncached part of a request twice (as input
 * and as cacheWrite). Make totalTokens the request size plus the output, so
 * context sizes grow and shrink with the request.
 */
const honestUsage: ExtensionFactory = (pi) => {
  pi.on("message_end", (event) => {
    const m = event.message;
    if (m.role !== "assistant") return;
    const u = m.usage;
    return { message: { ...m, usage: { ...u, totalTokens: u.input + u.cacheRead + u.output } } };
  });
};

/** A request with pi's summarization system prompt. */
const isSummarization = (messages: Message[]) =>
  messages[0]?.role === "system" && JSON.stringify(messages[0].content).includes("context summarization assistant");

const isContextNudge = (m: Message) => m.role === "user" && /^Context is \d+k\./.test(textOf(m));

function withoutTrailingNudges(messages: Message[]): Message[] {
  let end = messages.length;
  while (end > 0 && isContextNudge(messages[end - 1]!)) end--;
  return messages.slice(0, end);
}

/** A scripted model reply (see HarnessOptions.respond). */
export type Reply = { tool: string; args: Record<string, unknown> } | { error: string } | string | undefined;

export interface HarnessOptions {
  contextWindow?: number;
  /** pi settings, in memory. */
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  /**
   * Answers a request before the default script: a tool call, a text
   * reply, a provider error, or undefined to fall through. It runs while the
   * request is in flight, so it can also act on the running session.
   */
  respond?: (messages: Message[]) => Reply | Promise<Reply>;
  /** Continue this session, as resuming it would. */
  sessionManager?: SessionManager;
  /** Result returned by confirmation dialogs. Defaults to approval. */
  confirm?: boolean;
  /** More extensions, loaded after pi-percy. */
  extensions?: ExtensionFactory[];
  /** pi-percy's idle timer. Defaults to real timers. */
  timers?: Timers;
  /** The session's working and agent directory. Defaults to a new temporary one. */
  dir?: string;
}

/** Starts a session with pi-percy on its defaults, overridden by settings; pi's settings.json files are not read. */
export async function startHarness(
  settings: PercyOptions["settings"] = {},
  harness: HarnessOptions = {},
): Promise<Harness> {
  const contextWindow = harness.contextWindow ?? 1_000_000;
  const dir = harness.dir ?? mkdtempSync(join(tmpdir(), "percy-test-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux", contextWindow }] });
  const requests: Message[][] = [];
  const respond = async (ctx: { messages: Message[] }) => {
    requests.push(structuredClone(ctx.messages));
    // The script answers the message before a context nudge, which pi-percy
    // sends after a prompt or tool results.
    const messages = withoutTrailingNudges(ctx.messages);
    if (isSummarization(ctx.messages)) return fauxAssistantMessage(fauxText("## Goal\nSummary of the conversation."));
    const custom = await harness.respond?.(messages);
    if (typeof custom === "string") return fauxAssistantMessage(fauxText(custom));
    if (custom && "error" in custom)
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: custom.error });
    if (custom) return fauxAssistantMessage(fauxToolCall(custom.tool, custom.args as never, { id: `call${++calls}` }));
    const last = messages[messages.length - 1];
    const call = last?.role === "user" ? /^call (\w+) (.*)$/s.exec(textOf(last)) : null;
    if (call) return fauxAssistantMessage(fauxToolCall(call[1]!, parseJsonObject(call[2]!), { id: `call${++calls}` }));
    const many = last?.role === "user" ? /^calls (.*)$/s.exec(textOf(last)) : null;
    if (many) {
      const list = JSON.parse(many[1]!) as [string, Record<string, never>][];
      return fauxAssistantMessage(list.map(([name, args]) => fauxToolCall(name, args, { id: `call${++calls}` })));
    }
    if (last?.role === "user" && textOf(last) === "hello") return fauxAssistantMessage(fauxText(GREETING));
    if (last?.role === "user" && textOf(last) === "fail") {
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "faux provider failure" });
    }
    return fauxAssistantMessage(fauxText("ok"));
  };
  faux.setResponses(Array.from({ length: 1000 }, () => respond));

  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => pi.registerProvider(faux.provider),
      honestUsage,
      echoTool,
      createPercyExtension({
        settings,
        piSettings: () => SettingsManager.inMemory(harness.settings ?? {}),
        ...(harness.timers ? { timers: harness.timers } : {}),
      }),
      ...(harness.extensions ?? []),
    ],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: harness.sessionManager ?? SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory(harness.settings ?? {}),
    noTools: "builtin",
  });
  // Bind a UI that records notifications, and collect extension errors.
  const notifications: { message: string; type?: string }[] = [];
  const errors: string[] = [];
  // pi copies the UI's own properties, so it must be a plain object.
  const ui = {
    confirm: () => Promise.resolve(harness.confirm ?? true),
    notify: (message: string, type?: string) => {
      notifications.push(type === undefined ? { message } : { message, type });
    },
  } as unknown as ExtensionUIContext;
  await session.bindExtensions({
    uiContext: ui,
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: () => Promise.resolve({ cancelled: true }),
      fork: () => Promise.resolve({ cancelled: true }),
      navigateTree: (targetId, options) => session.navigateTree(targetId, options),
      switchSession: () => Promise.resolve({ cancelled: true }),
      reload: () => session.reload(),
    },
    onError: (e) => errors.push(`${e.event}: ${e.error}`),
  });
  await session.setModel(faux.getModel());

  const h: Harness = {
    session,
    requests,
    notifications,
    errors,
    send: (t) => session.prompt(t),
    call: (tool, args) => session.prompt(`call ${tool} ${JSON.stringify(args)}`),
    calls: (list) => session.prompt(`calls ${JSON.stringify(list)}`),
    toolResults: () =>
      session.sessionManager
        .getBranch()
        .flatMap((e) => (e.type === "message" && e.message.role === "toolResult" ? [e.message] : []))
        .map((r) => ({ text: textOf(r), isError: r.isError })),
    lastToolResult() {
      const results = session.sessionManager
        .getBranch()
        .flatMap((e) => (e.type === "message" && e.message.role === "toolResult" ? [e.message] : []));
      const r = results[results.length - 1];
      if (!r) throw new Error("no tool result yet");
      return { text: textOf(r), isError: r.isError };
    },
    dispose() {
      session.dispose();
      // Every test checks that no extension handler failed.
      if (errors.length > 0) throw new Error(`extension errors: ${errors.join("; ")}`);
    },
  };
  return h;
}

/** The texts of a request's messages, one string per message ("role: text"). */
export function dump(request: Message[]): string[] {
  return request.map((m) => `${m.role}: ${textOf(m)}`);
}
