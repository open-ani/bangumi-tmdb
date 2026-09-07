# bangumi-tmdb

[![Validate](https://github.com/open-ani/bangumi-tmdb/actions/workflows/ci.yml/badge.svg)](https://github.com/open-ani/bangumi-tmdb/actions/workflows/ci.yml)

公开维护 **Bangumi 动画 → TMDB 作品、季与剧集** 的映射。

服务端只消费确定的逐集映射，不再用片名自行匹配。这个仓库不存储剧照，也不负责 TMDB 图片下载、R2 镜像或客户端展示。

## 当前数据

初始种子来自 [BangumiExtLinker](https://github.com/Rhilip/BangumiExtLinker)，固定于 commit
`8f853e6bf9d6cb382448091ce3afaf2d9cdb0a3f`。清洗后有 **9,657 条候选，其中 5,568 条包含 TMDB 链接**。

**种子不是已验证映射。** `sources/seed.json` 仅供匹配工具使用；只有经过独立校验的记录才进入 `data/` 和 Releases。新仓库在首次成功巡检前没有正式数据 release。

BangumiExtLinker 是初始化来源，后续不自动重新导入或覆盖社区修改。运行时输入直接来自 [Bangumi Archive](https://github.com/bangumi/Archive) 和 TMDB，覆盖全部动画类型，包括 TV、剧场版、OVA、ONA、特别篇和 NSFW 动画。

## 数据消费

从 [最新 Release](https://github.com/open-ani/bangumi-tmdb/releases/latest) 下载：

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 格式版本、源 commit、Archive 快照、计数与 SHA-256 |
| `subjects.json` | Bangumi subject ID → TMDB movie / TV ID 列表 |
| `episodes.json` | Bangumi episode ID → 明确的 TMDB movie 或 TV episode 列表 |

`episodes.json` 的形状如下（**示例 ID，不是真实映射**）：

```json
{
  "schemaVersion": 1,
  "episodes": [
    {
      "bangumiId": 100,
      "bangumiEpisodeId": 101,
      "targets": [
        { "type": "tv", "id": 200, "season": 2, "episode": 13, "episodeId": 300 }
      ]
    }
  ]
}
```

电影目标为 `{ "type": "movie", "id": 200 }`。一集对应多个 TMDB 集时保留多个目标；消费方不能把数组当成无序备选项。没有充分依据的映射不出现在产物中。

先下载 manifest，再按它的 `sourceCommit` 从 `data-<sourceCommit>` release 下载另外两个文件并验证校验和，避免更新过程中混用两个版本。`main` 是协作数据源，正式消费请使用完整通过在线校验的 release。发布失败不会替换上一个版本。

## 本地运行

需要 Node.js 24+、pnpm（版本见 `package.json`）、`unzip`，运行测试还需要 `zip`。在线巡检另需 TMDB API Read Access Token、已用 ChatGPT 订阅登录的 Codex CLI。没有调用 OpenAI API key 的逻辑。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm validate

# 可重现的初次导入；日常更新无需重复执行。
pnpm import-seed

# 下载、校验并缓存 Archive；完整归档不会提交到 git。
pnpm archive

# 使用本地 .env 时由 Node 读取；不要提交 .env。
node --env-file=.env --import tsx src/cli.ts update
node --env-file=.env --import tsx src/cli.ts verify
node --env-file=.env --import tsx src/cli.ts publish
```

若环境变量已经设置，可以直接运行 `pnpm run update`、`pnpm cli verify`、`pnpm publish-data`。
注意 `pnpm update` 是包管理器更新依赖的命令，不是巡检脚本。

脚本在本地只修改文件。只有 CI 最后的提交步骤会 commit/push。所有缓存、诊断日志和暂存发布产物均位于被忽略的 `.cache/` 或 `dist/`。

## 如何判断映射

1. 脚本获取已知链接、IMDb/TheTVDB/Wikidata 对应关系，并使用名称搜索候选。
2. 确定性匹配必须有逐集标题和日期等交叉证据；名称相似度不能证明作品身份，裸 TV 链接不能确定第一季。
3. Codex 判断复杂名称、分割放送、续作、重制与特别篇。候选不足时可请求额外的名称搜索或指定 TMDB 作品、季查询，由脚本执行。
4. 脚本独立验证 Codex 输出的 Schema、Bangumi 归属、TMDB 目标存在性、集数区间和重复归属。结构正确不等于语义正确，因此决定必须附带具体判断依据。
5. 仍无法判断就记录原因，下次重试，不强行匹配。

巡检优先当季与即将播出条目，同时为历史积压和已有映射复核预留名额。相同输入在重试期内不会重复调用 Codex；未匹配项每周再查，已有映射每 28 天复核，暂时性失败次日允许重试。实际执行时点仍由周三、周日定时任务或手动触发决定。

## 社区贡献

编辑 `data/<Bangumi subject ID>.json` 并提交 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [映射格式](docs/data-format.md)。社区 PR 由维护者人工合并。

机器人在自托管 worker 上定期巡检，自己验证后直接 commit/push 到 `main`。**机器人不创建 PR，不自动合并社区 PR。** 需要保留人工决定时设置 `locked: true`；机器人会报告问题，不改动锁定记录。

部署、凭据、runner、失败恢复与任务开关见 [运维说明](docs/operations.md)。

## 许可和来源

脚本使用 [MIT](LICENSE)，映射与初始种子使用 [CC BY 4.0](LICENSE-DATA)。Bangumi 派生测试样本保留其原始 CC BY-SA 许可；第三方元数据、图像与名称不因本项目而重新授权。来源及修改说明见 [NOTICE.md](NOTICE.md)。

This product uses the TMDB API but is not endorsed or certified by TMDB.
