import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { getTimeTheme, themeInitScript } from "../lib/theme.mjs";

for (const [hour, minute, expected] of [
  [0, 0, "night"],
  [6, 59, "night"],
  [7, 0, "wuling"],
  [12, 0, "wuling"],
  [18, 59, "wuling"],
  [19, 0, "night"],
  [23, 59, "night"],
]) {
  test(`device local time ${hour}:${minute} uses ${expected}`, () => {
    assert.equal(getTimeTheme(new Date(2026, 9, 19, hour, minute)), expected);
  });
}

test("pre-paint theme matches the scheduled theme in the browser timezone", () => {
  for (const hour of [6, 7, 18, 19]) {
    const date = new Date(2026, 9, 19, hour);
    const document = { documentElement: { dataset: {} } };
    class FixedDate extends Date {
      constructor() {
        super(date.getTime());
      }
    }
    vm.runInNewContext(themeInitScript, { document, Date: FixedDate });
    assert.equal(document.documentElement.dataset.theme, getTimeTheme(date));
  }
});
