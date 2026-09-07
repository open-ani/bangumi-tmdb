import { join, resolve } from 'node:path';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { AnidbReport, Catalog, Mapping, Progress, Seeds } from './model.js';
import { mappings, readJson, stable, writeJson } from './io.js';
import { schemas } from './schemas.js';
import { validateAll } from './expand.js';
import { importSeed, importMappings } from './seed.js';
import { syncArchive } from './archive.js';
import { update } from './update.js';
import { Tmdb, verifyMapping } from './tmdb.js';
import { publish } from './publish.js';
import { guard } from './guard.js';
import { checkAnidb } from './anidb.js';

const root = resolve(process.env.DATASET_ROOT ?? '.');
const command = process.argv[2];
function positive(name: string, fallback: number): number {
  const n = Number(process.env[name] || fallback);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}
async function validate(): Promise<void> {
  const rows = await mappings(root); validateAll(rows);
  await readJson(join(root, 'state/progress.json'), Progress);
  const seed = await readJson(join(root, 'sources/seed.json'), Seeds);
  try { await readJson(join(root, 'sources/anidb-check.json'), AnidbReport); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (new Set(seed.rows.map(r => r.bangumiId)).size !== seed.rows.length) throw new Error('Duplicate seed subjects');
  for (const [name, value] of Object.entries(schemas())) {
    if (stable(value) !== await readFile(join(root, `schemas/${name}.schema.json`), 'utf8')) throw new Error(`Stale ${name} schema; run pnpm schemas`);
  }
  console.log(`Validated ${rows.length} mappings and ${seed.rows.length} seed candidates`);
}
try {
  switch (command) {
    case 'import-seed': await importSeed(root, process.argv[3]); break;
    case 'import-mappings': await importMappings(root); break;
    case 'check-anidb': await checkAnidb(root, process.argv[3]); break;
    case 'archive': await syncArchive(root); break;
    case 'validate': await validate(); break;
    case 'format':
      for (const name of await readdir(join(root, 'data'))) {
        if (!/^[1-9]\d*\.json$/.test(name)) continue;
        const path = join(root, 'data', name);
        if (!(await lstat(path)).isFile()) throw new Error('Data must be a regular file');
        await writeJson(path, await readJson(path, Mapping));
      }
      break;
    case 'update':
      await update(root, { maxSubjects: positive('CODEX_MAX_SUBJECTS', 100), maxMinutes: positive('UPDATE_MAX_MINUTES', 60), model: process.env.CODEX_MODEL });
      break;
    case 'verify': {
      await validate();
      const catalog = await readJson(join(root, '.cache/catalog.json'), Catalog);
      const tmdb = new Tmdb(process.env.TMDB_READ_TOKEN ?? '');
      for (const row of await mappings(root)) await verifyMapping(row, tmdb, catalog);
      console.log('All mappings verified against Archive and live TMDB'); break;
    }
    case 'guard': await guard(root, process.argv[3] ?? ''); break;
    case 'publish': await publish(root, process.argv.includes('--online')); break;
    default: throw new Error('Usage: pnpm cli <import-seed [SHA]|import-mappings|check-anidb [SHA]|archive|validate|format|update|verify|guard SHA|publish [--online]>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
