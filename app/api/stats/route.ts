import postgres from "postgres";
import { demoRows } from "../../../lib/demo";
export const dynamic = "force-dynamic";
export async function GET() {
  if (!process.env.DATABASE_URL)
    return Response.json({ mode: "demo", rows: demoRows(), updatedAt: null });
  try {
    const sql = postgres(process.env.DATABASE_URL, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
    });
    try {
      // Only explicitly public device labels belong in this table. No credentials or conversation data.
      const rows =
        await sql`select date::text, device, client, model, input_tokens as input, output_tokens as output, cached_input_tokens as cached, request_count as requests from usage_daily order by date`;
      return Response.json(
        {
          mode: "live",
          rows: rows.map((r) => ({
            ...r,
            input: Number(r.input),
            output: Number(r.output),
            cached: Number(r.cached),
            requests: Number(r.requests),
          })),
          updatedAt: new Date().toISOString(),
        },
        {
          headers: {
            "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
          },
        },
      );
    } finally {
      await sql.end();
    }
  } catch {
    return Response.json(
      { error: "暂时无法读取统计数据，请稍后重试。" },
      { status: 503 },
    );
  }
}
