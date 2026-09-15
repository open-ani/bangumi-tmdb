import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Catalog, Episode, Id, Progress, Subject, type Fresh, type FreshSubject } from './model.js';
import { cacheDir, mappings, readJson, writeJson } from './io.js';
import { dumpTime, readFresh } from './catalog.js';

const API = 'https://api.bgm.tv';
const USER_AGENT = 'open-ani/bangumi-tmdb (https://github.com/open-ani/bangumi-tmdb)';
const DAY = 86400000;
const InfoboxValue = z.union([z.string(), z.array(z.object({ k: z.string().optional(), v: z.string() }))]);
const ApiSubject = z.object({
  id: Id, type: z.number(), name: z.string(), name_cn: z.string().nullable().default(''),
  date: z.string().nullable().default(null), platform: z.string().nullable().optional(),
  summary: z.string().nullable().default(''), infobox: z.array(z.object({ key: z.string(), value: InfoboxValue })).nullable().default(null),
});
const ApiEpisode = z.object({
  id: Id, subject_id: Id, type: z.number().int().nonnegative(), sort: z.number().nonnegative(),
  name: z.string().nullable().default(''), name_cn: z.string().nullable().default(''), airdate: z.string().nullable().default(''),
});
const page = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), total: z.number().int().nonnegative() });

// Render the API's structured infobox like the Archive's wiki text so both sources look alike to readers.
export function renderInfobox(items: { key: string; value: z.infer<typeof InfoboxValue> }[] | null): string {
  if (!items?.length) return '';
  const lines = items.map(({ key, value }) => typeof value === 'string' ? `|${key}= ${value}`
    : `|${key}={\r\n${value.map(v => v.k ? `[${v.k}|${v.v}]` : `[${v.v}]`).join('\r\n')}\r\n}`);
  return `{{Infobox\r\n${lines.join('\r\n')}\r\n}}`;
}
export function toSubject(raw: unknown): Subject {
  const api = ApiSubject.parse(raw);
  return Subject.parse({ id: api.id, type: api.type, name: api.name, name_cn: api.name_cn ?? '', date: api.date ?? '',
    infobox: renderInfobox(api.infobox), summary: api.summary ?? '', ...(api.platform ? { platform: api.platform } : {}) });
}
export function toEpisode(raw: unknown): Episode {
  const api = ApiEpisode.parse(raw);
  return Episode.parse({ id: api.id, subject_id: api.subject_id, type: api.type, sort: api.sort,
    name: api.name ?? '', name_cn: api.name_cn ?? '', airdate: api.airdate ?? '' });
}
export type Lookup = { status: 'ok'; subject: Subject } | { status: 'merged'; target: number } | { status: 'missing' };

export class Bangumi {
  constructor(private token = '', private fetcher: typeof fetch = fetch, private pauseMs = 150) {}
  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try { response = await this.fetcher(`${API}${path}`, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(30000) }); }
      catch (error) { if (attempt >= 3) throw error; await delay(1000 * 2 ** attempt); continue; }
      if (response.status !== 429 && response.status < 500) { if (this.pauseMs) await delay(this.pauseMs); return response; }
      await response.body?.cancel();
      if (attempt >= 3) throw new Error(`Bangumi HTTP ${response.status}: ${path}`);
      const retry = Number(response.headers.get('retry-after'));
      await delay(Number.isFinite(retry) && retry > 0 ? Math.min(60000, retry * 1000) : 1000 * 2 ** attempt);
    }
  }
  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.call(path, init);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Bangumi HTTP ${response.status}: ${path}`); }
    return response.json();
  }
  async subject(id: number): Promise<Lookup> {
    const response = await this.call(`/v0/subjects/${id}`);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const target = /\/v0\/subjects\/([1-9]\d*)/.exec(response.headers.get('location') ?? '');
      if (!target) throw new Error(`Bangumi redirect without a subject target: ${id}`);
      return { status: 'merged', target: Number(target[1]) };
    }
    if (response.status === 404) { await response.body?.cancel(); return { status: 'missing' }; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Bangumi HTTP ${response.status}: /v0/subjects/${id}`); }
    return { status: 'ok', subject: toSubject(await response.json()) };
  }
  async episodes(subjectId: number): Promise<Episode[]> {
    const result: Episode[] = [];
    for (let offset = 0; ; offset += 200) {
      const body = page(z.unknown()).parse(await this.json(`/v0/episodes?subject_id=${subjectId}&limit=200&offset=${offset}`));
      result.push(...body.data.map(toEpisode));
      if (body.data.length < 200 || result.length >= body.total) break;
      if (offset > 20000) throw new Error(`Episode list too long: ${subjectId}`);
    }
    if (new Set(result.map(e => e.id)).size !== result.length) throw new Error(`Duplicate episode IDs: ${subjectId}`);
    if (result.some(e => e.subject_id !== subjectId)) throw new Error(`Foreign episode in listing: ${subjectId}`);
    return result;
  }
  // Anime subjects whose air date falls in [from, to]; the API caps pages at 20 rows.
  async search(from: string, to: string, maxPages = 200): Promise<Subject[]> {
    const result = new Map<number, Subject>();
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const body = page(z.unknown()).parse(await this.json(`/v0/search/subjects?limit=20&offset=${pageIndex * 20}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: '', sort: 'match', filter: { type: [2], air_date: [`>=${from}`, `<=${to}`] } }),
      }));
      for (const raw of body.data) { const subject = toSubject(raw); if (subject.type === 2) result.set(subject.id, subject); }
      if (body.data.length < 20 || (pageIndex + 1) * 20 >= body.total) break;
    }
    return [...result.values()];
  }
  async calendar(): Promise<number[]> {
    const days = z.array(z.object({ items: z.array(z.object({ id: Id, type: z.number() })) })).parse(await this.json('/calendar'));
    return [...new Set(days.flatMap(d => d.items.filter(i => i.type === 2).map(i => i.id)))];
  }
}
export interface DiscoverOptions {
  now?: number; pastDays: number; futureDays: number; maxSubjects: number; token?: string; fetcher?: typeof fetch; pauseMs?: number;
}
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// Choose which subjects need fresh API data today: mapped rows the Archive no longer carries (locked
// subjects), recently or soon airing works, calendar entries, mapped rows whose episodes are airing, and
// pending retries that are about to come due. The result overlays the Archive until the next dump.
export async function discover(root: string, options: DiscoverOptions): Promise<{ fetched: number; merged: number; missing: number; failed: number }> {
  const now = options.now ?? Date.now();
  const api = new Bangumi(options.token ?? '', options.fetcher, options.pauseMs);
  const archive = await readJson(join(cacheDir(root), 'catalog.json'), Catalog);
  const rows = await mappings(root);
  const progress = await readJson(join(root, 'state/progress.json'), Progress);
  const since = dumpTime(archive.snapshot);
  const previous = await readFresh(root);
  const subjects = new Map(archive.subjects.map(s => [s.id, s]));
  const airing = new Set<number>();
  for (const ep of archive.episodes) {
    const at = Date.parse(ep.airdate);
    if (Number.isFinite(at) && Math.abs(at - now) <= 30 * DAY) airing.add(ep.subject_id);
  }
  const searched = new Map<number, Subject>();
  for (const s of await api.search(isoDate(now - options.pastDays * DAY), isoDate(now + options.futureDays * DAY))) searched.set(s.id, s);
  const wanted: number[] = [];
  const push = (ids: Iterable<number>) => { for (const id of ids) if (!wanted.includes(id)) wanted.push(id); };
  push(rows.filter(r => !subjects.has(r.bangumiId)).map(r => r.bangumiId));
  push(searched.keys());
  push(await api.calendar());
  push(rows.filter(r => {
    const s = subjects.get(r.bangumiId);
    const at = Date.parse(s?.date ?? '');
    return airing.has(r.bangumiId) || (Number.isFinite(at) && at >= now - 200 * DAY && at <= now + 400 * DAY);
  }).map(r => r.bangumiId));
  push(Object.entries(progress.subjects).filter(([, p]) => p.status !== 'matched' && Date.parse(p.retryAt) <= now + DAY).map(([id]) => Number(id)));
  const selected = wanted.slice(0, options.maxSubjects);
  const fetchedAt = new Date(now).toISOString();
  const fresh: Map<number, FreshSubject> = new Map((previous?.subjects ?? []).filter(e => Date.parse(e.fetchedAt) > since).map(e => [e.subject.id, e]));
  const missing = new Map((previous?.missing ?? []).filter(m => Date.parse(m.fetchedAt) > since).map(m => [m.id, m]));
  let fetched = 0, failed = 0;
  for (const id of selected) {
    try {
      const lookup: Lookup = searched.has(id) ? { status: 'ok', subject: searched.get(id)! } : await api.subject(id);
      if (lookup.status !== 'ok') { missing.set(id, { id, fetchedAt, status: lookup.status, ...(lookup.status === 'merged' ? { target: lookup.target } : {}) }); fresh.delete(id); continue; }
      if (lookup.subject.type !== 2) { missing.set(id, { id, fetchedAt, status: 'missing' }); fresh.delete(id); continue; }
      fresh.set(id, { fetchedAt, subject: lookup.subject, episodes: await api.episodes(id) });
      missing.delete(id); fetched++;
    } catch (error) {
      failed++;
      console.warn(`Bangumi fetch failed for ${id}: ${String(error)}`);
      if (failed > 25 && fetched === 0) throw new Error('Bangumi API unavailable; keeping the previous overlay');
    }
  }
  const output: Fresh = { schemaVersion: 1,
    subjects: [...fresh.values()].sort((a, b) => a.subject.id - b.subject.id),
    missing: [...missing.values()].sort((a, b) => a.id - b.id) };
  await writeJson(join(cacheDir(root), 'bangumi-fresh.json'), output);
  const merged = output.missing.filter(m => m.status === 'merged').length;
  console.log(`Bangumi API: refreshed ${fetched} of ${selected.length} selected subjects (${wanted.length} wanted); ${failed} failed; overlay now ${output.subjects.length} subjects, ${merged} merged, ${output.missing.length - merged} missing`);
  return { fetched, merged, missing: output.missing.length - merged, failed };
}
