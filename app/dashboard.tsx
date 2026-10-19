"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { summarize, dayKey } from "../lib/stats.mjs";
import { getTimeTheme } from "../lib/theme.mjs";
import type { UsageRow } from "../lib/demo";
import { Icon, type IconName } from "./dashboard-icons";

const compact = (n: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const full = (n: number) => Intl.NumberFormat("zh-CN").format(n);
const dateString = (d: Date) => d.toISOString().slice(0, 10);
const EMPTY_ROWS: UsageRow[] = [];

type Payload = { mode: string; rows: UsageRow[]; updatedAt: string | null };
type Daily = { total: number; input: number; output: number; requests: number };

function SectionHeading({
  number,
  title,
  caption,
  id,
}: {
  number: string;
  title: string;
  caption: string;
  id?: string;
}) {
  return (
    <div className="section-heading">
      <span className="section-marker" aria-hidden="true">
        <span>{number}</span>
        <Icon name="arrow" />
      </span>
      <div>
        <span className="section-caption">{caption}</span>
        <h2 id={id}>{title}</h2>
      </div>
    </div>
  );
}

export default function Dashboard() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function syncTheme() {
      clearTimeout(timer);
      document.documentElement.dataset.theme = getTimeTheme();
      // Recheck on the next minute, including while this page stays open.
      timer = setTimeout(syncTheme, 60000 - (Date.now() % 60000) + 30);
    }
    syncTheme();
    window.addEventListener("focus", syncTheme);
    document.addEventListener("visibilitychange", syncTheme);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", syncTheme);
      document.removeEventListener("visibilitychange", syncTheme);
    };
  }, []);

  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [year, setYear] = useState(Number(dayKey(new Date()).slice(0, 4)));
  const [device, setDevice] = useState("");
  const [client, setClient] = useState("");
  const [model, setModel] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [previewDate, setPreviewDate] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    fetch("/api/stats", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw Error("统计服务暂时无法连接。");
        return r.json();
      })
      .then((d: Payload) => setData(d))
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError("统计服务暂时无法连接。");
      });
    return () => controller.abort();
  }, [retry]);

  const rows = data?.rows ?? EMPTY_ROWS;
  const today = dayKey(new Date());
  const currentYear = Number(today.slice(0, 4));
  const summary = useMemo(
    () => summarize(rows, { year, device, client, model }),
    [rows, year, device, client, model],
  );
  const days = summary.days as Record<string, Daily>;
  const current = days[today]?.total ?? 0;
  const monthly = Object.entries(days)
    .filter(([date]) => date.startsWith(today.slice(0, 7)))
    .reduce((sum, [, value]) => sum + value.total, 0);
  const activeDays = Object.values(days).filter((day) => day.total > 0).length;
  const reportedDays = Object.keys(days).length;
  const cells = useMemo(() => {
    const first = new Date(String(year) + "-01-01T00:00:00Z");
    const offset = (first.getUTCDay() + 6) % 7;
    first.setUTCDate(first.getUTCDate() - offset);
    const last = new Date(String(year) + "-12-31T00:00:00Z");
    const count =
      Math.ceil(((last.getTime() - first.getTime()) / 86400000 + 1) / 7) * 7;
    return Array.from({ length: count }, (_, i) => {
      const date = new Date(first);
      date.setUTCDate(date.getUTCDate() + i);
      return dateString(date);
    });
  }, [year]);

  const peakDay = Math.max(0, ...Object.values(days).map((day) => day.total));
  const maximum = Math.max(1, peakDay);
  const level = (value: number) =>
    !value ? 0 : Math.min(4, Math.max(1, Math.ceil((value / maximum) * 4)));
  const modelList = Object.entries(
    summary.models as Record<string, number>,
  ).sort((a, b) => b[1] - a[1]);
  const options = (key: "device" | "client" | "model") =>
    Array.from(new Set(rows.map((row) => row[key]))).sort();
  const monthValues = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    total: Object.entries(days)
      .filter(([date]) => Number(date.slice(5, 7)) === i + 1)
      .reduce((sum, [, value]) => sum + value.total, 0),
  }));
  const peakMonth = Math.max(0, ...monthValues.map((month) => month.total));
  const monthMax = Math.max(1, peakMonth);
  const years = Array.from(
    new Set([currentYear, ...rows.map((row) => Number(row.date.slice(0, 4)))]),
  ).sort((a, b) => b - a);
  const filters = Boolean(device || client || model);
  const filterKey = [year, device, client, model].join("|");
  const defaultDate =
    year === currentYear
      ? today
      : Object.keys(days).sort().at(-1) || String(year) + "-01-01";
  const readingDate = previewDate || selectedDate || defaultDate;
  const reading = days[readingDate];

  function clearSelection() {
    setSelectedDate("");
    setPreviewDate("");
  }

  const metrics: {
    title: string;
    value: number;
    note: string;
    icon: IconName;
    unit: string;
  }[] = [
    {
      title: "今日用量",
      value: year === currentYear ? current : 0,
      note: year === currentYear ? today : "当前筛选年份不含今日",
      icon: "tokens",
      unit: "tokens",
    },
    {
      title: "本月用量",
      value: year === currentYear ? monthly : 0,
      note: year === currentYear ? today.slice(0, 7) : "当前筛选年份不含本月",
      icon: "calendar",
      unit: "tokens",
    },
    {
      title: "年度用量",
      value: summary.total,
      note: full(summary.requests) + " 次模型请求",
      icon: "model",
      unit: "tokens",
    },
    {
      title: "活跃天数",
      value: activeDays,
      note: reportedDays + " 天有上报记录",
      icon: "activity",
      unit: "days",
    },
  ];

  return (
    <div className="shell">
      <main>
        <h1 className="sr-only">TokenGarden · 跨设备用量统计</h1>
        <section
          className="panel activity-panel entrance"
          aria-labelledby="activity-title"
        >
          <div className="panel-head activity-head">
            <SectionHeading
              number="01"
              title="年度活动"
              caption="TOKEN ACTIVITY"
              id="activity-title"
            />
            <label className="year-picker">
              <span className="sr-only">统计年份</span>
              <select
                aria-label="统计年份"
                value={year}
                onChange={(event) => {
                  setYear(Number(event.target.value));
                  clearSelection();
                }}
              >
                {years.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>

          {data?.mode === "demo" && (
            <div className="data-status">
              <span className="status-mark" aria-hidden="true" />
              <strong>演示数据</strong>
              <span>尚未接入真实用量</span>
            </div>
          )}

          {error ? (
            <div className="state-message error-message" role="alert">
              <span className="state-code">连接失败</span>
              <p>{error}</p>
              <button
                className="action-button"
                onClick={() => setRetry((value) => value + 1)}
              >
                <Icon name="refresh" />
                重新连接
              </button>
            </div>
          ) : !data ? (
            <div className="state-message loading-message" role="status">
              <div className="loading-track" aria-hidden="true">
                <i />
              </div>
              正在读取用量记录
            </div>
          ) : (
            <>
              <div className="activity-body">
                <div className="calendar-stage">
                  <div className="activity-meta">
                    <span>
                      <b>{year}</b> / 01.01 — 12.31
                    </span>
                    <span>{full(summary.requests)} 次请求</span>
                  </div>
                  <div
                    className="heat-scroll"
                    tabIndex={0}
                    aria-label="年度热力图，可横向滚动"
                  >
                    <div className="heat-wrap">
                      <div className="month-labels" aria-hidden="true">
                        {Array.from({ length: 12 }, (_, index) => {
                          const date =
                            String(year) +
                            "-" +
                            String(index + 1).padStart(2, "0") +
                            "-01";
                          const column = Math.floor(cells.indexOf(date) / 7);
                          return (
                            <span
                              key={index}
                              style={{
                                left: (column / (cells.length / 7)) * 100 + "%",
                              }}
                            >
                              {String(index + 1).padStart(2, "0")}
                              <small>月</small>
                            </span>
                          );
                        })}
                      </div>
                      <div className="heat-body">
                        <div className="weekdays" aria-hidden="true">
                          {["一", "", "三", "", "五", "", "日"].map(
                            (day, i) => (
                              <span key={i}>{day}</span>
                            ),
                          )}
                        </div>
                        <div className="chart-reveal" key={filterKey}>
                          <div
                            className="heat-grid chart-content"
                            onMouseLeave={() => setPreviewDate("")}
                            style={{
                              gridTemplateColumns:
                                "repeat(" +
                                cells.length / 7 +
                                ", minmax(0, 1fr))",
                            }}
                          >
                            {cells.map((date) => {
                              const outside = !date.startsWith(String(year));
                              const future = date > today;
                              const record = days[date];
                              const value = record?.total ?? 0;
                              const missing = !record && !future && !outside;
                              const label = future
                                ? "未来日期"
                                : missing
                                  ? "暂无上报记录"
                                  : full(value) + " tokens";
                              return (
                                <button
                                  key={date}
                                  className={[
                                    "cell",
                                    "level-" + level(value),
                                    outside ? "outside" : "",
                                    future ? "future" : "",
                                    missing ? "missing" : "",
                                    date === readingDate ? "selected" : "",
                                  ].join(" ")}
                                  disabled={outside || future}
                                  aria-label={date + "，" + label}
                                  aria-pressed={date === selectedDate}
                                  onMouseEnter={() => setPreviewDate(date)}
                                  onFocus={() => setPreviewDate(date)}
                                  onBlur={() => setPreviewDate("")}
                                  onClick={() => setSelectedDate(date)}
                                />
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="heat-footer">
                    <span>
                      活跃 <strong>{activeDays}</strong> 天
                    </span>
                    <div
                      className="legend"
                      aria-label="色阶由零用量到最大用量，斜线表示未上报"
                    >
                      <span>0</span>
                      {[0, 1, 2, 3, 4].map((value) => (
                        <i key={value} className={"level-" + value} />
                      ))}
                      <span>{compact(peakDay)}</span>
                      <i className="missing" />
                      <span>未上报</span>
                    </div>
                  </div>
                </div>

                <aside className="day-reading" aria-label="当日用量明细">
                  <div className="reading-head">
                    <span>当日读数</span>
                    <Icon name="activity" />
                  </div>
                  <time dateTime={readingDate}>
                    {readingDate.replaceAll("-", " / ")}
                  </time>
                  <div
                    className="reading-total"
                    title={reading ? full(reading.total) : "暂无上报记录"}
                  >
                    {reading ? compact(reading.total) : "—"}
                  </div>
                  <span className="reading-unit">
                    {reading ? "TOKENS" : "暂无上报记录"}
                  </span>
                  <dl className="reading-details">
                    <div>
                      <dt>
                        <Icon name="input" />
                        输入
                      </dt>
                      <dd>{reading ? compact(reading.input) : "—"}</dd>
                    </div>
                    <div>
                      <dt>
                        <Icon name="output" />
                        输出
                      </dt>
                      <dd>{reading ? compact(reading.output) : "—"}</dd>
                    </div>
                    <div>
                      <dt>请求</dt>
                      <dd>
                        {reading ? full(reading.requests) : "—"}
                        <span> 次</span>
                      </dd>
                    </div>
                  </dl>
                </aside>
              </div>

              <div className="filter-strip">
                <div className="filter-fields">
                  <label
                    className={
                      device ? "filter-field is-filtered" : "filter-field"
                    }
                  >
                    <Icon name="device" />
                    <select
                      aria-label="设备"
                      value={device}
                      onChange={(event) => {
                        setDevice(event.target.value);
                        clearSelection();
                      }}
                    >
                      <option value="">所有设备</option>
                      {options("device").map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label
                    className={
                      client ? "filter-field is-filtered" : "filter-field"
                    }
                  >
                    <Icon name="tokens" />
                    <select
                      aria-label="客户端"
                      value={client}
                      onChange={(event) => {
                        setClient(event.target.value);
                        clearSelection();
                      }}
                    >
                      <option value="">所有客户端</option>
                      {options("client").map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label
                    className={
                      model ? "filter-field is-filtered" : "filter-field"
                    }
                  >
                    <Icon name="model" />
                    <select
                      aria-label="模型"
                      value={model}
                      onChange={(event) => {
                        setModel(event.target.value);
                        clearSelection();
                      }}
                    >
                      <option value="">所有模型</option>
                      {options("model").map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  {filters && (
                    <button
                      className="reset-button"
                      onClick={() => {
                        setDevice("");
                        setClient("");
                        setModel("");
                        clearSelection();
                      }}
                    >
                      <Icon name="reset" />
                      重置
                    </button>
                  )}
                </div>
                <span className="filter-timezone">UTC+08:00</span>
              </div>
            </>
          )}
        </section>

        {data && !error && (
          <>
            <section className="metrics-grid" aria-label="用量摘要">
              {metrics.map((metric, index) => (
                <article
                  className="metric-card entrance"
                  key={metric.title}
                  style={
                    { "--enter-delay": 90 + index * 60 + "ms" } as CSSProperties
                  }
                >
                  <div className="metric-head">
                    <span>{metric.title}</span>
                    <Icon name={metric.icon} />
                  </div>
                  <div className="metric-number" title={full(metric.value)}>
                    {index === 3 ? metric.value : compact(metric.value)}
                    <span>{metric.unit}</span>
                  </div>
                  <div className="metric-note">{metric.note}</div>
                </article>
              ))}
            </section>

            <div className="detail-grid">
              <section
                className="panel model-panel entrance"
                style={{ "--enter-delay": "220ms" } as CSSProperties}
                aria-labelledby="models-title"
              >
                <div className="panel-head">
                  <SectionHeading
                    number="02"
                    title="模型分布"
                    caption="MODEL DISTRIBUTION"
                    id="models-title"
                  />
                  <span className="section-count">
                    {String(modelList.length).padStart(2, "0")}
                    <small>模型</small>
                  </span>
                </div>
                <div className="model-list" key={filterKey}>
                  {modelList.length ? (
                    modelList.map(([name, value], index) => (
                      <div className="model-row" key={name}>
                        <span className="model-rank">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <div className="model-detail">
                          <div className="model-label">
                            <strong>{name}</strong>
                            <span>
                              {compact(value)}
                              <small>
                                {Math.round(
                                  (value / Math.max(1, summary.total)) * 100,
                                )}
                                %
                              </small>
                            </span>
                          </div>
                          <div className="model-track">
                            <i
                              style={
                                {
                                  width:
                                    (value / Math.max(1, summary.total)) * 100 +
                                    "%",
                                  "--bar-delay": index * 70 + "ms",
                                } as CSSProperties
                              }
                            />
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="empty-state">当前条件下没有用量记录。</p>
                  )}
                </div>
                <dl className="token-breakdown">
                  <div>
                    <dt>输入</dt>
                    <dd>{compact(summary.input)}</dd>
                  </div>
                  <div>
                    <dt>输出</dt>
                    <dd>{compact(summary.output)}</dd>
                  </div>
                  <div>
                    <dt>
                      缓存输入<span>已计入输入</span>
                    </dt>
                    <dd>{compact(summary.cached)}</dd>
                  </div>
                </dl>
              </section>

              <section
                className="panel trend-panel entrance"
                style={{ "--enter-delay": "280ms" } as CSSProperties}
                aria-labelledby="trend-title"
              >
                <div className="panel-head">
                  <SectionHeading
                    number="03"
                    title="月度趋势"
                    caption="MONTHLY VOLUME"
                    id="trend-title"
                  />
                  <span className="chart-unit">TOKENS</span>
                </div>
                <div className="monthly-plot" key={filterKey}>
                  <div className="plot-scale" aria-hidden="true">
                    <span>{compact(peakMonth)}</span>
                    <span>0</span>
                  </div>
                  <div className="bars">
                    {monthValues.map((month) => {
                      const future =
                        year === currentYear &&
                        month.month > Number(today.slice(5, 7));
                      return (
                        <div
                          className={
                            "bar-column" + (future ? " future-month" : "")
                          }
                          key={month.month}
                        >
                          <div className="bar-space">
                            <div
                              className={
                                "bar" +
                                (year === currentYear &&
                                month.month === Number(today.slice(5, 7))
                                  ? " current"
                                  : "")
                              }
                              style={
                                {
                                  height: month.total
                                    ? Math.max(
                                        2,
                                        (month.total / monthMax) * 100,
                                      ) + "%"
                                    : "0%",
                                  "--bar-delay": month.month * 25 + "ms",
                                } as CSSProperties
                              }
                              tabIndex={0}
                              aria-label={
                                month.month +
                                "月，" +
                                (future
                                  ? "未来月份"
                                  : full(month.total) + " tokens")
                              }
                            >
                              <span className="bar-tooltip">
                                {compact(month.total)}
                              </span>
                            </div>
                          </div>
                          <span className="month-tick">
                            {String(month.month).padStart(2, "0")}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="trend-footer">
                  <span>{year} 年累计</span>
                  <strong>
                    {compact(summary.total)}
                    <small> tokens</small>
                  </strong>
                </div>
              </section>
            </div>

            <p className="methodology">
              总量 = 输入 + 输出，缓存输入已包含在输入中。按北京时间归日。
            </p>
          </>
        )}
      </main>
      <footer>
        <span className="footer-brand">
          TokenGarden<span> / 用量统计</span>
        </span>
        <span>
          {data?.mode === "live" ? "公开只读" : "演示预览"}
          <i />
          UTC+8
        </span>
      </footer>
    </div>
  );
}
