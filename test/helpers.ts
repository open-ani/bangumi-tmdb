import { Mapping, Catalog, type Episode } from '../src/model.js';

export function mapping(patch: Partial<Mapping> = {}): Mapping {
  return Mapping.parse({ schemaVersion: 1, bangumiId: 1, locked: false,
    targets: [{ type: 'tv', id: 100 }],
    episodes: [{ id: 11, type: 0, sort: 1 }, { id: 12, type: 0, sort: 2 }],
    rules: [{ bangumiType: 0, start: 1, end: 2, tmdbId: 100, season: 1, episodeStart: 1 }], overrides: [],
    provenance: { method: 'community', source: 'test', evidence: 'Synthetic test fixture', verifiedAt: '2026-01-01T00:00:00.000Z' },
    ...patch,
  });
}
export const episode = (id: number, sort: number, type = 0): Episode => ({
  id, sort, type, subject_id: 1, name: `Episode ${sort}`, name_cn: '', airdate: `2026-01-${String(sort).padStart(2, '0')}`,
});
export function catalog(row = mapping()): Catalog {
  return Catalog.parse({ snapshot: { name: 'fixture', sha256: 'a'.repeat(64), url: 'https://example.org/fixture' },
    subjects: [{ id: row.bangumiId, type: 2, name: 'Fixture', date: '2026-01-01' }],
    episodes: row.episodes.map(e => ({ ...e, subject_id: row.bangumiId })), relations: [] });
}
