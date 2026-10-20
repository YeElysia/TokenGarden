/** Atomic single-instance store with a draining flush queue and shutdown fencing. */
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  constants,
  unlinkSync,
} from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export class StatsStore {
  constructor(file, snapshot) {
    this.file = file;
    this.snapshot = snapshot;
    this.dirty = false;
    this.saving = false;
    this.pending = null;
    this.generation = 0;
    this.id = randomUUID();
    this.savedAt = 0;
    this.disposed = false;
    this.blocked = false;
    this.error = null;
    this.timer = null;
    this.legacyBackup = null;
  }
  load() {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Number.isSafeInteger(data.savedAt) || data.savedAt <= 0)
        throw new Error("Invalid savedAt");
      this.savedAt = data.savedAt;
      if (data.version === 1)
        this.legacyBackup = `${this.file}.v1.${data.savedAt}.bak`;
      return data;
    } catch (e) {
      if (e.code === "ENOENT") return null;
      this.blocked = true;
      this.error = "统计文件不可读取，已保留原文件";
      return null;
    }
  }
  schedule() {
    this.dirty = true;
    if (this.disposed || this.blocked || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 1500);
    this.timer.unref?.();
  }
  _text() {
    this.savedAt = Math.max(Date.now(), this.savedAt + 1);
    if (!Number.isSafeInteger(this.savedAt)) throw new Error("Unsafe savedAt");
    return JSON.stringify(this.snapshot(this.savedAt));
  }
  _backup() {
    if (!this.legacyBackup) return;
    try {
      copyFileSync(this.file, this.legacyBackup, constants.COPYFILE_EXCL);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    this.legacyBackup = null;
  }
  flush() {
    if (this.pending) return this.pending;
    if (!this.dirty || this.disposed || this.blocked) return Promise.resolve();
    this.saving = true;
    this.pending = (async () => {
      while (this.dirty && !this.disposed && !this.blocked) {
        this.dirty = false;
        const generation = ++this.generation;
        const temp = `${this.file}.${this.id}.${generation}.tmp`;
        try {
          const text = this._text();
          await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
          await writeFile(temp, text, { mode: 0o600 });
          if (generation === this.generation && !this.disposed) {
            this._backup();
            renameSync(temp, this.file);
            this.error = null;
          }
        } catch {
          this.dirty = true;
          this.error = "统计文件保存失败，将在后续更新时重试";
          break;
        } finally {
          await rm(temp, { force: true }).catch(() => {});
        }
      }
    })().finally(() => {
      this.saving = false;
      this.pending = null;
    });
    return this.pending;
  }
  flushSync() {
    ++this.generation;
    if (this.blocked) return;
    const temp = `${this.file}.${this.id}.${this.generation}.tmp`;
    try {
      const text = this._text();
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(temp, text, { mode: 0o600 });
      this._backup();
      renameSync(temp, this.file);
      this.dirty = false;
      this.error = null;
    } catch {
      this.dirty = true;
      this.error = "统计文件保存失败";
    } finally {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.disposed = true;
    if (this.dirty || this.saving) this.flushSync();
  }
}
