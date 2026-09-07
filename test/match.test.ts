import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanSeed, parseLink } from '../src/seed.js';
import { deterministic, normalize } from '../src/match.js';
import { Subject, type Episode, type SeedRow } from '../src/model.js';
import { requireEvidence, fingerprint, orderQueue } from '../src/update.js';
import type { Candidate } from '../src/tmdb.js';
import { episode, mapping, catalog } from './helpers.js';

test('seed import preserves bare TV uncertainty and quarantines conflicts', () => {
  assert.deepEqual(parseLink('tv/94664'), { type: 'tv', id: 94664 });
  assert.deepEqual(parseLink('tv/94664/season/0/episode/1'), { type: 'tv', id: 94664, season: 0, episode: 1 });
  assert.throws(() => parseLink('tv/1/season/-1'));
  const input = [{ bgm_id: '1', tmdb_id: 'tv/100' }, { bgm_id: '1', tmdb_id: 'tv/200' }, { bgm_id: '2', tmdb_id: 'movie/300' }];
  const result = cleanSeed(input);
  assert.deepEqual(result.rows, [{ bangumiId: 2, tmdb: { type: 'movie', id: 300 } }]);
  assert.equal(result.rejected.length, 1);
});
test('real Mushoku Tensei split-cour subjects cannot be resolved by seed/name alone', () => {
  const fixture = JSON.parse(readFileSync(new URL('fixtures/mushoku.json', import.meta.url), 'utf8')) as {
    subjects: unknown[]; episodes: Episode[]; seed: SeedRow[];
  };
  assert.ok(fixture.subjects.length >= 4);
  for (const raw of fixture.subjects) {
    const subject = Subject.parse(raw);
    const seed = fixture.seed.find(s => s.bangumiId === subject.id);
    // Synthetic same-name TMDB candidate deliberately supplies no season evidence.
    const choice: Candidate = { target: { type: 'tv', id: 94664 }, details: { id: 94664, name: subject.name }, seasons: [] };
    assert.equal(deterministic(subject, fixture.episodes.filter(e => e.subject_id === subject.id), seed, [choice]), null);
  }
  assert.notEqual(normalize('無職転生Ⅱ'), normalize('無職転生'));
});
test('TV deterministic match requires independent per-episode names and dates', () => {
  const subject = Subject.parse({ id: 1, type: 2, name: 'Anime', date: '2026-01-01' });
  const episodes = [episode(11, 1), episode(12, 2)];
  const candidate: Candidate = { target: { type: 'tv', id: 100 }, details: { id: 100, name: 'Anime' }, seasons: [{
    id: 1000, season_number: 2, episodes: episodes.map(e => ({ id: e.id + 1000, name: e.name, season_number: 2, episode_number: e.sort, air_date: e.airdate })),
  }] };
  const seed: SeedRow = { bangumiId: 1, tmdb: { type: 'tv', id: 100, season: 2 } };
  assert.equal(deterministic(subject, episodes, seed, [candidate])?.overrides.length, 2);
  candidate.seasons[0]!.episodes[1]!.name = 'Different episode';
  assert.equal(deterministic(subject, episodes, seed, [candidate]), null);
  assert.equal(deterministic(subject, episodes, { bangumiId: 1, tmdb: { type: 'tv', id: 100 } }, [candidate]), null);
});
test('same-name remake on a different date is not a deterministic movie match', () => {
  const subject = Subject.parse({ id: 1, type: 2, name: 'Anime', date: '2026-01-01' });
  assert.equal(deterministic(subject, [episode(11, 1)], { bangumiId: 1, tmdb: { type: 'movie', id: 100 } }, [
    { target: { type: 'movie', id: 100 }, details: { id: 100, title: 'Anime', release_date: '1999-01-01' }, seasons: [] },
  ]), null);
});
test('Codex cannot invent unseen targets, and new season evidence is accepted', () => {
  const row = mapping();
  assert.throws(() => requireEvidence(row, []), /unseen work/);
  const choices: Candidate[] = [{ target: { type: 'tv', id: 100 }, details: { id: 100 }, seasons: [] }];
  assert.throws(() => requireEvidence(row, choices), /unseen season/);
  choices.push({ ...choices[0]!, seasons: [{ id: 10, season_number: 1, episodes: [] }] });
  requireEvidence(row, choices);
});
test('fingerprints track episode changes; history and mapped audits get queue slots', () => {
  const base = catalog();
  const subject = base.subjects[0]!;
  assert.notEqual(fingerprint(subject, [episode(1, 1)], [], {}, ''), fingerprint(subject, [episode(1, 2)], [], {}, ''));
  const recent = Array.from({ length: 30 }, (_, i) => ({ ...subject, id: i + 20 }));
  base.subjects.push(...recent, { ...subject, id: 2, date: '2000-01-01' });
  const queue = orderQueue(base, { schemaVersion: 1, archive: null, subjects: {} }, [mapping()], Date.parse('2026-01-02'));
  assert.ok(queue.slice(0, 10).some(s => s.id === 2));
  assert.ok(queue.slice(0, 10).some(s => s.id === 1));
});
