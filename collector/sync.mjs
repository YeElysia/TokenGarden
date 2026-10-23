import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { uploadFailureDetails } from "../lib/storage-error.mjs";
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function uploadUrl(value, source) {
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
  url.pathname = url.pathname.replace(/\/$/, "") + "/api/upload/" + source;
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
/** Upload daily cumulative snapshots; channel identity stays in the URL and acknowledgement. */
export async function syncSnapshots({
  source,
  snapshots,
  stateFile,
  device,
  url,
  token,
  dryRun = false,
}) {
  if (!["ccs", "dsh", "antigravity"].includes(source)) throw new Error("上传渠道无效");
  const label = source.toUpperCase();
  const days = snapshots.map((s) => ({
    date: s.date,
    models: s.rows.length,
    tokens: s.rows.reduce((n, r) => n + r.input + r.output, 0),
    requests: s.rows.some((r) => r.requests === null)
      ? null
      : s.rows.reduce((n, r) => n + r.requests, 0),
  }));
  if (dryRun)
    return { dryRun: true, days, uploaded: 0, unchanged: 0, ignored: 0 };
  if (!token || /\s/.test(token))
    throw new Error(`请设置 ${label}_UPLOAD_TOKEN`);
  const destination = uploadUrl(url, source);
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
    if (!response.ok) {
      let failure;
      try {
        failure = await response.json();
      } catch {
        /* Older proxies may return HTML. */
      }
      throw new Error(
        `${label} 上传失败（HTTP ${response.status}${uploadFailureDetails(failure)}），未确认的日期将在下次重试`,
      );
    }
    const result = await response.json();
    if (
      result.ok !== true ||
      result.source !== source ||
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
