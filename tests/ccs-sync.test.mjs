import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { handleUpload } from "../lib/upload.mjs";
import { saveSnapshot, readUsage } from "../lib/usage-store.mjs";
import { summarize } from "../lib/stats.mjs";
import { uploadCcsOnce } from "../collector/ccs.mjs";
import { createCcsDb, insertLog, insertRollup } from "./helpers/ccs-db.mjs";
process.env.TZ = "Asia/Shanghai";
const exec = promisify(execFile);
test("CCS CLI → HTTP → Postgres preserves channel isolation, count backfills, retries and archival totals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccs-sync-")),
    file = join(dir, "cc-switch.db"),
    state = join(dir, "state.json");
  const local = createCcsDb(file),
    db = new PGlite();
  const execute = async (text, values) => (await db.query(text, values)).rows;
  let calls = 0,
    fail = false;
  const server = createServer(async (req, res) => {
    try {
      calls++;
      assert.equal(req.url, "/api/upload/ccs");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      assert.ok(!body.includes("private"));
      assert.ok(!body.includes("DO-NOT-UPLOAD"));
      const response = await handleUpload(
        new Request("http://localhost/api/upload/ccs", {
          method: "POST",
          headers: req.headers,
          body,
        }),
        "ccs",
        {
          token: "test-ccs",
          save: (snapshot) => {
            if (fail) throw new Error("temporary storage failure");
            return saveSnapshot(execute, snapshot);
          },
        },
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  try {
    await db.exec(
      await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"),
    );
    await saveSnapshot(execute, {
      source: "dsh",
      device: "mac",
      date: "2026-10-19",
      revision: 1,
      rows: [
        {
          client: "DSH",
          model: "p::m",
          input: 200,
          output: 50,
          cached: 0,
          requests: 1,
        },
      ],
    });
    insertLog(local);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    const { stdout } = await exec(
      process.execPath,
      [
        "collector/ccs-upload.mjs",
        "--device",
        "mac",
        "--db",
        file,
        "--state",
        state,
        "--url",
        url,
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          CCS_UPLOAD_TOKEN: "test-ccs",
          DSH_UPLOAD_TOKEN: "must-not-be-used",
        },
      },
    );
    assert.equal(JSON.parse(stdout).uploaded, 1);
    assert.equal(summarize(await readUsage(execute)).total, 720);
    const config = {
      dbFile: file,
      stateFile: state,
      device: "mac",
      url,
      token: "test-ccs",
    };
    assert.equal((await uploadCcsOnce(config)).unchanged, 1);
    assert.equal(calls, 1);
    insertLog(local, {
      id: "failed",
      input: 0,
      output: 0,
      cached: 0,
      write: 0,
      status: 500,
    });
    assert.equal((await uploadCcsOnce(config)).uploaded, 1);
    let data = await readUsage(execute);
    assert.equal(summarize(data, { source: "ccs" }).total, 470);
    assert.equal(summarize(data, { source: "ccs" }).requests, 2);
    insertLog(local, { id: "new", input: 20, output: 5, cached: 0, write: 0 });
    fail = true;
    await assert.rejects(uploadCcsOnce(config), /HTTP 503/);
    assert.equal(
      summarize(await readUsage(execute), { source: "ccs" }).total,
      470,
    );
    fail = false;
    assert.equal((await uploadCcsOnce(config)).uploaded, 1);
    assert.equal(
      summarize(await readUsage(execute), { source: "ccs" }).total,
      495,
    );
    const beforeArchive = calls;
    local.exec("BEGIN");
    insertRollup(local, {
      date: "2026-10-19",
      app: "claude",
      model: "sonnet",
      input: 120,
      output: 25,
      cached: 300,
      write: 50,
      sem: 2,
      requests: 3,
    });
    local.exec("DELETE FROM proxy_request_logs; COMMIT");
    assert.equal((await uploadCcsOnce(config)).unchanged, 1);
    assert.equal(calls, beforeArchive);
    assert.equal(
      (await uploadCcsOnce({ ...config, device: "pc" })).uploaded,
      1,
    );
    data = await readUsage(execute);
    assert.equal(summarize(data, { device: "pc" }).total, 495);
    assert.equal(summarize(data, { source: "dsh" }).total, 250);
    assert.equal(summarize(data).total, 1240);
    const stateBefore = await readFile(state, "utf8");
    await assert.rejects(
      uploadCcsOnce({ ...config, device: "unauthorized", token: "test-dsh" }),
      /HTTP 401/,
    );
    assert.equal(await readFile(state, "utf8"), stateBefore);
    // A lower source snapshot must never replace the higher server cumulative amount.
    local.exec(
      "UPDATE usage_daily_rollups SET input_tokens=1,output_tokens=0,cache_read_tokens=0,cache_creation_tokens=0,request_count=1",
    );
    assert.equal((await uploadCcsOnce(config)).ignored, 1);
    const afterLower = calls;
    assert.equal((await uploadCcsOnce(config)).unchanged, 1);
    assert.equal(calls, afterLower);
    assert.equal(
      summarize(await readUsage(execute), { source: "ccs", device: "mac" })
        .total,
      495,
    );
  } finally {
    local.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
