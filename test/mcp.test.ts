import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Tmdb } from '../src/tmdb.js';
import { callTool, serve, tools } from '../src/tmdb-mcp.js';

const fake = (async (url: string | URL | Request) => {
  const { pathname, searchParams } = new URL(String(url));
  if (pathname === '/3/search/tv') return Response.json({ page: 1, total_pages: 1, total_results: 1, results: [{ id: 100, name: 'Anime', original_name: 'アニメ', first_air_date: '2026-01-01', overview: 'o' }] });
  if (pathname === '/3/tv/100') return Response.json({ id: 100, name: 'Anime', seasons: [{ season_number: 1, name: 'S1', air_date: '2026-01-01', episode_count: 70 }],
    credits: { cast: [{ name: 'A', character: 'B' }], crew: [{ name: 'D', job: 'Director' }, { name: 'X', job: 'Gaffer' }] }, external_ids: { imdb_id: 'tt1' }, alternative_titles: { results: [] } });
  if (pathname === '/3/tv/100/season/1') return Response.json({ id: 1001, season_number: 1, episodes: Array.from({ length: 70 }, (_, i) => ({ id: 2000 + i, episode_number: i + 1, season_number: 1, name: `E${i + 1}`, air_date: null })) });
  if (pathname === '/3/find/tt1') return Response.json({ tv_results: [{ id: 100 }], movie_results: [], tv_episode_results: [], tv_season_results: [] });
  assert.equal(searchParams.get('language'), 'en-US');
  return new Response('missing', { status: 404 });
}) as typeof fetch;

test('TMDB research tools expose validated, paginated read-only views', async () => {
  const tmdb = new Tmdb('t', undefined, fake);
  assert.deepEqual(tools.map(t => t.name), ['tmdb_search', 'tmdb_details', 'tmdb_season', 'tmdb_find']);
  const search = await callTool(tmdb, 'tmdb_search', { query: 'Anime', type: 'tv' }) as { results: { url: string }[] };
  assert.equal(search.results[0]!.url, 'https://www.themoviedb.org/tv/100');
  const details = await callTool(tmdb, 'tmdb_details', { type: 'tv', id: 100 }) as { crew: { job: string }[]; seasons: { season: number }[] };
  assert.deepEqual(details.crew.map(c => c.job), ['Director']);
  assert.equal(details.seasons[0]!.season, 1);
  const page1 = await callTool(tmdb, 'tmdb_season', { id: 100, season: 1 }) as { total_pages: number; episodes: unknown[] };
  const page2 = await callTool(tmdb, 'tmdb_season', { id: 100, season: 1, page: 2 }) as { episodes: { episode_number: number }[] };
  assert.equal(page1.total_pages, 2); assert.equal(page1.episodes.length, 60); assert.equal(page2.episodes[0]!.episode_number, 61);
  await assert.rejects(callTool(tmdb, 'tmdb_details', { type: 'tv', id: '100' }), /Invalid|expected/i);
  await assert.rejects(callTool(tmdb, 'tmdb_search', { query: 'x', language: 'bad-lang' }));
  await assert.rejects(callTool(tmdb, 'tmdb_details', { type: 'movie', id: 5 }), /HTTP 404/);
});
test('the stdio server answers JSON-RPC, audits every call and enforces the budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-test-'));
  try {
    const audit = join(dir, 'calls.jsonl');
    const input = new PassThrough(), output = new PassThrough();
    let received = '';
    output.on('data', chunk => { received += String(chunk); });
    const done = serve(new Tmdb('t', undefined, fake), audit, 1, input, output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tmdb_find', arguments: { external_id: 'tt1', source: 'imdb_id' } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tmdb_find', arguments: { external_id: 'tt1', source: 'imdb_id' } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'nope' })}\n`);
    await new Promise(resolve => setTimeout(resolve, 200));
    input.end();
    await done;
    const replies = received.trim().split('\n').map(line => JSON.parse(line) as { id: number; result?: { isError?: boolean; tools?: unknown; serverInfo?: unknown }; error?: unknown });
    assert.equal(replies.find(r => r.id === 1)!.result!.serverInfo !== undefined, true);
    assert.equal(replies.find(r => r.id === 2)!.result!.isError, undefined);
    assert.equal(replies.find(r => r.id === 3)!.result!.isError, true);
    assert.ok(replies.find(r => r.id === 4)!.error);
    const lines = (await readFile(audit, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { ok: boolean; tool: string });
    assert.deepEqual(lines.map(l => [l.tool, l.ok]), [['tmdb_find', true], ['tmdb_find', false]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
