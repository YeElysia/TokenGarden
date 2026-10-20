import test from "node:test";
import assert from "node:assert/strict";
import { handleUpload } from "../lib/upload.mjs";
const body = {
  date: "2026-10-19",
  device: "mac",
  revision: 1,
  rows: [
    {
      client: "Codex",
      model: "a",
      input: 100,
      output: 20,
      cached: 50,
      requests: 2,
    },
  ],
};
const request = (value = body, token = "test-ccs") =>
  new Request("http://localhost/api/upload/ccs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(value),
  });
const mustNotWrite = () => {
  throw new Error("invalid requests must not reach storage");
};
test("missing channel configuration fails closed", async () =>
  assert.equal(
    (await handleUpload(request(), "ccs", { save: mustNotWrite })).status,
    503,
  ));
test("channel tokens cannot authorize the other channel", async () =>
  assert.equal(
    (
      await handleUpload(request(body, "test-ccs"), "dsh", {
        token: "test-dsh",
        save: mustNotWrite,
      })
    ).status,
    401,
  ));
test("unknown upload channels are rejected", async () =>
  assert.equal(
    (
      await handleUpload(request(), "other", {
        token: "test-ccs",
        save: mustNotWrite,
      })
    ).status,
    404,
  ));
for (const [name, patch] of [
  ["invalid calendar date", { date: "2026-02-30" }],
  ["invalid revision", { revision: 0 }],
  ["unstable whitespace identity", { device: " mac " }],
  ["negative tokens", { rows: [{ ...body.rows[0], input: -1 }] }],
  ["invalid cache subset", { rows: [{ ...body.rows[0], cached: 101 }] }],
  ["fractional tokens", { rows: [{ ...body.rows[0], output: 0.5 }] }],
  ["duplicate model rows", { rows: [body.rows[0], body.rows[0]] }],
  [
    "missing request count",
    { rows: [{ ...body.rows[0], requests: undefined }] },
  ],
])
  test(`invalid upload rejects ${name} without writing`, async () =>
    assert.equal(
      (
        await handleUpload(request({ ...body, ...patch }), "ccs", {
          token: "test-ccs",
          save: mustNotWrite,
        })
      ).status,
      400,
    ));
test("oversized bodies are rejected even when the content-length header is omitted", async () => {
  const req = new Request("http://localhost", {
    method: "POST",
    headers: {
      authorization: "Bearer test-ccs",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, padding: "a".repeat(300000) }),
  });
  assert.equal(
    (await handleUpload(req, "ccs", { token: "test-ccs", save: mustNotWrite }))
      .status,
    413,
  );
});
