import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { guard, allowedChange } from '../src/guard.js';
import { stable, writeJson } from '../src/io.js';
import { runCodex } from '../src/codex.js';
import { parseArchive, digestFile, syncArchive } from '../src/archive.js';
import { decisionSchema } from '../src/schemas.js';
import { mapping } from './helpers.js';

test('automation guard protects locks, code files and exact base HEAD', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mapping-guard-test-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '-b', 'main']);
    await writeJson(join(dir, 'data/1.json'), mapping({ locked: true }));
    git(['add', '.']);
    git(['-c', 'user.name=test', '-c', 'user.email=test@example.org', 'commit', '-m', 'fixture']);
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
test('Codex subprocess cannot inherit GitHub, TMDB or API credentials; invalid output is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-'));
  const original = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, TMDB_READ_TOKEN: process.env.TMDB_READ_TOKEN };
  try {
    await writeFile(join(dir, 'codex'), `#!${process.execPath}\n` +
      `const fs=require('fs'); if(process.env.GH_TOKEN || process.env.TMDB_READ_TOKEN) process.exit(8);\n` +
      `const out=process.argv[process.argv.indexOf('--output-last-message')+1];\n` +
      `process.stdin.resume();process.stdin.on('end',()=>fs.writeFileSync(out,JSON.stringify({status:'matched',proposal:null,queries:[],reason:'invalid'})));\n`, { mode: 0o755 });
    process.env.PATH = `${dir}:${original.PATH}`;
    process.env.GH_TOKEN = 'must-not-leak'; process.env.TMDB_READ_TOKEN = 'must-not-leak';
    await assert.rejects(runCodex({ arbitrary: 'metadata' }, 5000), /Invalid matched decision/);
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
test('Codex schema uses supported disjoint anyOf branches', () => {
  const json = JSON.stringify(decisionSchema());
  assert.ok(json.includes('anyOf'));
  assert.ok(!json.includes('oneOf'));
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
