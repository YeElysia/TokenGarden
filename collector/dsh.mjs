import { readFile } from "node:fs/promises";
import { parseSnapshot } from "../lib/upload.mjs";
import { syncSnapshots } from "./sync.mjs";
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
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
/** Reads only aggregate stats; no session or credential files. */
export async function uploadDshOnce(options) {
  const snapshots = dshSnapshots(
    JSON.parse(await readFile(options.statsFile, "utf8")),
    options.device,
  );
  return syncSnapshots({ ...options, source: "dsh", snapshots });
}
