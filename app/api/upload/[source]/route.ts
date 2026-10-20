import postgres from "postgres";
import { handleUpload } from "../../../../lib/upload.mjs";
import { saveSnapshot } from "../../../../lib/usage-store.mjs";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ source: string }> },
) {
  const { source } = await params;
  const token =
    source === "ccs"
      ? process.env.CCS_UPLOAD_TOKEN
      : source === "dsh"
        ? process.env.DSH_UPLOAD_TOKEN
        : undefined;
  const url = process.env.UPLOAD_DATABASE_URL || process.env.DATABASE_URL;
  return handleUpload(request, source, {
    token,
    save: url
      ? async (snapshot) => {
          const sql = postgres(url, {
            max: 1,
            prepare: false,
            connect_timeout: 10,
          });
          try {
            return await saveSnapshot(
              (text, values) => sql.unsafe(text, values),
              snapshot,
            );
          } finally {
            await sql.end();
          }
        }
      : null,
  });
}
