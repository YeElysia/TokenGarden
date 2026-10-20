import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCcsDb, insertLog, insertRollup } from "./helpers/ccs-db.mjs";
test("CCS CLI reads details and archived rollups read-only, normalizes caches and makes no dry-run writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccs-cli-"));
  const file = join(dir, "cc-switch.db"),
    state = join(dir, "state.json");
  try {
    const db = createCcsDb(file);
    insertLog(db);
    insertLog(db, {
      id: "legacy",
      app: "codex",
      model: "gpt-x",
      input: 1000,
      output: 50,
      cached: 600,
      write: 100,
    });
    insertLog(db, {
      id: "total",
      app: "codex",
      model: "gpt-x",
      input: 1000,
      output: 50,
      cached: 300,
      write: 200,
      sem: 1,
    });
    insertLog(db, {
      id: "fresh",
      app: "codex",
      model: "gpt-x",
      input: 500,
      output: 50,
      cached: 300,
      write: 200,
      sem: 2,
    });
    insertLog(db, {
      id: "failure",
      input: 0,
      output: 0,
      cached: 0,
      write: 0,
      status: 500,
    });
    insertRollup(db);
    db.close();
    const before = await readFile(file);
    const result = spawnSync(
      process.execPath,
      [
        "collector/ccs-upload.mjs",
        "--device",
        "mac",
        "--db",
        file,
        "--state",
        state,
        "--dry-run",
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, TZ: "Asia/Shanghai" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.dryRun, true);
    assert.equal(value.days.length, 2);
    assert.equal(value.days[0].tokens, 1150);
    assert.equal(value.days[1].date, "2026-10-19");
    assert.equal(value.days[1].tokens, 3720);
    assert.equal(value.days[1].requests, 5);
    assert.equal(value.uploaded, 0);
    assert.equal(value.days[1].models, 2);
    assert.deepEqual(await readFile(file), before);
    await assert.rejects(readFile(state), { code: "ENOENT" });
    assert.ok(!JSON.stringify(value).includes("private"));
    assert.ok(!JSON.stringify(value).includes("DO-NOT-UPLOAD"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
