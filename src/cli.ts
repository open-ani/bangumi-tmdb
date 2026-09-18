import { join, resolve } from 'node:path';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { AnidbReport, Mapping, Progress, Seeds } from './model.js';
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
import { discover } from './bangumi.js';
import { loadCatalog } from './catalog.js';
import { importPending } from './pending.js';
import { writeStats } from './stats.js';
import { writeCoverage } from './coverage.js';

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
    case 'discover':
      await discover(root, { pastDays: positive('DISCOVER_PAST_DAYS', 45), futureDays: positive('DISCOVER_FUTURE_DAYS', 120),
        maxSubjects: positive('DISCOVER_MAX_SUBJECTS', 600), token: process.env.BANGUMI_TOKEN });
      break;
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
      await update(root, { maxSubjects: positive('CODEX_MAX_SUBJECTS', 60), maxAdjudications: positive('CODEX_MAX_ADJUDICATIONS', 400), maxMinutes: positive('UPDATE_MAX_MINUTES', 60),
        concurrency: positive('CODEX_CONCURRENCY', 4), scopeDays: positive('UPDATE_SCOPE_DAYS', 180),
        researchMinutes: positive('CODEX_TIMEOUT_MINUTES', 8), tmdbBudget: positive('CODEX_TMDB_BUDGET', 16), webBudget: positive('CODEX_WEB_BUDGET', 8),
        platforms: process.env.UPDATE_PLATFORMS ? process.env.UPDATE_PLATFORMS.split(',').map(p => { const n = Number(p.trim()); if (!Number.isInteger(n) || n < 0) throw new Error('UPDATE_PLATFORMS must list Bangumi platform codes'); return n; }) : undefined,
        model: process.env.CODEX_MODEL || undefined, reasoning: process.env.CODEX_REASONING || undefined });
      break;
    case 'import-pending': {
      if (!process.argv[3]) throw new Error('Usage: pnpm cli import-pending <unresolved.md> [retryDays]');
      await importPending(root, process.argv[3], Number(process.argv[4] ?? 180)); break;
    }
    case 'verify': {
      await validate();
      const { catalog } = await loadCatalog(root);
      const tmdb = new Tmdb(process.env.TMDB_READ_TOKEN ?? '');
      for (const row of await mappings(root)) await verifyMapping(row, tmdb, catalog);
      console.log('All mappings verified against Archive and live TMDB'); break;
    }
    case 'stats': await writeStats(root, positive('UPDATE_SCOPE_DAYS', 180)); break;
    case 'coverage': await writeCoverage(root); break;
    case 'guard': await guard(root, process.argv[3] ?? ''); break;
    case 'publish': await publish(root, process.argv.includes('--online')); break;
    default: throw new Error('Usage: pnpm cli <import-seed [SHA]|import-mappings|check-anidb [SHA]|archive|discover|validate|format|update|import-pending FILE [DAYS]|stats|coverage|verify|guard SHA|publish [--online]>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
