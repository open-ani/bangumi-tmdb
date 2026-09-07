# 运维

## 启用自动更新

在 GitHub 仓库设置以下配置：

| 配置 | 类型 | 用途 |
| --- | --- | --- |
| `TMDB_READ_TOKEN` | Repository secret | TMDB API Read Access Token；在线巡检使用 |
| `OPENANI_BOT_TOKEN` | Repository/organization secret | 以 `openanibot` 对该仓库写入 |
| `AUTOMATION_ENABLED` | Repository variable | 设为 `true` 启用巡检 |
| `CODEX_MODEL` | Optional variable | 空值使用 Codex 默认模型 |
| `CODEX_MAX_SUBJECTS` | Optional variable | 默认每轮最多 100 个 Codex 条目 |
| `UPDATE_MAX_MINUTES` | Optional variable | 默认匹配阶段最多 60 分钟 |

自托管 runner 标签为 `self-hosted, macOS, ARM64`。安装 Node.js 24+、Codex CLI、gh、zip/unzip；runner 用户必须已通过 `codex login` 登录 ChatGPT 订阅，且 `codex`、`gh` 在 PATH 中。组织 runner group 必须允许本仓库使用。

机器人的 token 应允许本仓库 Contents 写入。由于它直接推送 `main`，如开启必须经过 PR/状态检查的 ruleset，需要为机器人配置对应的最小 bypass。使用机器人 token 而非 `GITHUB_TOKEN` 推送，以触发后续托管 CI 和发布工作流。

配置完成后手动运行 **Update mappings**，确认数据提交及 **Publish dataset** 成功。

## 调度与发布

北京时间周三、周日 07:17 运行巡检，即 UTC `17 23 * * 2,6`，通过 Archive 的 `aux/latest.json` 获取最新快照。

待匹配项每周重试，已有映射每 28 天复核，暂时性失败次日允许重试。到期条目由下一次定时任务或手动运行处理。

机器人验证后直接提交到 `main`。如果期间有其他提交，会在最新 main 上重新计算，最多尝试三次。main 更新后根据现有数据生成 Release，并更新 latest。

`pnpm cli check-anidb` 读取 AniDB 标题数据，按 AniDB ID 对照 Anime-Lists 的 TMDB 关联，结果写入 `sources/anidb-check.json`。`conflict` 表示作品或季不一致，`partial` 表示仅部分信息相符，`candidate` 表示可补充的关联。

## 故障处理

- **TMDB 401/403**：检查 token。
- **TMDB 429/5xx/网络超时**：自动重试，持续失败时检查 TMDB 服务状态及网络。
- **Codex 登录失效、超时或输出格式错误**：在 runner 用户环境中检查 Codex 登录状态和版本。
- **Archive 下载、摘要或解析失败**：检查上游文件及网络后重跑。
- **locked 记录有问题**：由维护者核对并修复。
- **推送竞争/权限失败**：最多重算三次，随后工作流失败；修复权限或等待主分支稳定后重跑。
- **定时任务没有运行**：检查 Actions 是否被 GitHub 因长期无活动而暂停、仓库变量和 runner 在线状态；手动触发可追赶最新快照。

工作流 summary 给出快照、变更数、Codex 使用条目数与失败计数。待匹配原因保存在 `state/progress.json`。

把 `AUTOMATION_ENABLED` 设为 `false` 可暂停后续巡检。已经排队/运行的任务需在 Actions 中另行取消。
