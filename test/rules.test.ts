import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datesAgree, derive, extend, type SeasonSource } from '../src/rules.js';
import { expand } from '../src/expand.js';
import { episode, mapping } from './helpers.js';

const now = Date.parse('2026-01-20T00:00:00Z');
// Build a fake TMDB whose season episodes air on the fixture's "2026-01-<sort>" schedule with an optional shift.
function tmdb(seasons: Record<string, { numbers: number[]; shiftDays?: number; undated?: number[]; firstDay?: number }>): SeasonSource {
  return { async season(tv, season) {
    const spec = seasons[`${tv}/${season}`];
    if (!spec) throw new Error(`HTTP 404: /tv/${tv}/season/${season}`);
    return { id: tv * 100 + season, season_number: season, episodes: spec.numbers.map((n, i) => ({
      id: tv * 10000 + season * 100 + n, episode_number: n, season_number: season, name: `E${n}`,
      air_date: spec.undated?.includes(n) ? null : new Date(Date.parse('2026-01-01') + ((spec.firstDay ?? 0) + i + (spec.shiftDays ?? 0)) * 86400000).toISOString().slice(0, 10),
    })) };
  } };
}
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
  assert.deepEqual(datesAgree([]), { compared: 0, ok: false });
});
