# 贡献映射

1. 确认 Bangumi 条目、章节 ID 及 TMDB 作品、季、集地址。不能只凭片名相似或集数相同判断。
2. 新建或修改 `data/<subject ID>.json`，参照 [数据格式](docs/data-format.md)。来源使用 `community`，写明逐集或分季证据。
3. 如需长期保留人工判断，设置 `locked: true`。它会锁定整个条目，包括后续集数更新；请按需要使用。
4. 执行 `pnpm cli format`、`pnpm check`、`pnpm test`、`pnpm validate`。
5. 提交 PR，说明解决了什么误配、日期/季/集依据，以及还有哪些未确定之处。

fork PR 运行不带 secrets 的托管 CI；不需要 TMDB token 或 Codex 订阅也能贡献。维护者人工审核并合并，合并后的发布任务负责在线核验。不要把凭据、完整 Archive、剧照或原始大段元数据提交到仓库。

代码贡献采用 MIT；新增映射采用 CC BY 4.0，第三方内容保留原始许可与署名。
