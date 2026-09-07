import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { AnidbReport, Catalog, Seeds, type AnidbCheck, type SubjectTarget, type Subject } from './model.js';
import { hash, mappings, readJson, writeJson } from './io.js';
import { request } from './http.js';
import { normalize } from './match.js';

const TITLES_URL = 'https://anidb.net/api/anime-titles.xml.gz';
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false,
  parseTagValue: false, processEntities: false, isArray: name => name === 'anime' || name === 'title' });
function xml(text: string): unknown {
  if (/<!DOCTYPE/i.test(text) || XMLValidator.validate(text) !== true) throw new Error('Invalid AniDB XML');
  return parser.parse(text);
}
export function parseTitles(text: string): Map<number, string[]> {
  const data = z.object({ animetitles: z.object({ anime: z.array(z.object({ aid: z.coerce.number().int().positive(),
    title: z.array(z.object({ '#text': z.string() })) })) }) }).parse(xml(text));
  return new Map(data.animetitles.anime.map(a => [a.aid, a.title.map(t => t['#text'])]));
}
export interface AniLink { targets: SubjectTarget[]; offset: number | null }
export function parseAniLinks(text: string): Map<number, AniLink> {
  const data = z.object({ 'anime-list': z.object({ anime: z.array(z.object({ anidbid: z.coerce.number().int().positive(),
    tmdbid: z.string().optional(), tmdbtv: z.string().optional(), tmdbseason: z.string().optional(), tmdboffset: z.string().optional(),
  })) }) }).parse(xml(text));
  const result = new Map<number, AniLink>();
  for (const row of data['anime-list'].anime) {
    const targets: SubjectTarget[] = [];
    for (const id of (row.tmdbid ?? '').split(',').map(s => s.trim()).filter(s => /^[1-9]\d*$/.test(s)))
      targets.push({ type: 'movie', id: Number(id) });
    if (/^[1-9]\d*$/.test(row.tmdbtv ?? '')) targets.push({ type: 'tv', id: Number(row.tmdbtv),
      ...(/^\d+$/.test(row.tmdbseason ?? '') ? { season: Number(row.tmdbseason) } : {}) });
    const offset = /^-?\d+$/.test(row.tmdboffset ?? '') ? Number(row.tmdboffset) : null;
    if (result.has(row.anidbid)) throw new Error(`Duplicate AniDB mapping ${row.anidbid}`);
    result.set(row.anidbid, { targets, offset });
  }
  return result;
}
export function compareTargets(actual: SubjectTarget[], expected: SubjectTarget[]): AnidbCheck['status'] {
  if (!expected.length) return 'no-tmdb';
  if (!actual.length) return 'candidate';
  const compatible = (a: SubjectTarget, e: SubjectTarget) => a.type === e.type && a.id === e.id &&
    !(a.type === 'tv' && e.type === 'tv' && a.season !== undefined && e.season !== undefined && a.season !== e.season);
  if (actual.some(a => !expected.some(e => compatible(a, e)))) return 'conflict';
  const exact = (a: SubjectTarget, e: SubjectTarget) => compatible(a, e) &&
    (a.type === 'movie' || (e.type === 'tv' && a.season === e.season && a.episode === undefined && e.episode === undefined));
  return actual.length === expected.length && actual.every(a => expected.some(e => exact(a, e))) ? 'agree' : 'partial';
}
export function titleStatus(subject: Subject | undefined, titles: string[] | undefined): AnidbCheck['titleStatus'] {
  if (!titles) return 'missing';
  if (!subject) return 'unavailable';
  const names = new Set(titles.map(normalize));
  return [subject.name, subject.name_cn].filter(Boolean).some(n => names.has(normalize(n))) ? 'matched' : 'different';
}
export async function checkAnidb(root: string, commit?: string): Promise<void> {
  commit ??= z.object({ sha: z.string() }).parse(await (await request(
    'https://api.github.com/repos/Anime-Lists/anime-lists/commits/master')).json()).sha;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Anime-Lists requires a pinned commit SHA');
  const reportPath = join(root, 'sources/anidb-check.json');
  const response = await request(TITLES_URL);
  const compressed = Buffer.from(await response.arrayBuffer());
  const titles = parseTitles(gunzipSync(compressed, { maxOutputLength: 100_000_000 }).toString('utf8'));
  const listUrl = `https://raw.githubusercontent.com/Anime-Lists/anime-lists/${commit}/anime-list-master.xml`;
  const listXml = await (await request(listUrl)).text();
  const links = parseAniLinks(listXml);
  const seed = await readJson(join(root, 'sources/seed.json'), Seeds);
  const current = new Map((await mappings(root)).map(m => [m.bangumiId, m]));
  let subjects = new Map<number, Subject>();
  try {
    const catalog = await readJson(join(root, '.cache/catalog.json'), Catalog);
    subjects = new Map(catalog.subjects.map(s => [s.id, s]));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const rows: AnidbCheck[] = seed.rows.filter(r => r.anidb).map(row => {
    const ani = links.get(row.anidb!);
    const targets = ani?.targets ?? [];
    return { bangumiId: row.bangumiId, anidbId: row.anidb!, targets, tmdbOffset: ani?.offset ?? null,
      titleStatus: titleStatus(subjects.get(row.bangumiId), titles.get(row.anidb!)),
      status: compareTargets(current.get(row.bangumiId)?.targets ?? (row.tmdb ? [row.tmdb] : []), targets) };
  });
  const report = AnidbReport.parse({ schemaVersion: 1,
    titles: { url: TITLES_URL, sha256: hash(compressed), lastModified: response.headers.get('last-modified') },
    mappings: { url: listUrl, sha256: hash(listXml), commit }, rows });
  await writeJson(reportPath, report);
  const counts = Object.fromEntries(['agree', 'partial', 'conflict', 'candidate', 'no-tmdb'].map(s => [s, rows.filter(r => r.status === s).length]));
  console.log(`AniDB cross-check: ${JSON.stringify(counts)}; ${rows.filter(r => r.titleStatus === 'matched').length} title matches. Existing mappings retained.`);
}
