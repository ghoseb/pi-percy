// Minimized form of the blackiron failure: a persisted system-prompt delta
// followed an assistant response, then Percy started an automatic idle turn.
// The system message stays where pi recorded it, and the request must still
// be one Anthropic accepts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicRequestWire, misplacedSystemMessages } from "./anthropic-wire.ts";
import { startHarness } from "./harness.ts";

test("blackiron system-delta idle regression sends a valid request", async () => {
  const first = await startHarness({ idle: { minutes: 0 } });
  let manager;
  try {
    await first.send("hello");
    first.session.sessionManager.appendMessage({ role: "system", content: "Changed prompt.", timestamp: Date.now() });
    manager = first.session.sessionManager;
  } finally {
    first.dispose();
  }
  const resumed = await startHarness(
    { limits: { keepRecentTokens: 1 }, idle: { minutes: 0.002, minTokens: 1 } },
    { sessionManager: manager },
  );
  try {
    for (let attempt = 0; resumed.requests.length === 0 && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const request = resumed.requests[0]!;
    // No forced prompt: the recorded system message stays mid-conversation.
    assert.ok(request.slice(1).some((m) => m.role === "system"));
    assert.deepEqual(misplacedSystemMessages(await anthropicRequestWire(request)), []);
  } finally {
    resumed.dispose();
  }
});
