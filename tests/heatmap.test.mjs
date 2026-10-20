import test from "node:test";
import assert from "node:assert/strict";
import { heatScale } from "../lib/heatmap.mjs";
test("an extreme peak does not collapse ordinary active days into one heat level", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 262100000],
    level = heatScale(values);
  assert.deepEqual(values.map(level), [1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(level(0), 0);
});
test("zero and missing days do not skew positive-day quartiles, and equal values have equal colors", () => {
  const values = [2, 2, 2, 3, 5, 8, 8, 12];
  const a = heatScale(values),
    b = heatScale([...Array(365).fill(0), ...values]);
  assert.deepEqual(values.map(a), values.map(b));
  assert.equal(a(2), a(2));
  const levels = values.map(a);
  assert.ok(levels.every((v, i) => i === 0 || v >= levels[i - 1]));
});
test("empty, zero-only and one-value calendars have valid stable heat colors", () => {
  assert.equal(heatScale([])(0), 0);
  assert.equal(heatScale([0, 0])(0), 0);
  const level = heatScale([10, 10, 10]);
  assert.equal(level(10), 1);
  assert.equal(level(0), 0);
});
