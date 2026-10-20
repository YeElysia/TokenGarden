/** @param {(text:string,values:any[])=>Promise<any[]>} execute
 * @param {any} snapshot */
export async function saveSnapshot(execute, snapshot) {
  const rows = await execute(
    "select replace_usage_snapshot($1::text,$2::text,$3::date,$4::bigint,$5::jsonb) as applied",
    [
      snapshot.source,
      snapshot.device,
      snapshot.date,
      snapshot.revision,
      JSON.stringify(snapshot.rows),
    ],
  );
  return rows[0].applied;
}
/** @param {(text:string,values:any[])=>Promise<any[]>} execute */
export async function readUsage(execute) {
  const rows = await execute(
    "select date::text,source,device,client,model,input_tokens as input,output_tokens as output,cached_input_tokens as cached,request_count as requests from usage_daily order by date,source,device,client,model",
    [],
  );
  return rows.map((row) => ({
    date: row.date,
    source: row.source,
    device: row.device,
    client: row.client,
    model: row.model,
    input: Number(row.input),
    output: Number(row.output),
    cached: Number(row.cached),
    requests: row.requests === null ? null : Number(row.requests),
  }));
}
