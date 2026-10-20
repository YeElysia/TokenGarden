import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const home = await mkdtemp(join(tmpdir(), "dsh-accounting-"));
process.env.DSH_HOME = home;
const { TokenStatsService } = await import(
  process.env.TOKEN_STATS_PLUGIN
    ? pathToFileURL(process.env.TOKEN_STATS_PLUGIN).href
    : new URL("../index.js", import.meta.url)
);
const { Service } = await import("@deepseek-ai/cordis");
const file = join(home, "data/dsh-token-stats/stats.json");
const now = Date.now();
const date = new Date(now);
const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const event = (seq, input = 10, patch = {}) => ({
  seq,
  time: now,
  type: "assistant/message",
  data: {
    message: { source: { kind: "model", provider: "p", model: "m" } },
    usage: { inputTokens: input, outputTokens: 0 },
  },
  ...patch,
});
const header = () =>
  event(0, 0, {
    type: "request/header",
    data: { header: { config: { provider: "p", model: "m" } } },
  });
const history = (events) => ({
  listSessions: async () => [{ header: { id: "s" } }],
  readSession: async () => ({ inheritedEventCount: 0, events }),
});
function make(t, q) {
  const cleanup = [];
  const ctx = {
    reflect: { provide() {} },
    on() {},
    get(name) {
      return name === "sessionQuery" ? q : undefined;
    },
    effect(fn) {
      cleanup.push(fn());
    },
  };
  const svc = new TokenStatsService(ctx, {});
  const start = svc._startBackfill.bind(svc);
  svc._startBackfill = () => (svc.pending = start());
  svc[Service.init]();
  t.after(async () => {
    await svc.pending;
    await svc._saveNow();
    cleanup.forEach((fn) => fn?.());
    while (svc._saving) await new Promise((resolve) => setImmediate(resolve));
  });
  return svc;
}
const record = async (svc) =>
  (await svc.getStats()).value.days
    .find((d) => d.date === day)
    ?.models.find((m) => m.key === "p::m");
const legacy = async (total = 100) => {
  await mkdir(join(home, "data/dsh-token-stats"), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: now + 1,
      watermarks: { s: 1 },
      folded: ["s"],
      modelMeta: { "p::m": { key: "p::m", name: "m", provider: "p" } },
      days: {
        [day]: {
          "p::m": {
            input: total,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            total,
          },
        },
      },
    }),
  );
};
beforeEach(() => rm(join(home, "data"), { recursive: true, force: true }));
after(() => rm(home, { recursive: true, force: true }));
test("counts model calls once, including zero usage and missing-usage responses", async (t) => {
  const svc = make(t, history([]));
  await svc.pending;
  svc._onSessionEvent({ id: "s" }, event(1, 10));
  svc._onSessionEvent({ id: "s" }, event(1, 10));
  svc._onSessionEvent({ id: "s" }, event(2, 0));
  svc._onSessionEvent(
    { id: "s" },
    event(3, 0, {
      data: {
        message: { source: { kind: "model", provider: "p", model: "m" } },
      },
    }),
  );
  const r = await record(svc);
  assert.equal(r.requests, 3);
  assert.equal(r.total, 10);
  assert.equal(r.usageMissing, 1);
});
test("failed attempts use the request header and latest stream usage, not sum of usage chunks", async (t) => {
  const svc = make(
    t,
    history([
      header(),
      event(1, 0, {
        type: "assistant/attempt",
        data: {
          stream: [
            {
              time: now,
              chunk: {
                type: "usage",
                usage: { inputTokens: 3, outputTokens: 0 },
              },
            },
            {
              time: now,
              chunk: {
                type: "usage",
                usage: { inputTokens: 7, outputTokens: 0 },
              },
            },
          ],
        },
      }),
    ]),
  );
  await svc.pending;
  const r = await record(svc);
  assert.equal(r.total, 7);
  assert.equal(r.requests, 1);
});
test("compaction model calls and title requests are included but synthetic summaries are excluded", async (t) => {
  const svc = make(
    t,
    history([
      event(0, 0, {
        type: "compaction/summary",
        data: {
          provider: "p",
          model: "m",
          llmStreamCall: true,
          usage: { inputTokens: 20, outputTokens: 5 },
        },
      }),
      event(1, 0, {
        type: "compaction/summary",
        data: {
          provider: "p",
          model: "m",
          usage: { inputTokens: 999, outputTokens: 0 },
        },
      }),
      event(2, 0, {
        type: "session/title-llm-request",
        data: { route: { provider: "p", model: "m" } },
      }),
    ]),
  );
  await svc.pending;
  const r = await record(svc);
  assert.equal(r.total, 25);
  assert.equal(r.requests, 2);
  assert.equal(r.usageMissing, 1);
});
test("legacy floor remains and newly appended usage is additive even when old logs are missing", async (t) => {
  await legacy();
  const svc = make(t, history([event(0, 40), event(2, 20)]));
  await svc.pending;
  const r = await record(svc);
  assert.equal(r.total, 120);
  assert.equal(r.requests, null);
  assert.equal(r.knownRequests, 2);
});
test("complete legacy replay backfills request counts without double adding legacy tokens", async (t) => {
  await legacy();
  const svc = make(t, history([event(0, 40), event(1, 60), event(2, 20)]));
  await svc.pending;
  const r = await record(svc);
  assert.equal(r.total, 120);
  assert.equal(r.requests, 3);
});
test("version-2 restart keeps request counts when old logs disappear", async (t) => {
  const first = make(t, history([event(0, 10), event(1, 20)]));
  await first.pending;
  await first._saveNow();
  const data = JSON.parse(await readFile(file, "utf8"));
  assert.equal(data.version, 2);
  assert.ok(!JSON.stringify(data).includes("message")); // only sanitized facts, never raw event objects
  const second = make(t, history([]));
  await second.pending;
  const r = await record(second);
  assert.equal(r.total, 30);
  assert.equal(r.requests, 2);
});
test("fork-inherited prefix is not a new request but supplies the failed-attempt route", async (t) => {
  const svc = make(t, {
    listSessions: async () => [{ header: { id: "s" } }],
    readSession: async () => ({
      inheritedEventCount: 2,
      events: [
        header(),
        event(1, 99),
        event(2, 0, { type: "assistant/attempt", data: { stream: [] } }),
      ],
    }),
  });
  await svc.pending;
  const r = await record(svc);
  assert.equal(r.total, 0);
  assert.equal(r.requests, 1);
});
test("history/live overlap and out-of-order delivery preserve exact request identities", async (t) => {
  let release;
  const barrier = new Promise((resolve) => (release = resolve));
  const svc = make(t, {
    listSessions: async () => {
      await barrier;
      return [{ header: { id: "s" } }];
    },
    readSession: async () => ({
      events: [event(0, 10), event(1, 20), event(2, 30)],
    }),
  });
  svc._onSessionEvent({ id: "s" }, event(2, 30));
  release();
  await svc.pending;
  svc._onSessionEvent({ id: "s" }, event(5, 50));
  svc._onSessionEvent({ id: "s" }, event(4, 40));
  svc._onSessionEvent({ id: "s" }, event(4, 40));
  const r = await record(svc);
  assert.equal(r.total, 150);
  assert.equal(r.requests, 5);
});
test("invalid usage does not consume the identity of a corrected record", async (t) => {
  const svc = make(t, history([]));
  await svc.pending;
  svc._onSessionEvent({ id: "s" }, event(0, -1));
  svc._onSessionEvent({ id: "s" }, event(0, 10));
  const r = await record(svc);
  assert.equal(r.total, 10);
  assert.equal(r.requests, 1);
});

test("strict Typert codec preserves counts on populated responses", async (t) => {
  const { TYPERT } = await import("../typert.host.js");
  const svc = make(t, history([event(0, 15)]));
  await svc.pending;
  const invocation = TYPERT.invocations.find((i) => i.method === "getStats");
  const parsed = invocation.result.schema.parse(await svc.getStats());
  assert.equal(parsed.value.days[0].requests, 1);
  assert.equal(parsed.value.days[0].models[0].knownRequests, 1);
});
test("save queue includes updates arriving during a flush and shutdown supersedes old snapshots", async (t) => {
  const svc = make(t, undefined);
  svc._onSessionEvent({ id: "s" }, event(0, 10));
  const pending = svc._saveNow();
  svc._onSessionEvent({ id: "s" }, event(1, 20));
  await pending;
  let saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.days[day]["p::m"].total, 30);
  svc._onSessionEvent({ id: "s" }, event(2, 40));
  const next = svc._saveNow();
  svc._onSessionEvent({ id: "s" }, event(3, 50));
  svc._saveSync();
  await next;
  saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.days[day]["p::m"].total, 120);
  assert.equal(saved.days[day]["p::m"].requests, 4);
});
test("corrupt stores remain intact instead of silently replacing lost history", async (t) => {
  await mkdir(join(home, "data/dsh-token-stats"), { recursive: true });
  await writeFile(file, "{broken");
  const svc = make(t, history([event(0, 10)]));
  await svc.pending;
  await svc._saveNow();
  assert.equal(await readFile(file, "utf8"), "{broken");
  assert.match((await svc.getStats()).value.error, /保留原文件/);
});
test("migration backs up the original version-1 aggregate before first version-2 write", async (t) => {
  await legacy();
  const before = await readFile(file, "utf8");
  const svc = make(t, history([event(0, 40), event(1, 60)]));
  await svc.pending;
  assert.equal(await readFile(`${file}.v1.${now + 1}.bak`, "utf8"), before);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 2);
});
test("malformed sequence and nonfinite token counters do not create requests", async (t) => {
  const svc = make(t, history([]));
  await svc.pending;
  for (const bad of [-1, 0.5, Infinity, "1"])
    svc._onSessionEvent({ id: "s" }, event(bad, 10));
  for (const bad of [-1, 0.5, Infinity, "1"])
    svc._onSessionEvent({ id: "s" }, event(0, bad));
  assert.equal((await svc.getStats()).value.days.length, 0);
});

test("missing legacy sessions keep count coverage unknown even when recovered tokens equal the floor", async (t) => {
  await legacy();
  const data = JSON.parse(await readFile(file, "utf8"));
  data.watermarks.other = 0;
  await writeFile(file, JSON.stringify(data));
  const svc = make(t, history([event(0, 40), event(1, 60)]));
  await svc.pending;
  assert.equal((await record(svc)).requests, null);
});
test("sessions absent from legacy watermarks add all usage even if their timestamps precede savedAt", async (t) => {
  await legacy();
  const svc = make(t, {
    listSessions: async () => [{ header: { id: "unseen" } }],
    readSession: async () => ({ events: [event(0, 30)] }),
  });
  await svc.pending;
  const r = await record(svc);
  assert.equal(r.total, 130);
  assert.equal(r.requests, null);
  assert.equal(r.knownRequests, 1);
});
test("version-1 empty-session watermark -1 remains valid during migration", async (t) => {
  await legacy();
  const data = JSON.parse(await readFile(file, "utf8"));
  data.watermarks.empty = -1;
  await writeFile(file, JSON.stringify(data));
  const svc = make(t, history([event(0, 40), event(1, 60)]));
  await svc.pending;
  const r = await record(svc);
  assert.equal(r.total, 100);
  assert.equal(r.requests, 2);
  assert.equal((await svc.getStats()).value.error, null);
});

test("zero-token legacy rows still keep request counts unknown when session coverage is missing", async (t) => {
  await legacy(0);
  const svc = make(t, history([]));
  await svc.pending;
  assert.equal((await record(svc)).requests, null);
  assert.equal((await record(svc)).total, 0);
});
