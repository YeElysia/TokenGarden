export function dayKey(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
/** @param {Array<{date:string,source?:string,device:string,client:string,model:string,input:number,output:number,cached:number,requests:number|null}>} rows
 * @param {{year?:number,device?:string,client?:string,model?:string,source?:string}} options */
export function summarize(
  rows,
  { year, device = "", client = "", model = "", source = "" } = {},
) {
  const selected = rows.filter(
    (r) =>
      (!year || r.date.startsWith(String(year) + "-")) &&
      (!device || r.device === device) &&
      (!source || r.source === source) &&
      (!client || r.client === client) &&
      (!model || r.model === model),
  );
  const result = {
    total: 0,
    input: 0,
    output: 0,
    cached: 0,
    requests: /** @type {number|null} */ (0),
    days: Object.create(null),
    models: Object.create(null),
  };
  for (const r of selected) {
    const total = r.input + r.output;
    result.total += total;
    result.input += r.input;
    result.output += r.output;
    result.cached += r.cached;
    result.requests =
      result.requests === null || r.requests === null
        ? null
        : result.requests + r.requests;
    const day = (result.days[r.date] ??= {
      total: 0,
      input: 0,
      output: 0,
      requests: 0,
    });
    day.total += total;
    day.input += r.input;
    day.output += r.output;
    day.requests =
      day.requests === null || r.requests === null
        ? null
        : day.requests + r.requests;
    result.models[r.model] = (result.models[r.model] || 0) + total;
  }
  return result;
}
