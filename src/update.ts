import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { AnidbReport, Mapping, Progress, Seeds, type AnidbCheck, type Catalog, type Episode, type SeedRow, type Subject, type Research } from './model.js';
import { cacheDir, hash, mappings, readJson, stable, writeJson } from './io.js';
import { Tmdb, verifyMapping } from './tmdb.js';
import { loadCatalog } from './catalog.js';
import { derive, extend } from './rules.js';
import { resolve } from './resolve.js';
import { requireEvidence, runResearch, toProposal } from './research.js';
import { validateAll } from './expand.js';

// Increment whenever evidence extraction, matching rules or prompts change.
export const MATCHER_VERSION = '2';
const DAY = 86400000;
export const PENDING_BACKOFF_DAYS = [7, 14, 28, 56, 90];
type ProgressEntry = Progress['subjects'][string];
type Status = ProgressEntry['status'];
type Relation = Catalog['relations'][number];

// Only identity-bearing fields participate, so the same subject hashes alike whether it came from the
// weekly Archive or the daily API overlay.
export function fingerprint(subject: Subject | null, episodes: Episode[], relations: Relation[], hints: unknown, model: string): string {
  return hash(stable({
    subject: subject && { id: subject.id, name: subject.name, name_cn: subject.name_cn, date: subject.date },
    episodes: episodes.map(e => ({ id: e.id, type: e.type, sort: e.sort, airdate: e.airdate })).sort((a, b) => a.id - b.id),
    relations: relations.map(r => [r.related_subject_id, r.relation_type]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!),
    hints, model, version: MATCHER_VERSION,
  }));
}
// Automation only researches recent and upcoming works; the deep backlog is handled outside CI.
export function inScope(subject: Subject, now: number, scopeDays: number): boolean {
  const at = Date.parse(subject.date);
  return Number.isFinite(at) && at >= now - scopeDays * DAY;
}
export function retryDays(status: Status, attempts: number, subject: Subject | null, now: number): number {
  if (status === 'error') return 1;
  if (status !== 'pending') return 28;
  const backoff = PENDING_BACKOFF_DAYS[Math.min(attempts, PENDING_BACKOFF_DAYS.length) - 1] ?? PENDING_BACKOFF_DAYS[0]!;
  const premiere = Date.parse(subject?.date ?? '');
  // A work that has not aired yet rarely exists on TMDB; look again shortly after its premiere.
  return Number.isFinite(premiere) && premiere > now ? Math.max(backoff, Math.ceil((premiere - now) / DAY) + 3) : backoff;
}
export interface UpdateOptions {
  maxSubjects: number; maxMinutes: number; concurrency: number; scopeDays: number; researchMinutes: number;
  tmdbBudget: number; webBudget: number; model?: string | undefined; reasoning?: string | undefined; now?: number;
}
export interface Task { subject: Subject; kind: 'new' | 'retry' | 'episodes' | 'broken'; before?: Mapping }
export interface Context {
  episodes: Map<number, Episode[]>; relations: Map<number, Relation[]>; subjects: Map<number, Subject>;
  seeds: Map<number, SeedRow>; anidb: Map<number, AnidbCheck>; model: string;
}
const olderFirst = (progress: Progress) => (a: number, b: number) =>
  (Date.parse(progress.subjects[String(a)]?.attemptedAt ?? '') || 0) - (Date.parse(progress.subjects[String(b)]?.attemptedAt ?? '') || 0) || a - b;
export function due(progress: Progress, id: number, print: string, before: Mapping | undefined, now: number): boolean {
  const previous = progress.subjects[String(id)];
  return !(previous && previous.fingerprint === hash(print + stable(before ?? null)) && Date.parse(previous.retryAt) > now);
}
function clean(e: Episode) { return { id: e.id, type: e.type, sort: e.sort, name: e.name, name_cn: e.name_cn, airdate: e.airdate }; }
export function bundle(subject: Subject, ctx: Context, rows: Map<number, Mapping>, snapshot: string, before?: Mapping): unknown {
  const all = [...(ctx.episodes.get(subject.id) ?? [])].sort((a, b) => a.type - b.type || a.sort - b.sort);
  const regular = all.filter(e => e.type === 0);
  const hint = ctx.seeds.get(subject.id);
  const anidb = ctx.anidb.get(subject.id);
  const hinted = new Set([...(hint?.tmdb ? [hint.tmdb] : []), ...(anidb?.targets ?? []), ...(before?.targets ?? [])].map(t => `${t.type}/${t.id}`));
  const ownership = [...rows.values()].filter(r => r.bangumiId !== subject.id && r.targets.some(t => hinted.has(`${t.type}/${t.id}`)))
    .slice(0, 20).map(r => ({ bangumiId: r.bangumiId, targets: r.targets }));
  return {
    bangumi: { id: subject.id, url: `https://bgm.tv/subject/${subject.id}`, name: subject.name, name_cn: subject.name_cn, date: subject.date, platform: subject.platform ?? null },
    archiveSnapshot: snapshot, infobox: subject.infobox.slice(0, 6500), summary: subject.summary.slice(0, 4000),
    regularEpisodeCount: regular.length, totalEpisodeCount: all.length,
    regularEpisodes: (regular.length <= 120 ? regular : [...regular.slice(0, 60), ...regular.slice(-60)]).map(clean),
    regularEpisodesTruncated: regular.length > 120, specialEpisodes: all.filter(e => e.type !== 0).slice(0, 30).map(clean),
    relations: (ctx.relations.get(subject.id) ?? []).slice(0, 20).map(r => ({ relation_type: r.relation_type, related_subject_id: r.related_subject_id,
      relatedName: ctx.subjects.get(r.related_subject_id)?.name ?? null, relatedDate: ctx.subjects.get(r.related_subject_id)?.date ?? null })),
    hints: { seed: hint ?? null, anidb: anidb ? { anidbId: anidb.anidbId, status: anidb.status, targets: anidb.targets } : null },
    existing: before ? { locked: before.locked, targets: before.targets, rules: before.rules, overrides: before.overrides,
      provenance: { method: before.provenance.method, evidence: before.provenance.evidence.slice(0, 3000) } } : null,
    ownership,
  };
}
export function provenanceFromResearch(decision: Research, model: string, bangumiId: number, verifiedAt: string): Mapping['provenance'] {
  const source = [...new Set([`https://bgm.tv/subject/${bangumiId}`, ...decision.evidence.map(e => e.url)])].slice(0, 40).join('; ');
  const evidence = [`${model}: ${decision.reason}`, ...decision.evidence.map(e => `${e.url} (${e.access}): ${e.fact}`),
    ...(decision.uncertainties.length ? [`备注：${decision.uncertainties.join('；')}`] : [])].join('\n\n').slice(0, 20000);
  return { method: 'codex', source, evidence, verifiedAt };
}
const comparable = (m: Mapping) => stable({ episodes: m.episodes, targets: m.targets, rules: m.rules, overrides: m.overrides });

export interface Loaded { catalog: Catalog; seed: Seeds; progress: Progress; existing: Mapping[]; ctx: Context }
export async function loadContext(root: string, model: string): Promise<Loaded> {
  const { catalog } = await loadCatalog(root);
  const seed = await readJson(join(root, 'sources/seed.json'), Seeds);
  const progress = await readJson(join(root, 'state/progress.json'), Progress);
  const existing = await mappings(root);
  validateAll(existing);
  const ctx: Context = { episodes: new Map(), relations: new Map(), subjects: new Map(catalog.subjects.map(s => [s.id, s])),
    seeds: new Map(seed.rows.map(s => [s.bangumiId, s])), anidb: new Map(), model };
  try {
    const report = await readJson(join(root, 'sources/anidb-check.json'), AnidbReport);
    ctx.anidb = new Map(report.rows.map(row => [row.bangumiId, row]));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const ep of catalog.episodes) { const list = ctx.episodes.get(ep.subject_id) ?? []; list.push(ep); ctx.episodes.set(ep.subject_id, list); }
  for (const rel of catalog.relations) { const list = ctx.relations.get(rel.subject_id) ?? []; list.push(rel); ctx.relations.set(rel.subject_id, list); }
  return { catalog, seed, progress, existing, ctx };
}
export const subjectPrint = (ctx: Context, id: number): string => fingerprint(ctx.subjects.get(id) ?? null, ctx.episodes.get(id) ?? [],
  ctx.relations.get(id) ?? [], { hint: ctx.seeds.get(id), anidb: ctx.anidb.get(id) }, ctx.model);

export async function update(root: string, options: UpdateOptions): Promise<void> {
  const now = options.now ?? Date.now();
  const { catalog, progress, existing, ctx } = await loadContext(root, options.model ?? 'default');
  const rows = new Map(existing.map(r => [r.bangumiId, r]));
  const token = process.env.TMDB_READ_TOKEN ?? '';
  const cached = new Tmdb(token, join(cacheDir(root), 'tmdb'));
  const live = new Tmdb(token);
  // `now` stamps records and drives retry logic (tests pin it); budgets follow the wall clock.
  const clock = Date.now();
  const deadline = clock + options.maxMinutes * 60000;
  const report: { bangumiId: number; status: string; kind: string; reason: string }[] = [];
  const changes = new Map<number, Mapping>();
  const counts = { verified: 0, derived: 0, extended: 0, resolved: 0, codexSubjects: 0, researchMatched: 0, researchReused: 0, absent: [] as number[] };
  const print = (id: number) => subjectPrint(ctx, id);
  const record = (id: number, kind: string, status: Status, reason: string, days?: number) => {
    const previous = progress.subjects[String(id)];
    const attempts = status === 'pending' ? (previous?.status === 'pending' ? previous.attempts : 0) + 1 : 0;
    const retry = days ?? retryDays(status, attempts, ctx.subjects.get(id) ?? null, now);
    progress.subjects[String(id)] = { fingerprint: hash(print(id) + stable(rows.get(id) ?? null)), attemptedAt: new Date(now).toISOString(),
      retryAt: new Date(now + retry * DAY).toISOString(), status, reason: reason.slice(0, 20000), attempts };
    report.push({ bangumiId: id, status, kind, reason: reason.slice(0, 20000) });
  };
  const fatal = (error: unknown) => /HTTP (401|403)/.test(String(error));
  const apply = (row: Mapping, before: Mapping | undefined) => {
    validateAll([...rows.values()].filter(r => r.bangumiId !== row.bangumiId).concat(row));
    if (!before || comparable(before) !== comparable(row)) { rows.set(row.bangumiId, row); changes.set(row.bangumiId, row); }
  };
  const research: Task[] = [];
  // Phase 1: existing mappings. Verification, deterministic episode rules and rule extension cost only TMDB
  // requests, so every due row is handled here; model work is deferred to phase 2.
  const phaseOneDeadline = clock + options.maxMinutes * 60000 * 0.5;
  // Long runs report from inside each phase, since a runner log shows nothing until a step ends.
  const elapsed = () => `${((Date.now() - clock) / 60000).toFixed(1)}m elapsed`;
  const dueRows = existing.filter(r => due(progress, r.bangumiId, print(r.bangumiId), r, now)).sort((a, b) => olderFirst(progress)(a.bangumiId, b.bangumiId));
  console.log(`Phase 1: ${dueRows.length} mappings due for verification`);
  let audited = 0;
  const phaseOne = () => `${audited}/${dueRows.length} audited; ${counts.derived} derived, ${counts.extended} extended, ${research.length} queued for research; ${elapsed()}`;
  for (const before of dueRows) {
    if (Date.now() > phaseOneDeadline) { console.log(`Phase 1: time budget reached at ${phaseOne()}`); break; }
    if (audited && audited % 500 === 0) console.log(`Phase 1: ${phaseOne()}`);
    audited++;
    const subject = ctx.subjects.get(before.bangumiId);
    if (!subject) { counts.absent.push(before.bangumiId); record(before.bangumiId, 'audit', 'error', 'Subject absent from the Bangumi catalog (merged or hidden?); maintainer review needed', 7); continue; }
    const eps = ctx.episodes.get(subject.id) ?? [];
    try {
      if (before.locked) {
        try { await verifyMapping(before, live, catalog); record(subject.id, 'audit', 'locked', 'Locked mapping verified; unchanged'); }
        catch (error) { if (fatal(error)) throw error; record(subject.id, 'audit', 'locked', `Locked mapping needs maintainer review: ${String(error)}`, 7); }
        continue;
      }
      let candidate = before;
      let note = '';
      let uncovered = 0;
      let retry: number | undefined;
      if (!before.rules.length && !before.overrides.length) {
        const derived = await derive(before, eps, cached);
        if (derived) { candidate = derived.mapping; note = derived.note; counts.derived++; }
        // Identity stays verified; episode research waits for model budget and is retried sooner than a full audit.
        else { research.push({ subject, kind: 'episodes', before }); retry = 7; }
      } else {
        const extended = await extend(before, eps, cached, now);
        candidate = extended.mapping; note = extended.note; uncovered = extended.uncovered;
        if (extended.added) counts.extended++;
      }
      await verifyMapping(candidate, live, catalog);
      if (comparable(candidate) !== comparable(before)) {
        const method = before.provenance.method === 'seed' ? 'deterministic' : before.provenance.method;
        candidate = Mapping.parse({ ...candidate, provenance: { ...before.provenance, method,
          evidence: `${before.provenance.evidence}\n\n${note}`.slice(0, 20000), verifiedAt: new Date(now).toISOString() } });
        apply(candidate, before);
      }
      counts.verified++;
      record(subject.id, 'audit', 'matched', note || (retry ? 'Verified against live TMDB; episode rules need research' : 'Verified against live TMDB; unchanged'), uncovered ? 2 : retry);
    } catch (error) {
      if (fatal(error)) throw error;
      record(subject.id, 'audit', 'pending', `Verification failed: ${String(error)}`);
      research.push({ subject, kind: 'broken', before });
    }
  }
  // Phase 2: model research for new in-scope subjects first, then existing rows that need episode-level
  // work or repair. Concurrency is bounded and every result is re-validated against live TMDB.
  const unmapped = catalog.subjects.filter(s => !rows.has(s.id) && (inScope(s, now, options.scopeDays) || progress.subjects[String(s.id)]))
    .filter(s => due(progress, s.id, print(s.id), undefined, now)).sort((a, b) => olderFirst(progress)(a.id, b.id));
  console.log(`Phase 1 done: ${phaseOne()}`);
  // Phase 1b: deterministic identification of unmapped subjects by title search and air-date agreement.
  // It costs only TMDB requests, so every due subject gets a try before any model work; whatever it
  // settles leaves the research queue. A failure of any kind simply leaves the subject to the model.
  const settled = new Set<number>();
  let tried = 0;
  const kindOf = (subject: Subject): Task['kind'] => progress.subjects[String(subject.id)] ? 'retry' : 'new';
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, async () => {
    while (tried < unmapped.length && deadline - Date.now() > 90000) {
      const subject = unmapped[tried++]!;
      try {
        const found = await resolve(subject, ctx.episodes.get(subject.id) ?? [], cached);
        if (!found) continue;
        const anidbId = ctx.seeds.get(subject.id)?.anidb;
        const row = Mapping.parse({ ...found.mapping, ...(anidbId ? { anidbId } : {}), provenance: { ...found.mapping.provenance, verifiedAt: new Date(now).toISOString() } });
        validateAll([...rows.values()].filter(r => r.bangumiId !== row.bangumiId).concat(row));
        await verifyMapping(row, live, catalog);
        apply(row, undefined);
        counts.resolved++; settled.add(subject.id);
        record(subject.id, kindOf(subject), 'matched', found.note);
      } catch (error) { if (fatal(error)) throw error; }
      if (tried % 200 === 0) console.log(`Phase 1b: ${tried}/${unmapped.length} tried, ${counts.resolved} resolved; ${elapsed()}`);
    }
  }));
  console.log(`Phase 1b done: ${tried}/${unmapped.length} unmapped subjects tried, ${counts.resolved} resolved without a model; ${elapsed()}`);
  // Broken rows outrank episode work; among episode work, currently relevant (recent) subjects come first.
  research.sort((a, b) => Number(b.kind === 'broken') - Number(a.kind === 'broken') || (Date.parse(b.subject.date) || 0) - (Date.parse(a.subject.date) || 0));
  const tasks: Task[] = [...unmapped.filter(s => !settled.has(s.id)).map((subject): Task => ({ subject, kind: kindOf(subject) })), ...research];
  const kinds = tasks.reduce((m, t) => m.set(t.kind, (m.get(t.kind) ?? 0) + 1), new Map<Task['kind'], number>());
  console.log(`Phase 2: ${tasks.length} tasks${kinds.size ? ` (${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}; budget ${options.maxSubjects} subjects, ${((deadline - Date.now()) / 60000).toFixed(0)}m`);
  let cursor = 0;
  let abort: unknown = null;
  let done = 0;
  const phaseTwo = () => `${done} researched (${counts.researchMatched} matched, ${done - counts.researchMatched} pending, ${counts.researchReused} reused from a recent run), ${tasks.length - cursor} queued; ${elapsed()}`;
  const handle = async (task: Task) => {
    const { subject, before } = task;
    const eps = ctx.episodes.get(subject.id) ?? [];
    try {
      const result = await runResearch(subject.id, bundle(subject, ctx, rows, catalog.snapshot.name, before), {
        model: options.model, reasoning: options.reasoning, timeoutMs: Math.min(options.researchMinutes * 60000, Math.max(60000, deadline - Date.now())),
        tmdbBudget: options.tmdbBudget, webBudget: options.webBudget, token, cacheDir: join(cacheDir(root), 'tmdb'), auditDir: join(cacheDir(root), 'research') });
      const decision = result.decision;
      if (result.reused) counts.researchReused++;
      if (decision.status !== 'matched' || !decision.proposal) {
        record(subject.id, task.kind, 'pending', `${decision.reason}${decision.uncertainties.length ? `\n未确定：${decision.uncertainties.join('；')}` : ''}`);
        return;
      }
      const proposal = toProposal(decision.proposal);
      requireEvidence(proposal, result.calls);
      const anidbId = before?.anidbId ?? ctx.seeds.get(subject.id)?.anidb;
      const row = Mapping.parse({ schemaVersion: 1, bangumiId: subject.id, locked: false, ...(anidbId ? { anidbId } : {}),
        episodes: eps.map(e => ({ id: e.id, type: e.type, sort: e.sort })).sort((a, b) => a.id - b.id), ...proposal,
        provenance: provenanceFromResearch(decision, options.model ?? 'codex', subject.id, new Date(now).toISOString()) });
      validateAll([...rows.values()].filter(r => r.bangumiId !== row.bangumiId).concat(row));
      await verifyMapping(row, live, catalog);
      apply(row, before);
      counts.researchMatched++;
      record(subject.id, task.kind, 'matched', decision.reason);
    } catch (error) {
      if (fatal(error)) { abort = error; return; }
      record(subject.id, task.kind, 'pending', `Research rejected: ${String(error)}`);
    }
  };
  const worker = async () => {
    while (!abort && cursor < tasks.length && counts.codexSubjects < options.maxSubjects && deadline - Date.now() > 90000) {
      const task = tasks[cursor++]!;
      counts.codexSubjects++;
      await handle(task);
      if (++done % 25 === 0) console.log(`Phase 2: ${phaseTwo()}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  if (abort) throw abort;
  console.log(`Phase 2 done: ${phaseTwo()}`);
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
  const summary = { archive: catalog.snapshot, changed: changes.size, ...counts, queued: { unmapped: unmapped.length, research: research.length, remaining: tasks.length - cursor }, report };
  await writeJson(join(cacheDir(root), 'update-report.json'), summary);
  const pending = report.filter(r => r.status === 'pending').length, errors = report.filter(r => r.status === 'error').length;
  console.log(`Update: ${changes.size} mappings changed; ${counts.verified} verified, ${counts.derived} derived, ${counts.extended} extended; ${counts.resolved} resolved without a model; ${counts.codexSubjects} Codex subjects (${counts.researchMatched} matched, ${counts.researchReused} reused); ${pending} pending; ${errors} errors; ${tasks.length - cursor} tasks left`);
}
