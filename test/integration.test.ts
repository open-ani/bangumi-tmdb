import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mapping, Progress } from '../src/model.js';
import { readJson, writeJson } from '../src/io.js';
import { update } from '../src/update.js';
import { mapping } from './helpers.js';

const now = Date.parse('2026-09-15T00:00:00Z');
const day = (d: string) => d;
function tmdbFake(url: string): Response {
  const path = new URL(url).pathname;
  const season = (numbers: number[], dates: (string | null)[], id: number) => Response.json({ id: id * 10 + 1, season_number: 1,
    episodes: numbers.map((n, i) => ({ id: id * 1000 + n, episode_number: n, season_number: 1, name: `E${n}`, air_date: dates[i] ?? null })) });
  if (path === '/3/tv/100') return Response.json({ id: 100 });
  if (path === '/3/tv/100/season/1') return season([1, 2, 3], ['2026-07-01', '2026-07-08', '2026-07-15'], 100);
  if (path === '/3/tv/200') return Response.json({ id: 200 });
  if (path === '/3/tv/200/season/1') return season([1, 2], ['2026-08-01', '2026-08-08'], 200);
  if (path === '/3/movie/7') return Response.json({ id: 7 });
  // Subject 5 is identified without a model: its title finds tv/300, whose season 1 airs on its dates.
  if (path === '/3/search/tv') return Response.json({ results: new URL(url).searchParams.get('query') === 'S5' ? [{ id: 300, name: 'S5' }] : [] });
  if (path === '/3/search/movie') return Response.json({ results: [] });
  if (path === '/3/tv/300') return Response.json({ id: 300, name: 'S5', seasons: [{ season_number: 1, name: 'S1', air_date: '2026-06-01', episode_count: 2 }] });
  if (path === '/3/tv/300/season/1') return season([1, 2], ['2026-06-01', '2026-06-08'], 300);
  return new Response('missing', { status: 404 });
}
// Full scheduled-run behaviour with a fake TMDB and a fake codex: derive rules for an existing
// season-level row, research one new in-scope subject, leave the old backlog and locked rows alone,
// and do nothing on an immediate rerun.
test('update derives, researches, respects scope and locks, and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-e2e-'));
  const bin = await mkdtemp(join(tmpdir(), 'fake-codex-e2e-'));
  const original = { PATH: process.env.PATH, TMDB_READ_TOKEN: process.env.TMDB_READ_TOKEN, fetch: globalThis.fetch, DATASET_CACHE: process.env.DATASET_CACHE };
  try {
    delete process.env.DATASET_CACHE;
    process.env.TMDB_READ_TOKEN = 'tmdb-secret';
    globalThis.fetch = (async (input: string | URL | Request) => tmdbFake(String(input))) as typeof fetch;
    await writeFile(join(bin, 'codex'), `#!${process.execPath}\n` +
      `const fs=require('fs');const a=process.argv;if(process.env.TMDB_READ_TOKEN)process.exit(8);\n` +
      `const out=a[a.indexOf('--output-last-message')+1];const mcp=JSON.parse(a.find(x=>x.startsWith('mcp_servers.tmdb.args=')).slice(22));\n` +
      `let p='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>p+=d);process.stdin.on('end',()=>{\n` +
      `const id=JSON.parse(p.slice(p.indexOf('{"bangumi"'))).bangumi.id;\n` +
      `fs.writeFileSync(mcp[1],JSON.stringify({tool:'tmdb_details',arguments:{type:'tv',id:200},ok:true,at:'t'})+'\\n'+JSON.stringify({tool:'tmdb_season',arguments:{id:200,season:1},ok:true,at:'t'})+'\\n');\n` +
      `fs.writeFileSync(out,JSON.stringify({bangumiId:id,status:'matched',reason:'研究结论',evidence:[{url:'https://www.themoviedb.org/tv/200',fact:'季表一致',access:'api_snapshot'}],uncertainties:[],\n` +
      `proposal:{targets:[{type:'tv',id:200,season:1,episode:null,episodeEnd:null}],rules:[{bangumiType:0,start:1,end:2,tmdbId:200,season:1,episodeStart:1}],overrides:[]}}));});\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${original.PATH}`;
    const subject = (id: number, date: string) => ({ id, type: 2, name: `S${id}`, name_cn: '', date, infobox: '', summary: '' });
    const ep = (id: number, subject_id: number, sort: number, airdate: string) => ({ id, subject_id, type: 0, sort, name: '', name_cn: '', airdate });
    await mkdir(join(root, '.cache'), { recursive: true });
    await writeJson(join(root, '.cache/catalog.json'), { snapshot: { name: 'dump-2026-09-08.210336Z.zip', sha256: 'a'.repeat(64), url: 'https://example.org/dump.zip' },
      subjects: [subject(1, '2026-07-01'), subject(2, '2026-08-01'), subject(3, '2010-01-01'), subject(4, '2026-05-01'), subject(5, '2026-06-01')],
      episodes: [ep(11, 1, 1, day('2026-07-01')), ep(12, 1, 2, '2026-07-08'), ep(13, 1, 3, '2026-07-15'), ep(21, 2, 1, '2026-08-01'), ep(22, 2, 2, '2026-08-08'), ep(31, 3, 1, '2010-01-01'), ep(41, 4, 1, '2026-05-01'), ep(51, 5, 1, '2026-06-01'), ep(52, 5, 2, '2026-06-08')],
      relations: [] });
    await writeJson(join(root, 'sources/seed.json'), { schemaVersion: 1, repository: 'Rhilip/BangumiExtLinker', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), rows: [] });
    await writeJson(join(root, 'state/progress.json'), { schemaVersion: 1, archive: null, subjects: {} });
    await writeJson(join(root, 'data/1.json'), mapping({ bangumiId: 1, episodes: [], rules: [], targets: [{ type: 'tv', id: 100, season: 1 }],
      provenance: { method: 'seed', source: 'seed', evidence: 'Imported.', verifiedAt: null } }));
    await writeJson(join(root, 'data/4.json'), mapping({ bangumiId: 4, locked: true, episodes: [{ id: 41, type: 0, sort: 1 }], rules: [], targets: [{ type: 'movie', id: 7 }],
      overrides: [{ bangumiEpisodeId: 41, targets: [{ type: 'movie', id: 7 }] }] }));
    const options = { maxSubjects: 5, maxMinutes: 5, concurrency: 1, scopeDays: 180, researchMinutes: 1, tmdbBudget: 16, webBudget: 8, now };
    await update(root, options);
    const one = await readJson(join(root, 'data/1.json'), Mapping);
    assert.deepEqual(one.rules, [{ bangumiType: 0, start: 1, end: 3, tmdbId: 100, season: 1, episodeStart: 1 }]);
    assert.equal(one.episodes.length, 3);
    assert.equal(one.provenance.method, 'deterministic');
    assert.ok(one.provenance.verifiedAt && one.provenance.evidence.startsWith('Imported.\n\n脚本'));
    const two = await readJson(join(root, 'data/2.json'), Mapping);
    assert.equal(two.provenance.method, 'codex');
    assert.deepEqual(two.targets, [{ type: 'tv', id: 200, season: 1 }]);
    assert.equal(two.rules.length, 1);
    assert.match(two.provenance.evidence, /研究结论/);
    await assert.rejects(readJson(join(root, 'data/3.json'), Mapping), /ENOENT/);
    const five = await readJson(join(root, 'data/5.json'), Mapping);
    assert.equal(five.provenance.method, 'deterministic');
    assert.deepEqual(five.targets, [{ type: 'tv', id: 300, season: 1 }]);
    assert.deepEqual(five.rules, [{ bangumiType: 0, start: 1, end: 2, tmdbId: 300, season: 1, episodeStart: 1 }]);
    assert.match(five.provenance.evidence, /脚本按放送日期识别作品/);
    assert.ok(five.provenance.verifiedAt);
    assert.equal((await readJson(join(root, 'data/4.json'), Mapping)).provenance.verifiedAt, '2026-01-01T00:00:00.000Z', 'locked rows are untouched');
    const progress = await readJson(join(root, 'state/progress.json'), Progress);
    assert.deepEqual(Object.fromEntries(Object.entries(progress.subjects).map(([k, v]) => [k, v.status])), { '1': 'matched', '2': 'matched', '4': 'locked', '5': 'matched' });
    assert.equal(progress.archive?.name, 'dump-2026-09-08.210336Z.zip');
    const report = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, '.cache/update-report.json'), 'utf8'));
    assert.equal(report.derived, 1); assert.equal(report.resolved, 1); assert.equal(report.researchMatched, 1); assert.equal(report.codexSubjects, 1, 'the resolved subject never reaches the model');
    assert.equal(report.changed, 3); assert.equal(report.queued.unmapped, 2);
    await update(root, { ...options, now: now + 3600000 });
    const again = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, '.cache/update-report.json'), 'utf8'));
    assert.equal(again.changed, 0); assert.equal(again.codexSubjects, 0); assert.equal(again.verified, 0);
  } finally {
    globalThis.fetch = original.fetch;
    for (const key of ['PATH', 'TMDB_READ_TOKEN', 'DATASET_CACHE'] as const) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    await rm(root, { recursive: true, force: true }); await rm(bin, { recursive: true, force: true });
  }
});
