import { createHash, timingSafeEqual, randomUUID } from "node:crypto";

import { storageDiagnostic } from "./storage-error.mjs";

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (message) => {
  throw new UploadError(400, message);
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
function label(value, name, max) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    fail(`${name} 无效`);
  return value;
}
export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
function integer(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max)
    fail(`${name} 必须为非负安全整数`);
  return value;
}
export function parseSnapshot(source, value) {
  if (!["ccs", "dsh"].includes(source)) fail("上传渠道无效");
  if (!object(value)) fail("上传内容必须是对象");
  const device = label(value.device, "device", 80);
  if (!validDate(value.date)) fail("date 必须是有效的 YYYY-MM-DD 日期");
  const revision = integer(value.revision, "revision");
  if (!revision) fail("revision 必须为正安全整数");
  if (!Array.isArray(value.rows) || value.rows.length > 500)
    fail("rows 必须为最多 500 条的数组");
  const seen = new Set();
  const rows = value.rows.map((row) => {
    if (!object(row)) fail("rows 中的记录必须是对象");
    const client = label(row.client, "client", 80),
      model = label(row.model, "model", 200);
    const key = JSON.stringify([client, model]);
    if (seen.has(key)) fail("同一快照内的 client/model 不可重复");
    seen.add(key);
    const input = integer(row.input, "input"),
      output = integer(row.output, "output"),
      cached = integer(row.cached, "cached");
    if (!Number.isSafeInteger(input + output) || cached > input)
      fail("token 总数或缓存子集无效");
    const requests =
      row.requests === null && source === "dsh"
        ? null
        : integer(row.requests, "requests", 2147483647);
    return { client, model, input, output, cached, requests };
  });
  return { source, device, date: value.date, revision, rows };
}
async function readBody(request) {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new UploadError(415, "请使用 application/json");
  const reader = request.body?.getReader();
  if (!reader) fail("缺少上传内容");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 262144) {
        await reader.cancel();
        throw new UploadError(413, "上传内容超过 256 KiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    fail("JSON 格式无效");
  }
}
/** @param {Request} request
 * @param {string} source
 * @param {{token?:string,save?:((snapshot:any)=>Promise<boolean>)|null}} options */
export async function handleUpload(request, source, { token, save }) {
  const reply = (body, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!["ccs", "dsh"].includes(source))
    return reply({ error: "上传渠道不存在" }, 404);
  if (!token) return reply({ error: "该上传渠道尚未配置" }, 503);
  const provided =
    request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1] ??
    "";
  const digest = (value) => createHash("sha256").update(value).digest();
  if (!provided || !timingSafeEqual(digest(provided), digest(token)))
    return reply({ error: "上传凭据无效" }, 401);
  if (!save) return reply({ error: "上传数据库尚未配置" }, 503);
  try {
    const snapshot = parseSnapshot(source, await readBody(request));
    const applied = await save(snapshot);
    return reply({
      ok: true,
      applied,
      source,
      device: snapshot.device,
      date: snapshot.date,
      revision: snapshot.revision,
      reason: applied ? "merged" : "not_higher",
    });
  } catch (error) {
    if (error instanceof UploadError)
      return reply({ error: error.message }, error.status);
    const requestId = randomUUID();
    const diagnostic = storageDiagnostic(error);
    console.error("TokenGarden upload failed", {
      requestId,
      source,
      ...diagnostic,
    });
    return reply(
      { error: "上传暂时失败，请使用相同版本重试", diagnostic, requestId },
      503,
    );
  }
}
