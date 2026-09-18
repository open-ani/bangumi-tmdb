import { join } from 'node:path';
import { z } from 'zod';
import { Progress, type Catalog, type Episode, type EpisodeTarget, type Mapping } from './model.js';
import { writeFile } from 'node:fs/promises';
import { cacheDir, mappings, readJson } from './io.js';
import { loadCatalog } from './catalog.js';
import { expand } from './expand.js';
import { Tmdb } from './tmdb.js';

// Where every subject and episode stands, for anyone deciding what to fix next: whether the subject is
// mapped, how much of it is mapped, and whether TMDB actually has an image for each mapped episode.
// Written to sources/coverage.json by the scheduled run and shipped with each release.
export const Status = z.enum(['complete', 'partial', 'season-only', 'work-only', 'movie', 'no-episodes', 'unresolved', 'unanalyzed']);
export const CoverageSubject = z.strictObject({
  bangumiId: z.number().int().positive(), name: z.string(), date: z.string(), platform: z.union([z.number(), z.string()]).nullable(),
  status: Status,
  regular: z.number().int(), aired: z.number().int(), mapped: z.number().int(),
  // Aired regular episodes without a TMDB target; for an unmapped subject that is every aired episode, so the list is left empty.
  missing: z.array(z.number().int()),
  // Mapped regular episodes whose TMDB episode (or film) has no image.
  noImage: z.array(z.number().int()),
  images: z.strictObject({ checked: z.number().int(), present: z.number().int() }),
});
export const Coverage = z.strictObject({
  schemaVersion: z.literal(1), generatedAt: z.iso.datetime(), archive: z.string().nullable(), subjects: z.array(CoverageSubject),
});
export type CoverageSubject = z.infer<typeof CoverageSubject>;
export type Coverage = z.infer<typeof Coverage>;

export interface ImageSource {
  // True, false, or null when TMDB could not be consulted (the episode then counts as unchecked).
  has(target: EpisodeTarget): Promise<boolean | null>;
}
export function imageSource(tmdb: Tmdb): ImageSource {
  const failed = new Set<string>();
  return { async has(target) {
    const key = target.type === 'movie' ? `movie/${target.id}` : `tv/${target.id}/${target.season}`;
    if (failed.has(key)) return null;
    try {
      if (target.type === 'movie') { const work = await tmdb.work(target); return Boolean(work.poster_path || work.backdrop_path); }
      const season = await tmdb.season(target.id, target.season);
      return Boolean(season.episodes.find(e => e.episode_number === target.episode)?.still_path);
    } catch { failed.add(key); return null; }
  } };
}
export function classify(row: Mapping | undefined, pending: boolean, regular: Episode[], aired: Episode[], mapped: Set<number>): z.infer<typeof Status> {
  if (!row) return pending ? 'unresolved' : 'unanalyzed';
  if (!regular.length) return 'no-episodes';
  const episodeLevel = row.rules.length || row.overrides.length;
  if (row.targets.every(t => t.type === 'movie')) return episodeLevel ? 'movie' : 'work-only';
  if (!episodeLevel) return row.targets.some(t => t.type === 'tv' && t.season === undefined) ? 'work-only' : 'season-only';
  return aired.every(e => mapped.has(e.id)) ? 'complete' : 'partial';
}
export async function computeCoverage(catalog: Catalog, rows: Mapping[], progress: Progress, images: ImageSource, now: number): Promise<Coverage> {
  const byId = new Map(rows.map(r => [r.bangumiId, r]));
  const episodes = new Map<number, Episode[]>();
  for (const ep of catalog.episodes) { const list = episodes.get(ep.subject_id) ?? []; list.push(ep); episodes.set(ep.subject_id, list); }
  const today = new Date(now).toISOString().slice(0, 10);
  const subjects: CoverageSubject[] = [];
  for (const subject of [...catalog.subjects].sort((a, b) => a.id - b.id)) {
    const row = byId.get(subject.id);
    const regular = (episodes.get(subject.id) ?? []).filter(e => e.type === 0).sort((a, b) => a.sort - b.sort);
    const aired = regular.filter(e => e.airdate && e.airdate <= today);
    const targets = new Map<number, EpisodeTarget[]>(row ? expand(row).map(e => [e.bangumiEpisodeId, e.targets]) : []);
    const mapped = new Set([...targets.keys()].filter(id => regular.some(e => e.id === id)));
    const noImage: number[] = []; let checked = 0, present = 0;
    for (const e of regular) {
      const list = targets.get(e.id); if (!list?.length) continue;
      const verdicts = await Promise.all(list.map(t => images.has(t)));
      if (verdicts.some(v => v === null)) continue;
      checked++;
      if (verdicts.some(Boolean)) present++; else noImage.push(e.id);
    }
    subjects.push({
      bangumiId: subject.id, name: subject.name_cn || subject.name, date: subject.date, platform: subject.platform ?? null,
      status: classify(row, progress.subjects[String(subject.id)]?.status === 'pending', regular, aired, mapped),
      regular: regular.length, aired: aired.length, mapped: mapped.size,
      missing: row ? aired.filter(e => !mapped.has(e.id)).map(e => e.id) : [], noImage, images: { checked, present },
    });
  }
  return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), archive: catalog.snapshot.name, subjects };
}
export function summarize(coverage: Coverage): string {
  const counts: Record<string, number> = {};
  for (const s of coverage.subjects) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const checked = coverage.subjects.reduce((n, s) => n + s.images.checked, 0), present = coverage.subjects.reduce((n, s) => n + s.images.present, 0);
  const allImages = coverage.subjects.filter(s => s.images.checked && s.images.present === s.images.checked).length;
  const noImages = coverage.subjects.filter(s => s.images.checked && !s.images.present).length;
  return `Coverage: ${coverage.subjects.length} subjects (${Status.options.map(k => `${counts[k] ?? 0} ${k}`).join(', ')}); `
    + `images on ${present}/${checked} mapped episodes; ${allImages} subjects fully illustrated, ${noImages} without any image`;
}
export async function writeCoverage(root: string, now = Date.now()): Promise<Coverage> {
  const { catalog } = await loadCatalog(root);
  const rows = await mappings(root);
  const progress = await readJson(join(root, 'state/progress.json'), Progress);
  const tmdb = new Tmdb(process.env.TMDB_READ_TOKEN ?? '', join(cacheDir(root), 'tmdb'));
  const coverage = await computeCoverage(catalog, rows, progress, imageSource(tmdb), now);
  // One subject per line keeps the file compact and its daily diff readable.
  const { subjects, ...head } = coverage;
  await writeFile(join(root, 'sources/coverage.json'), `${JSON.stringify(head).slice(0, -1)},"subjects":[\n${subjects.map(s => JSON.stringify(s)).join(',\n')}\n]}\n`);
  console.log(summarize(coverage));
  return coverage;
}
