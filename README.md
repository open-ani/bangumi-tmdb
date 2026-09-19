# bangumi-tmdb

[![Validate](https://github.com/open-ani/bangumi-tmdb/actions/workflows/ci.yml/badge.svg)](https://github.com/open-ani/bangumi-tmdb/actions/workflows/ci.yml)

公开维护 **Bangumi 动画 → TMDB 作品、季与剧集** 的映射。

按 Bangumi 条目 ID 查询作品关联，按章节 ID 查询已补齐的逐集对应关系。

## 当前数据

<!-- stats:start -->
基于 Bangumi Archive 快照 `2026-09-15`，Archive 共有 **30,921** 个动画条目，处理情况如下。此区块由定时任务自动更新（`pnpm cli stats`）。

| 状态 | 条目数 | 说明 |
| --- | --- | --- |
| 已建立映射 | **18,288** | 占 59.1%。电影 6,079，TV 指定到季 12,019，TV 仅确定作品 190 |
| 已分析但未能确定 | 2,766 | 730 条经人工与模型复核仍无法确定，理由见 [待定清单](docs/unresolved-mappings-2026-09-10.md)；2,036 条为定时任务判定证据不足，按退避策略重试 |
| 尚未分析 | 9,904 | 2,927 条放送日在近 10958 天内或尚未放送，已在定时任务队列中；其余为 2020 年前（3,997）、无放送日期（4,595）等早期或冷门条目，留待离线批处理 |

已映射条目的来源：

| 来源 | 条目数 | 含义 |
| --- | --- | --- |
| `codex` | 11,040 | 模型联网检索并读取 TMDB 详情与季表后的研究结论，evidence 保留引用 |
| `deterministic` | 6,405 | 脚本按放送日期比对确认作品身份或生成逐集规则 |
| `seed` | 843 | 直接沿用 BangumiExtLinker 的对应关系，尚未独立核验 |
| `community` | 0 | 社区 PR 提交的人工映射 |

逐集对应：**16,207** 条映射带有逐集规则，共 **183,258** 条 Bangumi 章节 → TMDB 剧集/电影的对应，覆盖已映射条目本篇章节（248,203 话）的 73.8%。其余 2,081 条目前只有作品或季级映射，逐集关系由定时任务逐步补齐：能按放送日期确定性推导的直接写入，其余交给模型研究。

剧集图片：已映射本篇章节中 129,023 话（70.6%）在 TMDB 有剧集图；13,271 个条目每一话都有图，2,401 个条目一张也没有。逐条目、逐章节的明细见 Release 里的 `coverage.json`。

已知问题：43 条映射的 TMDB 目标已失效（404 或声明范围缺集），已标记待重研究，修正前仍按原样发布。
<!-- stats:end -->

每个 Release 的 `manifest.json` 带有生成时的计数与校验和。

## 数据消费

从 [最新 Release](https://github.com/open-ani/bangumi-tmdb/releases/latest) 下载：

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 格式版本、源 commit、Archive 快照、计数与 SHA-256 |
| `subjects.json` | Bangumi subject ID → TMDB 作品及已知季、集信息 |
| `episodes.json` | Bangumi episode ID → 明确的 TMDB movie 或 TV episode 列表 |
| `coverage.json` | 每个 Bangumi 动画条目的对应状态：`complete`、`partial`、`season-only`、`work-only`、`movie`、`no-episodes`、`unresolved`、`unanalyzed`，已放送但未映射的章节 ID（`missing`），以及已映射但 TMDB 没有剧集图的章节 ID（`noImage`） |

`episodes.json` 示例（使用虚构 ID）：

```json
{
  "schemaVersion": 1,
  "episodes": [
    {
      "bangumiId": 100,
      "bangumiEpisodeId": 101,
      "targets": [
        { "type": "tv", "id": 200, "season": 2, "episode": 13 }
      ]
    }
  ]
}
```

电影目标为 `{ "type": "movie", "id": 200 }`。一集拆分为多个 TMDB 集时，`targets` 按顺序列出全部对应剧集。

先下载 manifest，再按它的 `sourceCommit` 从 `data-<sourceCommit>` release 下载其他文件并验证校验和，确保它们属于同一版本。`coverage.json` 由定时任务生成（需要查询 TMDB 图片），按 `sources/coverage.json` 的提交版本随 Release 发布。

## 本地运行

需要 Node.js 24+、pnpm（版本见 `package.json`）、`unzip`，运行测试还需要 `zip`。在线更新的配置见 [运维说明](docs/operations.md)。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm validate

# 可重现的初次导入；日常更新无需重复执行。
pnpm import-seed

# 生成消费文件。
pnpm publish-data

# 下载、校验并缓存 Archive。
pnpm archive

# 从 Bangumi API 刷新近期条目，作为 Archive 之上的覆盖层。
pnpm cli discover

# 通过 AniDB 标题数据和 Anime-Lists 交叉核对，结果写入 sources/anidb-check.json。
pnpm cli check-anidb

# 从 .env 读取配置：核验既有映射、推导逐集规则、研究新条目。
node --env-file=.env --import tsx src/cli.ts update
node --env-file=.env --import tsx src/cli.ts verify

# 把已复核的未定项记入 state/progress.json，180 天内不再重试。
pnpm cli import-pending docs/unresolved-mappings-2026-09-10.md 180

# 重新生成 README「当前数据」里的统计区块。
pnpm cli stats
```

若环境变量已经设置，可以直接运行 `pnpm run update`、`pnpm cli verify`。`pnpm publish-data` 使用现有数据生成文件；加上 `--online` 可同时核验 TMDB。缓存默认在 `.cache/`，可用 `DATASET_CACHE` 指到别处。

## 社区贡献

编辑 `data/<Bangumi subject ID>.json` 并提交 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [映射格式](docs/data-format.md)。

部署、凭据、runner、失败恢复与任务开关见 [运维说明](docs/operations.md)。

## 许可和来源

脚本使用 [MIT](LICENSE)，映射与初始种子使用 [CC BY 4.0](LICENSE-DATA)。Bangumi 派生测试样本保留其原始 CC BY-SA 许可；第三方元数据、图像与名称不因本项目而重新授权。来源及修改说明见 [NOTICE.md](NOTICE.md)。

This product uses the TMDB API but is not endorsed or certified by TMDB.

## 数据维护方式

**初始种子。** 数据起点是 [BangumiExtLinker](https://github.com/Rhilip/BangumiExtLinker) 固定于 commit `8f853e6bf9d6cb382448091ce3afaf2d9cdb0a3f` 的 12,835 条来源记录（`sources/seed.json`），其中 5,567 条带 TMDB 链接，作为 `seed` 映射导入；其余的 AniDB、IMDb、TVDB、Wikidata ID 只作检索线索。种子范围内的条目此后经过多轮模型研究与人工复核，绝大多数已建立映射，其余 730 条记入 2026-09-10 的待定清单。

**数据源。** [Bangumi Archive](https://github.com/bangumi/Archive) 每周二发布的 dump 是条目与章节的基准；Bangumi API 每天刷新近期放送、当季日历和正在放送的条目，作为 Archive 之上的覆盖层；TMDB API 用于候选检索与在线核验；AniDB 标题数据和 [Anime-Lists](https://github.com/Anime-Lists/anime-lists) 每周交叉核对一次，结果在 `sources/anidb-check.json`。

**定时任务。** 每天北京时间 06:17 在自托管 runner 上运行，依次：

1. 核验既有映射：在线确认 TMDB 作品、季和集仍然存在，每 28 天一轮，正在放送且 TMDB 尚缺集的条目 2 天后再看。锁定（`locked`）的条目只核验不修改。
2. 推导逐集规则：只有作品或季级映射的条目，若声明的 TMDB 范围集数与 Bangumi 本篇章节数一致、且可比对的放送日期全部在 ±1 天内，直接生成 `rules`。两边日期都按集序递增时，也接受至少 80% 的日期在 ±1 天内、其余不超过 7 天，或逐集间隔一致、整体平移小于一集间隔的情况。两边缺少可比日期时，只有模型研究已限定为单一整季或集范围、且集数相等的条目才按声明范围生成，并在 evidence 中注明未做日期核验。已有规则的条目在新话放送后仍须日期在 ±1 天内才追加。
3. 识别新条目：用标题和别名搜索 TMDB，拉取候选季表，只有唯一一个候选的集与 Bangumi 章节按放送日期逐一吻合才写入，不经过模型。
4. 一轮判定：识别阶段有候选但拿不定的条目，把已抓取的候选季表交给 Codex 一轮回答，不给工具、不联网，只能引用交给它的候选。
5. 模型研究：在预算内（当前每天 200 条、8 并发）用 Codex 研究前两步没解决的条目，其次修复核验失败的映射，再为无法确定性推导的条目补逐集关系。模型可联网搜索并直接调用 TMDB 工具，但只能引用它实际读取过的作品和季，结果还要通过结构校验和在线核验才会写入。
6. 生成对应状态报告 `sources/coverage.json`（逐条目、逐章节，含 TMDB 是否有剧集图），重新生成 README 的统计区块，验证后以 `openanibot` 提交到 `main`，随即发布 Release。

自动化先研究放送日在最近 180 天内或尚未放送的未映射条目，再按每轮固定的配额（默认 100 条）处理更早的积压，从新到旧；要一次清完某段积压由维护者手动运行并指定范围。判定证据不足的条目按 7、14、28、56、90 天退避重试，未放送作品在放送日后 3 天再看，已复核的待定项 180 天内不再重试；Bangumi 侧名称、日期或章节一旦变化会立即重新处理。

**人工维护。** 社区通过 PR 修改 `data/<subject ID>.json`，需要固定的映射设置 `locked: true`；自动化不会改动锁定条目，也不能删除文件，被 Bangumi 合并或隐藏的条目由维护者处理。

**发布。** `main` 的每次提交都会生成一个 Release，tag 为 `data-<commit>`，标题为生成时间；`manifest.json` 记录来源 commit、Archive 快照、计数与校验和。运行细节、凭据与故障处理见 [运维说明](docs/operations.md)，文件格式见 [映射格式](docs/data-format.md)。
