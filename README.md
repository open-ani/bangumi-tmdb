# bangumi-tmdb

[![Validate](https://github.com/open-ani/bangumi-tmdb/actions/workflows/ci.yml/badge.svg)](https://github.com/open-ani/bangumi-tmdb/actions/workflows/ci.yml)

公开维护 **Bangumi 动画 → TMDB 作品、季与剧集** 的映射。

按 Bangumi 条目 ID 查询作品关联，按章节 ID 查询已补齐的逐集对应关系。

## 当前数据

初始种子来自 [BangumiExtLinker](https://github.com/Rhilip/BangumiExtLinker)，固定于 commit
`8f853e6bf9d6cb382448091ce3afaf2d9cdb0a3f`。**5,568 条 TMDB 关联已导入 `data/`**，保留上游提供的作品、季和集信息。

`sources/seed.json` 保存 12,835 条来源记录，包含 AniDB 等外部 ID，用于后续核对和补充映射。

后续更新使用 [Bangumi Archive](https://github.com/bangumi/Archive) 和 TMDB，覆盖全部动画类型。

## 数据消费

从 [最新 Release](https://github.com/open-ani/bangumi-tmdb/releases/latest) 下载：

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 格式版本、源 commit、Archive 快照、计数与 SHA-256 |
| `subjects.json` | Bangumi subject ID → TMDB 作品及已知季、集信息 |
| `episodes.json` | Bangumi episode ID → 明确的 TMDB movie 或 TV episode 列表 |

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

先下载 manifest，再按它的 `sourceCommit` 从 `data-<sourceCommit>` release 下载另外两个文件并验证校验和，确保三个文件属于同一版本。

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

# 通过 AniDB 标题数据和 Anime-Lists 交叉核对，结果写入 sources/anidb-check.json。
pnpm cli check-anidb

# 从 .env 读取配置。
node --env-file=.env --import tsx src/cli.ts update
node --env-file=.env --import tsx src/cli.ts verify
```

若环境变量已经设置，可以直接运行 `pnpm run update`、`pnpm cli verify`。`pnpm publish-data` 使用现有数据生成文件；加上 `--online` 可同时核验 TMDB。

## 社区贡献

编辑 `data/<Bangumi subject ID>.json` 并提交 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [映射格式](docs/data-format.md)。

部署、凭据、runner、失败恢复与任务开关见 [运维说明](docs/operations.md)。

## 许可和来源

脚本使用 [MIT](LICENSE)，映射与初始种子使用 [CC BY 4.0](LICENSE-DATA)。Bangumi 派生测试样本保留其原始 CC BY-SA 许可；第三方元数据、图像与名称不因本项目而重新授权。来源及修改说明见 [NOTICE.md](NOTICE.md)。

This product uses the TMDB API but is not endorsed or certified by TMDB.
