// The idle scheduler, with timers fired by hand and a real SessionManager.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { idleScheduler, type Timers } from "../extensions/percy/idle.ts";
import { NUDGE_TYPE } from "../extensions/percy/types.ts";

function setup(minutes = 8) {
  const sm = SessionManager.inMemory("/tmp");
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 });
  const ctx = { sessionManager: sm } as unknown as ExtensionContext;
  let timer: (() => void) | undefined;
  const timers: Timers = {
    set(callback) {
      const t = () => callback();
      timer = t;
      return () => {
        if (timer === t) timer = undefined;
      };
    },
  };
  const fired: ExtensionContext[] = [];
  const idle = idleScheduler({ timers, minutes: () => minutes, fire: (c) => fired.push(c) });
  const fire = () => {
    const t = timer;
    timer = undefined;
    t?.();
  };
  return { sm, ctx, idle, fired, fire, armed: () => timer !== undefined };
}

test("idleScheduler: a settled run arms the timer, which fires once", () => {
  const { ctx, idle, fired, fire, armed } = setup();
  idle.settled(ctx, false);
  assert.ok(armed());
  assert.match(idle.status(ctx), /^armed; fires in ~8m$/);
  fire();
  assert.deepEqual(fired, [ctx]);
  assert.equal(idle.status(ctx), "not armed");
});

test("idleScheduler: cancel, an aborted run, or no minutes leave it off", () => {
  const s = setup();
  s.idle.arm(s.ctx);
  s.idle.cancel();
  assert.ok(!s.armed());
  s.idle.settled(s.ctx, true);
  assert.ok(!s.armed());
  const off = setup(0);
  off.idle.settled(off.ctx, false);
  assert.ok(!off.armed());
  assert.equal(off.idle.status(off.ctx), "disabled");
});

test("idleScheduler: the idle run does not re-arm, and stops warming until reset", () => {
  const { ctx, idle, armed } = setup();
  idle.startRun(() => {});
  assert.ok(idle.warmingStopped());
  idle.settled(ctx, false);
  assert.ok(!armed(), "the idle run settled");
  idle.settled(ctx, false);
  assert.ok(armed(), "a later run arms it");
  idle.reset();
  assert.ok(!armed());
  assert.ok(!idle.warmingStopped());
});

test("idleScheduler: a run that failed to start is not an idle run", () => {
  const { ctx, idle, armed } = setup();
  assert.throws(() =>
    idle.startRun(() => {
      throw new Error("no");
    }),
  );
  idle.settled(ctx, false);
  assert.ok(armed());
});

test("idleScheduler: blocked after an idle nudge until the user writes", () => {
  const { sm, ctx, idle, armed } = setup();
  sm.appendCustomMessageEntry(NUDGE_TYPE, "idle", true, { idle: true });
  idle.settled(ctx, false);
  assert.ok(!armed());
  assert.equal(idle.status(ctx), "blocked after an idle compaction");
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "back" }], timestamp: 1 });
  idle.settled(ctx, false);
  assert.ok(armed());
});
