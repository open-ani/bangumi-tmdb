import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datesAgree, derive, extend, listedEpisodes, type SeasonSource } from '../src/rules.js';
import { expand } from '../src/expand.js';
import { episode, mapping } from './helpers.js';

const now = Date.parse('2026-01-20T00:00:00Z');
const day = (offset: number): string => new Date(Date.parse('2026-01-01') + offset * 86400000).toISOString().slice(0, 10);
// Build a fake TMDB whose season episodes air on the fixture's "2026-01-<sort>" schedule with an optional shift,
// or on explicit day offsets from 2026-01-01.
function tmdb(seasons: Record<string, { numbers: number[]; shiftDays?: number; undated?: number[]; firstDay?: number; days?: number[] }>): SeasonSource {
  return { async season(tv, season) {
    const spec = seasons[`${tv}/${season}`];
    if (!spec) throw new Error(`HTTP 404: /tv/${tv}/season/${season}`);
    return { id: tv * 100 + season, season_number: season, episodes: spec.numbers.map((n, i) => ({
      id: tv * 10000 + season * 100 + n, episode_number: n, season_number: season, name: `E${n}`,
      air_date: spec.undated?.includes(n) ? null : day(spec.days?.[i] ?? (spec.firstDay ?? 0) + i + (spec.shiftDays ?? 0)),
    })) };
  } };
}
// Bangumi regular episodes 1..n airing on the given day offsets; null leaves the air date blank.
const aired = (days: (number | null)[]) => days.map((offset, i) => ({ ...episode(11 + i, i + 1), airdate: offset === null ? '' : day(offset) }));
const weekly = (n: number): number[] => Array.from({ length: n }, (_, i) => i * 7);
const numbers = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => from + i);
const researched = { method: 'codex' as const, source: 'test', evidence: 'Synthetic test fixture', verifiedAt: '2026-01-01T00:00:00.000Z' };
test('an airing season maps the prefix TMDB has listed and leaves the rest for extend', async () => {
  const whole = mapping({ episodes: [], rules: [], targets: [{ type: 'tv', id: 100, season: 1 }], provenance: researched });
  const episodes = aired(weekly(12));
  const derived = await derive(whole, episodes, tmdb({ '100/1': { numbers: [1, 2, 3], days: [0, 7, 14] } }), now);
  assert.ok(derived);
  assert.deepEqual(derived.mapping.rules, [{ bangumiType: 0, start: 1, end: 3, tmdbId: 100, season: 1, episodeStart: 1 }]);
  assert.equal(derived.uncovered, 9);
  assert.match(derived.note, /放送中.*目前 3 集.*其余 9 话/);
  assert.equal(await derive(whole, episodes, tmdb({ '100/1': { numbers: [1, 2, 3], days: [0, 7, 19] } }), now), null, 'every listed episode must agree to the day');
  assert.equal(await derive(whole, episodes, tmdb({ '100/1': { numbers: [1, 2, 3], undated: [3] } }), now), null, 'an undated listed episode is not evidence');
  assert.equal(await derive(whole, episodes, tmdb({ '100/1': { numbers: [1, 2, 3], days: [0, 7, 14] } }), Date.parse('2026-06-01')), null, 'a finished season with a short table is for the model');
  assert.equal(await derive(mapping({ ...whole, targets: [{ type: 'tv', id: 100, season: 1, episode: 1, episodeEnd: 12 }] }), episodes, tmdb({ '100/1': { numbers: [1, 2, 3], days: [0, 7, 14] } }), now), null, 'a declared range needs the whole range');
  assert.equal(await derive(whole, aired(weekly(2)), tmdb({ '100/1': { numbers: [1, 2, 3], days: [0, 7, 14] } }), now), null, 'TMDB listing more than Bangumi is not a prefix');
  assert.equal(await derive(whole, episodes, tmdb({ '100/1': { numbers: [] } }), now), null);
  assert.equal(await listedEpisodes(whole, tmdb({ '100/1': { numbers: [] } })), 0, 'nothing listed yet: worth another look in two days');
  assert.equal(await listedEpisodes(mapping({ ...whole, targets: [{ type: 'tv', id: 100 }] }), tmdb({ '100/1': { numbers: [] } })), null, 'a bare TV target has no season to check');
});

test('a whole-season subject mapping becomes one rule when counts and dates line up', async () => {
  const row = mapping({ episodes: [], rules: [], targets: [{ type: 'tv', id: 100, season: 2 }] });
  const episodes = [episode(11, 1), episode(12, 2), episode(13, 3), episode(14, 1, 1)];
  const derived = await derive(row, episodes, tmdb({ '100/2': { numbers: [1, 2, 3] } }));
  assert.ok(derived);
  assert.deepEqual(derived.mapping.rules, [{ bangumiType: 0, start: 1, end: 3, tmdbId: 100, season: 2, episodeStart: 1 }]);
  assert.equal(derived.mapping.episodes.length, 4);
  assert.deepEqual(expand(derived.mapping).map(e => e.targets[0]), [
    { type: 'tv', id: 100, season: 2, episode: 1 }, { type: 'tv', id: 100, season: 2, episode: 2 }, { type: 'tv', id: 100, season: 2, episode: 3 }]);
  assert.equal(await derive(row, episodes, tmdb({ '100/2': { numbers: [1, 2, 3, 4] } })), null, 'count mismatch');
  assert.equal(await derive(row, episodes, tmdb({ '100/2': { numbers: [1, 2, 3], shiftDays: 7 } })), null, 'dates disagree');
  assert.equal(await derive(row, episodes, tmdb({ '100/2': { numbers: [1, 2, 3], undated: [1, 2, 3] } })), null, 'no comparable dates');
  assert.ok(await derive(row, episodes, tmdb({ '100/2': { numbers: [1, 2, 3], shiftDays: 1 } })), 'one day drift is tolerated');
  assert.equal(await derive(mapping({ episodes: [], rules: [], targets: [{ type: 'tv', id: 100 }] }), episodes, tmdb({ '100/2': { numbers: [1, 2, 3] } })), null, 'bare TV');
  assert.equal(await derive({ ...row, locked: true }, episodes, tmdb({ '100/2': { numbers: [1, 2, 3] } })), null, 'locked');
  assert.equal(await derive(row, [episode(11, 1), episode(12, 2.5), episode(13, 3)], tmdb({ '100/2': { numbers: [1, 2, 3] } })), null, 'fractional sort');
});
test('explicit ranges across seasons produce one rule per contiguous TMDB run', async () => {
  const row = mapping({ episodes: [], rules: [], targets: [
    { type: 'tv', id: 100, season: 1, episode: 12, episodeEnd: 13 }, { type: 'tv', id: 100, season: 2, episode: 1, episodeEnd: 2 }] });
  const episodes = [episode(11, 1), episode(12, 2), episode(13, 3), episode(14, 4)];
  const derived = await derive(row, episodes, tmdb({ '100/1': { numbers: [11, 12, 13], firstDay: -1 }, '100/2': { numbers: [1, 2], firstDay: 2 } }));
  assert.ok(derived);
  assert.deepEqual(derived.mapping.rules, [
    { bangumiType: 0, start: 1, end: 2, tmdbId: 100, season: 1, episodeStart: 12 },
    { bangumiType: 0, start: 3, end: 4, tmdbId: 100, season: 2, episodeStart: 1 }]);
  assert.equal(await derive(row, episodes, tmdb({ '100/1': { numbers: [11, 13], firstDay: -1 }, '100/2': { numbers: [1, 2], firstDay: 2 } })), null, 'hole in TMDB range');
});
test('a few slipped dates or a constant small offset pass only while both sites keep airing order', async () => {
  const row = mapping({ episodes: [], rules: [], targets: [{ type: 'tv', id: 100, season: 1 }] });
  const ten = weekly(10);
  const slipped = await derive(row, aired(ten), tmdb({ '100/1': { numbers: numbers(10), days: ten.map((d, i) => i === 4 ? d + 5 : i === 7 ? d - 3 : d) } }));
  assert.match(slipped?.note ?? '', /10 对日期中 8 对在 ±1 天内，其余相差不超过 7 天/);
  assert.deepEqual(slipped?.mapping.rules, [{ bangumiType: 0, start: 1, end: 10, tmdbId: 100, season: 1, episodeStart: 1 }]);
  assert.equal(await derive(row, aired(ten), tmdb({ '100/1': { numbers: numbers(10), days: ten.map((d, i) => i === 4 ? d + 7 : i === 5 ? d - 7 : d) } })), null, 'two TMDB episodes listed in the other order');
  assert.equal(await derive(row, aired(ten), tmdb({ '100/1': { numbers: numbers(10), days: ten.map((d, i) => i === 9 ? d + 8 : d) } })), null, 'more than a week apart');
  assert.equal(await derive(row, aired(ten), tmdb({ '100/1': { numbers: numbers(10), days: ten.map((d, i) => i % 3 === 0 ? d + 4 : d) } })), null, 'too many slipped dates without a common cadence');
  const shifted = await derive(row, aired(ten), tmdb({ '100/1': { numbers: numbers(10), days: ten.map(d => d + 3) } }));
  assert.match(shifted?.note ?? '', /逐集间隔一致，10 对日期整体相差不超过 3 天/);
  assert.equal(await derive(row, aired(ten), tmdb({ '100/1': { numbers: numbers(10), days: ten.map(d => d + 7) } })), null, 'a whole episode interval may be an off-by-one alignment');
  assert.deepEqual(datesAgree([]), { compared: 0, exact: 0, ok: false, agreement: null, shiftDays: 0 });
});
test('position alone is accepted only for one model-declared season or episode range without comparable dates', async () => {
  const undated = aired([null, null, null]);
  const season = tmdb({ '100/1': { numbers: numbers(24) }, '100/0': { numbers: [1] }, '100/3': { numbers: [1] } });
  const range = mapping({ episodes: [], rules: [], provenance: researched, targets: [{ type: 'tv', id: 100, season: 1, episode: 13, episodeEnd: 15 }] });
  const derived = await derive(range, undated, season);
  assert.deepEqual(derived?.mapping.rules, [{ bangumiType: 0, start: 1, end: 3, tmdbId: 100, season: 1, episodeStart: 13 }]);
  assert.match(derived?.note ?? '', /未做日期核验/);
  assert.equal(await derive({ ...range, provenance: { ...researched, method: 'seed' } }, undated, season), null, 'unverified seed identity');
  assert.equal(await derive(range, aired([40, null, null]), season), null, 'the one comparable date disagrees');
  const split = mapping({ episodes: [], rules: [], provenance: researched, targets: [
    { type: 'tv', id: 100, season: 1, episode: 13, episodeEnd: 14 }, { type: 'tv', id: 100, season: 0, episode: 1 }] });
  assert.equal(await derive(split, undated, season), null, 'several targets can be ordered differently on Bangumi');
  const whole = mapping({ episodes: [], rules: [], provenance: researched, targets: [{ type: 'tv', id: 100, season: 3 }] });
  assert.ok(await derive(whole, aired([null]), season), 'a single episode has no order to get wrong');
  const season1 = await derive({ ...whole, targets: [{ type: 'tv', id: 100, season: 1 }] }, aired(Array(24).fill(null)), season);
  assert.deepEqual(season1?.mapping.rules, [{ bangumiType: 0, start: 1, end: 24, tmdbId: 100, season: 1, episodeStart: 1 }], 'a model-declared whole season with equal counts');
  assert.match(season1?.note ?? '', /单一 TMDB 整季/);
  assert.equal(await derive({ ...whole, targets: [{ type: 'tv', id: 100, season: 1 }] }, aired(Array(23).fill(null)), season), null, 'counts must still agree');
});
test('single-episode movie subjects map their episode to the movie; multi-part ones do not', async () => {
  const row = mapping({ episodes: [], rules: [], targets: [{ type: 'movie', id: 7 }] });
  const derived = await derive(row, [episode(11, 1)], tmdb({}));
  assert.deepEqual(derived?.mapping.overrides, [{ bangumiEpisodeId: 11, targets: [{ type: 'movie', id: 7 }] }]);
  assert.equal(await derive(row, [episode(11, 1), episode(12, 2)], tmdb({})), null);
});
test('rules extend only onto TMDB episodes that exist with agreeing dates; mapped episodes cannot vanish', async () => {
  const row = mapping({ targets: [{ type: 'tv', id: 100, season: 1 }] });
  const episodes = [episode(11, 1), episode(12, 2), episode(13, 3), episode(14, 4), episode(15, 1, 1)];
  const grown = await extend(row, episodes, tmdb({ '100/1': { numbers: [1, 2, 3] } }), now);
  assert.equal(grown.added, 1);
  assert.equal(grown.mapping.rules[0]!.end, 3);
  assert.equal(grown.mapping.episodes.length, 5);
  assert.equal(grown.uncovered, 1, 'episode 4 aired but TMDB lacks it');
  const stalled = await extend(row, episodes, tmdb({ '100/1': { numbers: [1, 2, 3, 4], shiftDays: 5 } }), now);
  assert.equal(stalled.added, 0);
  const future = await extend(row, [episode(11, 1), episode(12, 2), { ...episode(13, 3), airdate: '2026-03-01' }], tmdb({ '100/1': { numbers: [1, 2] } }), now);
  assert.equal(future.uncovered, 0, 'unaired episodes are not overdue');
  await assert.rejects(extend(row, [episode(11, 1)], tmdb({ '100/1': { numbers: [1, 2] } }), now), /disappeared/);
  await assert.rejects(extend(row, [episode(11, 1), episode(12, 5)], tmdb({ '100/1': { numbers: [1, 2] } }), now), /renumbered/);
});
