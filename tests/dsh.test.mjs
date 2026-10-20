import test from "node:test";
import assert from "node:assert/strict";
import { dshSnapshots } from "../collector/dsh.mjs";
const store = {
  version: 1,
  savedAt: 1792422000000,
  folded: ["private-session"],
  watermarks: { private: 99 },
  modelMeta: { "p::a": { name: "a", provider: "p" } },
  days: {
    "2026-10-19": {
      "p::a": {
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 5,
        reasoning: 7,
        total: 155,
      },
    },
  },
};
test("DSH input includes cache read and write; reasoning is not counted twice", () => {
  const [snapshot] = dshSnapshots(store, "mac");
  assert.deepEqual(snapshot, {
    device: "mac",
    date: "2026-10-19",
    revision: 1792422000000,
    rows: [
      {
        client: "DSH",
        model: "p::a",
        input: 135,
        output: 20,
        cached: 30,
        requests: null,
      },
    ],
  });
  assert.ok(!JSON.stringify(snapshot).includes("private"));
});
test("provider-qualified models stay separate and empty days produce an empty no-op snapshot", () => {
  const result = dshSnapshots(
    {
      ...store,
      days: {
        "2026-10-18": {},
        "2026-10-19": {
          "p::a": store.days["2026-10-19"]["p::a"],
          "q::a": { input: 4, output: 6, total: 10 },
        },
      },
    },
    "mac",
  );
  assert.deepEqual(result[0].rows, []);
  assert.deepEqual(
    result[1].rows.map((r) => r.model),
    ["p::a", "q::a"],
  );
});
for (const [name, patch] of [
  ["unsupported format", { version: 2 }],
  ["missing revision", { savedAt: undefined }],
  ["invalid date", { days: { "2026-02-30": {} } }],
  [
    "negative counter",
    { days: { "2026-10-19": { "p::a": { input: -1, output: 2, total: 1 } } } },
  ],
  [
    "mismatched total",
    {
      days: {
        "2026-10-19": { "p::a": { input: 100, output: 20, total: 999 } },
      },
    },
  ],
])
  test(`DSH rejects ${name}`, () =>
    assert.throws(() => dshSnapshots({ ...store, ...patch }, "mac")));
