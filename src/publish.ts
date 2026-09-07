import { join } from 'node:path';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Catalog, Progress } from './model.js';
import { hash, mappings, readJson, stable, writeJson } from './io.js';
import { expand, validateAll } from './expand.js';
import { Tmdb, verifyMapping } from './tmdb.js';

export async function publish(root: string, online = false): Promise<void> {
  const rows = await mappings(root);
  validateAll(rows);
  if (!rows.length) throw new Error('No mappings to publish');
  const episodes = rows.flatMap(expand);
  if (online) {
    const catalog = await readJson(join(root, '.cache/catalog.json'), Catalog);
    const tmdb = new Tmdb(process.env.TMDB_READ_TOKEN ?? '');
    episodes.length = 0;
    for (const row of rows) episodes.push(...await verifyMapping(row, tmdb, catalog));
  }
  episodes.sort((a, b) => a.bangumiEpisodeId - b.bangumiEpisodeId);
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const generatedAt = execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const sourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).length > 0;
  const progress = await readJson(join(root, 'state/progress.json'), Progress);
  const stage = join(root, '.cache/release-stage');
  await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
  await writeJson(join(stage, 'subjects.json'), { schemaVersion: 1, subjects: rows.map(row => ({ bangumiId: row.bangumiId, targets: row.targets })) });
  await writeJson(join(stage, 'episodes.json'), { schemaVersion: 1, episodes });
  await writeJson(join(stage, 'manifest.json'), {
    schemaVersion: 1, sourceCommit, sourceDirty, generatedAt, dataSha256: hash(stable(rows)), archive: progress.archive,
    onlineVerified: online,
    counts: { subjects: rows.length, episodes: episodes.length },
    files: Object.fromEntries(await Promise.all(['subjects.json', 'episodes.json'].map(async file => [file, { sha256: hash(await readFile(join(stage, file))) }]))),
  });
  await rm(join(root, 'dist'), { recursive: true, force: true });
  await rename(stage, join(root, 'dist'));
  console.log(`Built ${rows.length} subjects, ${episodes.length} episode mappings${online ? ' (online verified)' : ''}`);
}
