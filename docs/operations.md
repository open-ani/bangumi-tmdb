# 运维

## 启用自动更新

仓库准备好代码和种子后，再设置以下配置：

| 配置 | 类型 | 用途 |
| --- | --- | --- |
| `TMDB_READ_TOKEN` | Repository secret | TMDB API Read Access Token；在线巡检及发布使用 |
| `OPENANI_BOT_TOKEN` | Repository/organization secret | 以 `openanibot` 对该仓库写入；只在预检和提交步骤提供 |
| `AUTOMATION_ENABLED` | Repository variable | 全部准备好后设为 `true`，启用巡检与发布 |
| `CODEX_MODEL` | Optional variable | 空值使用 Codex 默认模型 |
| `CODEX_MAX_SUBJECTS` | Optional variable | 默认每轮最多 100 个 Codex 条目 |
| `UPDATE_MAX_MINUTES` | Optional variable | 默认匹配阶段最多 60 分钟 |

自托管 runner 标签为 `self-hosted, macOS, ARM64`。安装 Node.js 24+、Codex CLI、gh、zip/unzip；runner 用户必须已通过 `codex login` 登录 ChatGPT 订阅，且 `codex`、`gh` 在 PATH 中。组织 runner group 必须允许本仓库使用。不能把本机的 auth.json 上传成仓库文件或 workflow artifact。

Codex CLI 必须支持 `exec`、`--ignore-user-config`、`--ignore-rules`、`--ephemeral`、`--output-schema`。调用关闭 shell、浏览器、MCP 应用、hooks 和多代理，只通过结构化请求让脚本取证。继承现有订阅认证，不继承个人 config.toml；模型在 `CODEX_MODEL` 显式配置。

机器人的 token 应允许本仓库 Contents 写入。由于它直接推送 `main`，如开启必须经过 PR/状态检查的 ruleset，需要为机器人配置对应的最小 bypass。其他贡献者仍走人工合并。使用机器人 token 而非 `GITHUB_TOKEN` 推送，以触发后续托管 CI 和发布工作流。

配置完成后手动运行 **Update mappings**；确认数据提交及 **Publish dataset** 成功。GitHub 托管的 PR 检查不依赖 secrets，即使自动化未启用也正常运行。

## 调度与隔离

- 北京时间周三、周日 07:17，即 UTC `17 23 * * 2,6`。Archive 上游当前 README 仅承诺周三；实际通过 `aux/latest.json` 判断最新快照。
- 同一快照不重复下载或解析，但仍处理到期重试、TMDB 新增内容与映射复核。上游晚到时由下一次巡检或手动运行补齐。
- 更新 job 在调度到自托管机器前检查完整仓库名、默认分支、事件和开关。fork 的定时任务直接跳过。
- PR 只使用 `ubuntu-latest`，不提供 secrets。没有 `pull_request_target`、评论触发或 fork 代码进入自托管机器的路径。
- GitHub 凭据不传入匹配步骤；提交时发生并发冲突而重新匹配，也会先移除 GitHub token。Codex 子进程进一步使用环境变量白名单，排除 TMDB 和 GitHub token。

## 数据提交与发布

机器人只允许修改 `data/<id>.json`、`state/progress.json` 和受控来源文件。提交前重新取远端 main；若有人工变更，丢弃本轮生成的差异，在新 main 上重算并验证，最多尝试三次，绝不强推。锁定内容不能被自动修改。

提交前校验所有映射；一次 404、集号变化或人工锁定记录失效也会阻止不完整的提交。通过后直接推送 `main`，托管发布任务独立执行全部在线验证。构建完成后先创建 draft release、上传所有文件，再一次性发布为 latest。没有经过验证的映射时拒绝创建空 release。

社区 PR 的离线检查不能证明 TMDB 目标仍存在。维护者审核作品对应关系；合并后的在线发布会核对全部目标和 Bangumi 归属。发布失败时修正 main，上一版 release 继续可用。

## 故障处理

- **TMDB 401/403**：立即中止，检查 token；不会把身份验证失败记录成“作品不存在”。
- **TMDB 429/5xx/网络超时**：有限重试，仍失败时保持旧映射并记录错误，不把异常响应当候选。
- **Codex 登录失效、超时或输出格式错误**：保留待处理项，不生成映射。认证可用性需要在 runner 用户环境中检查。
- **Archive 下载、摘要或解析失败**：保留旧缓存，不更新快照标记，也不发布。
- **locked 记录有问题**：机器人不能修改，维护者核对后提交修复。
- **推送竞争/权限失败**：最多重算三次，随后工作流失败；修复权限或等待主分支稳定后重跑。
- **定时任务没有运行**：检查 Actions 是否被 GitHub 因长期无活动而暂停、仓库变量和 runner 在线状态；手动触发可追赶最新快照。

工作流 summary 给出快照、变更数、Codex 使用条目数与失败计数。公开的待匹配依据保存在 `state/progress.json`；完整 Archive、TMDB 响应缓存与 Codex 临时上下文不上传。

任何时候把 `AUTOMATION_ENABLED` 设为 `false` 都可以暂停后续巡检与发布。已经排队/运行的任务需在 Actions 中另行取消。
