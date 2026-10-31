// Minimized form of the blackiron failure: a persisted system-prompt delta
// followed an assistant response, then Percy started an automatic idle turn.
// The request must project one system prompt at the head, never assistant → system.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startHarness } from "./harness.ts";

test("blackiron system-delta idle regression keeps system prompt first", async () => {
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
    assert.equal(request[0]?.role, "system");
    assert.equal(request.filter((message) => message.role === "system").length, 1);
  } finally {
    resumed.dispose();
  }
});
