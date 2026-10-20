import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";
import { parseSnapshot } from "../lib/upload.mjs";
import { syncSnapshots } from "./sync.mjs";
const CLIENTS = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  "claude-desktop": "Claude Desktop",
  grokbuild: "Grok Build",
  openclaw: "OpenClaw",
};
const COUNTERS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
];
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
function columns(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name),
  );
}
const field = (cols, name) => (cols.has(name) ? name : "0");
/** Match CC Switch's explicit fresh/total/legacy semantics before summing rows. */
function expressions(cols) {
  const input = "input_tokens",
    read = field(cols, "cache_read_tokens"),
    write = field(cols, "cache_creation_tokens"),
    sem = field(cols, "input_token_semantics");
  const inclusive = "app_type IN ('codex','gemini','grokbuild')";
  const fresh = `CASE WHEN ${sem}=2 THEN ${input}
  WHEN ${inclusive} AND ${sem}=1 AND ${input}>=(${read}+${write}) THEN ${input}-${read}-${write}
  WHEN ${inclusive} AND ${sem}=0 AND ${input}>=${read} THEN ${input}-${read}
  ELSE ${input} END`;
  return { input: `((${fresh})+${read}+${write})`, cached: read };
}
function validateTable(db, table, cols, rollup) {
  const required = [
    "app_type",
    "model",
    "input_tokens",
    "output_tokens",
    rollup ? "date" : "created_at",
    ...(rollup ? ["request_count"] : []),
  ];
  if (required.some((c) => !cols.has(c)))
    throw new Error(`CC Switch ${table} 表结构不受支持`);
  const numeric = [
    ...COUNTERS.filter((c) => cols.has(c)),
    ...(rollup ? ["request_count"] : ["created_at"]),
  ];
  const invalid = numeric.map((c) => `typeof(${c})!='integer' OR ${c}<0`);
  if (cols.has("input_token_semantics"))
    invalid.push(
      "typeof(input_token_semantics)!='integer' OR input_token_semantics NOT IN (0,1,2)",
    );
  invalid.push(
    "typeof(app_type)!='text' OR app_type='' OR typeof(model)!='text' OR model=''",
  );
  if (
    db
      .prepare(
        `SELECT 1 FROM ${table} WHERE ${invalid.map((c) => "(" + c + ")").join(" OR ")} LIMIT 1`,
      )
      .get()
  )
    throw new Error(`CC Switch ${table} 包含无效的用量数据`);
}
function queryFor(table, cols, rollup) {
  const expr = expressions(cols);
  return `SELECT ${rollup ? "date" : "date(created_at,'unixepoch','localtime')"} AS date,app_type,model,
 SUM(${expr.input}) AS input,SUM(output_tokens) AS output,SUM(${expr.cached}) AS cached,
 ${rollup ? "SUM(request_count)" : "COUNT(*)"} AS requests FROM ${table} GROUP BY date,app_type,model`;
}
const number = (value) => {
  if (typeof value === "bigint" && value >= 0n && value <= MAX)
    return Number(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
  throw new Error("CC Switch 汇总计数超出安全范围");
};
async function revisionOf(file) {
  const stamps = await Promise.all(
    [file, file + "-wal"].map(async (p) => {
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
    throw new Error("CC Switch 数据文件版本无效");
  return revision;
}
/** Only statistics columns are queried; provider settings, conversations and request IDs are never read. */
export async function readCcsSnapshots(dbFile, device) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let records;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    const logCols = columns(db, "proxy_request_logs");
    validateTable(db, "proxy_request_logs", logCols, false);
    const queries = [queryFor("proxy_request_logs", logCols, false)];
    const rollupCols = columns(db, "usage_daily_rollups");
    if (rollupCols.size) {
      validateTable(db, "usage_daily_rollups", rollupCols, true);
      queries.push(queryFor("usage_daily_rollups", rollupCols, true));
    }
    const stmt = db.prepare(
      `SELECT date,app_type,model,SUM(input) AS input,SUM(output) AS output,SUM(cached) AS cached,SUM(requests) AS requests FROM (${queries.join(" UNION ALL ")}) GROUP BY date,app_type,model ORDER BY date,app_type,model`,
    );
    stmt.setReadBigInts(true);
    records = stmt.all();
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const revision = await revisionOf(dbFile),
    days = new Map();
  for (const rec of records) {
    const client = Object.hasOwn(CLIENTS, rec.app_type)
      ? CLIENTS[rec.app_type]
      : rec.app_type;
    const row = {
      client,
      model: rec.model,
      input: number(rec.input),
      output: number(rec.output),
      cached: number(rec.cached),
      requests: number(rec.requests),
    };
    if (!days.has(rec.date)) days.set(rec.date, new Map());
    const key = JSON.stringify([client, row.model]);
    const previous = days.get(rec.date).get(key);
    if (previous)
      for (const k of ["input", "output", "cached", "requests"])
        row[k] = number(BigInt(previous[k]) + BigInt(row[k]));
    days.get(rec.date).set(key, row);
  }
  return [...days].map(([date, models]) => {
    const { source, ...snapshot } = parseSnapshot("ccs", {
      device,
      date,
      revision,
      rows: [...models.values()].sort(
        (a, b) =>
          a.client.localeCompare(b.client) || a.model.localeCompare(b.model),
      ),
    });
    return snapshot;
  });
}
export async function uploadCcsOnce(options) {
  const snapshots = await readCcsSnapshots(options.dbFile, options.device);
  return syncSnapshots({ ...options, source: "ccs", snapshots });
}
