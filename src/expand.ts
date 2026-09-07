import type { EpisodeTarget, Mapping } from './model.js';

export interface ExpandedEpisode { bangumiId: number; bangumiEpisodeId: number; targets: EpisodeTarget[] }
export const targetKey = (t: EpisodeTarget): string => t.type === 'movie'
  ? `movie/${t.id}` : `tv/${t.id}/season/${t.season}/episode/${t.episode}`;

export function expand(mapping: Mapping): ExpandedEpisode[] {
  const workKeys = mapping.targets.map(t => `${t.type}/${t.id}`);
  if (workKeys.length === 0 || new Set(workKeys).size !== workKeys.length) throw new Error('Missing or duplicate work targets');
  const ids = new Set<number>();
  for (const ep of mapping.episodes) {
    if (ids.has(ep.id)) throw new Error(`Duplicate Bangumi episode ${ep.id}`);
    ids.add(ep.id);
  }
  const overrides = new Map<number, EpisodeTarget[]>();
  for (const override of mapping.overrides) {
    if (!ids.has(override.bangumiEpisodeId)) throw new Error('Override episode does not belong to subject');
    if (overrides.has(override.bangumiEpisodeId)) throw new Error('Duplicate override');
    overrides.set(override.bangumiEpisodeId, override.targets);
  }
  for (let i = 0; i < mapping.rules.length; i++) {
    const rule = mapping.rules[i]!;
    if (rule.end < rule.start) throw new Error('Reversed episode range');
    if (!workKeys.includes(`tv/${rule.tmdbId}`)) throw new Error('Rule targets undeclared TV work');
    for (const other of mapping.rules.slice(0, i)) {
      if (rule.bangumiType === other.bangumiType && rule.start <= other.end && other.start <= rule.end)
        throw new Error('Overlapping episode rules');
    }
    if (!mapping.episodes.some(e => e.type === rule.bangumiType && e.sort >= rule.start && e.sort <= rule.end))
      throw new Error('Rule has no Bangumi episodes');
  }
  const used = new Map<string, number>();
  return [...mapping.episodes].sort((a, b) => a.id - b.id).flatMap(ep => {
    const rule = mapping.rules.find(r => r.bangumiType === ep.type && ep.sort >= r.start && ep.sort <= r.end);
    const explicit = overrides.get(ep.id);
    let targets = explicit;
    if (targets === undefined && rule) {
      if (!Number.isInteger(ep.sort)) throw new Error('Fractional sort requires an explicit override');
      targets = [{ type: 'tv', id: rule.tmdbId, season: rule.season, episode: rule.episodeStart + ep.sort - rule.start }];
    }
    if (!targets?.length) return [];
    const keys = targets.map(targetKey);
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate episode target');
    for (const target of targets) {
      if (!workKeys.includes(`${target.type}/${target.id}`)) throw new Error('Episode targets undeclared work');
      const key = targetKey(target);
      // Many Bangumi episodes may intentionally point to one movie. TV collisions need a future explicit schema.
      if (target.type === 'tv' && used.has(key)) throw new Error(`Duplicate TMDB episode target: ${key}`);
      used.set(key, ep.id);
    }
    return [{ bangumiId: mapping.bangumiId, bangumiEpisodeId: ep.id, targets }];
  });
}

export function validateAll(rows: Mapping[]): void {
  const subjects = new Set<number>();
  const episodes = new Set<number>();
  const targets = new Map<string, number>();
  for (const row of rows) {
    if (subjects.has(row.bangumiId)) throw new Error('Duplicate subject');
    subjects.add(row.bangumiId);
    for (const ep of row.episodes) {
      if (episodes.has(ep.id)) throw new Error(`Episode belongs to multiple subjects: ${ep.id}`);
      episodes.add(ep.id);
    }
    for (const ep of expand(row)) for (const target of ep.targets) {
      if (target.type !== 'tv') continue;
      const key = targetKey(target);
      if (targets.has(key)) throw new Error(`TMDB episode claimed by subjects ${targets.get(key)} and ${row.bangumiId}: ${key}`);
      targets.set(key, row.bangumiId);
    }
  }
}
