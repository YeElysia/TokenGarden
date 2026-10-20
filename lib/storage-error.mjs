// Only stable error codes and authored explanations may leave the storage boundary.
// Never expose driver messages, detail, SQL, parameters, URLs or stack traces.
const descriptions = {
  42883:
    "上传数据库函数不存在或签名不匹配，请在应用连接的数据库执行最新版 db/schema.sql",
  "42P01": "上传数据表不存在，请核对数据库并执行最新版 db/schema.sql",
  42703: "数据库缺少所需字段，请执行最新版 db/schema.sql",
  42501: "上传数据库账户缺少表写入或函数执行权限",
  "28P01": "数据库密码验证失败，请检查服务端数据库连接配置",
  28000: "数据库账户验证失败，请检查服务端数据库连接配置",
  23502: "数据库拒绝空字段，请核对迁移和历史请求次数的可空设置",
  23503: "数据库外键约束未满足，请检查数据库结构",
  23505: "数据库出现唯一键冲突，请核对主键及上传函数版本",
  23514: "上传数据不符合数据库检查约束，请核对迁移和统计口径",
  "22P02": "数据库参数格式不正确，请核对上传函数签名及部署版本",
  22003: "统计数值超出数据库字段范围，请核对字段类型",
  53300: "数据库连接数已满，请稍后重试",
  "57P01": "数据库正在关闭或重启，请稍后重试",
  57014: "数据库查询被取消或超时，请稍后重试",
  40001: "数据库事务发生并发冲突，请重试相同快照",
  "40P01": "数据库事务发生死锁，请重试相同快照",
  CONNECT_TIMEOUT: "连接数据库超时，请检查连接地址及数据库可用性",
  CONNECTION_CLOSED: "数据库连接已关闭，请稍后重试",
  CONNECTION_ENDED: "数据库连接已结束，请稍后重试",
  ECONNREFUSED: "数据库连接被拒绝，请检查连接地址及数据库可用性",
  ECONNRESET: "数据库连接被重置，请稍后重试",
  ENOTFOUND: "无法解析数据库域名，请检查数据库连接地址",
  EAI_AGAIN: "数据库域名解析暂时失败，请稍后重试",
  ETIMEDOUT: "数据库网络连接超时，请稍后重试",
  CERT_HAS_EXPIRED: "数据库 TLS 证书已过期，请检查连接配置",
  DEPTH_ZERO_SELF_SIGNED_CERT: "数据库 TLS 证书验证失败，请检查连接配置",
  SELF_SIGNED_CERT_IN_CHAIN: "数据库 TLS 证书链验证失败，请检查连接配置",
  UNDEFINED_VALUE: "服务端向数据库传入了未定义参数，请核对部署版本",
  TYPE_ERROR: "服务端发生类型错误，请核对部署版本并查看追踪日志",
  UNKNOWN: "存储操作失败，请使用追踪 ID 核对服务端日志",
};
export function storageDiagnostic(error) {
  const raw = error?.code ?? error?.cause?.code;
  const code =
    typeof raw === "string" &&
    (/^[0-9A-Z]{5}$/.test(raw) || Object.hasOwn(descriptions, raw))
      ? raw
      : error instanceof TypeError
        ? "TYPE_ERROR"
        : "UNKNOWN";
  return {
    code,
    message: Object.hasOwn(descriptions, code)
      ? descriptions[code]
      : code.startsWith("08")
        ? "数据库连接异常，请检查连接配置及数据库可用性"
        : "数据库执行失败，请使用错误码和追踪 ID 核对服务端日志",
  };
}

const publicErrors = new Set([
  "该上传渠道尚未配置",
  "上传凭据无效",
  "上传数据库尚未配置",
  "上传渠道不存在",
  "上传暂时失败，请使用相同版本重试",
]);
export function uploadFailureDetails(body) {
  const parts = [];
  if (publicErrors.has(body?.error)) parts.push(body.error);
  if (typeof body?.diagnostic?.code === "string") {
    const diagnostic = storageDiagnostic({ code: body.diagnostic.code });
    parts.push(`${diagnostic.code}：${diagnostic.message}`);
  }
  if (
    typeof body?.requestId === "string" &&
    /^[0-9a-f-]{36}$/i.test(body.requestId)
  )
    parts.push(`追踪 ID：${body.requestId}`);
  return parts.length ? "；" + parts.join("；") : "";
}
