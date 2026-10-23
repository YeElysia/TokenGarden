#!/usr/bin/env node
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { uploadAntigravityOnce } from "./antigravity.mjs";

const help = `antigravity → TokenGarden
node collector/antigravity-upload.mjs --device <稳定的公开设备标识> [--dry-run] [--watch]

--url <站点地址>      或设置 TOKEN_GARDEN_URL
--db <文件>           默认 ~/.antigravity_tools/token_stats.db；或设置 ANTIGRAVITY_DB_FILE
--state <文件>        默认 ~/.antigravity_tools/token-garden-upload/state.json
--interval <秒>       watch 间隔，默认 300，最小 60
ANTIGRAVITY_UPLOAD_TOKEN  仅上传时需要；可以使用 Node --env-file 加载本地配置
`;
async function main() {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--help" || key === "-h") {
      console.log(help);
      return;
    }
    if (["--dry-run", "--watch"].includes(key)) {
      options[key] = true;
      continue;
    }
    if (
      !["--device", "--url", "--db", "--state", "--interval"].includes(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error("命令参数无效；使用 --help 查看用法");
    options[key] = args[++i];
  }
  const device = options["--device"] || process.env.TOKEN_GARDEN_DEVICE;
  if (!device) throw new Error("请用 --device 设置稳定的公开设备标识");
  const agHome = join(homedir(), ".antigravity_tools");
  const interval = Number(options["--interval"] || 300);
  if (!Number.isSafeInteger(interval) || interval < 60)
    throw new Error("interval 必须是至少 60 的整数");
  const config = {
    device,
    url: options["--url"] || process.env.TOKEN_GARDEN_URL,
    token: process.env.ANTIGRAVITY_UPLOAD_TOKEN,
    dbFile: resolve(
      options["--db"] ||
        process.env.ANTIGRAVITY_DB_FILE ||
        join(agHome, "token_stats.db"),
    ),
    stateFile: resolve(
      options["--state"] || join(agHome, "token-garden-upload/state.json"),
    ),
    dryRun: Boolean(options["--dry-run"]),
  };
  if (!config.dryRun && !config.url)
    throw new Error("请设置 TOKEN_GARDEN_URL 或 --url");
  do {
    try {
      console.log(JSON.stringify(await uploadAntigravityOnce(config), null, 2));
    } catch (error) {
      if (!options["--watch"]) throw error;
      console.error(error.message);
    }
    if (config.dryRun || !options["--watch"]) break;
    await delay(interval * 1000);
  } while (true);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
