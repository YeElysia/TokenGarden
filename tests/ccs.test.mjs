import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCcsSnapshots } from "../collector/ccs.mjs";
import { createCcsDb, insertLog, insertRollup } from "./helpers/ccs-db.mjs";
process.env.TZ = "Asia/Shanghai";
async function fixture(t, options) {
  const dir = await mkdtemp(join(tmpdir(), "ccs-read-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "cc-switch.db");
  return { file, db: createCcsDb(file, options) };
}
test("CCS preserves full model names, merges provider rows, and exports only accounting fields", async (t) => {
  const { file, db } = await fixture(t);
  insertLog(db, { model: "model-2026-10-19" });
  insertLog(db, { id: "b", model: "model-2026-10-19" });
  db.close();
  const [snapshot] = await readCcsSnapshots(file, "mac");
  assert.equal(snapshot.date, "2026-10-19");
  assert.equal(snapshot.rows.length, 1);
  assert.deepEqual(snapshot.rows[0], {
    client: "Claude Code",
    model: "model-2026-10-19",
    input: 900,
    output: 40,
    cached: 600,
    requests: 2,
  });
  assert.ok(!JSON.stringify(snapshot).includes("private"));
  assert.ok(!JSON.stringify(snapshot).includes("DO-NOT-UPLOAD"));
});
test("legacy CCS schemas without rollups or semantics flags remain readable", async (t) => {
  const { file, db } = await fixture(t, { rollups: false, semantics: false });
  insertLog(db, {
    app: "codex",
    input: 1000,
    output: 50,
    cached: 600,
    write: 100,
  });
  db.close();
  const [snapshot] = await readCcsSnapshots(file, "mac");
  assert.equal(snapshot.rows[0].input, 1100);
  assert.equal(snapshot.rows[0].cached, 600);
});
test("unknown app names matching object properties stay valid client labels", async (t) => {
  const { file, db } = await fixture(t);
  insertLog(db, { app: "constructor", model: "__proto__" });
  db.close();
  const [snapshot] = await readCcsSnapshots(file, "mac");
  assert.equal(snapshot.rows[0].client, "constructor");
  assert.equal(snapshot.rows[0].model, "__proto__");
});
test("live SQLite WAL data is visible in a read-only snapshot", async (t) => {
  const { file, db } = await fixture(t);
  db.exec("PRAGMA journal_mode=WAL");
  insertLog(db);
  try {
    const [snapshot] = await readCcsSnapshots(file, "mac");
    assert.equal(snapshot.rows[0].input, 450);
    assert.equal(snapshot.rows[0].requests, 1);
  } finally {
    db.close();
  }
});
test("details and rolled-up requests on the same day are additive", async (t) => {
  const { file, db } = await fixture(t);
  insertLog(db);
  insertRollup(db, {
    date: "2026-10-19",
    app: "claude",
    model: "sonnet",
    input: 40,
    output: 5,
    cached: 10,
    write: 0,
    requests: 3,
  });
  db.close();
  const [snapshot] = await readCcsSnapshots(file, "mac");
  assert.equal(snapshot.rows[0].input, 500);
  assert.equal(snapshot.rows[0].output, 25);
  assert.equal(snapshot.rows[0].requests, 4);
});
for (const [name, patch] of [
  ["negative", { input: -1 }],
  ["fraction", { input: 0.5 }],
  ["unknown semantics", { sem: 3 }],
  ["unsafe integer", { input: 9007199254740992 }],
])
  test(`CCS rejects ${name} counters before uploading`, async (t) => {
    const { file, db } = await fixture(t);
    insertLog(db, patch);
    db.close();
    await assert.rejects(readCcsSnapshots(file, "mac"));
  });
test("malformed rollup calendar dates are rejected", async (t) => {
  const { file, db } = await fixture(t);
  insertRollup(db, { date: "2026-02-30" });
  db.close();
  await assert.rejects(readCcsSnapshots(file, "mac"));
});
test("missing database fails without creating a file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ccs-missing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "missing.db");
  await assert.rejects(readCcsSnapshots(file, "mac"));
  await assert.rejects(stat(file), { code: "ENOENT" });
});
test("empty CCS usage returns an empty snapshot set", async (t) => {
  const { file, db } = await fixture(t);
  db.close();
  assert.deepEqual(await readCcsSnapshots(file, "mac"), []);
});
