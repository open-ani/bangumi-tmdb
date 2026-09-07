import { join } from 'node:path';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Catalog } from './model.js';
import { hash, mappings, readJson, writeJson } from './io.js';
import { validateAll } from './expand.js';
import { Tmdb, verifyMapping } from './tmdb.js';

export async function publish(root: string): Promise<void> {
  const catalog = await readJson(join(root, '.cache/catalog.json'), Catalog);
  const rows = await mappings(root);
  validateAll(rows);
  if (!rows.length) throw new Error('No verified mappings; refusing to publish an empty dataset');
  const tmdb = new Tmdb(process.env.TMDB_READ_TOKEN ?? ''); // A release never trusts the disk HTTP cache.
  const episodes = [];
  for (const row of rows) episodes.push(...await verifyMapping(row, tmdb, catalog));
  episodes.sort((a, b) => a.bangumiEpisodeId - b.bangumiEpisodeId);
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const generatedAt = execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const stage = join(root, '.cache/release-stage');
  await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
  await writeJson(join(stage, 'subjects.json'), { schemaVersion: 1, subjects: rows.map(row => ({ bangumiId: row.bangumiId, targets: row.targets })) });
  await writeJson(join(stage, 'episodes.json'), { schemaVersion: 1, episodes });
  await writeJson(join(stage, 'manifest.json'), {
    schemaVersion: 1, sourceCommit, generatedAt, archive: catalog.snapshot,
    counts: { subjects: rows.length, episodes: episodes.length, archiveSubjects: catalog.subjects.length },
    files: Object.fromEntries(await Promise.all(['subjects.json', 'episodes.json'].map(async file => [file, { sha256: hash(await readFile(join(stage, file))) }]))),
  });
  await rm(join(root, 'dist'), { recursive: true, force: true });
  await rename(stage, join(root, 'dist'));
  console.log(`Release validated: ${rows.length} subjects, ${episodes.length} episodes, commit ${sourceCommit}`);
}
