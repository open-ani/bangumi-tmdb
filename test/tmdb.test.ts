import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tmdb, verifyMapping } from '../src/tmdb.js';
import { request, HttpError } from '../src/http.js';
import { mapping, catalog } from './helpers.js';

test('online verification resolves concrete TMDB episode IDs and caches repeated seasons', async () => {
  const paths: string[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test');
    return Response.json(path.endsWith('/season/1') ? { id: 1001, season_number: 1, episodes: [
      { id: 2011, episode_number: 1, season_number: 1, name: 'One', air_date: null },
      { id: 2012, episode_number: 2, season_number: 1, name: 'Two', air_date: null },
    ] } : { id: 100 });
  }) as typeof fetch;
  const result = await verifyMapping(mapping(), new Tmdb('test', undefined, fake), catalog());
  assert.equal((result[1]!.targets[0] as { episodeId: number }).episodeId, 2012);
  assert.equal(paths.filter(p => p.endsWith('/season/1')).length, 1);
});
test('foreign Bangumi episodes, renamed numbering, and nonexistent TMDB episodes fail validation', async () => {
  const row = mapping();
  const fake = (async (url: string | URL | Request) => Response.json(String(url).includes('/season/')
    ? { id: 1001, season_number: 1, episodes: [] } : { id: 100 })) as typeof fetch;
  const client = new Tmdb('test', undefined, fake);
  await assert.rejects(verifyMapping(row, client, catalog()), /Missing TMDB episode/);
  const changed = catalog(); changed.episodes[0]!.sort = 99;
  await assert.rejects(verifyMapping(row, client, changed), /Stale\/invalid/);
  const foreign = catalog(); foreign.episodes[0]!.subject_id = 2;
  await assert.rejects(verifyMapping(row, client, foreign), /Stale\/invalid/);
});
test('TMDB missing/auth failures are typed and never silently become empty matches', async () => {
  for (const status of [401, 403, 404]) {
    await assert.rejects(request('https://api.themoviedb.org/3/tv/1', {}, (async () => new Response('', { status })) as typeof fetch),
      error => error instanceof HttpError && error.status === status);
  }
});
test('a transient 429 is retried and its body cannot turn into evidence', async () => {
  let calls = 0;
  const response = await request('https://api.themoviedb.org/3/tv/1', {}, (async () => ++calls === 1
    ? new Response('limited', { status: 429, headers: { 'retry-after': '0.001' } }) : Response.json({ id: 1 })) as typeof fetch);
  assert.equal(calls, 2); assert.deepEqual(await response.json(), { id: 1 });
});
test('IMDb episode IDs contribute parent-series candidates for split-cour subjects', async () => {
  const client = new Tmdb('test', undefined, (async () => Response.json({
    tv_results: [], movie_results: [], tv_episode_results: [{ show_id: 94664 }], tv_season_results: [],
  })) as typeof fetch);
  assert.deepEqual(await client.find('tt15553038', 'imdb_id'), [{ type: 'tv', id: 94664 }]);
});
