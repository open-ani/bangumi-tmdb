import type { Episode, Proposal, SeedRow, Subject, WorkTarget } from './model.js';
import { Tmdb, isMissing, type Candidate } from './tmdb.js';

export const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('ja').replace(/[\p{P}\p{Z}\p{S}]/gu, '');
export function names(subject: Subject): string[] {
  // Preserve season/cour markers. Parsing arbitrary infobox syntax is left to Codex, not a lossy regex.
  return [...new Set([subject.name, subject.name_cn].filter(Boolean))];
}
export async function candidates(subject: Subject, seed: SeedRow | undefined, tmdb: Tmdb): Promise<Candidate[]> {
  const targets: WorkTarget[] = [];
  if (seed?.tmdb) targets.push({ type: seed.tmdb.type, id: seed.tmdb.id });
  for (const [id, source] of [[seed?.imdb, 'imdb_id'], [seed?.tvdb?.toString(), 'tvdb_id'], [seed?.wikidata, 'wikidata_id']] as const) {
    if (id) targets.push(...await tmdb.find(id, source));
  }
  for (const name of names(subject)) targets.push(...await tmdb.search(name));
  const unique = [...new Map(targets.map(t => [`${t.type}/${t.id}`, t])).values()].slice(0, 10);
  const result: Candidate[] = [];
  for (const target of unique) {
    try {
      result.push(await tmdb.candidate(target, subject.date,
        seed?.tmdb?.type === 'tv' && target.type === 'tv' && target.id === seed.tmdb.id ? seed.tmdb.season : undefined));
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  return result;
}

export function deterministic(subject: Subject, episodes: Episode[], seed: SeedRow | undefined, choices: Candidate[]): Proposal | null {
  if (!seed?.tmdb) return null;
  const choice = choices.find(c => c.target.type === seed.tmdb!.type && c.target.id === seed.tmdb!.id);
  if (!choice) return null;
  const originalNames = names(subject).map(normalize);
  const titleMatch = [choice.details.name, choice.details.original_name, choice.details.title, choice.details.original_title]
    .some(n => n && normalize(n) && originalNames.includes(normalize(n)));
  const regular = episodes.filter(e => e.type === 0);
  if (seed.tmdb.type === 'movie') {
    if (!titleMatch || !/^\d{4}-\d{2}-\d{2}$/.test(subject.date) || subject.date !== choice.details.release_date) return null;
    return { targets: [choice.target], rules: [], overrides: regular.length === 1
      ? [{ bangumiEpisodeId: regular[0]!.id, targets: [choice.target as { type: 'movie'; id: number }] }] : [] };
  }
  // A bare TV link is deliberately insufficient to choose a season.
  if (seed.tmdb.season === undefined || regular.length === 0 || seed.tmdb.episode !== undefined) return null;
  const seasonNumber = seed.tmdb.season;
  const season = choice.seasons.find(s => s.season_number === seasonNumber);
  if (!season || regular.length !== season.episodes.length) return null;
  // Each episode needs its own corroborating exact title AND date, not a guessed offset.
  for (const ep of regular) {
    const remote = season.episodes.find(t => t.episode_number === ep.sort);
    if (!remote || !ep.airdate || ep.airdate !== remote.air_date || !normalize(remote.name) ||
      ![ep.name, ep.name_cn].filter(Boolean).map(normalize).includes(normalize(remote.name))) return null;
  }
  return { targets: [choice.target], rules: [], overrides: regular.map(ep => ({
    bangumiEpisodeId: ep.id, targets: [{ type: 'tv', id: seed.tmdb!.id, season: season.season_number, episode: ep.sort }],
  })) };
}

export async function extraCandidates(queries: string[], date: string, tmdb: Tmdb): Promise<Candidate[]> {
  const result: Candidate[] = [];
  for (const query of queries) {
    const locator = /^(tv|movie)\/([1-9]\d*)(?:\/season\/(\d+))?$/.exec(query);
    const targets = locator ? [{ type: locator[1] as 'tv' | 'movie', id: Number(locator[2]) }] : (await tmdb.search(query)).slice(0, 4);
    for (const target of targets) {
      try { result.push(await tmdb.candidate(target, date, locator?.[3] === undefined ? undefined : Number(locator[3]))); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
  }
  return result;
}
