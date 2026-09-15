// Minimal MCP stdio server exposing read-only TMDB research tools to Codex. Started by research.ts with
// an audit log path, a call budget, a token file and a cache directory; the token never enters argv or env.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Tmdb } from './tmdb.js';

const Language = z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default('en-US');
const Positive = z.number().int().positive();
const Search = z.strictObject({ query: z.string().trim().min(1).max(200), type: z.enum(['multi', 'tv', 'movie']).default('multi'),
  page: z.number().int().min(1).max(500).default(1), language: Language });
const Details = z.strictObject({ type: z.enum(['tv', 'movie']), id: Positive, language: Language });
const SeasonArgs = z.strictObject({ id: Positive, season: z.number().int().nonnegative(), page: z.number().int().min(1).default(1), language: Language });
const Find = z.strictObject({ external_id: z.string().regex(/^(tt\d+|\d+)$/), source: z.enum(['imdb_id', 'tvdb_id']) });
const url = (type: string, id: number) => `https://www.themoviedb.org/${type}/${id}`;
type Row = Record<string, unknown>;
const brief = (d: Row, type: string) => ({ type, id: d.id, url: url(type, Number(d.id)), name: d.name ?? d.title,
  original_name: d.original_name ?? d.original_title, date: d.first_air_date ?? d.release_date,
  overview: typeof d.overview === 'string' ? d.overview.slice(0, 1600) : undefined, original_language: d.original_language });
export const tools = [
  { name: 'tmdb_search', description: 'Search TMDB directly. Names, aliases and franchise titles are clues, never identity proof.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string', enum: ['multi', 'tv', 'movie'] },
      page: { type: 'integer', minimum: 1, maximum: 500 }, language: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'tmdb_details', description: 'Read a real TMDB movie or TV work: titles, synopsis, dates, runtime, credits, external IDs and season list. Existence alone does not verify the Bangumi identity.',
    inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['tv', 'movie'] }, id: { type: 'integer', minimum: 1 },
      language: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false } },
  { name: 'tmdb_season', description: 'Read a TMDB TV season and its actual episodes, 60 per page. Required before deciding any season or episode range; never substitute TVDB numbering.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer', minimum: 1 }, season: { type: 'integer', minimum: 0 },
      page: { type: 'integer', minimum: 1 }, language: { type: 'string' } }, required: ['id', 'season'], additionalProperties: false } },
  { name: 'tmdb_find', description: 'Find TMDB works by IMDb or TVDB ID. The external ID may itself be wrong: verify the result identity.',
    inputSchema: { type: 'object', properties: { external_id: { type: 'string' }, source: { type: 'string', enum: ['imdb_id', 'tvdb_id'] } },
      required: ['external_id', 'source'], additionalProperties: false } },
].map(t => ({ ...t, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }));

export async function callTool(tmdb: Tmdb, name: string, args: unknown): Promise<unknown> {
  if (name === 'tmdb_search') {
    const a = Search.parse(args);
    const r = await tmdb.get(`/search/${a.type}`, { query: a.query, page: String(a.page), include_adult: 'true', language: a.language }) as Row;
    const results = (r.results as Row[] | undefined ?? []).filter(d => a.type !== 'multi' || ['movie', 'tv'].includes(String(d.media_type)));
    return { query: a.query, page: a.page, total_pages: r.total_pages, total_results: r.total_results,
      results: results.map(d => brief(d, a.type === 'multi' ? String(d.media_type) : a.type)) };
  }
  if (name === 'tmdb_details') {
    const a = Details.parse(args);
    const d = await tmdb.get(`/${a.type}/${a.id}`, { language: a.language, append_to_response: 'credits,external_ids,alternative_titles' }) as Row;
    if (d.id !== a.id) throw new Error('TMDB work ID mismatch');
    const credits = d.credits as { cast?: Row[]; crew?: Row[] } | undefined;
    return { ...brief(d, a.type), runtime: d.runtime, last_air_date: d.last_air_date, number_of_episodes: d.number_of_episodes,
      number_of_seasons: d.number_of_seasons, status: d.status, production_companies: d.production_companies,
      external_ids: d.external_ids, alternative_titles: d.alternative_titles,
      cast: credits?.cast?.slice(0, 18).map(x => ({ name: x.name, character: x.character })),
      crew: credits?.crew?.filter(x => ['Director', 'Series Director', 'Original Story', 'Screenplay', 'Writer'].includes(String(x.job)))
        .slice(0, 25).map(x => ({ name: x.name, job: x.job })),
      seasons: (d.seasons as Row[] | undefined)?.map(s => ({ season: s.season_number, name: s.name, date: s.air_date, episode_count: s.episode_count,
        overview: typeof s.overview === 'string' ? s.overview.slice(0, 500) : undefined })) };
  }
  if (name === 'tmdb_season') {
    const a = SeasonArgs.parse(args);
    const d = await tmdb.get(`/tv/${a.id}/season/${a.season}`, { language: a.language }) as Row;
    if (d.season_number !== a.season) throw new Error('TMDB season identity mismatch');
    const episodes = [...(d.episodes as Row[] | undefined ?? [])].sort((x, y) => Number(x.episode_number) - Number(y.episode_number));
    return { url: `${url('tv', a.id)}/season/${a.season}`, season: d.season_number, name: d.name, overview: d.overview, air_date: d.air_date,
      episodeCount: episodes.length, page: a.page, total_pages: Math.max(1, Math.ceil(episodes.length / 60)),
      episodes: episodes.slice((a.page - 1) * 60, a.page * 60).map(e => ({ id: e.id, episode_number: e.episode_number, name: e.name,
        date: e.air_date, runtime: e.runtime, overview: typeof e.overview === 'string' ? e.overview.slice(0, 500) : undefined })) };
  }
  if (name === 'tmdb_find') {
    const a = Find.parse(args);
    return tmdb.get(`/find/${a.external_id}`, { external_source: a.source });
  }
  throw new Error(`Unknown tool ${name}`);
}
export function serve(tmdb: Tmdb, auditFile: string, budget: number, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  let calls = 0;
  const send = (id: unknown, body: Row) => output.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  const handle = async (line: string) => {
    let message: { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    try {
      switch (message.method) {
        case 'initialize': send(message.id, { result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'tmdb-research', version: '1.0.0' } } }); break;
        case 'ping': send(message.id, { result: {} }); break;
        case 'tools/list': send(message.id, { result: { tools } }); break;
        case 'tools/call': {
          const record: Row = { tool: message.params?.name, arguments: message.params?.arguments ?? {}, at: new Date().toISOString() };
          try {
            if (++calls > budget) throw new Error('TMDB tool budget exhausted; return pending if evidence is insufficient.');
            const result = await callTool(tmdb, String(message.params?.name), message.params?.arguments ?? {});
            appendFileSync(auditFile, `${JSON.stringify({ ...record, ok: true })}\n`);
            send(message.id, { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
          } catch (error) {
            appendFileSync(auditFile, `${JSON.stringify({ ...record, ok: false, error: String(error) })}\n`);
            send(message.id, { result: { isError: true, content: [{ type: 'text', text: String(error) }] } });
          }
          break;
        }
        default: send(message.id, { error: { code: -32601, message: 'Method not found' } });
      }
    } catch { send(message.id, { error: { code: -32603, message: 'Request failed' } }); }
  };
  lines.on('line', line => { queue = queue.then(() => handle(line)); });
  return new Promise(resolvePromise => lines.on('close', () => { void queue.then(() => resolvePromise()); }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [auditFile, budgetArg, tokenFile, cacheDir] = process.argv.slice(2);
  if (!auditFile || !budgetArg || !tokenFile || !cacheDir) throw new Error('Usage: tmdb-mcp <audit.jsonl> <budget> <token-file> <cache-dir>');
  await serve(new Tmdb(readFileSync(tokenFile, 'utf8').trim(), cacheDir), auditFile, Number(budgetArg), process.stdin, process.stdout);
  process.exit(0);
}
