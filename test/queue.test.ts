import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, Progress, type Mapping } from '../src/model.js';
import { hash, stable } from '../src/io.js';
import { queue, subjectPrint, type Context } from '../src/update.js';

const now = Date.parse('2026-09-15T00:00:00Z');
const subject = (id: number, date: string, platform: number | string = 1) => ({ id, type: 2, name: `S${id}`, name_cn: '', date, infobox: '', summary: '', platform });
// 1 is recent; 2, 3 and undated 4 are old and never analysed; 5 is old on platform 其他; 6 and 7 are old pending rows,
// 6 due again and 7 not; 8 is old but already mapped.
const catalog = Catalog.parse({ snapshot: { name: 'dump-2026-09-08.210336Z.zip', sha256: 'a'.repeat(64), url: 'https://example.org/dump.zip' },
  subjects: [subject(1, '2026-07-01'), subject(2, '2010-01-01'), subject(3, '2012-01-01'), subject(4, ''), subject(5, '2008-01-01', 0), subject(6, '2011-01-01', 2), subject(7, '2011-01-01', 2), subject(8, '2009-01-01')],
  episodes: [], relations: [] });
const ctx: Context = { episodes: new Map(), relations: new Map(), subjects: new Map(catalog.subjects.map(s => [s.id, s])), seeds: new Map(), anidb: new Map(), model: 'default' };
const row = (id: number, retryAt: string, attemptedAt: string) => ({ fingerprint: hash(subjectPrint(ctx, id) + stable(null)), attemptedAt, retryAt, status: 'pending', reason: 'not found', attempts: 1 });
const progress = Progress.parse({ schemaVersion: 1, archive: null, subjects: { '6': row(6, '2026-09-10T00:00:00.000Z', '2026-09-03T00:00:00.000Z'), '7': row(7, '2026-09-20T00:00:00.000Z', '2026-09-13T00:00:00.000Z') } });
const rows = new Map<number, Mapping>([[8, {} as Mapping]]);
const ids = (list: { id: number }[]) => list.map(s => s.id);

test('the backlog allowance takes never-analysed older subjects newest first, then due retries, within the cap', () => {
  const full = queue(catalog, rows, progress, ctx, { scopeDays: 180, backlogSubjects: 10 }, now);
  assert.deepEqual(ids(full.recent), [1]);
  assert.deepEqual(ids(full.backlog), [3, 2, 4, 6], 'undated subjects come after dated ones; the due retry last; platform 其他 and the unexpired retry stay out');
  assert.equal(full.eligible, 4);
  const capped = queue(catalog, rows, progress, ctx, { scopeDays: 180, backlogSubjects: 2 }, now);
  assert.deepEqual([ids(capped.backlog), capped.eligible], [[3, 2], 4]);
  assert.deepEqual(ids(queue(catalog, rows, progress, ctx, { scopeDays: 180, backlogSubjects: 0 }, now).backlog), []);
});

test('an explicit platform list governs both the scope window and the backlog', () => {
  const other = queue(catalog, rows, progress, ctx, { scopeDays: 180, platforms: [0], backlogSubjects: 10 }, now);
  assert.deepEqual([ids(other.recent), ids(other.backlog)], [[], [5]]);
  const ova = queue(catalog, rows, progress, ctx, { scopeDays: 180, platforms: [2], backlogSubjects: 10 }, now);
  assert.deepEqual(ids(ova.backlog), [6]);
});
