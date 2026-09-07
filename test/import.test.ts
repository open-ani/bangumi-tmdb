import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { cleanSeed, importMappings, seedMapping } from '../src/seed.js';
import { compareTargets, parseAniLinks, parseTitles, titleStatus } from '../src/anidb.js';
import { Mapping, Seeds, Subject } from '../src/model.js';
import { readJson, writeJson } from '../src/io.js';
import { publish } from '../src/publish.js';
import { mapping } from './helpers.js';

test('legacy import preserves movie, TV, season and explicit episode scope without verification', () => {
  for (const link of ['movie/100', 'tv/100', 'tv/100/season/0', 'tv/100/season/2/episode/4']) {
    const { rows } = cleanSeed([{ bgm_id: '1', anidb_id: '14758', tmdb_id: link }]);
    const row = seedMapping(rows[0]!, { commit: 'a'.repeat(40) })!;
    assert.deepEqual(row.targets, [rows[0]!.tmdb]);
    assert.equal(row.anidbId, 14758);
    assert.equal(row.provenance.verifiedAt, null);
    assert.deepEqual(row.rules, []);
  }
});
test('legacy import and publication work without network, credentials or Archive; existing edits survive reimport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seed-publish-test-'));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected online dependency'); };
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git(['init', '-b', 'main']);
    await writeJson(join(root, 'state/progress.json'), { schemaVersion: 1, archive: null, subjects: {} });
    git(['add', '.']);
    git(['-c', 'user.name=test', '-c', 'user.email=test@example.org', 'commit', '-m', 'fixture']);
    const seed = Seeds.parse({ schemaVersion: 1, repository: 'Rhilip/BangumiExtLinker', commit: 'a'.repeat(40), sha256: 'b'.repeat(64),
      rows: [{ bangumiId: 1, tmdb: { type: 'tv', id: 100, season: 2 } }, { bangumiId: 2, tmdb: { type: 'movie', id: 200 } }] });
    await importMappings(root, seed);
    assert.equal((await readJson(join(root, 'data/1.json'), Mapping)).provenance.verifiedAt, null);
    const edited = mapping({ locked: true, targets: [
      { type: 'tv', id: 100, season: 1, episode: 1, episodeEnd: 2 },
      { type: 'tv', id: 100, season: 2 },
    ] });
    await writeJson(join(root, 'data/1.json'), edited);
    await importMappings(root, seed);
    assert.deepEqual(await readJson(join(root, 'data/1.json'), Mapping), edited);
    await publish(root);
    const first = await readFile(join(root, 'dist/subjects.json'), 'utf8');
    assert.deepEqual(JSON.parse(first).subjects.find((s: { bangumiId: number }) => s.bangumiId === 1).targets, edited.targets);
    const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
    assert.equal(manifest.counts.subjects, 2);
    assert.equal(manifest.onlineVerified, false);
    assert.equal(manifest.sourceDirty, true);
    const episodes = JSON.parse(await readFile(join(root, 'dist/episodes.json'), 'utf8'));
    assert.equal(episodes.episodes.length, 2);
    await publish(root);
    assert.equal(await readFile(join(root, 'dist/subjects.json'), 'utf8'), first);
  } finally { globalThis.fetch = oldFetch; await rm(root, { recursive: true, force: true }); }
});
test('AniDB comparison distinguishes matching scope, missing seasons, conflicts and new candidates', () => {
  const known = [{ type: 'tv' as const, id: 94664, season: 1 }];
  assert.equal(compareTargets(known, known), 'agree');
  assert.equal(compareTargets([{ type: 'tv', id: 94664 }], known), 'partial');
  assert.equal(compareTargets([{ type: 'tv', id: 94664, season: 2 }], known), 'conflict');
  assert.equal(compareTargets([{ type: 'movie', id: 94664 }], known), 'conflict');
  assert.equal(compareTargets([], known), 'candidate');
  assert.equal(compareTargets(known, []), 'no-tmdb');
});
test('AniDB XML retains TMDB season/offset separately from TVDB fields and reads official aliases', () => {
  const links = parseAniLinks('<anime-list><anime anidbid="1" tmdbtv="94664" tmdbseason="2" tmdboffset="12" defaulttvdbseason="4"/>' +
    '<anime anidbid="2" tmdbid="100, 200"/>' +
    '<anime anidbid="3" tvdbid="1234" defaulttvdbseason="3"/></anime-list>');
  assert.deepEqual(links.get(1), { targets: [{ type: 'tv', id: 94664, season: 2 }], offset: 12 });
  assert.equal(links.get(2)!.targets.length, 2);
  assert.deepEqual(links.get(3)!.targets, []);
  const titles = parseTitles('<animetitles><anime aid="1"><title type="main">Romanized name</title><title xml:lang="ja">無職転生Ⅱ</title></anime></animetitles>');
  const subject = Subject.parse({ id: 1, type: 2, name: '無職転生Ⅱ' });
  assert.equal(titleStatus(subject, titles.get(1)), 'matched');
  assert.equal(titleStatus(subject, ['無職転生']), 'different');
  assert.equal(titleStatus(subject, undefined), 'missing');
});
