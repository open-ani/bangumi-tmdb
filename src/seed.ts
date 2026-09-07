import { SeedRow, Seeds } from './model.js';
import { hash, writeJson } from './io.js';
import { request } from './http.js';
import { join } from 'node:path';

export const SEED_COMMIT = '8f853e6bf9d6cb382448091ce3afaf2d9cdb0a3f';
export function parseLink(link: string): SeedRow['tmdb'] {
  const movie = /^movie\/([1-9]\d*)$/.exec(link);
  if (movie) return { type: 'movie', id: Number(movie[1]) };
  const tv = /^tv\/([1-9]\d*)(?:\/season\/(\d+)(?:\/episode\/([1-9]\d*))?)?$/.exec(link);
  if (!tv) throw new Error(`Invalid TMDB link: ${link}`);
  return { type: 'tv', id: Number(tv[1]),
    ...(tv[2] !== undefined ? { season: Number(tv[2]) } : {}),
    ...(tv[3] !== undefined ? { episode: Number(tv[3]) } : {}) };
}
export function cleanSeed(input: unknown): { rows: SeedRow[]; rejected: { index: number; reason: string }[] } {
  if (!Array.isArray(input)) throw new Error('Seed must be an array');
  const rows = new Map<number, SeedRow>();
  const conflicts = new Set<number>();
  const rejected: { index: number; reason: string }[] = [];
  input.forEach((raw: Record<string, unknown>, index) => {
    try {
      const row = SeedRow.parse({
        bangumiId: Number(raw.bgm_id),
        ...(raw.tmdb_id ? { tmdb: parseLink(String(raw.tmdb_id)) } : {}),
        ...(raw.imdb_id ? { imdb: raw.imdb_id } : {}),
        ...(raw.tvdb_id ? { tvdb: Number(raw.tvdb_id) } : {}),
        ...(raw.wikidata_id ? { wikidata: raw.wikidata_id } : {}),
      });
      if (!row.tmdb && !row.imdb && !row.tvdb && !row.wikidata) return;
      if (conflicts.has(row.bangumiId)) throw new Error(`Conflicting subject ${row.bangumiId}`);
      const previous = rows.get(row.bangumiId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row)) {
        rows.delete(row.bangumiId); conflicts.add(row.bangumiId);
        throw new Error(`Conflicting subject ${row.bangumiId}`);
      }
      rows.set(row.bangumiId, row);
    } catch (error) { rejected.push({ index, reason: String(error) }); }
  });
  return { rows: [...rows.values()].sort((a, b) => a.bangumiId - b.bangumiId), rejected };
}
export async function importSeed(root: string, commit = SEED_COMMIT): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Seed requires a pinned commit SHA');
  const url = `https://raw.githubusercontent.com/Rhilip/BangumiExtLinker/${commit}/data/anime_map.json`;
  const body = await (await request(url)).text();
  const { rows, rejected } = cleanSeed(JSON.parse(body));
  if (!rows.length) throw new Error('Empty seed import');
  const seed = Seeds.parse({ schemaVersion: 1, repository: 'Rhilip/BangumiExtLinker', commit, sha256: hash(body), rows });
  await writeJson(join(root, 'sources/seed.json'), seed);
  await writeJson(join(root, 'sources/import-report.json'), { commit, candidates: rows.length, rejected });
  console.log(`Imported ${rows.length} candidates (${rows.filter(r => r.tmdb).length} TMDB links); ${rejected.length} rejected. Not yet verified mappings.`);
}
