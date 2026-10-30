import assert from "node:assert/strict";
import { test } from "node:test";
import { debugCompletions, parseDebugCommand } from "../extensions/percy/debug.ts";

test("compact-debug completes its visible subcommands", () => {
  assert.deepEqual(debugCompletions(""), [
    { value: "index", label: "index", description: "Show the compaction index without changing context" },
    {
      value: "squish ",
      label: "squish <from>-<to> <summary>",
      description: "Record a test collapse of one message range",
    },
    { value: "trim ", label: "trim <id>", description: "Record test trimming for one tool-output row" },
  ]);
  assert.deepEqual(debugCompletions("sq"), [
    {
      value: "squish ",
      label: "squish <from>-<to> <summary>",
      description: "Record a test collapse of one message range",
    },
  ]);
  assert.equal(debugCompletions("squish "), null);
});

test("compact-debug accepts explicit index", () => {
  assert.deepEqual(parseDebugCommand("", []), { kind: "index" });
  assert.deepEqual(parseDebugCommand("index", []), { kind: "index" });
});
