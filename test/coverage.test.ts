import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, Progress, type EpisodeTarget } from '../src/model.js';
import { computeCoverage, summarize, summaryOf, type ImageSource } from '../src/coverage.js';
import { mapping } from './helpers.js';

const now = Date.parse('2026-09-18T00:00:00Z');
const subject = (id: number, date: string, platform: number | string = 1) => ({ id, type: 2, name: `S${id}`, name_cn: '', date, infobox: '', summary: '', platform });
const ep = (id: number, subject_id: number, sort: number, airdate: string, type = 0) => ({ id, subject_id, type, sort, name: '', name_cn: '', airdate });
// Images exist for tv/100 except episode 2, and for movie 7; tv/300 cannot be consulted at all.
const images: ImageSource = { async has(target: EpisodeTarget) {
  if (target.type === 'movie') return target.id === 7;
  if (target.id === 300) return null;
  return target.episode !== 2;
} };

test('coverage classifies every catalog subject and lists unmapped and image-less episodes', async () => {
  const catalog = Catalog.parse({ snapshot: { name: 'dump-2026-09-15.210336Z.zip', sha256: 'a'.repeat(64), url: 'https://example.org/dump.zip' },
    subjects: [subject(1, '2026-07-01'), subject(2, '2026-08-01', 5), subject(3, '2010-01-01'), subject(4, '2026-05-01', 3), subject(5, '2026-06-01'), subject(6, '2026-06-01'), subject(7, '2027-01-01')],
    episodes: [ep(11, 1, 1, '2026-07-01'), ep(12, 1, 2, '2026-07-08'), ep(13, 1, 3, '2026-07-15'), ep(14, 1, 1, '2026-07-20', 1),
      ep(21, 2, 1, '2026-08-01'), ep(22, 2, 2, '2026-08-08'), ep(23, 2, 3, '2026-12-01'),
      ep(31, 3, 1, '2010-01-01'), ep(41, 4, 1, '2026-05-01'), ep(51, 5, 1, '2026-06-01'), ep(61, 6, 1, '2026-06-01'), ep(62, 6, 2, '2026-06-08')],
    relations: [] });
  const rows = [
    mapping({ bangumiId: 1, episodes: [{ id: 11, type: 0, sort: 1 }, { id: 12, type: 0, sort: 2 }, { id: 13, type: 0, sort: 3 }, { id: 14, type: 1, sort: 1 }],
      targets: [{ type: 'tv', id: 100, season: 1 }], rules: [{ bangumiType: 0, start: 1, end: 3, tmdbId: 100, season: 1, episodeStart: 1 }] }),
    // Only the first two of three regular episodes are mapped; the third has not aired, so the subject is still complete.
    mapping({ bangumiId: 2, episodes: [{ id: 21, type: 0, sort: 1 }, { id: 22, type: 0, sort: 2 }, { id: 23, type: 0, sort: 3 }],
      targets: [{ type: 'tv', id: 100, season: 2 }], rules: [{ bangumiType: 0, start: 1, end: 2, tmdbId: 100, season: 2, episodeStart: 1 }] }),
    mapping({ bangumiId: 4, episodes: [{ id: 41, type: 0, sort: 1 }], targets: [{ type: 'movie', id: 7 }], rules: [], overrides: [{ bangumiEpisodeId: 41, targets: [{ type: 'movie', id: 7 }] }] }),
    mapping({ bangumiId: 5, episodes: [], targets: [{ type: 'tv', id: 200, season: 1 }], rules: [] }),
    mapping({ bangumiId: 6, episodes: [{ id: 61, type: 0, sort: 1 }, { id: 62, type: 0, sort: 2 }], targets: [{ type: 'tv', id: 300, season: 1 }],
      rules: [{ bangumiType: 0, start: 1, end: 1, tmdbId: 300, season: 1, episodeStart: 1 }] }),
  ];
  const progress = Progress.parse({ schemaVersion: 1, archive: null, subjects: { '3': { fingerprint: 'x', attemptedAt: '2026-09-17T00:00:00.000Z', retryAt: '2026-09-24T00:00:00.000Z', status: 'pending', reason: 'not found', attempts: 1 } } });
  const coverage = await computeCoverage(catalog, rows, progress, images, now);
  const by = Object.fromEntries(coverage.subjects.map(s => [s.bangumiId, s]));
  assert.deepEqual(coverage.subjects.map(s => [s.bangumiId, s.status]), [[1, 'complete'], [2, 'complete'], [3, 'unresolved'], [4, 'movie'], [5, 'season-only'], [6, 'partial'], [7, 'unanalyzed']]);
  assert.deepEqual([by[1]!.regular, by[1]!.aired, by[1]!.mapped, by[1]!.missing, by[1]!.noImage, by[1]!.images], [3, 3, 3, [], [12], { checked: 3, present: 2 }], 'the special is neither counted nor checked');
  assert.deepEqual([by[2]!.aired, by[2]!.mapped, by[2]!.missing], [2, 2, []]);
  assert.deepEqual([by[4]!.images, by[4]!.noImage], [{ checked: 1, present: 1 }, []]);
  assert.deepEqual([by[6]!.missing, by[6]!.images], [[62], { checked: 0, present: 0 }], 'an unreachable season leaves episodes unchecked');
  assert.equal(by[7]!.platform, 1);
  assert.match(summarize(coverage), /7 subjects \(2 complete, 1 partial, 1 season-only, 0 work-only, 1 movie, 0 no-episodes, 1 unresolved, 1 unanalyzed\); images on 4\/6 mapped episodes; 1 subjects fully illustrated, 0 without any image/);
  const summary = summaryOf(coverage, now);
  assert.deepEqual([summary.subjects.complete, summary.subjects.unanalyzed, summary.images], [2, 1, { checked: 6, present: 4, subjectsAll: 1, subjectsNone: 0 }]);
  assert.deepEqual(summary.bands.map(b => [b.label, b.subjects, b.mapped, b.episodeLevel, b.unresolved, b.unanalyzed, b.images.present, b.images.checked]),
    [['近 10 年', 6, 5, 4, 0, 1, 4, 6], ['10–20 年', 1, 0, 0, 1, 0, 0, 0], ['20–30 年', 0, 0, 0, 0, 0, 0, 0], ['30 年以上', 0, 0, 0, 0, 0, 0, 0], ['无日期', 0, 0, 0, 0, 0, 0, 0], ['其他平台', 0, 0, 0, 0, 0, 0, 0]],
    'the upcoming subject counts as recent; bands are measured from the reference time');
});
