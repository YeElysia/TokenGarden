# TokenGarden 采集与上传

服务端提供相互隔离的两个入口：`POST /api/upload/ccs` 和 `POST /api/upload/dsh`。每次上传是一个“渠道 × 设备 × 日期”的累计快照。服务端按客户端、模型逐条保留总 token 最高的记录；缺席模型不会被删除，两个渠道和不同设备最后相加。

## DSH

已适配本机 `@duke-dsh-plugins/dsh-token-stats@1.7.3` 的 version 1 统计文件。直接读取 `$DSH_HOME/data/dsh-token-stats/stats.json`，默认 `DSH_HOME=~/.dsh`，不修改插件或统计文件，不读取会话日志、provider 凭据或套餐余额。

转换口径：

- 输入 = `input + cacheRead + cacheWrite`。
- 输出 = `output`；`reasoning` 不额外相加，与原插件 total 保持一致。
- 缓存输入子集 = `cacheRead`；保留 `provider::model` 完整模型键。
- 客户端 = `DSH`；原文件未记录请求次数，因此上传 `requests: null`，页面显示请求数未完整统计。
- 日期沿用原插件的本地日历日期。需要与站点北京时间严格对齐时，应让 DSH 在 Asia/Shanghai 时区统计；已汇总的历史数据无法重新按时区拆分。

先查看本地待同步日期和 token 总量，不联网、不写同步状态：

```sh
node collector/dsh-upload.mjs --device macbook-pro --dry-run
```

复制 `collector/.env.example` 为 `collector/.env.local`，填写已部署的站点地址、稳定的公开设备标识、服务端相同的 DSH_UPLOAD_TOKEN。两个渠道使用相同 device 时会合并为同一设备；设备标识不要随昵称变化，也不要让不同设备共用一个标识。

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

## CCS 协议

CCS 的服务端通道已实现，本地 CC Switch 读取适配器仍待实现。CCS 使用独立的 `CCS_UPLOAD_TOKEN`；它与 DSH token 不通用。

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

比较键为 `(date, source, device, client, model)`，比较值为 `input + output`。只有新总量严格更高时才整条替换输入、输出、缓存和请求次数；相同或更低总量保留原记录，不对每个字段分别取最大，避免拼出虚假的总量。例如旧记录输入/输出为 100/100，新记录为 200/50，结果是 250，不能拼成 200/100 的 300。此规则不支持自动调低历史误报，纠错需人工核对数据库。

token 与数据库连接串只保存在本地配置和服务端环境变量中。
