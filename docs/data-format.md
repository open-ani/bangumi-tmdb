# 映射格式 v1

每个文件对应一个动画条目，文件名必须等于 `bangumiId`。权威定义是 `src/model.ts`，JSON Schema 和 TypeScript 类型从同一个 Zod 模型生成。

以下为虚构 ID 示例：

```json
{
  "schemaVersion": 1,
  "bangumiId": 100,
  "locked": true,
  "episodes": [
    { "id": 101, "type": 0, "sort": 1 },
    { "id": 102, "type": 0, "sort": 2 },
    { "id": 103, "type": 1, "sort": 1 }
  ],
  "targets": [{ "type": "tv", "id": 200 }],
  "rules": [
    { "bangumiType": 0, "start": 1, "end": 2, "tmdbId": 200, "season": 2, "episodeStart": 13 }
  ],
  "overrides": [
    { "bangumiEpisodeId": 103, "targets": [{ "type": "tv", "id": 200, "season": 0, "episode": 1 }] }
  ],
  "provenance": {
    "method": "community",
    "source": "https://bgm.tv/subject/100; https://www.themoviedb.org/tv/200",
    "evidence": "填写实际核对的季、分割放送关系、逐集标题和播出日期依据。",
    "verifiedAt": "2026-09-01T00:00:00.000Z"
  }
}
```

示例中，正篇第一、二集对应 S02E13、S02E14，特别篇对应 S00E01。

- `episodes` 保存 Bangumi 章节 ID、类型和原始 sort。
- `targets` 列出目标电影或 TV 范围。TV 目标可带 `season` 和 `episode`；`episode` 需同时指定 `season`。连续多集用 `episode` 表示起点、`episodeEnd` 表示包含端点的终点，例如 `{ "type": "tv", "id": 200, "season": 2, "episode": 13, "episodeEnd": 24 }`。省略集号表示整季，省略季号表示仅确定了作品。
- 同一 TV 可以列出多个季或互不重叠的集数范围。`targets` 表示 subject 的覆盖范围；Bangumi 章节到 TMDB 剧集的对应关系由 `rules` 和 `overrides` 单独描述。
- `rules` 的 `start` / `end` 是包含端点的整数序号。目标集号为 `episodeStart + sort - start`，缺集不改变后续集号。
- 一个条目可以用多个互不重叠的区间跨季、跨作品。发布产物包含已映射的章节。
- `overrides` 按 Bangumi episode ID 优先于区间。空目标数组明确排除该章节；多个目标表示该章拆成多个 TMDB 集，顺序由贡献者确定。
- 小数 sort 必须使用显式 override；不同 Bangumi 类型分别匹配。季号允许 0，TMDB 正片集号从 1 开始。
- 重复声明、重叠区间、同一 TV episode 被多个 Bangumi episode/subject 占用均拒绝发布。两站合并/拆分关系暂时无法准确表达时保持待匹配。
- `locked` 锁定整个条目，不自动追加新集。人工解除锁定后，后续巡检会重新处理。
- `provenance.verifiedAt` 是在线验证时间，未执行在线验证时为 `null`。`method: seed` 标识上游导入记录。
- `anidbId` 保存关联的 AniDB 条目 ID，用于交叉核对。

贡献后运行 `pnpm cli format` 生成统一排序的 JSON，再运行 `pnpm validate`。若修改模型，运行 `pnpm schemas` 并一起提交生成的 Schema。
