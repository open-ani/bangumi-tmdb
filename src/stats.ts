import { join } from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { expand } from './expand.js';
import { loadContext } from './update.js';
import { dumpTime } from './catalog.js';
import { parseUnresolved } from './pending.js';
import { STATS_END, STATS_START } from './guard.js';

const DAY = 86400000;
export interface Stats {
  snapshot: string; archiveAnime: number;
  mapped: number; movie: number; tvSeason: number; tvBare: number;
  methods: Record<string, number>; verified: number;
  episodeLevel: number; subjectLevel: number; mappedEpisodes: number; regularOfMapped: number;
  unresolved: number; unresolvedDocumented: number; unresolvedAutomation: number;
  unanalyzed: number; unanalyzedInScope: number; unanalyzedNoDate: number; unanalyzedBefore2020: number;
  broken: number;
}
// Composition of the dataset against the current Bangumi catalog. The scope split uses the Archive dump
// time as "now" so the numbers only move when data moves, not with the calendar.
export async function computeStats(root: string, scopeDays: number): Promise<Stats> {
  const { catalog, progress, existing, ctx } = await loadContext(root, 'default');
  const mapped = new Set(existing.map(r => r.bangumiId));
  const documented = new Set<number>();
  for (const name of (await readdir(join(root, 'docs'))).filter(n => /^unresolved-mappings-.*\.md$/.test(n))) {
    for (const entry of parseUnresolved(await readFile(join(root, 'docs', name), 'utf8'))) documented.add(entry.bangumiId);
  }
  const pendingUnmapped = Object.entries(progress.subjects).filter(([id, p]) => p.status === 'pending' && !mapped.has(Number(id))).map(([id]) => Number(id));
  const analyzed = new Set([...mapped, ...pendingUnmapped]);
  const reference = dumpTime(catalog.snapshot) || Date.now();
  const inScope = (date: string) => { const at = Date.parse(date); return Number.isFinite(at) && at >= reference - scopeDays * DAY; };
  const rest = catalog.subjects.filter(s => !analyzed.has(s.id));
  const stats: Stats = {
    snapshot: catalog.snapshot.name, archiveAnime: catalog.subjects.length,
    mapped: existing.length, movie: 0, tvSeason: 0, tvBare: 0, methods: {}, verified: 0,
    episodeLevel: 0, subjectLevel: 0, mappedEpisodes: 0, regularOfMapped: 0,
    unresolved: pendingUnmapped.length, unresolvedDocumented: pendingUnmapped.filter(id => documented.has(id)).length,
    unresolvedAutomation: pendingUnmapped.filter(id => !documented.has(id)).length,
    unanalyzed: rest.length, unanalyzedInScope: rest.filter(s => inScope(s.date)).length,
    unanalyzedNoDate: rest.filter(s => !s.date).length, unanalyzedBefore2020: rest.filter(s => s.date && s.date < '2020').length,
    broken: Object.entries(progress.subjects).filter(([id, p]) => p.status === 'pending' && mapped.has(Number(id))).length,
  };
  for (const row of existing) {
    if (row.targets.every(t => t.type === 'movie')) stats.movie++;
    else if (row.targets.some(t => t.type === 'tv' && t.season === undefined)) stats.tvBare++;
    else stats.tvSeason++;
    stats.methods[row.provenance.method] = (stats.methods[row.provenance.method] ?? 0) + 1;
    if (row.provenance.verifiedAt) stats.verified++;
    if (row.rules.length || row.overrides.length) stats.episodeLevel++; else stats.subjectLevel++;
    stats.mappedEpisodes += expand(row).length;
    stats.regularOfMapped += (ctx.episodes.get(row.bangumiId) ?? []).filter(e => e.type === 0).length;
  }
  return stats;
}
const n = (value: number) => value.toLocaleString('en-US');
const pct = (part: number, whole: number) => whole ? `${(100 * part / whole).toFixed(1)}%` : '0%';
export function renderStats(s: Stats, scopeDays: number): string {
  const snapshot = s.snapshot.replace(/^dump-|\.\d{6}Z\.zip$/g, '');
  return `${STATS_START}
基于 Bangumi Archive 快照 \`${snapshot}\`，Archive 共有 **${n(s.archiveAnime)}** 个动画条目，处理情况如下。此区块由定时任务自动更新（\`pnpm cli stats\`）。

| 状态 | 条目数 | 说明 |
| --- | --- | --- |
| 已建立映射 | **${n(s.mapped)}** | 占 ${pct(s.mapped, s.archiveAnime)}。电影 ${n(s.movie)}，TV 指定到季 ${n(s.tvSeason)}，TV 仅确定作品 ${n(s.tvBare)} |
| 已分析但未能确定 | ${n(s.unresolved)} | ${n(s.unresolvedDocumented)} 条经人工与模型复核仍无法确定，理由见 [待定清单](docs/unresolved-mappings-2026-09-10.md)；${n(s.unresolvedAutomation)} 条为定时任务判定证据不足，按退避策略重试 |
| 尚未分析 | ${n(s.unanalyzed)} | ${n(s.unanalyzedInScope)} 条放送日在近 ${scopeDays} 天内或尚未放送，已在定时任务队列中；其余为 2020 年前（${n(s.unanalyzedBefore2020)}）、无放送日期（${n(s.unanalyzedNoDate)}）等早期或冷门条目，留待离线批处理 |

已映射条目的来源：

| 来源 | 条目数 | 含义 |
| --- | --- | --- |
| \`codex\` | ${n(s.methods.codex ?? 0)} | 模型联网检索并读取 TMDB 详情与季表后的研究结论，evidence 保留引用 |
| \`deterministic\` | ${n(s.methods.deterministic ?? 0)} | 脚本按精确日期比对确认作品身份或生成逐集规则 |
| \`seed\` | ${n(s.methods.seed ?? 0)} | 直接沿用 BangumiExtLinker 的对应关系，尚未独立核验 |
| \`community\` | ${n(s.methods.community ?? 0)} | 社区 PR 提交的人工映射 |

逐集对应：**${n(s.episodeLevel)}** 条映射带有逐集规则，共 **${n(s.mappedEpisodes)}** 条 Bangumi 章节 → TMDB 剧集/电影的对应，覆盖已映射条目本篇章节（${n(s.regularOfMapped)} 话）的 ${pct(s.mappedEpisodes, s.regularOfMapped)}。其余 ${n(s.subjectLevel)} 条目前只有作品或季级映射，逐集关系由定时任务逐步补齐：能按放送日期确定性推导的直接写入，其余交给模型研究。

已知问题：${n(s.broken)} 条映射的 TMDB 目标已失效（404 或声明范围缺集），已标记待重研究，修正前仍按原样发布。
${STATS_END}`;
}
export function replaceStats(readme: string, block: string): string {
  const start = readme.indexOf(STATS_START), end = readme.indexOf(STATS_END);
  if (start === -1 || end === -1 || end < start) throw new Error('README.md is missing the generated stats markers');
  return readme.slice(0, start) + block + readme.slice(end + STATS_END.length);
}
export async function writeStats(root: string, scopeDays: number): Promise<Stats> {
  const stats = await computeStats(root, scopeDays);
  const path = join(root, 'README.md');
  const before = await readFile(path, 'utf8');
  const after = replaceStats(before, renderStats(stats, scopeDays));
  if (after !== before) await writeFile(path, after);
  console.log(`Stats: ${stats.mapped} mapped of ${stats.archiveAnime}; ${stats.episodeLevel} with episode rules; ${stats.unresolved} unresolved; ${stats.broken} broken${after !== before ? '; README updated' : ''}`);
  return stats;
}
