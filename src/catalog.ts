import { join } from 'node:path';
import { Catalog, Fresh, type FreshSubject } from './model.js';
import { cacheDir, readJson } from './io.js';

// Archive dumps are named dump-YYYY-MM-DD.HHMMSSZ.zip; anything fetched from the API after that instant is newer.
export function dumpTime(snapshot: { name: string }): number {
  const match = /^dump-(\d{4}-\d{2}-\d{2})\.(\d{2})(\d{2})(\d{2})Z\.zip$/.exec(snapshot.name);
  return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`) : 0;
}
// Overlay API results on the weekly Archive: newer subject records replace the dump's subject and its
// whole episode list; subjects the API reports as merged disappear. 404s never remove anything, because
// unauthenticated API access hides NSFW subjects that the Archive still contains.
export function overlay(catalog: Catalog, fresh: Fresh): Catalog {
  const since = dumpTime(catalog.snapshot);
  const replaced = new Map<number, FreshSubject>();
  for (const entry of fresh.subjects) {
    if (Date.parse(entry.fetchedAt) > since && entry.subject.type === 2) replaced.set(entry.subject.id, entry);
  }
  const removed = new Set(fresh.missing.filter(m => m.status === 'merged' && Date.parse(m.fetchedAt) > since).map(m => m.id));
  const gone = (id: number) => replaced.has(id) || removed.has(id);
  const subjects = catalog.subjects.filter(s => !gone(s.id)).concat([...replaced.values()].map(e => e.subject));
  const episodes = catalog.episodes.filter(e => !gone(e.subject_id)).concat([...replaced.values()].flatMap(e => e.episodes));
  subjects.sort((a, b) => a.id - b.id); episodes.sort((a, b) => a.id - b.id);
  const relations = catalog.relations.filter(r => !removed.has(r.subject_id) && !removed.has(r.related_subject_id));
  return { snapshot: catalog.snapshot, subjects, episodes, relations };
}
export async function readFresh(root: string): Promise<Fresh | null> {
  try { return await readJson(join(cacheDir(root), 'bangumi-fresh.json'), Fresh); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function loadCatalog(root: string): Promise<{ catalog: Catalog; fresh: Fresh | null }> {
  const archive = await readJson(join(cacheDir(root), 'catalog.json'), Catalog);
  const fresh = await readFresh(root);
  return { catalog: fresh ? overlay(archive, fresh) : archive, fresh };
}
