import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSeed, parseLink } from '../src/seed.js';
import { Subject } from '../src/model.js';
import { bundle, due, fingerprint, inScope, provenanceFromResearch, retryDays, type Context } from '../src/update.js';
import { requireEvidence, toProposal, type ToolCall } from '../src/research.js';
import { hash, stable } from '../src/io.js';
import { episode, mapping, catalog } from './helpers.js';

const DAY = 86400000;
const now = Date.parse('2026-09-15T00:00:00Z');

test('seed import preserves bare TV uncertainty and quarantines conflicts', () => {
  assert.deepEqual(parseLink('tv/94664'), { type: 'tv', id: 94664 });
  assert.deepEqual(parseLink('tv/94664/season/0/episode/1'), { type: 'tv', id: 94664, season: 0, episode: 1 });
  assert.throws(() => parseLink('tv/1/season/-1'));
  const input = [{ bgm_id: '1', tmdb_id: 'tv/100' }, { bgm_id: '1', tmdb_id: 'tv/200' }, { bgm_id: '2', tmdb_id: 'movie/300' }];
  const result = cleanSeed(input);
  assert.deepEqual(result.rows, [{ bangumiId: 2, tmdb: { type: 'movie', id: 300 } }]);
  assert.equal(result.rejected.length, 1);
});
test('fingerprints ignore Archive/API encoding differences but track episode and hint changes', () => {
  const archive = Subject.parse({ id: 1, type: 2, name: 'Anime', date: '2026-01-01', platform: 1, infobox: '{{Infobox\r\n|x= 1\r\n}}', summary: 'a' });
  const api = Subject.parse({ id: 1, type: 2, name: 'Anime', date: '2026-01-01', platform: 'TV', infobox: '{{Infobox\r\n|x= 1\r\n|y= 2\r\n}}', summary: 'b' });
  assert.equal(fingerprint(archive, [episode(1, 1)], [], {}, ''), fingerprint(api, [episode(1, 1)], [], {}, ''));
  assert.notEqual(fingerprint(archive, [episode(1, 1)], [], {}, ''), fingerprint(archive, [episode(1, 2)], [], {}, ''));
  assert.notEqual(fingerprint(archive, [], [], { hint: 1 }, ''), fingerprint(archive, [], [], { hint: 2 }, ''));
  assert.notEqual(fingerprint(archive, [], [], {}, 'a'), fingerprint(archive, [], [], {}, 'b'));
  assert.notEqual(fingerprint(null, [], [], {}, ''), fingerprint(archive, [], [], {}, ''));
});
test('only recent, upcoming or previously handled subjects are automation scope; retries back off', () => {
  const subject = Subject.parse({ id: 1, type: 2, name: 'Anime', date: '2026-06-01' });
  assert.equal(inScope(subject, now, 180), true);
  assert.equal(inScope({ ...subject, date: '2020-01-01' }, now, 180), false);
  assert.equal(inScope({ ...subject, date: '2027-01-01' }, now, 180), true);
  assert.equal(inScope({ ...subject, date: '' }, now, 180), false);
  assert.equal(retryDays('pending', 1, subject, now), 7);
  assert.equal(retryDays('pending', 2, subject, now), 14);
  assert.equal(retryDays('pending', 9, subject, now), 90);
  assert.equal(retryDays('pending', 1, { ...subject, date: '2026-12-01' }, now), Math.ceil((Date.parse('2026-12-01') - now) / DAY) + 3);
  assert.equal(retryDays('error', 5, subject, now), 1);
  assert.equal(retryDays('matched', 0, subject, now), 28);
  const progress = { schemaVersion: 1 as const, archive: null, subjects: { '1': {
    fingerprint: 'x', attemptedAt: new Date(now).toISOString(), retryAt: new Date(now + DAY).toISOString(), status: 'pending' as const, reason: '', attempts: 1 } } };
  assert.equal(due(progress, 1, 'p', undefined, now), true);
  const printed = fingerprint(subject, [], [], {}, '');
  progress.subjects['1']!.fingerprint = hash(printed + stable(null));
  assert.equal(due(progress, 1, printed, undefined, now), false);
  assert.equal(due(progress, 1, printed, undefined, now + 2 * DAY), true);
  assert.equal(due(progress, 1, `${printed}changed`, undefined, now), true);
  assert.equal(due(progress, 1, printed, mapping(), now), true);
});
test('research proposals convert scope fields and reject bare TV or malformed ranges', () => {
  const converted = toProposal({ targets: [
    { type: 'movie', id: 1, season: null, episode: null, episodeEnd: null },
    { type: 'tv', id: 2, season: 1, episode: null, episodeEnd: null },
    { type: 'tv', id: 2, season: 2, episode: 13, episodeEnd: 24 },
    { type: 'tv', id: 2, season: 3, episode: 5, episodeEnd: 5 },
  ], rules: [], overrides: [] });
  assert.deepEqual(converted.targets, [{ type: 'movie', id: 1 }, { type: 'tv', id: 2, season: 1 },
    { type: 'tv', id: 2, season: 2, episode: 13, episodeEnd: 24 }, { type: 'tv', id: 2, season: 3, episode: 5 }]);
  const bad = (t: Parameters<typeof toProposal>[0]['targets'][number]) => () => toProposal({ targets: [t], rules: [], overrides: [] });
  assert.throws(bad({ type: 'tv', id: 2, season: null, episode: null, episodeEnd: null }), /explicit TMDB season/);
  assert.throws(bad({ type: 'movie', id: 1, season: 1, episode: null, episodeEnd: null }), /TV fields/);
  assert.throws(bad({ type: 'tv', id: 2, season: 1, episode: null, episodeEnd: 3 }), /without a start/);
  assert.throws(bad({ type: 'tv', id: 2, season: 1, episode: 5, episodeEnd: 3 }), /Reversed/);
});
test('proposals may only cite works and seasons actually read through the TMDB tools', () => {
  const proposal = { targets: [{ type: 'tv' as const, id: 100, season: 2 }], rules: [{ bangumiType: 0, start: 1, end: 2, tmdbId: 100, season: 2, episodeStart: 1 }],
    overrides: [{ bangumiEpisodeId: 5, targets: [{ type: 'tv' as const, id: 100, season: 0, episode: 1 }] }] };
  const call = (tool: string, args: Record<string, unknown>, ok = true): ToolCall => ({ tool, arguments: args, ok, at: '2026-01-01T00:00:00Z' });
  assert.throws(() => requireEvidence(proposal, []), /unread TMDB tv\/100/);
  assert.throws(() => requireEvidence(proposal, [call('tmdb_details', { type: 'tv', id: 100 })]), /unread season tv\/100\/season\/2/);
  assert.throws(() => requireEvidence(proposal, [call('tmdb_details', { type: 'tv', id: 100 }), call('tmdb_season', { id: 100, season: 2 })]), /Override cites unread season tv\/100\/season\/0/);
  assert.throws(() => requireEvidence(proposal, [call('tmdb_details', { type: 'tv', id: 100 }, false), call('tmdb_season', { id: 100, season: 2 }), call('tmdb_season', { id: 100, season: 0 })]), /unread TMDB/);
  requireEvidence(proposal, [call('tmdb_details', { type: 'tv', id: 100 }), call('tmdb_season', { id: 100, season: 2 }), call('tmdb_season', { id: 100, season: 0 })]);
  assert.throws(() => requireEvidence({ targets: [{ type: 'movie', id: 7 }], rules: [], overrides: [] }, [call('tmdb_details', { type: 'tv', id: 7 })]), /unread TMDB movie\/7/);
});
test('research bundles truncate long inputs, carry hints, existing rows and ownership; provenance keeps citations', () => {
  const base = catalog();
  const subject = { ...base.subjects[0]!, infobox: 'x'.repeat(10000), summary: 'y'.repeat(10000) };
  const episodes = Array.from({ length: 200 }, (_, i) => episode(100 + i, i + 1));
  const ctx: Context = { episodes: new Map([[1, episodes]]), relations: new Map([[1, [{ subject_id: 1, related_subject_id: 2, relation_type: 3 }]]]),
    subjects: new Map([[1, subject], [2, { ...subject, id: 2, name: 'Sequel' }]]),
    seeds: new Map([[1, { bangumiId: 1, tmdb: { type: 'tv', id: 100, season: 1 } }]]), anidb: new Map(), model: 'm' };
  const rows = new Map([[2, mapping({ bangumiId: 2, episodes: [{ id: 99, type: 0, sort: 1 }], rules: [{ bangumiType: 0, start: 1, end: 1, tmdbId: 100, season: 2, episodeStart: 1 }] })]]);
  const out = bundle(subject, ctx, rows, 'dump', mapping()) as Record<string, unknown>;
  assert.equal((out.infobox as string).length, 6500);
  assert.equal((out.regularEpisodes as unknown[]).length, 120);
  assert.equal(out.regularEpisodesTruncated, true);
  assert.deepEqual((out.ownership as { bangumiId: number }[]).map(o => o.bangumiId), [2]);
  assert.equal((out.relations as { relatedName: string }[])[0]!.relatedName, 'Sequel');
  assert.equal((out.existing as { targets: unknown[] }).targets.length, 1);
  const provenance = provenanceFromResearch({ bangumiId: 1, status: 'matched', proposal: null, reason: 'why',
    evidence: [{ url: 'https://www.themoviedb.org/tv/100', fact: 'fact', access: 'api_snapshot' }], uncertainties: ['u'] }, 'model-x', 1, '2026-01-01T00:00:00.000Z');
  assert.equal(provenance.method, 'codex');
  assert.equal(provenance.source, 'https://bgm.tv/subject/1; https://www.themoviedb.org/tv/100');
  assert.match(provenance.evidence, /^model-x: why\n\nhttps:\/\/www.themoviedb.org\/tv\/100 \(api_snapshot\): fact\n\n备注：u$/);
});
