import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { UsageLedger, dayKey } from "../plugins/dsh-token-stats/stats-core.mjs";
import { StatsStore } from "../plugins/dsh-token-stats/store.mjs";
import { uploadDshOnce } from "../collector/dsh.mjs";
import { handleUpload } from "../lib/upload.mjs";
import { saveSnapshot, readUsage } from "../lib/usage-store.mjs";
test("rewritten plugin ledger → disk → collector → HTTP → database preserves tokens and request counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "token-garden-plugin-"));
  const db = new PGlite();
  const execute = async (text, values) => (await db.query(text, values)).rows;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = Buffer.concat(chunks).toString();
      assert.ok(!body.includes("private-session"));
      const response = await handleUpload(
        new Request("http://localhost/api/upload/dsh", {
          method: "POST",
          headers: req.headers,
          body,
        }),
        "dsh",
        { token: "test-token", save: (value) => saveSnapshot(execute, value) },
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
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const time = Date.now(),
      date = dayKey(time),
      file = join(dir, "stats.json");
    const engine = new UsageLedger();
    engine.ingest("private-session", {
      seq: 0,
      time,
      type: "assistant/message",
      data: {
        message: { source: { kind: "model", provider: "p", model: "m" } },
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 },
      },
    });
    const store = new StatsStore(file, (revision) =>
      engine.serialize(revision),
    );
    store.schedule();
    await store.flush();
    const config = {
      statsFile: file,
      stateFile: join(dir, "upload.json"),
      device: "mac",
      url: `http://127.0.0.1:${server.address().port}`,
      token: "test-token",
    };
    assert.equal((await uploadDshOnce(config)).uploaded, 1);
    let [row] = await readUsage(execute);
    assert.equal(row.input, 130);
    assert.equal(row.output, 20);
    assert.equal(row.requests, 1);
    engine.ingest(
      "private-session",
      { seq: 1, time, type: "assistant/attempt", data: { stream: [] } },
      { provider: "p", model: "m" },
    );
    store.schedule();
    await store.flush();
    assert.equal((await uploadDshOnce(config)).uploaded, 1);
    [row] = await readUsage(execute);
    assert.equal(row.input + row.output, 150);
    assert.equal(row.requests, 2);
    assert.equal(row.date, date);
    assert.equal((await uploadDshOnce(config)).unchanged, 1);
    store.dispose();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
