import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { guard, allowedChange } from '../src/guard.js';
import { stable, writeJson } from '../src/io.js';
import { runResearch } from '../src/research.js';
import { parseArchive, digestFile, syncArchive } from '../src/archive.js';
import { researchSchema } from '../src/schemas.js';
import { mapping } from './helpers.js';

test('automation guard protects locks, code files and exact base HEAD', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mapping-guard-test-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '-b', 'main']);
    await writeJson(join(dir, 'data/1.json'), mapping({ locked: true }));
    git(['add', '.']);
    git(['-c', 'user.name=test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
    const base = git(['rev-parse', 'HEAD']);
    await guard(dir, base);
    await writeJson(join(dir, 'data/1.json'), mapping({ locked: false }));
    await assert.rejects(guard(dir, base), /Locked record/);
    git(['restore', 'data/1.json']);
    await writeFile(join(dir, 'code.ts'), 'unapproved');
    await assert.rejects(guard(dir, base), /cannot change code/);
    await assert.rejects(guard(dir, 'a'.repeat(40)), /HEAD changed/);
    assert.equal(allowedChange('data/../src/cli.ts'), false);
    assert.equal(allowedChange('.github/workflows/update.yml'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
// A stand-in codex binary: refuses inherited secrets, checks the research wiring, records the tool calls
// listed next to it into the MCP audit file, and returns the canned decision next to it.
async function fakeCodex(dir: string): Promise<void> {
  await writeFile(join(dir, 'codex'), `#!${process.execPath}\n` +
    `const fs=require('fs'),path=require('path');\n` +
    `if(process.env.GH_TOKEN||process.env.TMDB_READ_TOKEN||process.env.OPENAI_API_KEY)process.exit(8);\n` +
    `const a=process.argv,out=a[a.indexOf('--output-last-message')+1],schema=a[a.indexOf('--output-schema')+1];\n` +
    `const mcp=JSON.parse(a.find(x=>x.startsWith('mcp_servers.tmdb.args=')).slice('mcp_servers.tmdb.args='.length));\n` +
    `if(!fs.readFileSync(schema,'utf8').includes('bangumiId'))process.exit(9);\n` +
    `if(fs.readFileSync(mcp[3],'utf8')!=='tmdb-secret')process.exit(10);\n` +
    `if(!a.includes('web_search="live"')||!a.includes('--ephemeral'))process.exit(11);\n` +
    `let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{\n` +
    `if(!prompt.includes('"bangumiId":1'))process.exit(12);\n` +
    `const here=path.dirname(fs.realpathSync(process.argv[1]));\n` +
    `try{fs.writeFileSync(mcp[1],fs.readFileSync(path.join(here,'calls.jsonl')));}catch{}\n` +
    `fs.writeFileSync(out,fs.readFileSync(path.join(here,'decision.json')));\n` +
    `console.log(JSON.stringify({type:'item.completed',item:{type:'web_search'}}));\n` +
    `console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));});\n`, { mode: 0o755 });
}
test('research subprocess cannot inherit credentials; decisions are validated and tool calls captured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-'));
  const original = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, TMDB_READ_TOKEN: process.env.TMDB_READ_TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  const options = { timeoutMs: 10000, tmdbBudget: 16, webBudget: 8, token: 'tmdb-secret', cacheDir: join(dir, 'cache'), auditDir: join(dir, 'audit') };
  try {
    await fakeCodex(dir);
    process.env.PATH = `${dir}:${original.PATH}`;
    process.env.GH_TOKEN = 'must-not-leak'; process.env.TMDB_READ_TOKEN = 'must-not-leak'; process.env.OPENAI_API_KEY = 'must-not-leak';
    await writeFile(join(dir, 'decision.json'), JSON.stringify({ bangumiId: 1, status: 'matched', proposal: null, reason: 'invalid', evidence: [], uncertainties: [] }));
    await assert.rejects(runResearch(1, { bangumiId: 1 }, options), /Invalid matched decision/);
    await writeFile(join(dir, 'decision.json'), JSON.stringify({ bangumiId: 2, status: 'pending', proposal: null, reason: 'other subject', evidence: [], uncertainties: [] }));
    await assert.rejects(runResearch(1, { bangumiId: 1 }, options), /different subject/);
    await writeFile(join(dir, 'calls.jsonl'), `${JSON.stringify({ tool: 'tmdb_details', arguments: { type: 'tv', id: 100 }, ok: true, at: 'now' })}\n{broken\n`);
    await writeFile(join(dir, 'decision.json'), JSON.stringify({ bangumiId: 1, status: 'matched', reason: 'ok',
      proposal: { targets: [{ type: 'tv', id: 100, season: 1, episode: null, episodeEnd: null }], rules: [], overrides: [] },
      evidence: [{ url: 'https://www.themoviedb.org/tv/100', fact: 'read', access: 'api_snapshot' }], uncertainties: [] }));
    const result = await runResearch(1, { bangumiId: 1 }, options);
    assert.equal(result.decision.status, 'matched');
    assert.deepEqual(result.calls.map(c => c.tool), ['tmdb_details']);
    assert.equal(result.webCalls, 1);
    assert.equal(result.usage.input_tokens, 10);
    assert.ok((await readFile(join(dir, 'audit/1/prompt.txt'), 'utf8')).includes('"bangumiId":1'));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
test('Archive parser filters anime without excluding NSFW, validates broken JSON and computes digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-fixture-'));
  try {
    await writeFile(join(dir, 'subject.jsonlines'), [{ id: 1, type: 2, name: 'Anime', nsfw: true }, { id: 2, type: 1, name: 'Book' }].map(v => JSON.stringify(v)).join('\n'));
    await writeFile(join(dir, 'episode.jsonlines'), [{ id: 11, subject_id: 1, type: 0, sort: 1 }, { id: 12, subject_id: 2, type: 0, sort: 1 }].map(v => JSON.stringify(v)).join('\n'));
    await writeFile(join(dir, 'subject-relations.jsonlines'), '');
    execFileSync('zip', ['-q', 'fixture.zip', 'subject.jsonlines', 'episode.jsonlines', 'subject-relations.jsonlines'], { cwd: dir });
    const zip = join(dir, 'fixture.zip');
    const snapshot = { name: 'fixture', sha256: await digestFile(zip), url: 'https://example.org/fixture.zip' };
    const catalog = await parseArchive(zip, snapshot);
    assert.deepEqual(catalog.subjects.map(s => s.id), [1]);
    assert.deepEqual(catalog.episodes.map(e => e.id), [11]);
    assert.equal(snapshot.sha256.length, 64);
    await writeFile(join(dir, 'subject.jsonlines'), '{broken\n');
    execFileSync('zip', ['-q', 'fixture.zip', 'subject.jsonlines'], { cwd: dir });
    await assert.rejects(parseArchive(zip, snapshot));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('canonical output is deterministic and repeat writes leave content unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stable-test-'));
  try {
    await mkdir(join(dir, 'data'));
    await writeJson(join(dir, 'data/1.json'), { b: 2, a: 1 });
    const first = await readFile(join(dir, 'data/1.json'), 'utf8');
    await writeJson(join(dir, 'data/1.json'), { a: 1, b: 2 });
    assert.equal(await readFile(join(dir, 'data/1.json'), 'utf8'), first);
    assert.equal(stable({ b: 2, a: 1 }), first);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('research schema uses supported disjoint anyOf branches and requires every property', () => {
  const json = JSON.stringify(researchSchema());
  assert.ok(json.includes('anyOf'));
  assert.ok(json.includes('"episodeEnd"'));
  for (const keyword of ['oneOf', '$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'minLength', 'maxLength', 'maxItems']) assert.ok(!json.includes(`"${keyword}"`), keyword);
});
test('Archive checksum mismatch leaves the prior catalog intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-integrity-test-'));
  const previousFetch = globalThis.fetch;
  try {
    const prior = '{"prior":"cached catalog"}\n';
    await mkdir(join(dir, '.cache'));
    await writeFile(join(dir, '.cache/catalog.json'), prior);
    globalThis.fetch = (async (url: string | URL | Request) => String(url).includes('latest.json') ? Response.json({
      name: 'dump-test.zip', browser_download_url: 'https://github.com/bangumi/Archive/releases/download/archive/dump-test.zip',
      digest: `sha256:${'0'.repeat(64)}`,
    }) : new Response('corrupt archive')) as typeof fetch;
    await assert.rejects(syncArchive(dir), /SHA-256 mismatch/);
    assert.equal(await readFile(join(dir, '.cache/catalog.json'), 'utf8'), prior);
  } finally { globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); }
});
