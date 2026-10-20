# TokenGarden 采集与上传

服务端提供相互隔离的两个入口：`POST /api/upload/ccs` 和 `POST /api/upload/dsh`。每次上传是一个“渠道 × 设备 × 日期”的累计快照。服务端按客户端、模型逐条保留总 token 最高的记录；缺席模型不会被删除，两个渠道和不同设备最后相加。

## CC Switch（Claude Code / Codex 等）

需要 Node.js 22.13 或更新版本。默认以只读方式读取 `~/.cc-switch/cc-switch.db`，同时采集请求明细和归档日汇总，不修改数据库，不读取 provider 配置、密钥、对话或会话日志。只能上传 CC Switch 已经记录的用量；未进入 CC Switch 的本地会话不在此采集器的范围内。

先预览，不联网、不写同步状态：

```sh
node collector/ccs-upload.mjs --device macbook-pro --dry-run
```

首次配置时复制 `collector/.env.example` 为 `collector/.env.local`；已有 DSH 配置则直接补充 `CCS_UPLOAD_TOKEN`，不要覆盖原配置。填写站点地址、稳定的公开设备标识，以及与 Vercel 服务端一致的 CCS token。两个渠道可以共用配置文件和设备标识，使用各自独立的上传 token。

```sh
node --env-file=collector/.env.local collector/ccs-upload.mjs
```

持续同步，默认每 300 秒检查一次：

```sh
node --env-file=collector/.env.local collector/ccs-upload.mjs --watch
```

首次上传全部已有日期，之后跳过内容未变化的日期。状态默认保存在 `~/.cc-switch/token-garden-upload/state.json`，按站点与设备区分，与 DSH 状态独立。失败后可重试；服务端继续遵循各模型累计量只能提高的规则。版本取数据库与 WAL 文件的修改时间，内容指纹不会因为单纯归档明细而重复上传。

采集口径：

- 按客户端和完整模型名合并不同 provider 的用量。不会把同样计数的不同请求误当作重复请求删除。
- 按 CC Switch 的 `input_token_semantics`（旧格式、总输入、纯新增输入）逐条归一化，再求和；上传输入包含新增输入、缓存读取和缓存创建，缓存子集只计读取。对应规则见 [CC Switch SQL helpers](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/sql_helpers.rs)。
- 请求次数是明细记录数加归档的 `request_count`，包含失败记录。沿用 CC Switch 的统计记录口径，不保证等于所有上游 HTTP 尝试次数。归档与明细在同一只读事务内相加，参照 [CC Switch usage stats](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/usage_stats.rs)。
- 明细按运行采集器的本地日历天归组，归档保留原日期。与站点北京时间对齐时，应在 Asia/Shanghai 时区运行；历史归档无法重新按时区拆分。

`--db` 或 `CCS_DB_FILE` 可指定数据库；`--state` 可指定同步状态文件；`--interval` 设置 watch 间隔（最小 60 秒）。数据库正在使用 WAL 时也可以读取，无需关闭 CC Switch。

## DSH

支持原版 `@duke-dsh-plugins/dsh-token-stats@1.7.3` 的 version 1 文件，以及仓库内重写版 `2.0.0-local.1` 的 version 2 文件。直接读取 `$DSH_HOME/data/dsh-token-stats/stats.json`，默认 `DSH_HOME=~/.dsh`，不修改插件或统计文件，不读取会话日志、provider 凭据或套餐余额。

转换口径：

- 输入 = `input + cacheRead + cacheWrite`。
- 输出 = `output`；`reasoning` 不额外相加，与原插件 total 保持一致。
- 缓存输入子集 = `cacheRead`；保留 `provider::model` 完整模型键。
- 客户端 = `DSH`；version 1 未记录请求次数，上传 `requests: null`；version 2 上传已恢复的日志调用次数，历史覆盖不足时仍上传 null。次数包含已落盘失败尝试和辅助调用，不等同全部 HTTP 请求。
- 日期沿用原插件的本地日历日期。需要与站点北京时间严格对齐时，应让 DSH 在 Asia/Shanghai 时区统计；已汇总的历史数据无法重新按时区拆分。

先查看本地待同步日期和 token 总量，不联网、不写同步状态：

```sh
node collector/dsh-upload.mjs --device macbook-pro --dry-run
```

首次配置时复制 `collector/.env.example` 为 `collector/.env.local`；已有 CCS 配置则补充 `DSH_UPLOAD_TOKEN`。填写已部署的站点地址、稳定的公开设备标识、服务端相同的 DSH_UPLOAD_TOKEN。两个渠道使用相同 device 时会合并为同一设备；设备标识不要随昵称变化，也不要让不同设备共用一个标识。

```sh
node --env-file=collector/.env.local collector/dsh-upload.mjs
```

持续同步（默认每 300 秒检查一次）：

```sh
node --env-file=collector/.env.local collector/dsh-upload.mjs --watch
```

首次同步现存的全部历史日期；之后通过每日内容指纹跳过未变化的日期。状态默认保存在 `$DSH_HOME/data/token-garden-upload/state.json`，按站点地址与设备分别保存。失败日期不记为成功，下次重试；已成功的日期不重复发送。未提高任何模型总量的请求只缓存该次版本，文件产生新版本后会重新尝试。插件清理掉的历史日期、模型或空 rows 均不会从服务器删除已有记录。

上传版本使用统计文件的 `savedAt`。服务端记录见过的最大版本，但版本不会阻止更高累计量入库；同版本或旧版本中更高的模型总量也能合并。不要在两台机器间共用设备标识或拷贝旧统计文件覆盖新统计。上传只允许 HTTPS，localhost 调试可使用 HTTP；不会携带 token 跟随重定向。

`--stats`、`--state` 可指定文件位置，`--interval` 可设置 watch 间隔（最小 60 秒）。配置完成前只有 dry-run，不会上传真实数据。

## 上传协议

CCS 使用独立的 `CCS_UPLOAD_TOKEN`；它与 DSH token 不通用。下面的累计快照格式适用于两个渠道。

```json
{
  "device": "macbook-pro",
  "date": "2026-10-19",
  "revision": 1,
  "rows": [
    {
      "client": "Codex",
      "model": "gpt-5.4",
      "input": 10000,
      "output": 2000,
      "cached": 3000,
      "requests": 5
    }
  ]
}
```

请求头：`Authorization: Bearer <对应渠道的 token>`、`Content-Type: application/json`。最多 500 个 client/model 组合，正文最多 256 KiB。每次发送当日累计量，不发送增量；缺席模型保留原记录，不修改另一渠道、设备或日期。同一快照内 client/model 不可重复。

`revision` 是正安全整数，采集端应持久化并递增，重试保留原版本；它只用于跟踪上传进度，不作为高累计量的阻拦条件。响应 `applied: true`、`reason: merged` 表示至少新增或提高了一条记录；`applied: false`、`reason: not_higher` 表示没有记录需要提高。`rows: []` 是空操作。

比较键为 `(date, source, device, client, model)`，比较值为 `input + output`。新总量严格更高时整条替换输入、输出、缓存和请求次数；总量更低时保留原记录。输入、输出和缓存均完全相同时，可把请求次数从 null 补齐，或用更高的请求次数更新；不会降低已知请求次数。其他相同总量的上传保留原记录，不对每个字段分别取最大，避免拼出虚假的总量。例如旧记录输入/输出为 100/100，新记录为 200/50，结果是 250，不能拼成 200/100 的 300。此规则不支持自动调低历史误报，纠错需人工核对数据库。

token 与数据库连接串只保存在本地配置和服务端环境变量中。

## 重写版 DSH 插件

源码在 `plugins/dsh-token-stats/`，安装与验证见该目录 README。插件保留套餐余额功能，并将统计存储迁移到 version 2。重启 DSH 后自动备份 version 1 文件并回填；统计文件损坏时保留原件并显示错误，不能通过清空文件冒充迁移成功。缺少 usage 的调用仅计入次数，不估算 token，详细口径及不可恢复的标题用量见插件说明。

部署这次更新时，在 Neon 再执行最新 `db/schema.sql`，使相同 token 下的请求次数回填可以入库。然后部署新版站点，使用新版采集器上传。
