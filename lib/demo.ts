export type UsageRow = {
  date: string;
  source: "ccs" | "dsh";
  device: string;
  client: string;
  model: string;
  input: number;
  output: number;
  cached: number;
  requests: number | null;
};
export function demoRows(): UsageRow[] {
  let seed = 137;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const year = Number(today.slice(0, 4));
  const rows: UsageRow[] = [];
  for (
    let d = new Date(`${year}-01-01T00:00:00Z`);
    d.toISOString().slice(0, 10) <= today;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const date = d.toISOString().slice(0, 10);
    if (random() < 0.19) continue;
    for (const [device, client, model] of [
      ["MacBook Pro", "Codex", "gpt-5.4"],
      ["工作站", "Claude Code", "claude-sonnet-4.6"],
      ["MacBook Pro", "OpenCode", "deepseek-chat"],
    ]) {
      if (random() < 0.32) continue;
      const input = Math.round(random() ** 2 * 2400000);
      rows.push({
        date,
        source: client === "OpenCode" ? "dsh" : "ccs",
        device,
        client,
        model,
        input,
        output: Math.round(input * (0.04 + random() * 0.12)),
        cached: Math.round(input * random() * 0.85),
        requests: Math.ceil(random() * 65),
      });
    }
  }
  return rows;
}
