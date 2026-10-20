# DSH Token Stats（个人重写版）

基于 MIT 授权的 [MoonlitDropOfBlood/dsh-token-stats](https://github.com/MoonlitDropOfBlood/dsh-token-stats) 1.7.3，重写统计内核为独立事件账本。版本 `2.0.0-local.1`，保留原包名、TokenStatsService、设置页、Typert 接口与套餐余额功能。已针对本机 DSH `0.2.1-rc.2` 验证，不发布到 npm。

## 统计口径

- `assistant/message`：带模型来源的响应，每条计 1 次，即使 usage 为零或未返回。
- `assistant/attempt`：已落盘的失败、重试或中断尝试，从前面的 `request/header` 获取路由；从 stream 取最后一份 usage，不累加多份 usage 快照。
- `compaction/summary`：仅 `llmStreamCall: true` 的真实模型总结计数，排除合成总结。
- `session/title-llm-request`：已记录的标题调用尝试计 1 次；当前 SDK 没有把标题响应 usage 落盘，因此该路径的 token 标为缺失，不估算。
- 次数是**日志记录的模型调用尝试**，不是实际 HTTP 请求账单；适配器内部重试、落盘前失败等不保证包含。标题调用在调用前记录，因而可能包含随后取消的尝试。
- input 是非缓存输入；total = input + output + cacheRead + cacheWrite。reasoning 是输出子集，不再次相加。无 usage 时仅统计调用数，`usageMissing` 增长，token 不推算。
- 按本地日历日、provider::model 汇总。日期口径需要与北京时间一致时，应在 Asia/Shanghai 时区运行 DSH。

## 架构与存储

- `stats-core.mjs`：不依赖 DSH 的纯统计账本。按会话/seq 去重，实时和历史使用同一入口，处理乱序；只保存时间、来源、分类、计数，不保存正文、提示词、工具参数或凭据。
- `store.mjs`：原子落盘、合并写入队列、唯一临时文件、退出刷新与旧任务隔离。
- `index.js`：Host SDK 生命周期、实时监听、4 路历史读取、失败重试；不读取原始会话文件，使用 SDK sessionQuery 的验证后快照。
- `quota.js`：保留上游的余额/套餐查询，独立于统计与上传。
- `client.js` / `typert.host.js`：设置页与严格 wire schema，包含请求次数、已确认次数和缺失 usage 数。

存储位置为 `$DSH_HOME/data/dsh-token-stats/stats.json`，默认 `~/.dsh`。存储版本升到 2，仍提供可直接上传的 days 汇总。保留约 400 天；会话内容不在统计文件中。写入前自动将 v1 原文件保存为 `stats.json.v1.<savedAt>.bak`。损坏或未知版本的文件会保留，阻止持久化覆盖，页面显示错误；不会静默清空。

迁移时：旧累计量作为下限，按旧水位线区分已覆盖的模型响应和新增事件。重新扫描只修复旧覆盖范围的不足，新增事件继续相加。只有旧会话的水位线逐一经过完整日志验证，才确认历史次数已完整恢复。旧日志缺失时保留 token 下限，requests 为 null，knownRequests 是已确认的下限；设置页显示 ≥。v2 会持久化事件账本，后续日志删除不会丢失已统计数据。

## 安装与恢复

维护源码放在 TokenGarden 的 `plugins/dsh-token-stats/`。从 TokenGarden 根目录使用安装脚本（默认只安装源码文件，**不会重启 DSH**）：

```sh
node plugins/dsh-token-stats/scripts/install-local.mjs
```

脚本备份当前插件的程序文件到 DSH_HOME/data/dsh-token-stats/plugin-backups；保持旧文件备份，不包含凭据、会话或统计数据。使用前先验证，安装后自行重启 DSH，让 Host/Client/Typert 同时加载新版。统计文件会在新版运行后自动迁移。

安装脚本打印备份路径；程序文件可按备份恢复。迁移后的 stats.json 是 v2，若回退到 1.7.3，需同时在 DSH 停止时恢复自动保存的 v1 统计备份；回退会失去迁移后新增的统计，先保留 v2 文件用于恢复。

更新原 npm 插件可能覆盖此重写版本。TokenGarden 采集器已支持 v1/v2：仍使用 `collector/dsh-upload.mjs`，无需让插件获取上传密钥。

## 开发验证

需要真实 DSH SDK。测试时可让 `node_modules/@deepseek-ai` 指向 DSH 安装的同名 scope，让 `node_modules/zod` 指向其 zod 目录；不要把这些链接提交到 Git。安装在 DSH profile 中时使用宿主依赖。

```sh
npm test
DSH_NODE_MODULES=/path/to/dsh/node_modules npm run e2e
```

e2e 包含新统计测试、旧回归测试、持久化、余额 fixture、容错、真实 Typert 校验、版本兼容、Client 挂载与 Host RPC。`DSH_PROFILE_DIR` 和 `DSH_INSTALL_ANCHOR` 可启用只读 profile 启动预演。所有统计测试在临时 DSH_HOME 中运行，不能对真实会话目录跑测试或执行凭据探针。
