import { z } from 'zod';

export const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Natural = z.number().int().nonnegative();
export const WorkTarget = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('movie'), id: Id }),
  z.strictObject({ type: z.literal('tv'), id: Id }),
]);
export const SubjectTarget = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('movie'), id: Id }),
  z.strictObject({ type: z.literal('tv'), id: Id, season: Natural.optional(), episode: Id.optional(), episodeEnd: Id.optional() }),
]);
export const EpisodeTarget = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('movie'), id: Id }),
  z.strictObject({ type: z.literal('tv'), id: Id, season: Natural, episode: Id }),
]);
export const EpisodeRef = z.strictObject({ id: Id, type: Natural, sort: z.number().nonnegative() });
export const Rule = z.strictObject({
  bangumiType: Natural,
  start: Natural,
  end: Natural,
  tmdbId: Id,
  season: Natural,
  episodeStart: Id,
});
export const Override = z.strictObject({ bangumiEpisodeId: Id, targets: z.array(EpisodeTarget) });
export const Proposal = z.strictObject({
  targets: z.array(WorkTarget),
  rules: z.array(Rule),
  overrides: z.array(Override),
});
export const Provenance = z.strictObject({
  method: z.enum(['seed', 'deterministic', 'codex', 'community']),
  source: z.string().min(1),
  evidence: z.string().min(1).max(20000),
  verifiedAt: z.iso.datetime().nullable(),
});
export const Mapping = z.strictObject({
  schemaVersion: z.literal(1),
  bangumiId: Id,
  anidbId: Id.optional(),
  locked: z.boolean(),
  episodes: z.array(EpisodeRef),
  ...Proposal.shape,
  targets: z.array(SubjectTarget),
  provenance: Provenance,
});
// Codex strict structured outputs require every property; optional scope fields are nullable instead.
export const ResearchTarget = z.strictObject({
  type: z.enum(['movie', 'tv']), id: Id,
  season: Natural.nullable(), episode: Id.nullable(), episodeEnd: Id.nullable(),
});
export const ResearchProposal = z.strictObject({
  targets: z.array(ResearchTarget).max(50), rules: z.array(Rule).max(200), overrides: z.array(Override).max(500),
});
export const Research = z.strictObject({
  bangumiId: Id,
  status: z.enum(['matched', 'pending']),
  proposal: ResearchProposal.nullable(),
  reason: z.string().min(1).max(20000),
  evidence: z.array(z.strictObject({
    url: z.string().max(2000), fact: z.string().min(1).max(4000), access: z.enum(['page', 'search_snippet', 'api_snapshot']),
  })).max(40),
  uncertainties: z.array(z.string().min(1).max(4000)).max(40),
});
export const SeedLink = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('movie'), id: Id }),
  z.strictObject({ type: z.literal('tv'), id: Id, season: Natural.optional(), episode: Id.optional() }),
]);
export const SeedRow = z.strictObject({
  bangumiId: Id, tmdb: SeedLink.optional(),
  anidb: Id.optional(),
  imdb: z.string().regex(/^tt\d+$/).optional(),
  tvdb: Id.optional(), wikidata: z.string().regex(/^Q\d+$/).optional(),
});
export const Seeds = z.strictObject({
  schemaVersion: z.literal(1), repository: z.literal('Rhilip/BangumiExtLinker'),
  commit: z.string().regex(/^[a-f0-9]{40}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  rows: z.array(SeedRow),
});
export const Subject = z.object({
  id: Id, type: z.number(), name: z.string(), name_cn: z.string().default(''),
  date: z.string().default(''), infobox: z.string().default(''),
  summary: z.string().default(''), platform: z.union([z.number(), z.string()]).optional(),
});
export const Episode = z.object({
  id: Id, subject_id: Id, type: Natural, sort: z.number().nonnegative(),
  name: z.string().default(''), name_cn: z.string().default(''), airdate: z.string().default(''),
});
export const Relation = z.object({ subject_id: Id, related_subject_id: Id, relation_type: z.number() });
export const Snapshot = z.strictObject({ name: z.string(), sha256: z.string(), url: z.string().url() });
export const Catalog = z.strictObject({
  snapshot: Snapshot, subjects: z.array(Subject), episodes: z.array(Episode), relations: z.array(Relation),
});
export const Progress = z.strictObject({
  schemaVersion: z.literal(1), archive: Snapshot.nullable(),
  subjects: z.record(z.string().regex(/^[1-9]\d*$/), z.strictObject({
    fingerprint: z.string(), attemptedAt: z.iso.datetime(), retryAt: z.iso.datetime(),
    status: z.enum(['matched', 'pending', 'error', 'locked']), reason: z.string(),
    attempts: z.number().int().nonnegative().default(0),
  })),
});
// Bangumi API overlay on top of the weekly Archive. Entries newer than the dump win.
export const FreshSubject = z.strictObject({ fetchedAt: z.iso.datetime(), subject: Subject, episodes: z.array(Episode) });
export const FreshMissing = z.strictObject({
  id: Id, fetchedAt: z.iso.datetime(), status: z.enum(['merged', 'missing']), target: Id.optional(),
});
export const Fresh = z.strictObject({
  schemaVersion: z.literal(1), subjects: z.array(FreshSubject), missing: z.array(FreshMissing),
});
export const AnidbCheck = z.strictObject({
  bangumiId: Id, anidbId: Id,
  titleStatus: z.enum(['matched', 'different', 'missing', 'unavailable']),
  status: z.enum(['agree', 'partial', 'conflict', 'candidate', 'no-tmdb']),
  targets: z.array(SubjectTarget), tmdbOffset: z.number().int().nullable(),
});
export const AnidbReport = z.strictObject({
  schemaVersion: z.literal(1),
  titles: z.strictObject({ url: z.string().url(), sha256: z.string(), lastModified: z.string().nullable() }),
  mappings: z.strictObject({ url: z.string().url(), sha256: z.string(), commit: z.string() }),
  rows: z.array(AnidbCheck),
});
export type WorkTarget = z.infer<typeof WorkTarget>;
export type SubjectTarget = z.infer<typeof SubjectTarget>;
export type EpisodeTarget = z.infer<typeof EpisodeTarget>;
export type Proposal = z.infer<typeof Proposal>;
export type Rule = z.infer<typeof Rule>;
export type EpisodeRef = z.infer<typeof EpisodeRef>;
export type Override = z.infer<typeof Override>;
export type Mapping = z.infer<typeof Mapping>;
export type SeedRow = z.infer<typeof SeedRow>;
export type Seeds = z.infer<typeof Seeds>;
export type Subject = z.infer<typeof Subject>;
export type Episode = z.infer<typeof Episode>;
export type Catalog = z.infer<typeof Catalog>;
export type Progress = z.infer<typeof Progress>;
export type Research = z.infer<typeof Research>;
export type ResearchProposal = z.infer<typeof ResearchProposal>;
export type Fresh = z.infer<typeof Fresh>;
export type FreshSubject = z.infer<typeof FreshSubject>;
export type AnidbCheck = z.infer<typeof AnidbCheck>;
export type AnidbReport = z.infer<typeof AnidbReport>;
