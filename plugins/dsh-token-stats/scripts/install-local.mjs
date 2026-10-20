/** Back up and replace only the installed plugin's program files. Never restart DSH. */
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  stat,
  rename,
  rm,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const target =
  process.env.DSH_TOKEN_STATS_TARGET ||
  join(home, "profiles/web/node_modules/@duke-dsh-plugins/dsh-token-stats");
const files = [
  "index.js",
  "client.js",
  "typert.host.js",
  "quota.js",
  "stats-core.mjs",
  "store.mjs",
  "package.json",
  "cordis.patch.yml",
  "LICENSE",
];
const manifest = JSON.parse(
  await readFile(join(target, "package.json"), "utf8"),
);
if (manifest.name !== "@duke-dsh-plugins/dsh-token-stats")
  throw new Error("Target is not the expected DSH plugin");
const backupRoot =
  process.env.DSH_TOKEN_STATS_BACKUP_DIR ||
  join(home, "data/dsh-token-stats/plugin-backups");
const backup = join(backupRoot, Date.now() + "-" + randomUUID());
await mkdir(backup, { recursive: true, mode: 0o700 });
const old = [];
for (const file of files) {
  try {
    await stat(join(target, file));
    await copyFile(join(target, file), join(backup, file));
    old.push(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
await writeFile(
  join(backup, "backup-manifest.json"),
  JSON.stringify(
    { target, files: old, installedVersion: manifest.version },
    null,
    2,
  ),
  { mode: 0o600 },
);
// Stage every file before replacing any installed module.
const stages = [];
try {
  for (const file of files) {
    const temp = join(target, file + "." + randomUUID() + ".tmp");
    await copyFile(join(source, file), temp);
    stages.push([temp, join(target, file)]);
  }
  for (const [temp, destination] of stages) await rename(temp, destination);
} catch (error) {
  // Restore original program files if an installation step fails.
  for (const file of old)
    await copyFile(join(backup, file), join(target, file));
  for (const file of files)
    if (!old.includes(file)) await rm(join(target, file), { force: true });
  throw error;
} finally {
  for (const [temp] of stages) await rm(temp, { force: true });
}
console.log(
  JSON.stringify(
    {
      installed: target,
      version: JSON.parse(await readFile(join(source, "package.json"), "utf8"))
        .version,
      backup,
      restartRequired: true,
    },
    null,
    2,
  ),
);
