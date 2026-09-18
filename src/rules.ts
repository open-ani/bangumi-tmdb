import { Mapping, type Episode, type EpisodeRef, type Rule, type SubjectTarget } from './model.js';
import type { TmdbSeason } from './tmdb.js';
import { expand } from './expand.js';

export interface SeasonSource { season(tv: number, season: number): Promise<TmdbSeason> }
const DAY = 86400000;
// Late-night Japanese broadcasts are recorded on neighbouring calendar days by different sites.
export const MAX_DATE_DRIFT_DAYS = 1;
export function dayDelta(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = Date.parse(a ?? ''), y = Date.parse(b ?? '');
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) / DAY : null;
}
const ref = (e: Episode): EpisodeRef => ({ id: e.id, type: e.type, sort: e.sort });
const refs = (episodes: Episode[]): EpisodeRef[] => episodes.map(ref).sort((a, b) => a.id - b.id);
type TmdbEpisode = TmdbSeason['episodes'][number];
interface Segment { tmdbId: number; season: number; episodes: TmdbEpisode[] }

// The TMDB episodes each subject target covers, in declared order. Null when any target is not a
// concrete season or the declared range has holes on TMDB.
async function segments(targets: SubjectTarget[], tmdb: SeasonSource): Promise<Segment[] | null> {
  const result: Segment[] = [];
  for (const t of targets) {
    if (t.type !== 'tv' || t.season === undefined) return null;
    const sorted = [...(await tmdb.season(t.id, t.season)).episodes].sort((a, b) => a.episode_number - b.episode_number);
    if (t.episode === undefined) { result.push({ tmdbId: t.id, season: t.season, episodes: sorted }); continue; }
    const end = t.episodeEnd ?? t.episode;
    const range = sorted.filter(e => e.episode_number >= t.episode! && e.episode_number <= end);
    if (range.length !== end - t.episode + 1) return null;
    result.push({ tmdbId: t.id, season: t.season, episodes: range });
  }
  return result;
}
// A skipped week, a double-length premiere or an early stream moves dates by days without changing the order.
export const MAX_DATE_SLIP_DAYS = 7;
const MIN_EXACT_SHARE = 0.8;
// exact: every comparable pair within the drift. mostly: most pairs exact, the rest within the slip.
// shifted: one constant offset smaller than an episode interval, with the same cadence on both sites.
export type DateAgreement = 'exact' | 'mostly' | 'shifted';
export interface DateCheck { compared: number; exact: number; ok: boolean; agreement: DateAgreement | null; shiftDays: number }
const dayOf = (date: string | null | undefined): number | null => { const at = Date.parse(date ?? ''); return Number.isFinite(at) ? at / DAY : null; };
const ascending = (days: (number | null)[]): boolean => {
  const dated = days.filter((d): d is number => d !== null);
  return dated.every((d, i) => i === 0 || d >= dated[i - 1]!);
};
// Most pairs must be comparable so a season without dates cannot pass. Anything short of exact agreement
// also needs both sites to list the episodes in airing order, which is what catches a special or an
// unaired episode sitting at a different position, and no pair further apart than the slip.
export function datesAgree(pairs: { bangumi: Episode; tmdb: TmdbEpisode }[]): DateCheck {
  const bangumi = pairs.map(p => dayOf(p.bangumi.airdate)), remote = pairs.map(p => dayOf(p.tmdb.air_date));
  const deltas = bangumi.flatMap((day, i) => day === null || remote[i] == null ? [] : [Math.abs(remote[i]! - day)]);
  const compared = deltas.length, exact = deltas.filter(d => d <= MAX_DATE_DRIFT_DAYS).length;
  const shiftDays = Math.round(Math.max(0, ...deltas));
  const verdict = (agreement: DateAgreement | null): DateCheck => ({ compared, exact, ok: agreement !== null, agreement, shiftDays });
  if (compared < Math.max(1, Math.ceil(pairs.length * 0.6))) return verdict(null);
  if (exact === compared) return verdict('exact');
  if (!ascending(bangumi) || !ascending(remote) || deltas.some(d => d > MAX_DATE_SLIP_DAYS)) return verdict(null);
  if (exact >= compared * MIN_EXACT_SHARE) return verdict('mostly');
  let gaps = 0, shortest = Infinity;
  for (let i = 1; i < pairs.length; i++) {
    const a = bangumi[i - 1], b = bangumi[i], x = remote[i - 1], y = remote[i];
    if (a == null || b == null || x == null || y == null) continue;
    if (Math.abs((b - a) - (y - x)) > MAX_DATE_DRIFT_DAYS) return verdict(null);
    gaps++; shortest = Math.min(shortest, b - a, y - x);
  }
  // An offset of a whole episode interval is indistinguishable from an alignment that is off by one episode.
  return verdict(gaps && deltas.every(d => d < shortest) ? 'shifted' : null);
}
export interface Derived { mapping: Mapping; note: string }
// Turn a subject-level mapping into episode rules without any judgement call: the declared TMDB scope
// must contain exactly as many episodes as Bangumi's regular episodes, in order, with agreeing air dates.
// Position alone is accepted only where it restates the target: a model-researched mapping that
// declares one season or episode range and has no dates to compare. That is what a model does anyway
// when it writes rules for an undated subject; here it is explicit and the evidence says so.
export async function derive(mapping: Mapping, episodes: Episode[], tmdb: SeasonSource): Promise<Derived | null> {
  if (mapping.locked || mapping.rules.length || mapping.overrides.length) return null;
  const regular = episodes.filter(e => e.type === 0).sort((a, b) => a.sort - b.sort);
  if (!regular.length) return null;
  const only = mapping.targets.length === 1 ? mapping.targets[0]! : null;
  if (only?.type === 'movie') {
    if (regular.length !== 1) return null;
    const row = Mapping.parse({ ...mapping, episodes: refs(episodes), overrides: [{ bangumiEpisodeId: regular[0]!.id, targets: [{ type: 'movie', id: only.id }] }] });
    expand(row);
    return { mapping: row, note: '脚本生成逐集规则：单一本篇章节对应整部电影。' };
  }
  if (mapping.targets.some(t => t.type === 'movie')) return null;
  if (!regular.every(e => Number.isInteger(e.sort)) || regular.some((e, i) => i > 0 && e.sort !== regular[i - 1]!.sort + 1)) return null;
  const segs = await segments(mapping.targets, tmdb);
  if (!segs) return null;
  const flat = segs.flatMap(s => s.episodes);
  if (flat.length !== regular.length) return null;
  const check = datesAgree(regular.map((bangumi, i) => ({ bangumi, tmdb: flat[i]! })));
  // Multi-target scopes are where Bangumi and TMDB order specials differently, so they always need dates.
  const declared = !check.ok && check.exact === check.compared && mapping.provenance.method === 'codex' && only !== null;
  if (!check.ok && !declared) return null;
  const rules: Rule[] = [];
  let index = 0;
  for (const s of segs) {
    let runStart = 0;
    for (let i = 1; i <= s.episodes.length; i++) {
      if (i < s.episodes.length && s.episodes[i]!.episode_number === s.episodes[i - 1]!.episode_number + 1) continue;
      rules.push({ bangumiType: 0, start: regular[index + runStart]!.sort, end: regular[index + i - 1]!.sort,
        tmdbId: s.tmdbId, season: s.season, episodeStart: s.episodes[runStart]!.episode_number });
      runStart = i;
    }
    index += s.episodes.length;
  }
  const row = Mapping.parse({ ...mapping, episodes: refs(episodes), rules, overrides: [] });
  expand(row);
  const matched = `${regular.length} 个本篇章节与声明的 TMDB 范围逐一对应`;
  const note = check.agreement === 'exact' ? `脚本按放送日期核对生成逐集规则：${matched}，${check.compared} 对日期全部在 ±${MAX_DATE_DRIFT_DAYS} 天内。`
    : check.agreement === 'mostly' ? `脚本按放送日期核对生成逐集规则：${matched}，两边日期均按集序递增，${check.compared} 对日期中 ${check.exact} 对在 ±${MAX_DATE_DRIFT_DAYS} 天内，其余相差不超过 ${MAX_DATE_SLIP_DAYS} 天。`
    : check.agreement === 'shifted' ? `脚本按放送日期核对生成逐集规则：${matched}，两边日期均按集序递增且逐集间隔一致，${check.compared} 对日期整体相差不超过 ${check.shiftDays} 天，小于一集的放送间隔。`
    : `脚本按声明范围生成逐集规则：${matched}；模型研究已将本条目限定为单一 TMDB ${only?.type === 'tv' && only.episode !== undefined ? '集范围' : '整季'}，可比对的放送日期不足（${check.compared} 对），未做日期核验。`;
  return { mapping: row, note };
}
export interface Extended { mapping: Mapping; added: number; uncovered: number; note: string }
// Keep an episode-level mapping current: refresh the Bangumi episode list, and append newly aired
// episodes to the rule they continue when TMDB has the episode with an agreeing date. Anything that
// would alter an already mapped episode is refused so a maintainer or the model can look at it.
export async function extend(mapping: Mapping, episodes: Episode[], tmdb: SeasonSource, now: number): Promise<Extended> {
  const previous = new Map(mapping.episodes.map(e => [e.id, e]));
  const current = new Map(episodes.map(e => [e.id, e]));
  const settled = new Set([...expand(mapping).map(e => e.bangumiEpisodeId), ...mapping.overrides.map(o => o.bangumiEpisodeId)]);
  for (const [id, old] of previous) {
    const fresh = current.get(id);
    if (!fresh) { if (settled.has(id)) throw new Error(`Mapped Bangumi episode ${id} disappeared`); continue; }
    if ((fresh.type !== old.type || fresh.sort !== old.sort) && settled.has(id)) throw new Error(`Mapped Bangumi episode ${id} was renumbered`);
  }
  const rules = mapping.rules.map(r => ({ ...r }));
  const seasons = new Map<string, TmdbEpisode[]>();
  let added = 0;
  const pending = episodes.filter(e => e.type === 0 && Number.isInteger(e.sort) && !settled.has(e.id)).sort((a, b) => a.sort - b.sort);
  for (const ep of pending) {
    const rule = rules.find(r => r.bangumiType === 0 && r.end + 1 === ep.sort);
    if (!rule) continue;
    const key = `${rule.tmdbId}/${rule.season}`;
    if (!seasons.has(key)) seasons.set(key, (await tmdb.season(rule.tmdbId, rule.season)).episodes);
    const remote = seasons.get(key)!.find(e => e.episode_number === rule.episodeStart + ep.sort - rule.start);
    const delta = remote ? dayDelta(ep.airdate, remote.air_date) : null;
    if (delta === null || delta > MAX_DATE_DRIFT_DAYS) continue;
    rule.end = ep.sort; added++;
  }
  const row = Mapping.parse({ ...mapping, episodes: refs(episodes), rules });
  const mapped = new Set([...expand(row).map(e => e.bangumiEpisodeId), ...row.overrides.map(o => o.bangumiEpisodeId)]);
  const uncovered = episodes.filter(e => e.type === 0 && !mapped.has(e.id) && Date.parse(e.airdate) <= now + 2 * DAY).length;
  return { mapping: row, added, uncovered, note: added ? `脚本按放送日期延长逐集规则 ${added} 集。` : '' };
}
