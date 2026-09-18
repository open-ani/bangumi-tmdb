# 运维

## 启用自动更新

在 GitHub 仓库设置以下配置：

| 配置 | 类型 | 用途 |
| --- | --- | --- |
| `TMDB_READ_TOKEN` | Repository secret | TMDB API Read Access Token；在线核验与 Codex 的 TMDB 工具使用 |
| `OPENANI_BOT_TOKEN` | Repository/organization secret | 以 `openanibot` 对该仓库写入 |
| `BANGUMI_TOKEN` | Optional secret | Bangumi API token；缺省时 API 不返回 NSFW 条目，这些条目仍以 Archive 为准 |
| `AUTOMATION_ENABLED` | Repository variable | 设为 `true` 启用巡检 |
| `CODEX_MODEL` | Optional variable | 空值使用 Codex 默认模型 |
| `CODEX_REASONING` | Optional variable | 推理强度，默认 `high` |
| `CODEX_MAX_SUBJECTS` | Optional variable | 每轮最多交给 Codex 研究的条目数，默认 60 |
| `CODEX_CONCURRENCY` | Optional variable | 并行的 Codex 会话数，默认 4 |
| `CODEX_MAX_ADJUDICATIONS` | Optional variable | 每轮最多交给 Codex 一轮判定（无工具）的条目数，默认 400 |
| `CODEX_TIMEOUT_MINUTES` | Optional variable | 单个条目的研究超时，默认 8 分钟 |
| `UPDATE_MAX_MINUTES` | Optional variable | 一轮更新的总时间预算，默认 75 分钟；前一半留给校验与规则推导 |
| `UPDATE_SCOPE_DAYS` | Optional variable | 只研究放送日在最近这么多天内或尚未放送的未映射条目，默认 180；手动运行时可用 `scope_days` 输入覆盖 |
| `UPDATE_PLATFORMS` | Manual input only | 手动运行时用 `platforms` 输入限定未映射条目的 Bangumi 平台代码，逗号分隔（1 TV、2 OVA、3 剧场版、5 WEB、0 其他、2006 动态漫画）；留空不限 |
| `DISCOVER_MAX_SUBJECTS` | Optional variable | 每轮通过 Bangumi API 刷新的条目上限，默认 600 |

自托管 runner 标签为 `self-hosted, macOS, ARM64`，与 animeko 的 Codex 工作流共用同一台组织级 Mac mini：`codex` 在 `~/.local/bin`，`gh` 与 Node 在 `/opt/homebrew/bin`，工作流开头会把这两个目录加入 PATH；runner 用户已通过 `codex login` 登录 ChatGPT 订阅（`~/.codex/auth.json`）。这台机器只有一个 runner，本任务会和 animeko 的 Codex 任务串行排队，因此安排在北京时间清晨运行。组织 runner group 必须允许本仓库使用。

工作流把 Archive dump、解析后的 catalog、Bangumi API 覆盖层、TMDB 响应缓存和每个条目的研究记录放在 runner 用户的 `~/.cache/bangumi-tmdb`（环境变量 `DATASET_CACHE`），checkout 清理不会删除它们。Archive 只在 sha256 变化时重新下载。

机器人的 token 应允许本仓库 Contents 写入。由于它直接推送 `main`，如开启必须经过 PR/状态检查的 ruleset，需要为机器人配置对应的最小 bypass。使用机器人 token 而非 `GITHUB_TOKEN` 推送，以触发后续托管 CI 和发布工作流。

配置完成后手动运行 **Update mappings**（可先把 `max_subjects` 设为 10 试跑），确认数据提交及 **Publish dataset** 成功。

## 每轮做什么

北京时间每天 06:17 运行，即 UTC `17 22 * * *`。每轮依次：

1. `pnpm archive`：读取 Archive 的 `aux/latest.json`，仅在出现新 dump（每周二 21:03 UTC 左右发布）时下载并解析。
2. `pnpm cli discover`：从 Bangumi API 刷新最近 45 天到未来 120 天放送的动画、当季日历、正在放送的已映射条目、Archive 中缺失的已映射条目（Bangumi 锁定条目）以及即将重试的待定项，写入 API 覆盖层。覆盖层里比当前 dump 新的记录优先于 Archive；API 返回 302 的条目视为已合并并从 catalog 移除，404 不移除。
3. `pnpm cli check-anidb`：每周三或手动勾选时刷新 AniDB 交叉核对。
4. `pnpm run update`：
   - 校验阶段：对到期的已有映射在线核验 TMDB 作品、季和集是否仍存在；对只有作品级映射的条目按放送日期推导逐集规则（集数一致，且可比对的日期全部在 ±1 天内；两边日期都按集序递增时，也接受至少 80% 在 ±1 天内、其余不超过 7 天，或逐集间隔一致而整体平移小于一集间隔；缺少可比日期时，仅限模型研究已限定为单一整季或集范围、且集数相等的条目）；对已有逐集规则的条目追加新放送的集。锁定条目只核验不修改。
   - 识别阶段：对到期的未映射条目，用标题、译名、别名（去掉季数后缀）搜索 TMDB，拉取候选的季表，只有唯一一个候选的集与 Bangumi 本篇章节按放送日期逐一吻合时才写入作品与逐集映射（`deterministic`，evidence 记录搜索词与候选数）；单集条目按上映日期匹配电影。多候选吻合、缺少日期或对不上的留给模型。
   - 判定阶段：识别阶段有候选但拿不定的条目（多候选吻合、缺日期、集数对不上），把 Bangumi 数据和已抓取的候选季表一起交给 Codex 一轮判定，不给工具、不联网，结果同样经证据检查（只能引用交给它的候选）、结构校验和在线核验；pending 的留给研究阶段。每轮最多 `CODEX_MAX_ADJUDICATIONS` 条（默认 400）。
   - 研究阶段：在时间与条目预算内，用 Codex（联网搜索加 TMDB MCP 工具）研究新出现的、在范围内的未映射条目，其次修复核验失败的映射，再为无法确定性推导的条目补逐集规则。模型只能引用它实际通过工具读取过的作品和季，结果还要经过结构校验和在线核验。
5. `pnpm cli stats`：重新生成 README「当前数据」里 `<!-- stats:start -->` 到 `<!-- stats:end -->` 之间的统计区块。
6. `scripts/commit-update.sh`：guard 检查只改动了 `data/`、`state/`、`sources/` 和 README 的统计区块（区块之外必须与基线一致），验证后以 openanibot 提交 main。若 main 期间有变化，先把生成的改动 rebase 到最新 main 并重新校验、重新生成统计区块；rebase 冲突或校验不过才在最新 main 上重算，最多三次。

每个条目的研究决策连同输入摘要保存在 `$DATASET_CACHE/research/<subject ID>/decision.json`；48 小时内输入相同的再次研究直接复用这份决策（仍经过结构校验和在线核验），所以超时中断或重算只重复便宜的核验阶段，不重复消耗 Codex。

待定项按 7、14、28、56、90 天退避重试；未放送作品在放送日后 3 天再看。已映射条目每 28 天复核，正在放送且 TMDB 尚缺集的条目 2 天后再试。Bangumi 数据（名称、日期、章节、关系、种子线索）一旦变化，条目会立即重新处理，不受重试时间限制。

手动补跑积压时，把要处理的条目在 `state/progress.json` 里的 `retryAt` 改到当前时间之前并提交，再以 `max_subjects`、`max_adjudications`、`max_minutes`（最多 450，作业上限 8 小时），必要时加 `scope_days` 与 `platforms`，手动运行 **Update mappings**；研究队列先处理到期的未映射条目和核验失败的映射，剩余预算按放送日期从新到旧补逐集规则。

放送日早于范围的未映射条目不进入定时任务，由维护者用离线批处理完成后提交。`docs/unresolved-mappings-*.md` 里的已复核未定项通过 `pnpm cli import-pending <文件> [天数]` 写入 `state/progress.json`，默认 180 天后才重试。

## 故障处理

- **TMDB 401/403**：检查 token。整轮中止，不提交。
- **TMDB 429/5xx/网络超时**：自动重试，持续失败时检查 TMDB 服务状态及网络。
- **Bangumi API 不可用**：discover 步骤允许失败，沿用上一轮覆盖层继续。
- **Codex 登录失效、超时或输出格式错误**：在 runner 用户环境中检查 Codex 登录状态和版本；单个条目的提示词、事件流、工具调用记录和结果保存在 `$DATASET_CACHE/research/<subject ID>/`。
- **一轮因超时或作业上限中断**：结果不会提交，但研究决策已在缓存里；直接重跑，48 小时内相同输入不再调用 Codex。
- **Archive 下载、摘要或解析失败**：检查上游文件及网络后重跑。
- **已映射条目从 Bangumi 消失**：summary 会列出被合并或隐藏的条目 ID；自动化不能删除文件，由维护者删除或迁移映射。
- **locked 记录有问题**：由维护者核对并修复。
- **推送竞争/权限失败**：最多重算三次，随后工作流失败；修复权限或等待主分支稳定后重跑。
- **定时任务没有运行**：检查 Actions 是否被 GitHub 因长期无活动而暂停、仓库变量和 runner 在线状态；手动触发可追赶最新快照。

工作流 summary 给出快照、变更数、核验/推导/延长计数、Codex 使用条目数与各状态计数。待匹配原因保存在 `state/progress.json`。

把 `AUTOMATION_ENABLED` 设为 `false` 可暂停后续巡检。已经排队/运行的任务需在 Actions 中另行取消。
