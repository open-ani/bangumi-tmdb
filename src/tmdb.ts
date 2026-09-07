import { join } from 'node:path';
import { z } from 'zod';
import { request, HttpError } from './http.js';
import { hash, readJson, writeJson } from './io.js';
import { Id, type WorkTarget, type Mapping, type Catalog } from './model.js';
import { expand } from './expand.js';

const TmdbEpisode = z.object({ id: Id, episode_number: Id, season_number: z.number().int().nonnegative(),
  name: z.string(), air_date: z.string().nullable(), overview: z.string().optional() });
const Season = z.object({ id: Id, season_number: z.number().int().nonnegative(), episodes: z.array(TmdbEpisode) });
const Work = z.object({
  id: Id, name: z.string().optional(), original_name: z.string().optional(),
  title: z.string().optional(), original_title: z.string().optional(),
  first_air_date: z.string().optional(), release_date: z.string().optional(),
  overview: z.string().optional(),
  seasons: z.array(z.object({ season_number: z.number().int().nonnegative(), name: z.string(),
    air_date: z.string().nullable(), episode_count: z.number() })).optional(),
});
export type TmdbWork = z.infer<typeof Work>;
export type TmdbSeason = z.infer<typeof Season>;
export interface Candidate { target: WorkTarget; details: TmdbWork; seasons: TmdbSeason[] }
const Cache = z.object({ expires: z.number(), value: z.unknown() });

export class Tmdb {
  private memory = new Map<string, Promise<unknown>>();
  constructor(private token: string, private cacheDir?: string, private fetcher = fetch) {
    if (!token.trim()) throw new Error('TMDB_READ_TOKEN is required');
  }
  async get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (!/^\/(tv|movie|search|find)(\/|$)/.test(path)) throw new Error('Unsupported TMDB path');
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    for (const [k, v] of Object.entries({ language: 'ja-JP', ...params })) url.searchParams.set(k, v);
    const key = url.href;
    if (this.memory.has(key)) return this.memory.get(key)!;
    const call = (async () => {
      const cacheFile = this.cacheDir ? join(this.cacheDir, `${hash(key)}.json`) : null;
      if (cacheFile) {
        try { const cached = await readJson(cacheFile, Cache); if (cached.expires > Date.now()) return cached.value; }
        catch { /* A cache miss/corrupt cache never becomes a match. */ }
      }
      const value: unknown = await (await request(url.href, { headers: {
        Authorization: `Bearer ${this.token}`, 'User-Agent': 'open-ani/bangumi-tmdb (https://github.com/open-ani/bangumi-tmdb)',
      } }, this.fetcher)).json();
      if (cacheFile) await writeJson(cacheFile, { expires: Date.now() + 86400000, value });
      return value;
    })();
    this.memory.set(key, call);
    try { return await call; } catch (error) { this.memory.delete(key); throw error; }
  }
  async work(target: WorkTarget): Promise<TmdbWork> {
    const result = Work.parse(await this.get(`/${target.type}/${target.id}`));
    if (result.id !== target.id) throw new Error('TMDB work ID mismatch');
    return result;
  }
  async season(tv: number, season: number): Promise<TmdbSeason> {
    const result = Season.parse(await this.get(`/tv/${tv}/season/${season}`));
    if (result.season_number !== season || result.episodes.some(e => e.season_number !== season))
      throw new Error('TMDB season identity mismatch');
    if (new Set(result.episodes.map(e => e.episode_number)).size !== result.episodes.length)
      throw new Error('Duplicate TMDB episode numbers');
    return result;
  }
  async search(query: string): Promise<WorkTarget[]> {
    const found: WorkTarget[] = [];
    for (const type of ['tv', 'movie'] as const) {
      const result = z.object({ results: z.array(z.object({ id: Id })) }).parse(
        await this.get(`/search/${type}`, { query, include_adult: 'true' }));
      found.push(...result.results.slice(0, 4).map(r => ({ type, id: r.id })));
    }
    return found;
  }
  async find(id: string, source: string): Promise<WorkTarget[]> {
    const result = z.object({ tv_results: z.array(z.object({ id: Id })), movie_results: z.array(z.object({ id: Id })),
      tv_episode_results: z.array(z.object({ show_id: Id })).default([]),
      tv_season_results: z.array(z.object({ show_id: Id })).default([]) })
      .parse(await this.get(`/find/${encodeURIComponent(id)}`, { external_source: source }));
    return [...result.tv_results.map(r => ({ type: 'tv' as const, id: r.id })),
      ...[...result.tv_episode_results, ...result.tv_season_results].map(r => ({ type: 'tv' as const, id: r.show_id })),
      ...result.movie_results.map(r => ({ type: 'movie' as const, id: r.id }))];
  }
  async candidate(target: WorkTarget, date: string, explicitSeason?: number): Promise<Candidate> {
    const details = await this.work(target);
    const seasons: TmdbSeason[] = [];
    if (target.type === 'tv') {
      const distance = (airDate: string | null): number => {
        const delta = Math.abs(Date.parse(airDate ?? '') - Date.parse(date));
        return Number.isFinite(delta) ? delta : Number.MAX_SAFE_INTEGER;
      };
      const chosen = [...(details.seasons ?? [])].sort((a, b) => distance(a.air_date) - distance(b.air_date)).slice(0, 3).map(s => s.season_number);
      if (explicitSeason !== undefined && !chosen.includes(explicitSeason)) chosen.unshift(explicitSeason);
      for (const number of chosen) seasons.push(await this.season(target.id, number));
    }
    return { target, details, seasons };
  }
}

const catalogIndexes = new WeakMap<Catalog, { subjects: Set<number>; episodes: Map<number, Catalog['episodes'][number]> }>();
export function checkBangumi(mapping: Mapping, catalog: Catalog): void {
  let index = catalogIndexes.get(catalog);
  if (!index) {
    index = { subjects: new Set(catalog.subjects.filter(s => s.type === 2).map(s => s.id)),
      episodes: new Map(catalog.episodes.map(e => [e.id, e])) };
    catalogIndexes.set(catalog, index);
  }
  if (!index.subjects.has(mapping.bangumiId)) throw new Error(`Subject ${mapping.bangumiId} absent from anime Archive`);
  for (const ep of mapping.episodes) {
    const current = index.episodes.get(ep.id);
    if (!current || current.subject_id !== mapping.bangumiId || current.type !== ep.type || current.sort !== ep.sort)
      throw new Error(`Stale/invalid Bangumi episode: ${ep.id}`);
  }
}
export async function verifyMapping(mapping: Mapping, tmdb: Tmdb, catalog: Catalog) {
  checkBangumi(mapping, catalog);
  for (const target of mapping.targets) await tmdb.work(target);
  const resolved = [];
  for (const entry of expand(mapping)) {
    const targets = [];
    for (const target of entry.targets) {
      if (target.type === 'movie') { targets.push(target); continue; }
      const season = await tmdb.season(target.id, target.season);
      const episode = season.episodes.find(e => e.episode_number === target.episode);
      if (!episode) throw new Error(`Missing TMDB episode: tv/${target.id}/${target.season}/${target.episode}`);
      targets.push({ ...target, episodeId: episode.id });
    }
    resolved.push({ ...entry, targets });
  }
  return resolved;
}
export function isMissing(error: unknown): boolean { return error instanceof HttpError && error.status === 404; }
