import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Catalog, Mapping, Progress, Seeds, type Subject, type Episode, type Proposal } from './model.js';
import { hash, mappings, readJson, stable, writeJson } from './io.js';
import { candidates, deterministic, extraCandidates } from './match.js';
import { Tmdb, verifyMapping, type Candidate } from './tmdb.js';
import { runCodex } from './codex.js';
import { expand, targetKey, validateAll } from './expand.js';

// Increment whenever evidence extraction, matching rules or prompts change.
export const MATCHER_VERSION = '1';
const DAY = 86400000;
export function fingerprint(subject: Subject, episodes: Episode[], relations: unknown, seed: unknown, model: string): string {
  return hash(stable({ subject, episodes, relations, seed, model, version: MATCHER_VERSION }));
}
export function orderQueue(catalog: Catalog, progress: Progress, rows: Mapping[], now: number): Subject[] {
  const mapped = new Set(rows.map(r => r.bangumiId));
  const recent = (s: Subject) => Math.abs(Date.parse(s.date) - now) < 180 * DAY;
  const olderFirst = (a: Subject, b: Subject) =>
    (Date.parse(progress.subjects[String(a.id)]?.attemptedAt ?? '') || 0) -
    (Date.parse(progress.subjects[String(b.id)]?.attemptedAt ?? '') || 0) || a.id - b.id;
  const fresh = catalog.subjects.filter(s => !mapped.has(s.id) && recent(s)).sort(olderFirst);
  const old = catalog.subjects.filter(s => !mapped.has(s.id) && !recent(s)).sort(olderFirst);
  const audit = catalog.subjects.filter(s => mapped.has(s.id)).sort(olderFirst);
  const ordered: Subject[] = [];
  // Reserve 20% for history and existing mappings; neither can starve behind current-season work.
  while (fresh.length || old.length || audit.length) {
    ordered.push(...fresh.splice(0, 8), ...old.splice(0, 1), ...audit.splice(0, 1));
    if (!fresh.length) ordered.push(...old.splice(0, 8), ...audit.splice(0, 2));
  }
  return ordered;
}
export function requireEvidence(proposal: Proposal, choices: Candidate[]): void {
  for (const work of proposal.targets) {
    if (!choices.some(c => c.target.type === work.type && c.target.id === work.id)) throw new Error('Codex proposed unseen work');
  }
  for (const rule of proposal.rules) {
    if (!choices.some(c => c.target.type === 'tv' && c.target.id === rule.tmdbId &&
      c.seasons.some(s => s.season_number === rule.season))) throw new Error('Codex proposed unseen season');
  }
  for (const override of proposal.overrides) for (const t of override.targets) {
    if (t.type === 'tv' && !choices.some(c => c.target.type === 'tv' && c.target.id === t.id &&
      c.seasons.some(s => s.season_number === t.season && s.episodes.some(e => e.episode_number === t.episode))))
      throw new Error('Codex proposed unseen episode');
  }
}
export interface UpdateOptions { maxSubjects: number; maxMinutes: number; model?: string }
export async function update(root: string, options: UpdateOptions): Promise<void> {
  const catalog = await readJson(join(root, '.cache/catalog.json'), Catalog);
  const seed = await readJson(join(root, 'sources/seed.json'), Seeds);
  const progress = await readJson(join(root, 'state/progress.json'), Progress);
  const existing = await mappings(root);
  validateAll(existing);
  const rows = new Map(existing.map(r => [r.bangumiId, r]));
  const seedMap = new Map(seed.rows.map(s => [s.bangumiId, s]));
  const episodes = new Map<number, Episode[]>();
  for (const ep of catalog.episodes) { const list = episodes.get(ep.subject_id) ?? []; list.push(ep); episodes.set(ep.subject_id, list); }
  const relationMap = new Map<number, Catalog['relations']>();
  for (const rel of catalog.relations) { const list = relationMap.get(rel.subject_id) ?? []; list.push(rel); relationMap.set(rel.subject_id, list); }
  const subjectMap = new Map(catalog.subjects.map(s => [s.id, s]));
  const cached = new Tmdb(process.env.TMDB_READ_TOKEN ?? '', join(root, '.cache/tmdb'));
  const live = new Tmdb(process.env.TMDB_READ_TOKEN ?? '');
  const started = Date.now();
  const deadline = started + options.maxMinutes * 60000;
  const report: { bangumiId: number; status: string; reason: string }[] = [];
  const changes = new Map<number, Mapping>();
  let codexSubjects = 0;
  for (const subject of orderQueue(catalog, progress, existing, started)) {
    if (Date.now() > deadline - 15000) break;
    const eps = episodes.get(subject.id) ?? [];
    const rels = (relationMap.get(subject.id) ?? []).map(r => ({ ...r, subject: subjectMap.get(r.related_subject_id) }));
    const hint = seedMap.get(subject.id);
    const fp = fingerprint(subject, eps, rels, hint, options.model ?? 'default');
    const previous = progress.subjects[String(subject.id)];
    const before = rows.get(subject.id);
    const fingerprintWithMapping = hash(fp + stable(before ?? null));
    if (previous?.fingerprint === fingerprintWithMapping && Date.parse(previous.retryAt) > started) continue;
    const record = (status: 'matched' | 'pending' | 'error' | 'locked', reason: string, days: number) => {
      progress.subjects[String(subject.id)] = {
        fingerprint: hash(fp + stable(rows.get(subject.id) ?? null)), attemptedAt: new Date(started).toISOString(),
        retryAt: new Date(started + days * DAY).toISOString(), status, reason: reason.slice(0, 20000),
      };
      report.push({ bangumiId: subject.id, status, reason: reason.slice(0, 20000) });
    };
    try {
      if (before?.locked) {
        try { await verifyMapping(before, live, catalog); record('locked', 'Locked mapping verified; unchanged', 28); }
        catch (error) { record('locked', `Locked mapping needs maintainer review: ${String(error)}`, 7); }
        continue;
      }
      let choices = await candidates(subject, hint, cached);
      // Include existing targets in a review even if name search no longer returns them.
      if (before) for (const t of before.targets) {
        if (!choices.some(c => c.target.type === t.type && c.target.id === t.id)) {
          try { choices.push(await cached.candidate(t, subject.date)); } catch { /* Live verification still decides validity. */ }
        }
      }
      let proposal = before ? null : deterministic(subject, eps, hint, choices);
      let method: 'deterministic' | 'codex' = 'deterministic';
      let reason = 'Pinned seed identity corroborated by exact title/date or per-episode title/date comparisons.';
      if (!proposal) {
        if (codexSubjects >= options.maxSubjects) continue;
        codexSubjects++;
        method = 'codex';
        const ownership = [...rows.values()].filter(r => r.bangumiId !== subject.id).flatMap(r =>
          expand(r).flatMap(e => e.targets.filter(t => choices.some(c => c.target.type === t.type && c.target.id === t.id))
            .map(t => ({ bangumiId: r.bangumiId, target: targetKey(t) }))));
        let decision;
        for (let round = 0; round < 3; round++) {
          const remaining = deadline - Date.now();
          if (remaining < 15000) throw new Error('Update time budget exhausted');
          decision = await runCodex({ subject, episodes: eps, relations: rels, seed: hint, existing: before,
            candidates: choices, ownership, queryRoundsRemaining: 2 - round }, Math.min(300000, remaining), options.model);
          if (decision.status !== 'query') break;
          if (round === 2) break;
          choices = [...choices, ...await extraCandidates(decision.queries, subject.date, cached)];
        }
        if (!decision || decision.status !== 'matched' || !decision.proposal) {
          record('pending', decision?.reason ?? 'No decision', 7); continue;
        }
        proposal = decision.proposal; reason = decision.reason;
      }
      requireEvidence(proposal, choices);
      const row = Mapping.parse({ schemaVersion: 1, bangumiId: subject.id, locked: false,
        episodes: eps.map(({ id, type, sort }) => ({ id, type, sort })), ...proposal,
        provenance: { method, source: `${catalog.snapshot.name}; BangumiExtLinker@${seed.commit}`, evidence: reason,
          verifiedAt: new Date(started).toISOString() } });
      validateAll([...rows.values()].filter(r => r.bangumiId !== row.bangumiId).concat(row));
      await verifyMapping(row, live, catalog);
      // Do not churn a proven mapping's provenance just because it was audited again.
      const comparable = (m: Mapping) => stable({ episodes: m.episodes, targets: m.targets, rules: m.rules, overrides: m.overrides });
      if (!before || comparable(before) !== comparable(row)) { rows.set(row.bangumiId, row); changes.set(row.bangumiId, row); }
      record('matched', reason, 28);
    } catch (error) {
      record('error', String(error), 1);
      // Authentication failures are not per-title failures. Abort without committing partial progress.
      if (/HTTP (401|403)/.test(String(error))) throw error;
    }
  }
  validateAll([...rows.values()]);
  for (const row of changes.values()) {
    const path = join(root, `data/${row.bangumiId}.json`);
    const original = existing.find(r => r.bangumiId === row.bangumiId);
    if (original?.locked) throw new Error('Locked mapping changed');
    if (original && stable(original) !== await readFile(path, 'utf8')) throw new Error('Mapping changed during update');
    await writeJson(path, row);
  }
  progress.archive = catalog.snapshot;
  await writeJson(join(root, 'state/progress.json'), progress);
  await writeJson(join(root, '.cache/update-report.json'), { archive: catalog.snapshot, changed: changes.size, codexSubjects, report });
  console.log(`Update: ${changes.size} mappings changed; ${codexSubjects} Codex subjects; ${report.filter(r => r.status === 'pending').length} pending; ${report.filter(r => r.status === 'error').length} errors`);
}
