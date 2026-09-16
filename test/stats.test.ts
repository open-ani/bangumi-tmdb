import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeStats, renderStats, replaceStats, writeStats } from '../src/stats.js';
import { writeJson } from '../src/io.js';
import { catalog, mapping } from './helpers.js';

test('dataset statistics classify subjects, count episode coverage and rewrite only the README block', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stats-test-'));
  try {
    const base = catalog(mapping({ bangumiId: 1 }));
    base.snapshot.name = 'dump-2026-09-15.210336Z.zip';
    const subject = base.subjects[0]!;
    base.subjects.push({ ...subject, id: 2, date: '2026-09-01' }, { ...subject, id: 3, date: '2026-09-02' }, { ...subject, id: 4, date: '2010-01-01' },
      { ...subject, id: 5, date: '' }, { ...subject, id: 6, date: '2026-08-01' });
    base.episodes.push({ ...base.episodes[0]!, id: 61, subject_id: 6 });
    await mkdir(join(root, '.cache'), { recursive: true });
    await writeJson(join(root, '.cache/catalog.json'), base);
    await writeJson(join(root, 'data/1.json'), mapping({ bangumiId: 1 }));
    await writeJson(join(root, 'data/6.json'), mapping({ bangumiId: 6, episodes: [], rules: [], targets: [{ type: 'movie', id: 9 }],
      provenance: { method: 'seed', source: 's', evidence: 'e', verifiedAt: null } }));
    await writeJson(join(root, 'sources/seed.json'), { schemaVersion: 1, repository: 'Rhilip/BangumiExtLinker', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), rows: [] });
    const entry = { fingerprint: '', attemptedAt: '2026-09-16T00:00:00Z', retryAt: '2026-09-17T00:00:00Z', status: 'pending', reason: 'r', attempts: 1 };
    await writeJson(join(root, 'state/progress.json'), { schemaVersion: 1, archive: null, subjects: { '2': entry, '3': entry, '6': entry } });
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/unresolved-mappings-2026-09-10.md'), '### 2 · x\n\n[Bangumi 条目](u) · r\n\nreason\n\n参考资料：a\n');
    await writeFile(join(root, 'README.md'), 'Intro\n\n<!-- stats:start -->\nplaceholder\n<!-- stats:end -->\n\nOutro\n');
    const stats = await computeStats(root, 180);
    assert.equal(stats.archiveAnime, 6);
    assert.equal(stats.mapped, 2); assert.equal(stats.tvBare, 1); assert.equal(stats.movie, 1);
    assert.equal(stats.unresolved, 2); assert.equal(stats.unresolvedDocumented, 1); assert.equal(stats.unresolvedAutomation, 1);
    assert.equal(stats.unanalyzed, 2); assert.equal(stats.unanalyzedBefore2020, 1); assert.equal(stats.unanalyzedNoDate, 1); assert.equal(stats.unanalyzedInScope, 0);
    assert.equal(stats.broken, 1);
    assert.equal(stats.episodeLevel, 1); assert.equal(stats.subjectLevel, 1);
    assert.equal(stats.mappedEpisodes, 2); assert.equal(stats.regularOfMapped, 3);
    assert.deepEqual(stats.methods, { community: 1, seed: 1 });
    const block = renderStats(stats, 180);
    assert.match(block, /快照 `2026-09-15`/);
    assert.match(block, /\| 已建立映射 \| \*\*2\*\* \| 占 33\.3%/);
    assert.equal(replaceStats('a\n<!-- stats:start -->x<!-- stats:end -->\nb', 'B'), 'a\nB\nb');
    assert.throws(() => replaceStats('no markers', 'B'), /missing/);
    await writeStats(root, 180);
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    assert.ok(readme.startsWith('Intro\n\n<!-- stats:start -->') && readme.endsWith('<!-- stats:end -->\n\nOutro\n'));
    assert.ok(!readme.includes('placeholder'));
    await writeStats(root, 180);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), readme, 'idempotent');
  } finally { await rm(root, { recursive: true, force: true }); }
});
