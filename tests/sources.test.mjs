import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../lib/stats.mjs";

const rows = [
  {
    date: "2026-10-19",
    source: "ccs",
    device: "mac",
    client: "Codex",
    model: "a",
    input: 100,
    output: 20,
    cached: 50,
    requests: 2,
  },
  {
    date: "2026-10-19",
    source: "dsh",
    device: "mac",
    client: "Codex",
    model: "a",
    input: 200,
    output: 30,
    cached: 0,
    requests: 3,
  },
  {
    date: "2026-10-19",
    source: "ccs",
    device: "pc",
    client: "Codex",
    model: "a",
    input: 40,
    output: 10,
    cached: 0,
    requests: 1,
  },
];
test("channel filtering retains independent snapshots for the same device and model", () => {
  assert.equal(summarize(rows, { device: "mac", source: "ccs" }).total, 120);
  assert.equal(summarize(rows, { device: "mac", source: "dsh" }).total, 230);
  assert.equal(summarize(rows, { device: "mac" }).total, 350);
  assert.equal(summarize(rows).days["2026-10-19"].total, 400);
});
test("unknown DSH request counts stay unknown while tokens and known-only filters remain accurate", () => {
  const data = [rows[0], { ...rows[1], requests: null }];
  assert.equal(summarize(data).total, 350);
  assert.equal(summarize(data).requests, null);
  assert.equal(summarize(data).days["2026-10-19"].requests, null);
  assert.equal(summarize(data, { source: "ccs" }).requests, 2);
});
test("model names that match JavaScript object properties still aggregate as numeric model totals", () => {
  for (const model of ["__proto__", "constructor", "toString"]) {
    const result = summarize([{ ...rows[0], model }]);
    assert.equal(result.models[model], 120);
    assert.equal(Object.hasOwn(result.models, model), true);
  }
});
