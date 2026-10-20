import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { postgresWire } from "./helpers/postgres-wire.mjs";
import { saveSnapshot, readUsage } from "../lib/usage-store.mjs";

test("production Postgres.js wire binding passes model arrays as JSON arrays rather than JSON-encoded strings", async () => {
  const wire = await postgresWire();
  try {
    await wire.db.exec(
      await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"),
    );
    const execute = (query, values) => wire.sql.unsafe(query, values);
    const snapshot = {
      source: "dsh",
      device: "mac",
      date: "2026-10-19",
      revision: 1,
      rows: [
        {
          client: "DSH",
          model: 'provider::m"\\中文',
          input: 130,
          output: 20,
          cached: 30,
          requests: null,
        },
        {
          client: "DSH",
          model: "provider::other",
          input: 10,
          output: 5,
          cached: 0,
          requests: 2,
        },
      ],
    };
    assert.equal(await saveSnapshot(execute, snapshot), true);
    const rows = await readUsage(execute);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.find((r) => r.model === snapshot.rows[0].model),
      {
        date: snapshot.date,
        source: "dsh",
        device: "mac",
        ...snapshot.rows[0],
      },
    );
    assert.equal(await saveSnapshot(execute, snapshot), false);
    assert.equal(
      await saveSnapshot(execute, {
        ...snapshot,
        revision: 2,
        rows: [{ ...snapshot.rows[0], input: 1, output: 0, cached: 0 }],
      }),
      false,
    );
    assert.equal(
      await saveSnapshot(execute, {
        ...snapshot,
        source: "ccs",
        rows: [{ ...snapshot.rows[0], client: "Codex", requests: 3 }],
      }),
      true,
    );
    assert.equal((await readUsage(execute)).length, 3);
    assert.equal(await saveSnapshot(execute, { ...snapshot, rows: [] }), false);
  } finally {
    await wire.close();
  }
});
