import assert from "node:assert/strict";
import { test } from "node:test";
import { stringIds } from "../extensions/percy/tools.ts";

test("stringIds: ids sent as numbers become strings", () => {
  assert.deepEqual(
    stringIds({
      action: "compact",
      trim: [3, "4"],
      collapse: [{ from: 1, to: "2", note: "n" }],
      collapseUnits: [{ id: 5, note: "u" }],
    }),
    {
      action: "compact",
      trim: ["3", "4"],
      collapse: [{ from: "1", to: "2", note: "n" }],
      collapseUnits: [{ id: "5", note: "u" }],
    },
  );
  assert.deepEqual(stringIds({ ids: [12, "12-20", "s30.1"] }), { ids: ["12", "12-20", "s30.1"] });
});

test("stringIds: ids sent as strings stay as they are", () => {
  const args = { action: "compact", trim: ["3"], collapse: [{ from: "1", to: "2", note: "1" }] };
  assert.deepEqual(stringIds(args), args);
});

test("stringIds: malformed input is left for the schema to reject", () => {
  for (const args of [undefined, null, "trim 3", 3, [1, 2]]) assert.deepEqual(stringIds(args), args);
  assert.deepEqual(stringIds({ trim: 3, ids: "4" }), { trim: 3, ids: "4" }, "not lists");
  assert.deepEqual(stringIds({ collapse: [7, null, ["1", "2"]] }), { collapse: [7, null, ["1", "2"]] });
  assert.deepEqual(stringIds({ trim: [true, null, { id: 1 }] }), { trim: [true, null, { id: 1 }] });
  assert.deepEqual(stringIds({ note: 1, other: [1] }), { note: 1, other: [1] }, "not id fields");
});
