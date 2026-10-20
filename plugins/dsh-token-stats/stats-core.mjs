/** Pure accounting ledger. No SDK, I/O, credentials or conversation persistence. */
export const WINDOW_DAYS = 400;
const FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "total",
];
const TYPES = new Set(["assistant", "attempt", "compaction", "session-title"]);
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
export const dayKey = (time) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const validTime = (t) => integer(t) && Number.isFinite(new Date(t).getTime());
const validDate = (s) =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  dayKey(new Date(`${s}T12:00:00`).getTime()) === s;
const routeOK = (r) =>
  object(r) &&
  typeof r.provider === "string" &&
  typeof r.model === "string" &&
  r.model.length > 0;
const zero = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
  knownRequests: 0,
  usageMissing: 0,
});
function usageOf(usage) {
  if (usage === undefined) return { ...zero(), usageMissing: 1 };
  if (!object(usage)) return null;
  const values = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ].map((k) => usage[k] ?? 0);
  if (!values.every(integer)) return null;
  const [input, output, cacheRead, cacheWrite, reasoning] = values;
  const total = input + output + cacheRead + cacheWrite;
  if (!integer(total)) return null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total,
    knownRequests: 0,
    usageMissing: 0,
  };
}
function latestUsage(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i--)
    if (stream[i]?.chunk?.type === "usage") return stream[i].chunk.usage;
}
function normalize(event, route) {
  if (!event || !integer(event.seq) || !validTime(event.time)) return null;
  const data = event.data;
  if (!object(data)) return null;
  let kind, source, usage;
  if (event.type === "assistant/message") {
    source = data.message?.source;
    if (source?.kind !== "model") return null;
    kind = "assistant";
    usage = data.usage ?? latestUsage(data.stream);
  } else if (event.type === "assistant/attempt") {
    source = route;
    kind = "attempt";
    usage = latestUsage(data.stream);
  } else if (
    event.type === "compaction/summary" &&
    data.llmStreamCall === true
  ) {
    source = data;
    kind = "compaction";
    usage = data.usage;
  } else if (event.type === "session/title-llm-request") {
    source = data.route;
    kind = "session-title";
  } else return null;
  if (!routeOK(source)) return null;
  const counters = usageOf(usage);
  if (!counters) return null;
  return {
    time: event.time,
    kind,
    provider: source.provider,
    model: source.model,
    ...counters,
    knownRequests: 1,
  };
}
function sum(a, b, sign = 1) {
  const next = { ...a };
  for (const key of [...FIELDS, "knownRequests", "usageMissing"]) {
    next[key] = (a[key] ?? 0) + sign * (b[key] ?? 0);
    if (!integer(next[key])) throw new Error("Unsafe aggregate counter");
  }
  return next;
}
function entry(map, date, key) {
  if (!map.has(date)) map.set(date, new Map());
  return map.get(date).get(key) ?? zero();
}
function loadFloor(days) {
  const result = new Map();
  if (!object(days)) throw new Error("Invalid legacy days");
  for (const [date, models] of Object.entries(days)) {
    if (!validDate(date) || !object(models))
      throw new Error("Invalid legacy day");
    const day = new Map();
    for (const [key, value] of Object.entries(models)) {
      if (!object(value)) throw new Error("Invalid legacy model");
      const rec = Object.fromEntries(FIELDS.map((k) => [k, value[k] ?? 0]));
      if (
        !Object.values(rec).every(integer) ||
        rec.total !== rec.input + rec.output + rec.cacheRead + rec.cacheWrite
      )
        throw new Error("Invalid legacy counters");
      day.set(key, rec);
    }
    result.set(date, day);
  }
  return result;
}
export class UsageLedger {
  constructor() {
    this.facts = new Map();
    this.covered = new Map();
    this.added = new Map();
    this.floor = new Map();
    this.modelMeta = new Map();
    this.legacy = null;
    this.verifiedLegacy = new Set();
  }
  restore(data) {
    if (!object(data) || ![1, 2].includes(data.version))
      throw new Error("Unsupported statistics store");
    const legacy = data.version === 1 ? data : data.legacy;
    if (legacy) {
      if (!integer(legacy.savedAt) || !object(legacy.watermarks))
        throw new Error("Invalid legacy boundary");
      this.legacy = {
        savedAt: legacy.savedAt,
        watermarks: Object.assign(Object.create(null), legacy.watermarks),
        days: legacy.days,
      };
      for (const seq of Object.values(this.legacy.watermarks))
        if (!(integer(seq) || seq === -1))
          throw new Error("Invalid legacy watermark");
      this.verifiedLegacy = new Set(
        (Array.isArray(legacy.verifiedSessions)
          ? legacy.verifiedSessions
          : []
        ).filter(
          (sid) =>
            typeof sid === "string" &&
            Object.hasOwn(this.legacy.watermarks, sid),
        ),
      );
      this.floor = loadFloor(legacy.days);
      for (const [date, models] of this.floor)
        for (const key of models.keys()) {
          const meta = data.modelMeta?.[key] ?? legacy.modelMeta?.[key];
          const pos = key.indexOf("::");
          this.modelMeta.set(key, {
            key,
            name:
              typeof meta?.name === "string" ? meta.name : key.slice(pos + 2),
            provider:
              typeof meta?.provider === "string"
                ? meta.provider
                : key.slice(0, pos),
          });
        }
    }
    if (data.version === 2) {
      if (!object(data.ledger)) throw new Error("Missing event ledger");
      for (const [sid, events] of Object.entries(data.ledger)) {
        if (!object(events)) throw new Error("Invalid ledger session");
        for (const [seq, fact] of Object.entries(events)) {
          if (
            !object(fact) ||
            !validTime(fact.time) ||
            !TYPES.has(fact.kind) ||
            !routeOK(fact)
          )
            throw new Error("Invalid ledger fact");
          if (
            ![...FIELDS, "knownRequests", "usageMissing"].every((k) =>
              integer(fact[k]),
            ) ||
            fact.knownRequests !== 1 ||
            fact.usageMissing > 1 ||
            fact.total !==
              fact.input + fact.output + fact.cacheRead + fact.cacheWrite
          )
            throw new Error("Invalid ledger counters");
          if (!integer(Number(seq)) || String(Number(seq)) !== seq)
            throw new Error("Invalid event identity");
          this._put(sid, Number(seq), {
            ...Object.fromEntries(
              [...FIELDS, "knownRequests", "usageMissing"].map((k) => [
                k,
                fact[k],
              ]),
            ),
            time: fact.time,
            kind: fact.kind,
            provider: fact.provider,
            model: fact.model,
          });
        }
      }
    }
  }
  _isCovered(sid, seq, fact) {
    if (!this.legacy || fact.kind !== "assistant") return false;
    if (Object.hasOwn(this.legacy.watermarks, sid))
      return seq <= this.legacy.watermarks[sid];
    // The v1 writer retained watermarks for every folded session. An absent
    // id was never counted, even when its timestamp precedes the last save.
    return false;
  }
  _put(sid, seq, fact) {
    if (typeof sid !== "string" || !sid)
      throw new Error("Invalid session identity");
    const date = dayKey(fact.time),
      key = `${fact.provider || "?"}::${fact.model}`;
    const target = this._isCovered(sid, seq, fact) ? this.covered : this.added;
    const next = sum(entry(target, date, key), fact);
    if (!target.has(date)) target.set(date, new Map());
    target.get(date).set(key, next);
    if (!this.facts.has(sid)) this.facts.set(sid, new Map());
    this.facts.get(sid).set(seq, fact);
    this.modelMeta.set(key, { key, name: fact.model, provider: fact.provider });
  }
  ingest(sid, event, route) {
    const fact = normalize(event, route);
    if (!fact) return false;
    const cutoff = Date.now() - WINDOW_DAYS * 86400000;
    if (fact.time < cutoff) return false;
    const old = this.facts.get(sid)?.get(event.seq);
    // Durable event identities are immutable. A missing-usage record may be
    // enriched if the same event is later read with authoritative accounting.
    if (old) {
      if (
        !(old.usageMissing === 1 && fact.usageMissing === 0) ||
        old.provider !== fact.provider ||
        old.model !== fact.model ||
        old.time !== fact.time
      )
        return false;
      const target = this._isCovered(sid, event.seq, old)
        ? this.covered
        : this.added;
      const date = dayKey(old.time),
        key = `${old.provider || "?"}::${old.model}`;
      target.get(date).set(key, sum(target.get(date).get(key), old, -1));
    }
    this._put(sid, event.seq, fact);
    return true;
  }
  ingestHistory(sid, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.events))
      throw new Error("Invalid session snapshot");
    const inherited = snapshot.inheritedEventCount ?? 0;
    if (!integer(inherited) || inherited > snapshot.events.length)
      throw new Error("Invalid inherited prefix");
    let route,
      changed = false;
    const events = snapshot.events.slice().sort((a, b) => a.seq - b.seq);
    const inheritedSeqs = new Set(
      snapshot.events.slice(0, inherited).map((e) => e.seq),
    );
    for (const event of events) {
      if (event.type === "request/header") route = event.data?.header?.config;
      if (!inheritedSeqs.has(event.seq))
        changed = this.ingest(sid, event, route) || changed;
    }
    const watermark = this.legacy?.watermarks[sid];
    if (
      watermark !== undefined &&
      !this.verifiedLegacy.has(sid) &&
      (watermark === -1 ||
        snapshot.events.some((event) => event.seq === watermark))
    ) {
      this.verifiedLegacy.add(sid);
      changed = true;
    }
    return changed;
  }
  days() {
    const dates = new Set([
      ...this.floor.keys(),
      ...this.covered.keys(),
      ...this.added.keys(),
    ]);
    const result = new Map();
    const legacyVerified =
      !this.legacy ||
      (Object.keys(this.legacy.watermarks).length > 0 &&
        Object.entries(this.legacy.watermarks).every(
          ([sid, seq]) => seq === -1 || this.verifiedLegacy.has(sid),
        ));
    const cutoff = Date.now() - WINDOW_DAYS * 86400000;
    for (const date of [...dates].sort()) {
      if (new Date(`${date}T23:59:59`).getTime() < cutoff) continue;
      const keys = new Set([
        ...(this.floor.get(date)?.keys() || []),
        ...(this.covered.get(date)?.keys() || []),
        ...(this.added.get(date)?.keys() || []),
      ]);
      const day = new Map();
      for (const key of keys) {
        const floor = this.floor.get(date)?.get(key) ?? zero();
        const covered = this.covered.get(date)?.get(key) ?? zero();
        const added = this.added.get(date)?.get(key) ?? zero();
        const baseline = floor.total > covered.total ? floor : covered;
        const rec = sum(
          {
            ...baseline,
            knownRequests: covered.knownRequests,
            usageMissing: covered.usageMissing,
          },
          added,
        );
        rec.requests =
          floor.total > covered.total ||
          (this.floor.get(date)?.has(key) && !legacyVerified)
            ? null
            : rec.knownRequests;
        day.set(key, rec);
      }
      if (day.size) result.set(date, day);
    }
    return result;
  }
  serialize(savedAt) {
    const days = Object.create(null),
      ledger = Object.create(null),
      meta = Object.create(null);
    for (const [date, day] of this.days()) days[date] = Object.fromEntries(day);
    const cutoff = Date.now() - WINDOW_DAYS * 86400000;
    for (const [sid, events] of this.facts) {
      const kept = [...events].filter(([, fact]) => fact.time >= cutoff);
      if (kept.length) ledger[sid] = Object.fromEntries(kept);
    }
    for (const [key, value] of this.modelMeta) meta[key] = value;
    // Preserve only the legacy days still inside the same retention window.
    const legacy = this.legacy
      ? {
          ...this.legacy,
          verifiedSessions: [...this.verifiedLegacy],
          days: Object.fromEntries(
            [...this.floor]
              .filter(([date]) => Object.hasOwn(days, date))
              .map(([date, day]) => [date, Object.fromEntries(day)]),
          ),
        }
      : null;
    return { version: 2, savedAt, legacy, ledger, modelMeta: meta, days };
  }
}
