import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { Catalog, Episode, Relation, Subject } from './model.js';
import { readJson, writeJson } from './io.js';
import { request } from './http.js';

const Latest = z.object({ name: z.string().regex(/^dump-[\w.\-]+\.zip$/),
  browser_download_url: z.string().url(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) });
export async function digestFile(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}
async function* archiveLines(zip: string, member: string): AsyncGenerator<unknown> {
  const child = spawn('unzip', ['-p', zip, member], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000); });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`unzip ${member}: ${code}: ${stderr}`)));
  });
  // Prevent an early process failure from becoming an unhandled rejection while consuming lines.
  void done.catch(() => {});
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (line.trim()) yield JSON.parse(line);
    }
    await done;
  } finally { if (child.exitCode === null) child.kill(); }
}
export async function parseArchive(zip: string, snapshot: Catalog['snapshot']): Promise<Catalog> {
  const subjects: Catalog['subjects'] = [];
  const episodes: Catalog['episodes'] = [];
  const relations: Catalog['relations'] = [];
  for await (const raw of archiveLines(zip, 'subject.jsonlines')) {
    if ((raw as { type?: number }).type === 2) subjects.push(Subject.parse(raw));
  }
  const ids = new Set(subjects.map(s => s.id));
  if (ids.size !== subjects.length || ids.size === 0) throw new Error('Duplicate or empty anime subjects in Archive');
  for await (const raw of archiveLines(zip, 'episode.jsonlines')) {
    if (ids.has((raw as { subject_id: number }).subject_id)) episodes.push(Episode.parse(raw));
  }
  if (new Set(episodes.map(e => e.id)).size !== episodes.length) throw new Error('Duplicate Archive episode IDs');
  for await (const raw of archiveLines(zip, 'subject-relations.jsonlines')) {
    const rel = raw as { subject_id: number; related_subject_id: number };
    if (ids.has(rel.subject_id) && ids.has(rel.related_subject_id)) relations.push(Relation.parse(raw));
  }
  subjects.sort((a, b) => a.id - b.id); episodes.sort((a, b) => a.id - b.id);
  relations.sort((a, b) => a.subject_id - b.subject_id || a.related_subject_id - b.related_subject_id || a.relation_type - b.relation_type);
  return { snapshot, subjects, episodes, relations };
}
export async function syncArchive(root: string): Promise<Catalog> {
  const latest = Latest.parse(await (await request('https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json')).json());
  const url = new URL(latest.browser_download_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/bangumi/Archive/releases/download/'))
    throw new Error('Unexpected Archive download origin');
  const snapshot = { name: latest.name, sha256: latest.digest.slice(7), url: url.href };
  const catalogPath = join(root, '.cache/catalog.json');
  try {
    const existing = await readJson(catalogPath, Catalog);
    if (existing.snapshot.sha256 === snapshot.sha256) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Rebuilding invalid Archive cache');
  }
  const zip = join(root, '.cache/bangumi.zip');
  await mkdir(join(root, '.cache'), { recursive: true });
  let valid = false;
  try { valid = await digestFile(zip) === snapshot.sha256; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!valid) {
    const temp = `${zip}.download`;
    try {
      const response = await request(url.href, { signal: AbortSignal.timeout(15 * 60000) });
      if (!response.body) throw new Error('Archive response is empty');
      // Enforce both a deadline and a generous size ceiling without buffering the dump.
      let bytes = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 2_000_000_000 ? new Error('Archive exceeds 2 GB') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as never), limit, createWriteStream(temp));
      if (await digestFile(temp) !== snapshot.sha256) throw new Error('Archive SHA-256 mismatch');
      await rename(temp, zip);
    } finally { await rm(temp, { force: true }); }
  }
  const catalog = await parseArchive(zip, snapshot);
  await writeJson(catalogPath, catalog);
  console.log(`Archive ${basename(zip)}: ${catalog.subjects.length} anime, ${catalog.episodes.length} episodes`);
  return catalog;
}
