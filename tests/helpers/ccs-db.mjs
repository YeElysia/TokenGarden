import { DatabaseSync } from "node:sqlite";
export function createCcsDb(file, { rollups = true, semantics = true } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE proxy_request_logs (
 request_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL DEFAULT 'private-provider', app_type TEXT NOT NULL, model TEXT NOT NULL,
 input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
 cache_creation_tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, status_code INTEGER NOT NULL DEFAULT 200,
 session_id TEXT DEFAULT 'private-session', error_message TEXT DEFAULT 'private-error' ${semantics ? ",input_token_semantics INTEGER NOT NULL DEFAULT 0" : ""});
 CREATE TABLE providers (settings_config TEXT); INSERT INTO providers VALUES ('DO-NOT-UPLOAD-CREDENTIALS');`);
  if (rollups)
    db.exec(`CREATE TABLE usage_daily_rollups (
 date TEXT NOT NULL,app_type TEXT NOT NULL,provider_id TEXT DEFAULT 'private-provider',model TEXT NOT NULL,request_count INTEGER NOT NULL,
 input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,cache_read_tokens INTEGER NOT NULL DEFAULT 0,
 cache_creation_tokens INTEGER NOT NULL DEFAULT 0 ${semantics ? ",input_token_semantics INTEGER NOT NULL DEFAULT 0" : ""});`);
  return db;
}
export function insertLog(
  db,
  {
    id = "a",
    app = "claude",
    model = "sonnet",
    input = 100,
    output = 20,
    cached = 300,
    write = 50,
    sem = 0,
    time = 1792339200,
    status = 200,
  } = {},
) {
  const cols = db
    .prepare("PRAGMA table_info(proxy_request_logs)")
    .all()
    .map((c) => c.name);
  const values = [id, app, model, input, output, cached, write, time, status];
  if (cols.includes("input_token_semantics")) values.push(sem);
  db.prepare(
    `INSERT INTO proxy_request_logs(request_id,app_type,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,created_at,status_code${cols.includes("input_token_semantics") ? ",input_token_semantics" : ""}) VALUES(${values.map(() => "?").join(",")})`,
  ).run(...values);
}
export function insertRollup(
  db,
  {
    date = "2026-06-23",
    app = "codex",
    model = "gpt-x",
    input = 1000,
    output = 50,
    cached = 600,
    write = 100,
    sem = 0,
    requests = 3,
  } = {},
) {
  const cols = db
    .prepare("PRAGMA table_info(usage_daily_rollups)")
    .all()
    .map((c) => c.name);
  const values = [date, app, model, input, output, cached, write, requests];
  if (cols.includes("input_token_semantics")) values.push(sem);
  db.prepare(
    `INSERT INTO usage_daily_rollups(date,app_type,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,request_count${cols.includes("input_token_semantics") ? ",input_token_semantics" : ""}) VALUES(${values.map(() => "?").join(",")})`,
  ).run(...values);
}
