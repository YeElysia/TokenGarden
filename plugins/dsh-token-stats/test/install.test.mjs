import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const exec = promisify(execFile);
test("local installer backs up program files and preserves stats and profile configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-installer-"));
  const target = join(
    home,
    "profiles/web/node_modules/@duke-dsh-plugins/dsh-token-stats",
  );
  try {
    await mkdir(target, { recursive: true });
    await mkdir(join(home, "data/dsh-token-stats"), { recursive: true });
    await writeFile(
      join(target, "package.json"),
      JSON.stringify({
        name: "@duke-dsh-plugins/dsh-token-stats",
        version: "1.7.3",
      }),
    );
    await writeFile(join(target, "index.js"), "original-host");
    await writeFile(
      join(home, "data/dsh-token-stats/stats.json"),
      "original-stats",
    );
    await writeFile(join(home, "profiles/web/cordis.yml"), "original-profile");
    const { stdout } = await exec(
      process.execPath,
      [new URL("../scripts/install-local.mjs", import.meta.url).pathname],
      {
        env: { ...process.env, DSH_HOME: home, DSH_TOKEN_STATS_TARGET: target },
      },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.version, "2.0.0-local.1");
    assert.equal(
      await readFile(join(result.backup, "index.js"), "utf8"),
      "original-host",
    );
    assert.equal(
      await readFile(join(target, "index.js"), "utf8"),
      await readFile(new URL("../index.js", import.meta.url), "utf8"),
    );
    assert.equal(
      await readFile(join(home, "data/dsh-token-stats/stats.json"), "utf8"),
      "original-stats",
    );
    assert.equal(
      await readFile(join(home, "profiles/web/cordis.yml"), "utf8"),
      "original-profile",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("local installer rejects unrelated packages without replacing their files", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-installer-other-"));
  try {
    await writeFile(
      join(home, "package.json"),
      JSON.stringify({ name: "another-plugin" }),
    );
    await writeFile(join(home, "index.js"), "original");
    await assert.rejects(
      exec(
        process.execPath,
        [new URL("../scripts/install-local.mjs", import.meta.url).pathname],
        {
          env: { ...process.env, DSH_HOME: home, DSH_TOKEN_STATS_TARGET: home },
        },
      ),
    );
    assert.equal(await readFile(join(home, "index.js"), "utf8"), "original");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
