import test from "node:test";
import assert from "node:assert/strict";
import { summarize, dayKey } from "../lib/stats.mjs";
test("uses Shanghai dates at UTC day boundary", () =>
  assert.equal(dayKey("2026-10-18T17:00:00Z"), "2026-10-19"));
test("filters devices and includes cached input only once", () => {
  const rows = [
    {
      date: "2026-10-19",
      device: "mac",
      client: "Codex",
      model: "a",
      input: 100,
      output: 20,
      cached: 70,
      requests: 2,
    },
    {
      date: "2026-10-19",
      device: "pc",
      client: "Claude",
      model: "b",
      input: 10,
      output: 5,
      cached: 0,
      requests: 1,
    },
  ];
  const result = summarize(rows, { year: 2026, device: "mac" });
  assert.equal(result.total, 120);
  assert.equal(result.cached, 70);
  assert.equal(result.requests, 2);
  assert.equal(result.days["2026-10-19"].total, 120);
});
test("empty data produces a zero total", () =>
  assert.equal(summarize([], { year: 2026 }).total, 0));
