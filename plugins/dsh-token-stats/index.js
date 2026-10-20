/** DSH Host adapter. Accounting is in stats-core.mjs; quotas in quota.js. */
import { Remote } from "@deepseek-ai/dsh-typert-protocol";
import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageLedger, dayKey } from "./stats-core.mjs";
import { StatsStore } from "./store.mjs";
import { QuotaService } from "./quota.js";
function markRemoteMethod(instance, method, exportName) {
  const decorator = Remote(method, undefined);
  const initializers = [];
  decorator(undefined, {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer: (fn) => initializers.push(fn),
  });
  for (const fn of initializers) fn.call(instance);
}

export class TokenStatsService extends QuotaService {
  static inject = [];
  [Service.init]() {
    this._engine = new UsageLedger();
    this._byDay = new Map();
    this._modelMeta = this._engine.modelMeta;
    this._routes = new Map();
    this._backfill = {
      started: false,
      done: false,
      total: 0,
      doneCount: 0,
      error: null,
    };
    this._retryAt = 0;
    this._disposed = false;
    this._initErrors = [];
    this._quotaCache = Object.create(null);
    this._quotaActiveRef = Object.create(null);
    this._curlPath = null;
    const file = join(
      process.env.DSH_HOME || join(homedir(), ".dsh"),
      "data/dsh-token-stats/stats.json",
    );
    this._store = new StatsStore(file, (revision) =>
      this._engine.serialize(revision),
    );
    const loaded = this._store.load();
    if (loaded)
      try {
        this._engine.restore(loaded);
      } catch {
        this._engine = new UsageLedger();
        this._modelMeta = this._engine.modelMeta;
        this._store.blocked = true;
        this._store.error = "统计文件结构不兼容，已保留原文件";
      }
    this._refresh();
    for (const method of ["getStats", "getQuota", "getAllQuotas"])
      try {
        markRemoteMethod(this, method, method);
      } catch {
        this._initErrors.push(method + " 未发布");
      }
    try {
      this.ctx.effect(() => () => {
        this._disposed = true;
        clearTimeout(this._retryTimer);
        this._store.dispose();
      });
    } catch {
      this._initErrors.push("退出保存未注册");
    }
    try {
      this.ctx.on("session/event", (session, event) =>
        this._onSessionEvent(session, event),
      );
    } catch {
      this._initErrors.push("实时采集未注册");
    }
    void this._startBackfill();
  }
  _refresh() {
    this._byDay = this._engine.days();
    this._modelMeta = this._engine.modelMeta;
  }
  _dayKeyOf(time) {
    return dayKey(time);
  }
  get _saving() {
    return this._store.saving;
  }
  _saveNow() {
    return this._store.flush();
  }
  _saveSync() {
    return this._store.flushSync();
  }
  _serializeStore() {
    return this._store._text();
  }
  _onSessionEvent(session, event) {
    if (this._disposed || !session || typeof session.id !== "string" || !event)
      return;
    try {
      if (event.type === "request/header") {
        this._routes.set(session.id, event.data?.header?.config);
        return;
      }
      if (event.seq < (session.inheritedEventCount || 0)) return;
      const route =
        this._routes.get(session.id) ?? session.requestHeader?.()?.config;
      if (this._engine.ingest(session.id, event, route)) {
        this._refresh();
        this._store.schedule();
      }
    } catch {
      /* An observer must never prevent the session append. */
    }
  }
  async _startBackfill() {
    if (this._disposed || this._backfill.started || this._backfill.done) return;
    let query;
    try {
      query = this.ctx.get("sessionQuery");
    } catch {
      this._backfill.error = "历史查询不可用";
      return;
    }
    if (!query || typeof query.listSessions !== "function") {
      clearTimeout(this._retryTimer);
      this._retryTimer = setTimeout(() => {
        void this._startBackfill();
      }, 5000);
      this._retryTimer.unref?.();
      return;
    }
    Object.assign(this._backfill, {
      started: true,
      done: false,
      total: 0,
      doneCount: 0,
      error: null,
    });
    let failed = false;
    try {
      const sessions = await query.listSessions();
      if (!Array.isArray(sessions)) throw new Error("Invalid session list");
      this._backfill.total = sessions.length;
      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= sessions.length || this._disposed) return;
          try {
            const sid = sessions[i]?.header?.id;
            if (typeof sid !== "string" || !sid)
              throw new Error("Invalid session");
            const snapshot = await query.readSession(sid);
            if (this._disposed) return;
            if (this._engine.ingestHistory(sid, snapshot)) {
              this._refresh();
              this._store.schedule();
            }
          } catch {
            failed = true;
          } finally {
            this._backfill.doneCount++;
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } catch {
      failed = true;
    }
    if (this._disposed) return;
    this._backfill.started = false;
    this._backfill.done = !failed;
    this._backfill.error = failed ? "部分历史记录未完成读取，将自动重试" : null;
    this._retryAt = failed ? Date.now() + 30000 : 0;
    if (failed) {
      clearTimeout(this._retryTimer);
      this._retryTimer = setTimeout(() => {
        void this._startBackfill();
      }, 30000);
      this._retryTimer.unref?.();
    }
    await this._saveNow();
  }
  async getStats() {
    if (
      !this._backfill.started &&
      !this._backfill.done &&
      Date.now() >= this._retryAt
    )
      void this._startBackfill();
    const days = [];
    for (const [date, day] of this._byDay) {
      const models = [...day]
        .map(([key, rec]) => ({ ...this._modelMeta.get(key), ...rec }))
        .sort((a, b) => b.total - a.total);
      days.push({
        date,
        total: models.reduce((n, r) => n + r.total, 0),
        requests: models.some((r) => r.requests === null)
          ? null
          : models.reduce((n, r) => n + r.requests, 0),
        knownRequests: models.reduce((n, r) => n + r.knownRequests, 0),
        usageMissing: models.reduce((n, r) => n + r.usageMissing, 0),
        models,
      });
    }
    const errors = [
      ...this._initErrors,
      this._backfill.error,
      this._store.error,
    ].filter(Boolean);
    return {
      ok: true,
      value: {
        ready: this._backfill.done,
        collecting: this._backfill.started,
        progress: {
          done: this._backfill.doneCount,
          total: this._backfill.total,
        },
        error: errors.length ? errors.join("；") : null,
        days,
        models: [...this._modelMeta.values()],
      },
    };
  }
}
export default TokenStatsService;
