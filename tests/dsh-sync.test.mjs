import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { handleUpload } from "../lib/upload.mjs";
import { saveSnapshot, readUsage } from "../lib/usage-store.mjs";
import { uploadDshOnce } from "../collector/dsh.mjs";
import { summarize } from "../lib/stats.mjs";
const exec = promisify(execFile);
const value = {
  version: 1,
  savedAt: 1792422000000,
  folded: ["do-not-upload-session"],
  watermarks: { "do-not-upload": 999 },
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
    "2026-10-18": { "p::b": { input: 10, output: 5, total: 15 } },
  },
};
test("DSH CLI → authenticated HTTP → Postgres → combined CCS/DSH totals; unchanged files make no requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "token-garden-dsh-")),
    db = new PGlite();
  const execute = async (text, values) => (await db.query(text, values)).rows;
  let requests = 0;
  let failDate = null;
  const server = createServer(async (req, res) => {
    try {
      requests++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      assert.ok(!body.includes("do-not-upload"));
      const request = new Request("http://localhost/api/upload/dsh", {
        method: "POST",
        headers: req.headers,
        body,
      });
      const response = await handleUpload(request, "dsh", {
        token: "test-dsh",
        save: (snapshot) => {
          if (snapshot.date === failDate)
            throw new Error("temporary storage outage");
          return saveSnapshot(execute, snapshot);
        },
      });
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
      date: "2026-10-19",
      source: "ccs",
      device: "mac",
      revision: 1,
      rows: [
        {
          client: "DSH",
          model: "p::a",
          input: 40,
          output: 10,
          cached: 0,
          requests: 1,
        },
      ],
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    const statsFile = join(dir, "stats.json"),
      stateFile = join(dir, "state.json");
    await writeFile(statsFile, JSON.stringify(value));
    const cliArgs = [
      "collector/dsh-upload.mjs",
      "--device",
      "mac",
      "--url",
      url,
      "--stats",
      statsFile,
      "--state",
      stateFile,
    ];
    const { stdout } = await exec(process.execPath, cliArgs, {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, DSH_UPLOAD_TOKEN: "test-dsh" },
    });
    assert.equal(JSON.parse(stdout).uploaded, 2);
    assert.equal(summarize(await readUsage(execute)).total, 220);
    const config = {
      url,
      device: "mac",
      statsFile,
      stateFile,
      token: "test-dsh",
    };
    assert.equal((await uploadDshOnce(config)).unchanged, 2);
    assert.equal(requests, 2);
    const next = structuredClone(value);
    next.savedAt++;
    next.days["2026-10-19"]["p::a"] = {
      input: 200,
      output: 20,
      cacheRead: 30,
      cacheWrite: 5,
      total: 255,
    };
    await writeFile(statsFile, JSON.stringify(next));
    assert.equal((await uploadDshOnce(config)).uploaded, 1);
    assert.equal(requests, 3);
    const data = await readUsage(execute);
    assert.equal(summarize(data).total, 320);
    assert.equal(summarize(data, { source: "ccs" }).total, 50);
    next.savedAt++;
    next.days["2026-10-18"]["p::b"] = { input: 15, output: 5, total: 20 };
    next.days["2026-10-19"]["p::a"] = {
      input: 300,
      output: 20,
      cacheRead: 30,
      cacheWrite: 5,
      total: 355,
    };
    await writeFile(statsFile, JSON.stringify(next));
    failDate = "2026-10-19";
    await assert.rejects(uploadDshOnce(config), /HTTP 503/);
    assert.equal(summarize(await readUsage(execute)).total, 325);
    failDate = null;
    const retry = await uploadDshOnce(config);
    assert.equal(retry.uploaded, 1);
    assert.equal(retry.unchanged, 1);
    assert.equal(requests, 6);
    assert.equal(summarize(await readUsage(execute)).total, 425);
    assert.equal(
      (await uploadDshOnce({ ...config, device: "pc" })).uploaded,
      2,
    );
    assert.equal(
      summarize(await readUsage(execute), { device: "pc" }).total,
      375,
    );
    assert.equal(summarize(await readUsage(execute)).total, 800);
    assert.equal((await uploadDshOnce(config)).unchanged, 2);
    assert.equal(requests, 8);
    await saveSnapshot(execute, {
      source: "dsh",
      device: "mac",
      date: "2026-10-19",
      revision: next.savedAt + 100,
      rows: [
        {
          client: "DSH",
          model: "p::a",
          input: 500,
          output: 0,
          cached: 0,
          requests: null,
        },
      ],
    });
    next.savedAt += 50;
    next.days["2026-10-19"]["p::a"] = {
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 5,
      total: 155,
    };
    await writeFile(statsFile, JSON.stringify(next));
    assert.equal((await uploadDshOnce(config)).ignored, 1);
    const afterRejection = requests;
    assert.equal((await uploadDshOnce(config)).unchanged, 2);
    assert.equal(requests, afterRejection);
    next.savedAt += 51;
    await writeFile(statsFile, JSON.stringify(next));
    assert.equal((await uploadDshOnce(config)).ignored, 1);
    assert.equal(summarize(await readUsage(execute)).total, 945);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("dry-run never contacts a server or creates sync state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "token-garden-dry-"));
  try {
    const statsFile = join(dir, "stats.json"),
      stateFile = join(dir, "state.json");
    await writeFile(statsFile, JSON.stringify(value));
    const result = await uploadDshOnce({
      statsFile,
      stateFile,
      device: "mac",
      dryRun: true,
    });
    assert.equal(result.days[1].tokens, 155);
    assert.equal(result.uploaded, 0);
    await assert.rejects(readFile(stateFile), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
