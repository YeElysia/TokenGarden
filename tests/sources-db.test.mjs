import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { saveSnapshot, readUsage } from "../lib/usage-store.mjs";
import { handleUpload } from "../lib/upload.mjs";
import { summarize } from "../lib/stats.mjs";
const schema = await readFile(
  new URL("../db/schema.sql", import.meta.url),
  "utf8",
);
let db;
const execute = async (text, values) => (await db.query(text, values)).rows;
const row = (input = 100, output = 20, model = "a") => ({
  client: "Codex",
  model,
  input,
  output,
  cached: 0,
  requests: 2,
});
const snapshot = (patch = {}) => ({
  source: "ccs",
  device: "mac",
  date: "2026-10-19",
  revision: 1,
  rows: [row()],
  ...patch,
});
before(async () => {
  db = new PGlite();
  await db.exec(schema);
});
after(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("truncate usage_daily,usage_uploads");
});

test("same-day CCS and DSH on one device add together; other devices stay distinct", async () => {
  await saveSnapshot(execute, snapshot());
  await saveSnapshot(
    execute,
    snapshot({ source: "dsh", rows: [row(200, 30)] }),
  );
  await saveSnapshot(execute, snapshot({ device: "pc", rows: [row(40, 10)] }));
  const data = await readUsage(execute);
  assert.equal(data.length, 3);
  assert.equal(summarize(data).total, 400);
  assert.equal(summarize(data, { device: "mac" }).total, 350);
  assert.equal(summarize(data, { source: "ccs" }).total, 170);
});
test("a higher model total updates only its row and preserves absent models and other scopes", async () => {
  await saveSnapshot(
    execute,
    snapshot({ rows: [row(), row(10, 5, "removed")] }),
  );
  await saveSnapshot(
    execute,
    snapshot({ source: "dsh", rows: [row(200, 30)] }),
  );
  await saveSnapshot(execute, snapshot({ device: "pc", rows: [row(40, 10)] }));
  await saveSnapshot(
    execute,
    snapshot({ date: "2026-10-18", rows: [row(5, 5)] }),
  );
  assert.equal(
    await saveSnapshot(
      execute,
      snapshot({ revision: 2, rows: [row(150, 25)] }),
    ),
    true,
  );
  const data = await readUsage(execute);
  assert.equal(summarize(data, { device: "mac", source: "ccs" }).total, 200);
  assert.equal(
    data.some((r) => r.model === "removed"),
    true,
  );
  assert.equal(summarize(data, { source: "dsh" }).total, 230);
  assert.equal(summarize(data, { device: "pc" }).total, 50);
  assert.equal(summarize(data).total, 480);
});
test("retries and older versions cannot duplicate or roll back a newer snapshot", async () => {
  await saveSnapshot(execute, snapshot({ revision: 3, rows: [row(150, 25)] }));
  assert.equal(await saveSnapshot(execute, snapshot({ revision: 3 })), false);
  assert.equal(await saveSnapshot(execute, snapshot({ revision: 2 })), false);
  assert.equal(summarize(await readUsage(execute)).total, 175);
});
test("a newer version cannot lower a cumulative model total", async () => {
  await saveSnapshot(execute, snapshot());
  await saveSnapshot(execute, snapshot({ revision: 2, rows: [row(1, 2)] }));
  assert.equal(summarize(await readUsage(execute)).total, 120);
});
test("empty uploads preserve all model records", async () => {
  await saveSnapshot(execute, snapshot());
  await saveSnapshot(execute, snapshot({ source: "dsh" }));
  await saveSnapshot(execute, snapshot({ revision: 2, rows: [] }));
  assert.equal(await saveSnapshot(execute, snapshot()), false);
  const data = await readUsage(execute);
  assert.equal(data.length, 2);
  assert.equal(summarize(data).total, 240);
});
test("a failing merge rolls back all row and metadata changes together", async () => {
  await saveSnapshot(execute, snapshot());
  await assert.rejects(
    saveSnapshot(
      execute,
      snapshot({ revision: 2, rows: [row(300, 10, "new"), row(-1, 0)] }),
    ),
  );
  assert.equal(summarize(await readUsage(execute)).total, 120);
  assert.equal(
    Number((await execute("select revision from usage_uploads"))[0].revision),
    1,
  );
  assert.equal(
    await saveSnapshot(execute, snapshot({ revision: 2, rows: [row(210, 2)] })),
    true,
  );
  assert.equal(summarize(await readUsage(execute)).total, 212);
});
test("authenticated HTTP processing persists DSH unknown request counts and returns an acknowledgement", async () => {
  const request = new Request("http://localhost/api/upload/dsh", {
    method: "POST",
    headers: {
      authorization: "Bearer test-dsh",
      "content-type": "application/json",
    },
    body: JSON.stringify(snapshot({ rows: [{ ...row(), requests: null }] })),
  });
  const response = await handleUpload(request, "dsh", {
    token: "test-dsh",
    save: (value) => saveSnapshot(execute, value),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).applied, true);
  const data = await readUsage(execute);
  assert.equal(data[0].source, "dsh");
  assert.equal(data[0].requests, null);
  assert.equal(summarize(data).total, 120);
  assert.equal(summarize(data).requests, null);
});
test("migration preserves original data as CCS and can be run again without resetting uploads", async () => {
  await db.exec("drop table usage_daily,usage_uploads");
  await db.exec(
    await readFile(
      new URL("./fixtures/schema-v1.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.exec(
    "insert into usage_daily values('2026-10-19','mac','Codex','a',100,20,0,2)",
  );
  await db.exec(schema);
  assert.equal((await readUsage(execute))[0].source, "ccs");
  await saveSnapshot(
    execute,
    snapshot({
      source: "dsh",
      revision: 9,
      rows: [{ ...row(50, 10), requests: null }],
    }),
  );
  await db.exec(schema);
  assert.equal(summarize(await readUsage(execute)).total, 180);
  assert.equal(
    await saveSnapshot(execute, snapshot({ source: "dsh", revision: 8 })),
    true,
  );
});

test("older and same-revision reports with larger model totals still merge", async () => {
  await saveSnapshot(execute, snapshot({ revision: 9 }));
  assert.equal(
    await saveSnapshot(
      execute,
      snapshot({ revision: 8, rows: [row(200, 30)] }),
    ),
    true,
  );
  assert.equal(
    await saveSnapshot(
      execute,
      snapshot({ revision: 8, rows: [row(300, 40)] }),
    ),
    true,
  );
  assert.equal(summarize(await readUsage(execute)).total, 340);
  assert.equal(
    Number((await execute("select revision from usage_uploads"))[0].revision),
    9,
  );
});
test("higher total wins as one coherent row without independently inflating components", async () => {
  await saveSnapshot(execute, snapshot({ rows: [row(100, 100)] }));
  await saveSnapshot(execute, snapshot({ revision: 2, rows: [row(200, 50)] }));
  const [stored] = await readUsage(execute);
  assert.equal(stored.input, 200);
  assert.equal(stored.output, 50);
  assert.equal(summarize([stored]).total, 250);
  assert.equal(
    await saveSnapshot(
      execute,
      snapshot({ revision: 3, rows: [row(125, 125)] }),
    ),
    false,
  );
  assert.equal((await readUsage(execute))[0].input, 200);
});
