import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expand, validateAll } from '../src/expand.js';
import { mapping } from './helpers.js';

test('missing episodes do not shift later numbers; specials stay outside regular ranges', () => {
  const row = mapping({ episodes: [{ id: 11, type: 0, sort: 1 }, { id: 13, type: 0, sort: 3 }, { id: 14, type: 1, sort: 1 }],
    rules: [{ bangumiType: 0, start: 1, end: 3, tmdbId: 100, season: 2, episodeStart: 13 }] });
  assert.deepEqual(expand(row).map(e => e.targets[0]), [
    { type: 'tv', id: 100, season: 2, episode: 13 }, { type: 'tv', id: 100, season: 2, episode: 15 },
  ]);
});
test('explicit overrides handle fractional episodes, season zero, exclusion and split episodes', () => {
  const row = mapping({ episodes: [{ id: 11, type: 0, sort: 1 }, { id: 12, type: 0, sort: 1.5 }, { id: 13, type: 0, sort: 2 }],
    overrides: [{ bangumiEpisodeId: 11, targets: [] }, { bangumiEpisodeId: 12, targets: [{ type: 'tv', id: 100, season: 0, episode: 1 }] },
      { bangumiEpisodeId: 13, targets: [{ type: 'tv', id: 100, season: 2, episode: 1 }, { type: 'tv', id: 100, season: 2, episode: 2 }] }] });
  const expanded = expand(row);
  assert.deepEqual(expanded.map(e => e.bangumiEpisodeId), [12, 13]);
  assert.equal(expanded[1]!.targets.length, 2);
  assert.throws(() => expand({ ...row, overrides: [] }), /Fractional/);
});
test('cross-season and cross-work ranges are supported', () => {
  const row = mapping({ targets: [{ type: 'tv', id: 100 }, { type: 'tv', id: 200 }], rules: [
    { bangumiType: 0, start: 1, end: 1, tmdbId: 100, season: 1, episodeStart: 12 },
    { bangumiType: 0, start: 2, end: 2, tmdbId: 200, season: 2, episodeStart: 1 },
  ] });
  assert.equal(expand(row)[1]!.targets[0]!.id, 200);
});
test('overlaps, unowned overrides and duplicate TV destinations are rejected', () => {
  const row = mapping();
  assert.throws(() => expand({ ...row, rules: [...row.rules, ...row.rules] }), /Overlapping/);
  assert.throws(() => expand({ ...row, overrides: [{ bangumiEpisodeId: 999, targets: [] }] }), /belong/);
  assert.throws(() => expand({ ...row, overrides: [{ bangumiEpisodeId: 12, targets: [{ type: 'tv', id: 100, season: 1, episode: 1 }] }] }), /Duplicate TMDB/);
  assert.throws(() => validateAll([row, mapping({ bangumiId: 2, episodes: [{ id: 99, type: 0, sort: 1 }] })]), /claimed/);
});
test('movie targets remain movie locators and do not invent TV episodes', () => {
  const row = mapping({ targets: [{ type: 'movie', id: 200 }], rules: [],
    overrides: [{ bangumiEpisodeId: 11, targets: [{ type: 'movie', id: 200 }] }] });
  assert.deepEqual(expand(row)[0]!.targets, [{ type: 'movie', id: 200 }]);
});
