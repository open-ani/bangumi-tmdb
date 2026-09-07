import { z } from 'zod';

export const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Natural = z.number().int().nonnegative();
export const WorkTarget = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('movie'), id: Id }),
  z.strictObject({ type: z.literal('tv'), id: Id }),
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
  verifiedAt: z.iso.datetime(),
});
export const Mapping = z.strictObject({
  schemaVersion: z.literal(1),
  bangumiId: Id,
  locked: z.boolean(),
  episodes: z.array(EpisodeRef),
  ...Proposal.shape,
  provenance: Provenance,
});
// Nullable properties are required: compatible with Codex strict structured output.
export const Decision = z.strictObject({
  status: z.enum(['matched', 'pending', 'query']),
  reason: z.string().min(1).max(20000),
  proposal: Proposal.nullable(),
  queries: z.array(z.string().min(1).max(200)).max(3),
});
export const SeedLink = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('movie'), id: Id }),
  z.strictObject({ type: z.literal('tv'), id: Id, season: Natural.optional(), episode: Id.optional() }),
]);
export const SeedRow = z.strictObject({
  bangumiId: Id, tmdb: SeedLink.optional(),
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
  })),
});
export type WorkTarget = z.infer<typeof WorkTarget>;
export type EpisodeTarget = z.infer<typeof EpisodeTarget>;
export type Proposal = z.infer<typeof Proposal>;
export type Mapping = z.infer<typeof Mapping>;
export type SeedRow = z.infer<typeof SeedRow>;
export type Seeds = z.infer<typeof Seeds>;
export type Subject = z.infer<typeof Subject>;
export type Episode = z.infer<typeof Episode>;
export type Catalog = z.infer<typeof Catalog>;
export type Progress = z.infer<typeof Progress>;
export type Decision = z.infer<typeof Decision>;
