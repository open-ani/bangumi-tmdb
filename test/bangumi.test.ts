import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bangumi, discover, renderInfobox, toSubject } from '../src/bangumi.js';
import { dumpTime, loadCatalog, overlay } from '../src/catalog.js';
import { Fresh } from '../src/model.js';
import { readJson, writeJson } from '../src/io.js';
import { catalog, episode, mapping } from './helpers.js';

test('API subjects render like Archive records; dump names carry their timestamp', () => {
  const subject = toSubject({ id: 5, type: 2, name: 'N', name_cn: null, date: null, platform: 'TV', summary: null,
    infobox: [{ key: '中文名', value: 'X' }, { key: '别名', value: [{ v: 'A' }, { k: 'en', v: 'B' }] }] });
  assert.equal(subject.date, '');
  assert.equal(subject.infobox, '{{Infobox\r\n|中文名= X\r\n|别名={\r\n[A]\r\n[en|B]\r\n}\r\n}}');
  assert.equal(renderInfobox(null), '');
  assert.equal(dumpTime({ name: 'dump-2026-09-08.210336Z.zip' }), Date.parse('2026-09-08T21:03:36Z'));
  assert.equal(dumpTime({ name: 'fixture' }), 0);
});
test('overlay replaces newer subjects and their episodes, drops merged ones, ignores 404s and stale fetches', () => {
  const base = catalog();
  base.snapshot.name = 'dump-2026-09-08.210336Z.zip';
  base.subjects.push({ ...base.subjects[0]!, id: 2 }, { ...base.subjects[0]!, id: 3 });
  base.episodes.push({ ...episode(21, 1), subject_id: 2 }, { ...episode(31, 1), subject_id: 3 });
  const fresh = Fresh.parse({ schemaVersion: 1, subjects: [
    { fetchedAt: '2026-09-09T00:00:00Z', subject: { ...base.subjects[0]!, name: 'Renamed' }, episodes: [episode(11, 1), episode(12, 2), episode(13, 3)] },
    { fetchedAt: '2026-09-01T00:00:00Z', subject: { ...base.subjects[0]!, id: 3, name: 'Stale' }, episodes: [] },
  ], missing: [{ id: 2, fetchedAt: '2026-09-09T00:00:00Z', status: 'merged', target: 1 }, { id: 3, fetchedAt: '2026-09-09T00:00:00Z', status: 'missing' }] });
  const merged = overlay(base, fresh);
  assert.deepEqual(merged.subjects.map(s => [s.id, s.name]), [[1, 'Renamed'], [3, 'Fixture']]);
  assert.deepEqual(merged.episodes.map(e => e.id), [11, 12, 13, 31]);
});
test('discovery pages through the API, records merges, keeps prior overlay entries and writes the overlay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'discover-test-'));
  const now = Date.parse('2026-09-15T00:00:00Z');
  const calls: string[] = [];
  const subjectJson = (id: number, date: string) => ({ id, type: 2, name: `S${id}`, name_cn: '', date, platform: 'TV', summary: '', infobox: [] });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname === '/v0/search/subjects') {
      const offset = Number(url.searchParams.get('offset'));
      const all = [subjectJson(50, '2026-09-20'), ...Array.from({ length: 20 }, (_, i) => subjectJson(60 + i, '2026-09-01'))];
      return Response.json({ data: all.slice(offset, offset + 20), total: all.length, limit: 20, offset });
    }
    if (url.pathname === '/calendar') return Response.json([{ items: [{ id: 70, type: 2 }, { id: 200, type: 1 }] }]);
    if (url.pathname === '/v0/subjects/2') return new Response(null, { status: 302, headers: { location: 'https://api.bgm.tv/v0/subjects/1' } });
    if (url.pathname === '/v0/subjects/9') return new Response('nsfw hidden', { status: 404 });
    if (url.pathname.startsWith('/v0/subjects/')) return Response.json(subjectJson(Number(url.pathname.split('/').pop()), '2026-08-01'));
    if (url.pathname === '/v0/episodes') {
      const subject = Number(url.searchParams.get('subject_id')), offset = Number(url.searchParams.get('offset'));
      const total = subject === 50 ? 250 : 2;
      const eps = Array.from({ length: Math.min(200, total - offset) }, (_, i) => ({ id: subject * 1000 + offset + i, subject_id: subject, type: 0, sort: offset + i + 1, name: '', name_cn: '', airdate: '2026-09-01' }));
      return Response.json({ data: eps, total, limit: 200, offset });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  try {
    const base = catalog(mapping({ bangumiId: 1 }));
    base.snapshot.name = 'dump-2026-09-08.210336Z.zip';
    base.subjects.push({ ...base.subjects[0]!, id: 9, date: '2026-09-10' });
    await mkdir(join(root, '.cache'), { recursive: true });
    await writeJson(join(root, '.cache/catalog.json'), base);
    await writeJson(join(root, '.cache/bangumi-fresh.json'), { schemaVersion: 1, subjects: [
      { fetchedAt: '2026-09-10T00:00:00Z', subject: { ...base.subjects[0]!, id: 80, name: 'Kept' }, episodes: [] },
      { fetchedAt: '2026-09-01T00:00:00Z', subject: { ...base.subjects[0]!, id: 81, name: 'Superseded' }, episodes: [] }], missing: [] });
    await mkdir(join(root, 'data'));
    for (const id of [1, 2, 9]) await writeJson(join(root, `data/${id}.json`), mapping({ bangumiId: id, episodes: [] , rules: [] }));
    await writeJson(join(root, 'state/progress.json'), { schemaVersion: 1, archive: null, subjects: {
      '90': { fingerprint: '', attemptedAt: '2026-09-01T00:00:00Z', retryAt: '2026-09-15T12:00:00Z', status: 'pending', reason: 'r', attempts: 1 } } });
    const summary = await discover(root, { now, pastDays: 45, futureDays: 120, maxSubjects: 100, fetcher, pauseMs: 0 });
    assert.equal(summary.merged, 1);
    assert.equal(summary.failed, 0);
    const fresh = await readJson(join(root, '.cache/bangumi-fresh.json'), Fresh);
    const ids = fresh.subjects.map(e => e.subject.id);
    assert.ok(ids.includes(50) && ids.includes(79) && ids.includes(70) && ids.includes(80) && ids.includes(90));
    assert.ok(!ids.includes(1), 'a finished, long-aired mapped subject is not refreshed');
    assert.ok(!ids.includes(81), 'entries older than the dump are dropped');
    assert.ok(!ids.includes(200), 'non-anime calendar items are ignored');
    assert.equal(fresh.subjects.find(e => e.subject.id === 50)!.episodes.length, 250);
    assert.deepEqual(fresh.missing, [{ id: 2, fetchedAt: new Date(now).toISOString(), status: 'merged', target: 1 }, { id: 9, fetchedAt: new Date(now).toISOString(), status: 'missing' }]);
    assert.equal(calls.filter(c => c.startsWith('POST /v0/search')).length, 2);
    const { catalog: merged } = await loadCatalog(root);
    assert.ok(merged.subjects.some(s => s.id === 9), '404 keeps the Archive record');
    assert.ok(!merged.subjects.some(s => s.id === 2), 'merged subjects leave the catalog');
    const api = new Bangumi('', fetcher, 0);
    assert.deepEqual(await api.subject(2), { status: 'merged', target: 1 });
    assert.deepEqual(await api.subject(9), { status: 'missing' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
