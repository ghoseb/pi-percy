// An in-process pi session with pi-percy loaded and pi's faux provider as the
// model, for end-to-end tests. The faux model is scripted on the last message
// of each request: a user message "call <tool> <json args>" makes it call that
// tool, and "calls [[tool, args], ...]" makes parallel calls; "hello" gets
// GREETING; anything else gets the reply "ok".
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
import { createPercyExtension, type PercyOptions } from "../extensions/percy/index.ts";

export const GREETING = "Well, hi there! What shall we work on today?";

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

export interface HarnessOptions {
  contextWindow?: number;
  /** pi settings, in memory. */
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  /**
   * Answers a request before the default script: a tool call, a text
   * reply, or undefined to fall through.
   */
  respond?: (messages: Message[]) => { tool: string; args: Record<string, unknown> } | string | undefined;
  /** Continue this session, as resuming it would. */
  sessionManager?: SessionManager;
  /** Result returned by confirmation dialogs. Defaults to approval. */
  confirm?: boolean;
}

/** Starts a session with pi-percy on its defaults, overridden by settings; pi's settings.json files are not read. */
export async function startHarness(
  settings: PercyOptions["settings"] = {},
  harness: HarnessOptions = {},
): Promise<Harness> {
  const contextWindow = harness.contextWindow ?? 1_000_000;
  const dir = mkdtempSync(join(tmpdir(), "percy-test-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux", contextWindow }] });
  const requests: Message[][] = [];
  let calls = 0;
  const respond = (ctx: { messages: Message[] }) => {
    requests.push(structuredClone(ctx.messages));
    const custom = harness.respond?.(ctx.messages);
    if (typeof custom === "string") return fauxAssistantMessage(fauxText(custom));
    if (custom) return fauxAssistantMessage(fauxToolCall(custom.tool, custom.args as never, { id: `call${++calls}` }));
    const last = ctx.messages[ctx.messages.length - 1];
    const call = last?.role === "user" ? /^call (\w+) (.*)$/s.exec(textOf(last)) : null;
    if (call) return fauxAssistantMessage(fauxToolCall(call[1]!, parseJsonObject(call[2]!), { id: `call${++calls}` }));
    const many = last?.role === "user" ? /^calls (.*)$/s.exec(textOf(last)) : null;
    if (many) {
      const list = JSON.parse(many[1]!) as [string, Record<string, never>][];
      return fauxAssistantMessage(list.map(([name, args]) => fauxToolCall(name, args, { id: `call${++calls}` })));
    }
    if (last?.role === "user" && textOf(last) === "hello") return fauxAssistantMessage(fauxText(GREETING));
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
      createPercyExtension({ settings, piSettings: () => SettingsManager.inMemory(harness.settings ?? {}) }),
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
