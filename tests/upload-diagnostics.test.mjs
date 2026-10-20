import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { handleUpload } from "../lib/upload.mjs";
import { saveSnapshot } from "../lib/usage-store.mjs";
import { syncSnapshots } from "../collector/sync.mjs";
const snapshot = {
  device: "mac",
  date: "2026-10-19",
  revision: 1,
  rows: [
    {
      client: "DSH",
      model: "p::a",
      input: 100,
      output: 20,
      cached: 30,
      requests: 1,
    },
  ],
};
const request = () =>
  new Request("http://localhost/api/upload/dsh", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(snapshot),
  });

test("real missing Postgres upload function returns a useful diagnostic with a matching private log reference", async (t) => {
  const log = t.mock.method(console, "error", () => {}),
    db = new PGlite();
  try {
    const res = await handleUpload(request(), "dsh", {
      token: "test-token",
      save: (s) => saveSnapshot(async (q, v) => (await db.query(q, v)).rows, s),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.diagnostic?.code, "42883");
    assert.match(body.diagnostic.message, /函数|schema/);
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    const logged = JSON.stringify(log.mock.calls.map((c) => c.arguments));
    assert.ok(logged.includes(body.requestId));
    assert.ok(logged.includes("42883"));
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally {
    await db.close();
  }
});

test("raw storage errors and unrecognized error codes never leak connection strings, tokens or data values", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  for (const code of [
    "42501",
    "ECONNREFUSED",
    "DO-NOT-LEAK-secret",
    "constructor",
    undefined,
  ]) {
    const error = Object.assign(
      new Error(
        "postgresql://owner:DO-NOT-LEAK-password@private/db Bearer DO-NOT-LEAK-token",
      ),
      {
        code,
        detail: "DO-NOT-LEAK-uploaded-content",
        query: "DO-NOT-LEAK-query",
      },
    );
    const res = await handleUpload(request(), "dsh", {
      token: "test-token",
      save: async () => {
        throw error;
      },
    });
    const body = await res.json();
    assert.equal(
      body.diagnostic?.code,
      ["42501", "ECONNREFUSED"].includes(code) ? code : "UNKNOWN",
    );
    assert.ok(!JSON.stringify(body).includes("DO-NOT-LEAK"));
    assert.ok(
      !JSON.stringify(log.mock.calls.map((c) => c.arguments)).includes(
        "DO-NOT-LEAK",
      ),
    );
  }
});

for (const source of ["ccs", "dsh"])
  test(`${source} transport displays server diagnosis and trace ID without marking failed dates synced`, async (t) => {
    t.mock.method(console, "error", () => {});
    const dir = await mkdtemp(join(tmpdir(), "upload-diagnostics-")),
      stateFile = join(dir, "state.json");
    let reference;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const response = await handleUpload(
        new Request("http://localhost/api/upload/" + source, {
          method: "POST",
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        }),
        source,
        {
          token: "test-token",
          save: async () => {
            throw Object.assign(new Error("DO-NOT-LEAK-credential"), {
              code: "42501",
            });
          },
        },
      );
      const body = await response.text();
      reference = JSON.parse(body).requestId;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(body);
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      await assert.rejects(
        syncSnapshots({
          source,
          snapshots: [snapshot],
          device: "mac",
          stateFile,
          url: `http://127.0.0.1:${server.address().port}`,
          token: "test-token",
        }),
        (error) => {
          assert.match(error.message, /HTTP 503/);
          assert.match(error.message, /42501/);
          assert.match(error.message, /权限/);
          assert.ok(error.message.includes(reference));
          assert.ok(!error.message.includes("DO-NOT-LEAK"));
          return true;
        },
      );
      await assert.rejects(access(stateFile), { code: "ENOENT" });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(dir, { recursive: true, force: true });
    }
  });
