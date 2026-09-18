import { z } from 'zod';
import { Mapping, type Episode, type Subject, type SubjectTarget } from './model.js';
import type { Tmdb, TmdbSeason } from './tmdb.js';
import { datesAgree, derive, MAX_DATE_DRIFT_DAYS, type DateAgreement, type Derived } from './rules.js';
import { normalize } from './anidb.js';

// Deterministic identification: a title search only proposes candidates; a candidate is accepted when
// the Bangumi regular episodes line up, date by date, with the candidate's TMDB episodes and no other
// candidate does. Movies need a release date next to Bangumi's. Anything short of that is left for the
// model, so this stage never guesses.
const DAY = 86400000;
const MAX_QUERIES = 6, RESULTS_PER_QUERY = 5, MAX_SHOWS = 6, MAX_SEASONS_PER_SHOW = 6;
const SEASON_WINDOW_DAYS = 400;
const MOVIE_TITLE_SLACK_DAYS = 30, MOVIE_DATE_SLACK_DAYS = 3;
const Search = z.object({ results: z.array(z.object({ id: z.number().int().positive(), name: z.string().optional(), title: z.string().optional(),
  original_name: z.string().optional(), original_title: z.string().optional(), first_air_date: z.string().optional(), release_date: z.string().optional() })) });
type Hit = z.infer<typeof Search>['results'][number];
type Placed = TmdbSeason['episodes'][number] & { season: number };

export interface Resolved extends Derived { candidates: { tv: number; movie: number } }

// Aliases listed in the wiki infobox: |别名={ [Frieren] [Sousou no Frieren] }
export function aliases(infobox: string): string[] {
  const block = /\|别名=\{([\s\S]*?)\n\}/.exec(infobox)?.[1] ?? '';
  return [...block.matchAll(/\[([^\]\n]+)\]/g)].map(m => m[1]!.trim()).filter(Boolean);
}
// TMDB lists a series once with numbered seasons, so a season or part suffix in the Bangumi title only
// hides the show; the dates pick the season afterwards.
const SUFFIX = /(?:\s*[（(]?(?:第\s*[0-9０-９一二三四五六七八九十]+\s*(?:季|期|章|部|篇|クール|シーズン)|(?:season|series|part|cour|chapter)\s*[0-9ⅠⅡⅢⅣⅤⅰⅱⅲ]+|[0-9]+(?:st|nd|rd|th)(?:\s+(?:season|series))?|(?:シーズン|パート)\s*[0-9０-９]+|最终季|最終章|完结篇|(?:the\s+)?final\s+season|(?:the\s+)?animation|oad|ova)[）)]?)+\s*$/iu;
export function stripSuffix(title: string): string {
  const stripped = title.replace(SUFFIX, '').replace(/[\s:：\-–—・/／]+$/u, '').trim();
  return stripped && stripped !== title.trim() ? stripped : '';
}
export function queries(subject: Subject): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  const raw = [subject.name, subject.name_cn, ...aliases(subject.infobox)];
  for (const candidate of [...raw, ...raw.map(stripSuffix)]) {
    const q = candidate.trim(); const key = normalize(q);
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(q);
    if (out.length === MAX_QUERIES) break;
  }
  return out;
}
const dayOf = (date: string | null | undefined): number | null => { const at = Date.parse(date ?? ''); return Number.isFinite(at) ? at / DAY : null; };
interface Match { tmdbId: number; name: string; agreement: DateAgreement; episodes: Placed[]; compared: number; how: 'run' | 'dates' }

// Every same-length run of consecutive episodes whose dates agree with the subject's. Specials (season 0)
// form their own sequence so a run never crosses into or out of them.
function runs(tmdbId: number, name: string, seasons: TmdbSeason[], regular: Episode[]): Match[] {
  const found: Match[] = [];
  const first = regular.findIndex(e => dayOf(e.airdate) !== null);
  for (const flat of sequences(seasons)) {
    for (let k = 0; k + regular.length <= flat.length; k++) {
      const run = flat.slice(k, k + regular.length);
      // Cheap pre-check on the first dated pair keeps the full comparison for plausible offsets only.
      if (first >= 0) { const d = dayOf(run[first]!.air_date); if (d === null || Math.abs(d - dayOf(regular[first]!.airdate)!) > 7) continue; }
      const check = datesAgree(regular.map((bangumi, i) => ({ bangumi, tmdb: run[i]! })));
      if (check.agreement) found.push({ tmdbId, name, agreement: check.agreement, episodes: run, compared: check.compared, how: 'run' });
    }
  }
  return found;
}
// When TMDB carries extra episodes (a recap, a numbered special), the dates alone can still place every
// Bangumi episode: each dated one must match exactly one TMDB episode, in order, and undated ones must
// sit between dated neighbours with exactly as many TMDB episodes in between.
function byDates(tmdbId: number, name: string, seasons: TmdbSeason[], regular: Episode[]): Match[] {
  const found: Match[] = [];
  for (const flat of sequences(seasons)) {
    const picked: (number | null)[] = regular.map(e => {
      const day = dayOf(e.airdate); if (day === null) return null;
      const hits = flat.flatMap((t, i) => { const d = dayOf(t.air_date); return d !== null && Math.abs(d - day) <= MAX_DATE_DRIFT_DAYS ? [i] : []; });
      return hits.length === 1 ? hits[0]! : -1;
    });
    if (picked.some(p => p === -1)) continue;
    const anchors = picked.flatMap((p, i) => p === null ? [] : [[i, p] as const]);
    if (anchors.length < 2) continue;
    const place: number[] = [];
    const [firstIndex, firstPlace] = anchors[0]!;
    if (firstPlace < firstIndex) continue;
    for (let i = 0; i < firstIndex; i++) place[i] = firstPlace - firstIndex + i;
    let ok = true;
    for (let n = 0; n < anchors.length && ok; n++) {
      const [i, p] = anchors[n]!; place[i] = p;
      if (n === 0) continue;
      const [prevIndex, prevPlace] = anchors[n - 1]!;
      const between = i - prevIndex - 1;
      // Extra TMDB episodes may only sit between two dated neighbours; undated Bangumi episodes fill an exact gap.
      if (p <= prevPlace || (between > 0 && p - prevPlace !== i - prevIndex)) { ok = false; break; }
      for (let m = 1; m <= between; m++) place[prevIndex + m] = prevPlace + m;
    }
    const [lastIndex, lastPlace] = anchors[anchors.length - 1]!;
    const tail = regular.length - 1 - lastIndex;
    if (!ok || lastPlace + tail >= flat.length) continue;
    for (let m = 1; m <= tail; m++) place[lastIndex + m] = lastPlace + m;
    const episodes = place.map(p => flat[p]!);
    const check = datesAgree(regular.map((bangumi, i) => ({ bangumi, tmdb: episodes[i]! })));
    if (check.agreement === 'exact') found.push({ tmdbId, name, agreement: 'exact', episodes, compared: check.compared, how: 'dates' });
  }
  return found;
}
function sequences(seasons: TmdbSeason[]): Placed[][] {
  const place = (list: TmdbSeason[]) => list.sort((a, b) => a.season_number - b.season_number)
    .flatMap(s => [...s.episodes].sort((a, b) => a.episode_number - b.episode_number).map(e => ({ ...e, season: s.season_number })));
  const regular = place(seasons.filter(s => s.season_number > 0)), specials = place(seasons.filter(s => s.season_number === 0));
  return [regular, specials].filter(s => s.length);
}
// Contiguous runs of matched episodes become subject targets: a whole regular season when the run covers
// it, otherwise an explicit range. Specials are always declared as ranges.
function targetsFor(match: Match, seasons: Map<number, TmdbSeason>): SubjectTarget[] {
  const targets: SubjectTarget[] = [];
  let i = 0;
  while (i < match.episodes.length) {
    let j = i;
    while (j + 1 < match.episodes.length && match.episodes[j + 1]!.season === match.episodes[i]!.season
      && match.episodes[j + 1]!.episode_number === match.episodes[j]!.episode_number + 1) j++;
    const season = match.episodes[i]!.season, start = match.episodes[i]!.episode_number, end = match.episodes[j]!.episode_number;
    const whole = season > 0 && seasons.get(season)!.episodes.length === j - i + 1;
    targets.push(whole ? { type: 'tv', id: match.tmdbId, season } : { type: 'tv', id: match.tmdbId, season, episode: start, ...(end > start ? { episodeEnd: end } : {}) });
    i = j + 1;
  }
  return targets;
}
const label = (t: DateAgreement) => t === 'exact' ? '全部在 ±1 天内' : t === 'mostly' ? '绝大多数在 ±1 天内、其余不超过 7 天' : '逐集间隔一致、整体平移小于一集间隔';
const describe = (t: SubjectTarget) => t.type === 'movie' ? `movie/${t.id}` : `第 ${t.season} 季${t.episode !== undefined ? `第 ${t.episode}–${t.episodeEnd ?? t.episode} 集` : '整季'}`;

// `trace` collects why a subject was left alone, for diagnostics.
export async function resolve(subject: Subject, episodes: Episode[], tmdb: Tmdb, base?: Partial<Mapping>, trace?: string[]): Promise<Resolved | null> {
  const why = (reason: string) => { trace?.push(reason); return null; };
  const regular = episodes.filter(e => e.type === 0).sort((a, b) => a.sort - b.sort);
  if (!regular.length || !regular.every(e => Number.isInteger(e.sort)) || regular.some((e, i) => i > 0 && e.sort !== regular[i - 1]!.sort + 1)) return why(regular.length ? 'irregular sorts' : 'no regular episodes');
  // A lone episode (a film, an OVA, a special) usually carries no date of its own; the subject's premiere is its air date.
  const dated = regular.filter(e => dayOf(e.airdate) !== null);
  const compare = regular.length === 1 && !dated.length && dayOf(subject.date) !== null ? [{ ...regular[0]!, airdate: subject.date }] : regular;
  const known = compare.filter(e => dayOf(e.airdate) !== null);
  const verified = compare === regular ? episodes : episodes.map(e => e.id === regular[0]!.id ? { ...e, airdate: subject.date } : e);
  if (known.length < Math.max(1, Math.ceil(regular.length * 0.6))) return why(`too few dated episodes (${known.length}/${regular.length})`);
  const terms = queries(subject);
  if (!terms.length) return why('no title');
  const tv = new Map<number, Hit>(), movies = new Map<number, Hit>();
  for (const q of terms) {
    for (const [type, into] of [['tv', tv], ['movie', movies]] as const) {
      const hits = Search.parse(await tmdb.get(`/search/${type}`, { query: q, include_adult: 'true' })).results.slice(0, RESULTS_PER_QUERY);
      for (const hit of hits) if (!into.has(hit.id)) into.set(hit.id, hit);
    }
  }
  const candidates = { tv: tv.size, movie: movies.size };
  const first = dayOf(known[0]!.airdate)!, last = dayOf(known[known.length - 1]!.airdate)!;
  const skeleton = { schemaVersion: 1 as const, bangumiId: subject.id, locked: false, episodes: [], rules: [], overrides: [], ...base };
  const provenance = (note: string, work: string) => ({ method: 'deterministic' as const, source: `https://bgm.tv/subject/${subject.id}; https://www.themoviedb.org/${work}`, evidence: note, verifiedAt: null });
  const searched = `以「${terms.join('」「')}」搜索得到 ${candidates.tv} 个 TV、${candidates.movie} 个电影候选`;
  // TV: fetch the seasons that could overlap the subject's airing window, then look for agreeing episodes.
  const passing: { match: Match; seasons: Map<number, TmdbSeason> }[] = [];
  for (const hit of [...tv.values()].slice(0, MAX_SHOWS)) {
    const work = await tmdb.work({ type: 'tv', id: hit.id });
    const relevant = (work.seasons ?? []).filter(s => s.episode_count > 0).filter(s => {
      const at = dayOf(s.air_date); return at === null || (at <= last + SEASON_WINDOW_DAYS && at + s.episode_count * 7 >= first - SEASON_WINDOW_DAYS);
    }).slice(0, MAX_SEASONS_PER_SHOW);
    if (!relevant.length) continue;
    const seasons = new Map<number, TmdbSeason>();
    for (const s of relevant) seasons.set(s.season_number, await tmdb.season(hit.id, s.season_number));
    const name = hit.name ?? hit.original_name ?? '';
    const matches = runs(hit.id, name, [...seasons.values()], compare);
    if (!matches.length) matches.push(...byDates(hit.id, name, [...seasons.values()], compare));
    // Two agreeing placements inside one show (or in two shows) cannot be told apart by dates.
    if (matches.length > 1) return why(`ambiguous runs in tv/${hit.id}`);
    if (matches.length === 1) passing.push({ match: matches[0]!, seasons });
  }
  if (passing.length > 1) return why(`ambiguous shows ${passing.map(p => p.match.tmdbId).join(',')}`);
  if (passing.length === 1) {
    const { match, seasons } = passing[0]!;
    const targets = targetsFor(match, seasons);
    const note = `脚本按放送日期识别作品：${searched}；tv/${match.tmdbId}「${match.name}」${targets.map(describe).join('、')}与 ${regular.length} 个本篇章节逐一对应`
      + `${match.how === 'dates' ? '（TMDB 该范围之外的集没有对应章节，按日期逐话定位）' : ''}，${match.compared} 对日期${label(match.agreement)}；其他候选没有吻合的集序列。`;
    const derived = await derive(Mapping.parse({ ...skeleton, targets, provenance: provenance(note, `tv/${match.tmdbId}`) }), verified, tmdb);
    return derived ? { ...derived, candidates } : why(`derive refused tv/${match.tmdbId}`);
  }
  // Movies: one regular episode and a release date next to Bangumi's premiere; a title match buys a month of slack.
  if (regular.length !== 1) return why(tv.size ? `no agreeing run in ${Math.min(tv.size, MAX_SHOWS)} shows` : 'no tv candidates');
  const names = new Set(terms.map(normalize));
  const titled = (m: Hit) => [m.title, m.original_title].some(t => t && names.has(normalize(t)));
  const near = (m: Hit, days: number) => { const at = dayOf(m.release_date); return at !== null && Math.abs(at - first) <= days; };
  const close = [...movies.values()].filter(m => near(m, MOVIE_DATE_SLACK_DAYS));
  const matches = close.length ? close : [...movies.values()].filter(m => titled(m) && near(m, MOVIE_TITLE_SLACK_DAYS));
  if (matches.length !== 1) return why(matches.length ? 'several matching movies' : movies.size ? `no movie matched among ${movies.size}` : 'no movie candidates');
  const movie = matches[0]!;
  const note = `脚本按上映日期识别电影：${searched}；movie/${movie.id}「${movie.original_title ?? movie.title}」上映日期 ${movie.release_date} 与 Bangumi 放送日期`
    + `${close.length ? `相差不超过 ${MOVIE_DATE_SLACK_DAYS} 天` : `相差不超过 ${MOVIE_TITLE_SLACK_DAYS} 天且标题一致`}，且是唯一吻合的候选。`;
  const derived = await derive(Mapping.parse({ ...skeleton, targets: [{ type: 'movie', id: movie.id }], provenance: provenance(note, `movie/${movie.id}`) }), verified, tmdb);
  return derived ? { ...derived, candidates } : why(`derive refused movie/${movie.id}`);
}
