import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliases, queries, resolve, stripSuffix } from '../src/resolve.js';
import type { Tmdb } from '../src/tmdb.js';
import type { Subject } from '../src/model.js';
import { episode } from './helpers.js';

const day = (offset: number): string => new Date(Date.parse('2026-01-01') + offset * 86400000).toISOString().slice(0, 10);
const weekly = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + i * 7);
const aired = (days: (number | null)[]) => days.map((offset, i) => ({ ...episode(11 + i, i + 1), airdate: offset === null ? '' : day(offset) }));
const subject = (patch: Partial<Subject> = {}): Subject => ({ id: 1, type: 2, name: 'テスト 第2期', name_cn: '测试 第二季', date: day(0), infobox: '|别名={\n[Test S2]\n}', summary: '', ...patch });
interface Show { name: string; seasons: Record<number, (number | null)[]> }
interface Film { title: string; release: string }
// A fake TMDB: search hits are keyed by normalized query, seasons list episode air-day offsets.
function fake(spec: { search: Record<string, { tv?: number[]; movie?: number[] }>; shows?: Record<number, Show>; movies?: Record<number, Film> }): Tmdb {
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
  const shows = spec.shows ?? {}, films = spec.movies ?? {};
  return {
    async get(path: string, params: Record<string, string> = {}) {
      const kind = path.split('/')[2]!;
      const hits = spec.search[norm(params.query ?? '')]?.[kind as 'tv' | 'movie'] ?? [];
      return { results: hits.map(id => kind === 'tv' ? { id, name: shows[id]!.name } : { id, title: films[id]!.title, release_date: films[id]!.release }) };
    },
    async work(target: { type: 'tv' | 'movie'; id: number }) {
      if (target.type === 'movie') return { id: target.id, title: films[target.id]!.title, release_date: films[target.id]!.release };
      const show = shows[target.id]!;
      return { id: target.id, name: show.name, seasons: Object.entries(show.seasons).map(([n, days]) => ({ season_number: Number(n), name: `S${n}`, air_date: days[0] === null ? null : day(days[0]!), episode_count: days.length })) };
    },
    async season(tv: number, season: number) {
      const days = shows[tv]?.seasons[season];
      if (!days) throw new Error(`HTTP 404: /tv/${tv}/season/${season}`);
      return { id: tv * 100 + season, season_number: season, episodes: days.map((d, i) => ({ id: tv * 10000 + season * 100 + i + 1, episode_number: i + 1, season_number: season, name: `E${i + 1}`, air_date: d === null ? null : day(d) })) };
    },
  } as unknown as Tmdb;
}

test('search terms come from the title, its translation, infobox aliases and season-suffix-free variants', () => {
  assert.deepEqual(aliases('|别名={\n[Frieren: Beyond Journey\'s End ]\n[Sousou no Frieren]\n}\n|话数= 28'), ['Frieren: Beyond Journey\'s End', 'Sousou no Frieren']);
  assert.deepEqual(queries(subject()), ['テスト 第2期', '测试 第二季', 'Test S2', 'テスト', '测试']);
  for (const [title, base] of [['緋色の欠片 第二章', '緋色の欠片'], ['BanG Dream! 3rd Season', 'BanG Dream!'], ['Family Guy (Season 10)', 'Family Guy'],
    ['ソードガイ The Animation PartⅡ', 'ソードガイ'], ['青の祓魔師 OAD', '青の祓魔師'], ['师兄啊师兄 最终季', '师兄啊师兄'], ['葬送のフリーレン', '']]) assert.equal(stripSuffix(title!), base);
});
test('a show is accepted only when one run of its episodes agrees with the subject by date', async () => {
  const tmdb = fake({ search: { 'テスト': { tv: [100, 200] } }, shows: {
    100: { name: 'Test', seasons: { 1: weekly(12, -400), 2: weekly(12) } },
    200: { name: 'Other', seasons: { 1: weekly(12, 30) } } } });
  const trace: string[] = [];
  const found = await resolve(subject(), aired(weekly(12)), tmdb, undefined, trace);
  assert.deepEqual(found?.mapping.targets, [{ type: 'tv', id: 100, season: 2 }], trace.join());
  assert.deepEqual(found?.mapping.rules, [{ bangumiType: 0, start: 1, end: 12, tmdbId: 100, season: 2, episodeStart: 1 }]);
  assert.equal(found?.mapping.provenance.method, 'deterministic');
  assert.match(found?.mapping.provenance.evidence ?? '', /tv\/100「Test」第 2 季整季与 12 个本篇章节逐一对应/);
  // A second cour is an explicit range inside the season that holds it.
  const cour = await resolve(subject(), aired(weekly(12, 84)), fake({ search: { 'テスト': { tv: [100] } }, shows: { 100: { name: 'Test', seasons: { 1: weekly(24) } } } }));
  assert.deepEqual(cour?.mapping.targets, [{ type: 'tv', id: 100, season: 1, episode: 13, episodeEnd: 24 }]);
  // Two shows that both agree, or no show that agrees, leave the subject alone.
  const twins: string[] = [];
  assert.equal(await resolve(subject(), aired(weekly(12)), fake({ search: { 'テスト': { tv: [100, 300] } }, shows: {
    100: { name: 'Test', seasons: { 1: weekly(12) } }, 300: { name: 'Twin', seasons: { 1: weekly(12) } } } }), undefined, twins), null);
  assert.match(twins.join(), /ambiguous shows 100,300/);
  assert.equal(await resolve(subject(), aired(weekly(12)), fake({ search: { 'テスト': { tv: [200] } }, shows: { 200: { name: 'Other', seasons: { 1: weekly(12, 30) } } } })), null);
  assert.equal(await resolve(subject(), aired(Array(12).fill(null)), tmdb), null, 'no dates, no verdict');
});
test('extra TMDB episodes between dated neighbours are skipped; specials stay in their own sequence', async () => {
  // TMDB lists a recap as episode 7, so 12 Bangumi episodes map onto E1-6 and E8-13.
  const days = [...weekly(6), 45, ...weekly(6, 49)];
  const tmdb = fake({ search: { 'テスト': { tv: [100] } }, shows: { 100: { name: 'Test', seasons: { 1: days } } } });
  const found = await resolve(subject(), aired([...weekly(6), ...weekly(6, 49)]), tmdb);
  assert.deepEqual(found?.mapping.targets, [{ type: 'tv', id: 100, season: 1, episode: 1, episodeEnd: 6 }, { type: 'tv', id: 100, season: 1, episode: 8, episodeEnd: 13 }]);
  assert.deepEqual(found?.mapping.rules.map(r => [r.start, r.end, r.episodeStart]), [[1, 6, 1], [7, 12, 8]]);
  assert.match(found?.mapping.provenance.evidence ?? '', /按日期逐话定位/);
  // An OVA whose episodes are the show's specials 3-5 becomes an explicit season-0 range.
  const ova = await resolve(subject(), aired([0, 60, 120]), fake({ search: { 'テスト': { tv: [100] } }, shows: { 100: { name: 'Test', seasons: { 0: [-300, -200, 0, 60, 120], 1: weekly(12, -400) } } } }));
  assert.deepEqual(ova?.mapping.targets, [{ type: 'tv', id: 100, season: 0, episode: 3, episodeEnd: 5 }]);
});
test('a lone episode is a film when exactly one searched movie was released alongside it', async () => {
  const tmdb = fake({ search: { '映画テスト': { movie: [7, 8] } }, movies: { 7: { title: '映画テスト', release: day(1) }, 8: { title: '映画テスト2', release: day(400) } } });
  const film = await resolve(subject({ name: '映画テスト', name_cn: '', infobox: '' }), aired([null]), tmdb);
  assert.deepEqual(film?.mapping.targets, [{ type: 'movie', id: 7 }]);
  assert.deepEqual(film?.mapping.overrides, [{ bangumiEpisodeId: 11, targets: [{ type: 'movie', id: 7 }] }]);
  assert.equal(await resolve(subject({ name: '映画テスト', name_cn: '', infobox: '' }), aired([null]), fake({ search: { '映画テスト': { movie: [7, 9] } },
    movies: { 7: { title: '映画テスト', release: day(1) }, 9: { title: '映画テスト 総集編', release: day(2) } } })), null, 'two films released together are ambiguous');
  const titled = await resolve(subject({ name: '映画テスト', name_cn: '', infobox: '' }), aired([null]), fake({ search: { '映画テスト': { movie: [7] } }, movies: { 7: { title: '映画テスト', release: day(20) } } }));
  assert.deepEqual(titled?.mapping.targets, [{ type: 'movie', id: 7 }], 'a title match tolerates a few weeks');
  assert.equal(await resolve(subject({ name: '映画テスト', name_cn: '', infobox: '' }), aired([null]), fake({ search: { '映画テスト': { movie: [8] } }, movies: { 8: { title: '別の映画', release: day(20) } } })), null);
});
