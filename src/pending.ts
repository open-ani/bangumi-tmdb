import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { hash, stable, writeJson } from './io.js';
import { loadContext, subjectPrint, PENDING_BACKOFF_DAYS } from './update.js';

const DAY = 86400000;
// docs/unresolved-mappings-*.md lists one "### <id> · <name>" section per subject; the paragraphs between
// the metadata line and the reference list are the reviewer's conclusion.
export function parseUnresolved(markdown: string): { bangumiId: number; reason: string }[] {
  return markdown.split(/^### /m).slice(1).map(section => {
    const [heading = '', ...body] = section.split('\n');
    const id = /^([1-9]\d*) · /.exec(heading);
    if (!id) throw new Error(`Unexpected heading: ${heading}`);
    const lines = body.map(l => l.trim()).filter(Boolean);
    const stop = lines.findIndex(l => l.startsWith('参考资料：'));
    const reason = lines.slice(0, stop === -1 ? undefined : stop).filter(l => !l.startsWith('[Bangumi 条目]') && !l.startsWith('#')).join('\n');
    if (!reason) throw new Error(`Missing conclusion for ${id[1]}`);
    return { bangumiId: Number(id[1]), reason };
  });
}
// Record reviewed-but-unresolved subjects as pending with the reviewer's conclusion, so scheduled runs
// neither treat them as new work nor retry them before `days` have passed or Bangumi data changes.
export async function importPending(root: string, file: string, days: number, now = Date.now()): Promise<void> {
  const entries = parseUnresolved(await readFile(file, 'utf8'));
  if (new Set(entries.map(e => e.bangumiId)).size !== entries.length) throw new Error('Duplicate subjects in the unresolved list');
  const { progress, existing, ctx } = await loadContext(root, 'default');
  const mapped = new Set(existing.map(r => r.bangumiId));
  let imported = 0, skipped = 0;
  for (const entry of entries) {
    if (mapped.has(entry.bangumiId)) { skipped++; continue; }
    progress.subjects[String(entry.bangumiId)] = {
      fingerprint: hash(subjectPrint(ctx, entry.bangumiId) + stable(null)), attemptedAt: new Date(now).toISOString(),
      retryAt: new Date(now + days * DAY).toISOString(), status: 'pending', reason: entry.reason.slice(0, 20000),
      attempts: PENDING_BACKOFF_DAYS.length,
    };
    imported++;
  }
  await writeJson(join(root, 'state/progress.json'), progress);
  console.log(`Imported ${imported} pending subjects (${skipped} already mapped) with retry after ${days} days`);
}
