# 贡献映射

1. 核对 Bangumi 条目、章节与 TMDB 作品、季、集的对应关系。
2. 新建或修改 `data/<subject ID>.json`，参照 [数据格式](docs/data-format.md)。来源使用 `community`，写明逐集或分季证据。
3. 需要固定人工映射时，设置 `locked: true`；该条目的后续更新也需人工维护。
4. 执行 `pnpm cli format`、`pnpm check`、`pnpm test`、`pnpm validate`。
5. 提交 PR，说明解决了什么误配、日期/季/集依据，以及还有哪些未确定之处。

代码贡献采用 MIT；新增映射采用 CC BY 4.0，第三方内容保留原始许可与署名。
