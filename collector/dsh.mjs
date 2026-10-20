import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseSnapshot } from "../lib/upload.mjs";

const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function dshSnapshots(store, device) {
  if (!object(store) || ![1, 2].includes(store.version))
    throw new Error("不支持的 DSH 统计文件版本");
  if (!Number.isSafeInteger(store.savedAt) || store.savedAt <= 0)
    throw new Error("DSH savedAt 无效");
  if (!object(store.days)) throw new Error("DSH days 无效");
  return Object.keys(store.days)
    .sort()
    .map((date) => {
      const models = store.days[date];
      if (!object(models)) throw new Error("DSH 每日统计无效");
      const rows = Object.keys(models)
        .sort()
        .map((model) => {
          const rec = models[model];
          if (!object(rec)) throw new Error("DSH 模型统计无效");
          const values = ["input", "output", "cacheRead", "cacheWrite"].map(
            (key) => {
              const value = rec[key] ?? 0;
              if (!Number.isSafeInteger(value) || value < 0)
                throw new Error("DSH token 计数无效");
              return value;
            },
          );
          const [input, output, cacheRead, cacheWrite] = values;
          const total = input + output + cacheRead + cacheWrite;
          if (!Number.isSafeInteger(total) || rec.total !== total)
            throw new Error("DSH total 与分类计数不一致");
          return {
            client: "DSH",
            model,
            input: input + cacheRead + cacheWrite,
            output,
            cached: cacheRead,
            requests: store.version === 2 ? rec.requests : null,
          };
        });
      const { source, ...snapshot } = parseSnapshot("dsh", {
        device,
        date,
        revision: store.savedAt,
        rows,
      });
      return snapshot;
    });
}
function uploadUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("站点地址不能包含凭据、查询参数或锚点");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("远程上传必须使用 HTTPS");
  url.pathname = url.pathname.replace(/\/$/, "") + "/api/upload/dsh";
  return url.toString();
}
async function readState(file) {
  try {
    const state = JSON.parse(await readFile(file, "utf8"));
    if (state.version !== 1 || !object(state.targets))
      throw new Error("上传状态文件无效");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, targets: {} };
    throw error;
  }
}
async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, file);
}
/** Reads only the aggregate stats file. No provider credentials or session files are read. */
export async function uploadDshOnce({
  statsFile,
  stateFile,
  device,
  url,
  token,
  dryRun = false,
}) {
  const snapshots = dshSnapshots(
    JSON.parse(await readFile(statsFile, "utf8")),
    device,
  );
  const days = snapshots.map((s) => ({
    date: s.date,
    models: s.rows.length,
    tokens: s.rows.reduce((n, r) => n + r.input + r.output, 0),
  }));
  if (dryRun)
    return { dryRun: true, days, uploaded: 0, unchanged: 0, ignored: 0 };
  if (!token || /\s/.test(token)) throw new Error("请设置 DSH_UPLOAD_TOKEN");
  const destination = uploadUrl(url);
  const state = await readState(stateFile);
  const key = hash([destination, device]);
  const target = (state.targets[key] ??= { days: {} });
  let uploaded = 0,
    unchanged = 0,
    ignored = 0;
  for (const snapshot of snapshots) {
    const fingerprint = hash(snapshot.rows);
    const previous = target.days[snapshot.date];
    if (
      previous === fingerprint ||
      (previous?.fingerprint === fingerprint &&
        previous.revision === snapshot.revision)
    ) {
      unchanged++;
      continue;
    }
    const response = await fetch(destination, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify(snapshot),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        `DSH 上传失败（HTTP ${response.status}），未确认的日期将在下次重试`,
      );
    const result = await response.json();
    if (
      result.ok !== true ||
      result.source !== "dsh" ||
      result.device !== device ||
      result.date !== snapshot.date ||
      result.revision !== snapshot.revision ||
      typeof result.applied !== "boolean"
    )
      throw new Error("服务端未返回有效的上传确认");
    // A rejected version does not certify that its content is stored remotely.
    // Skip only that exact rejected revision; a newer revision must be retried.
    target.days[snapshot.date] = result.applied
      ? fingerprint
      : { fingerprint, revision: snapshot.revision };
    await saveState(stateFile, state);
    if (result.applied) uploaded++;
    else ignored++;
  }
  return { dryRun: false, days, uploaded, unchanged, ignored };
}
