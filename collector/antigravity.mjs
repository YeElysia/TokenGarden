import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";
import { parseSnapshot } from "../lib/upload.mjs";
import { syncSnapshots } from "./sync.mjs";

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

const number = (value) => {
  if (typeof value === "bigint" && value >= 0n && value <= MAX)
    return Number(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
  throw new Error("antigravity 汇总计数超出安全范围");
};

async function revisionOf(file) {
  const stamps = await Promise.all(
    [file, file + "-wal", file + "-shm"].map(async (p) => {
      try {
        return (await stat(p)).mtimeMs;
      } catch (e) {
        if (e.code === "ENOENT" && p !== file) return 0;
        throw e;
      }
    }),
  );
  const revision = Math.max(1, ...stamps.map(Math.ceil));
  if (!Number.isSafeInteger(revision))
    throw new Error("antigravity 数据文件版本无效");
  return revision;
}

function validateTable(db) {
  const cols = new Set(
    db.prepare("PRAGMA table_info(token_usage)").all().map((c) => c.name),
  );
  const required = [
    "timestamp",
    "account_email",
    "model",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
  ];
  if (required.some((c) => !cols.has(c)))
    throw new Error("antigravity token_usage 表结构不受支持");
  const invalid = db
    .prepare(
      `SELECT 1 FROM token_usage WHERE
        typeof(timestamp) != 'integer' OR timestamp <= 0 OR
        typeof(account_email) != 'text' OR account_email = '' OR
        typeof(model) != 'text' OR model = '' OR
        typeof(input_tokens) != 'integer' OR input_tokens < 0 OR
        typeof(output_tokens) != 'integer' OR output_tokens < 0 OR
        typeof(cached_tokens) != 'integer' OR cached_tokens < 0
      LIMIT 1`,
    )
    .get();
  if (invalid) throw new Error("antigravity token_usage 包含无效的用量数据");
}

/** Only statistics columns are queried; account credentials, request bodies and file paths are never read. */
export async function readAntigravitySnapshots(dbFile, device) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let records;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    validateTable(db);
    // timestamp 单位是秒（Unix epoch seconds）；日期按本地时区聚合，与 ccs 行为一致
    // device 固定为 antigravity（代理层），client 固定为 neo-mofox（消费方），多账号用量合并
    const stmt = db.prepare(
      `SELECT date(timestamp, 'unixepoch', 'localtime') AS date,
              'neo-mofox' AS client,
              model,
              SUM(input_tokens) AS input,
              SUM(output_tokens) AS output,
              SUM(cached_tokens) AS cached,
              COUNT(*) AS requests
       FROM token_usage
       GROUP BY date, model
       ORDER BY date, model`,
    );
    stmt.setReadBigInts(true);
    records = stmt.all();
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const revision = await revisionOf(dbFile);
  const days = new Map();
  for (const rec of records) {
    const row = {
      client: rec.client,
      model: rec.model,
      input: number(rec.input),
      output: number(rec.output),
      cached: number(rec.cached),
      requests: number(rec.requests),
    };
    if (!days.has(rec.date)) days.set(rec.date, []);
    days.get(rec.date).push(row);
  }
  return [...days].map(([date, rows]) => {
    const { source, ...snapshot } = parseSnapshot("antigravity", {
      device,
      date,
      revision,
      rows: rows.sort(
        (a, b) =>
          a.client.localeCompare(b.client) || a.model.localeCompare(b.model),
      ),
    });
    return snapshot;
  });
}

export async function uploadAntigravityOnce(config) {
  const snapshots = await readAntigravitySnapshots(config.dbFile, config.device);
  return syncSnapshots({
    source: "antigravity",
    snapshots,
    stateFile: config.stateFile,
    device: config.device,
    url: config.url,
    token: config.token,
    dryRun: config.dryRun,
  });
}
