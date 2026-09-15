import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importPending, parseUnresolved } from '../src/pending.js';
import { Progress } from '../src/model.js';
import { readJson, writeJson } from '../src/io.js';
import { loadContext, subjectPrint, due } from '../src/update.js';
import { catalog, mapping } from './helpers.js';

const doc = `# 待定映射完整清单

前言。

## 全部条目

### 2255 · 日本第一男人之魂

[Bangumi 条目](https://bgm.tv/subject/2255) · 第二轮复核（2026-09-09） · 作品日期：1999-01-05

原名：日本一の男の魂

TMDB TV 200944 可以确认是同一作品线索，但季表不完整。

参考资料：[1](<https://www.themoviedb.org/tv/200944>)

### 1 · 已映射条目

[Bangumi 条目](https://bgm.tv/subject/1) · 此前逐条核对

已有映射，应跳过。

参考资料：[1](<https://bgm.tv/subject/1>)
`;
test('unresolved review documents become long-lived pending entries that skip mapped subjects', async () => {
  const parsed = parseUnresolved(doc);
  assert.deepEqual(parsed.map(p => p.bangumiId), [2255, 1]);
  assert.equal(parsed[0]!.reason, '原名：日本一の男の魂\nTMDB TV 200944 可以确认是同一作品线索，但季表不完整。');
  assert.throws(() => parseUnresolved('### x · y\n\ntext\n'), /Unexpected heading/);
  const root = await mkdtemp(join(tmpdir(), 'pending-test-'));
  try {
    const base = catalog();
    base.subjects.push({ ...base.subjects[0]!, id: 2255, date: '1999-01-05' });
    await mkdir(join(root, '.cache'), { recursive: true });
    await writeJson(join(root, '.cache/catalog.json'), base);
    await writeJson(join(root, 'data/1.json'), mapping());
    await writeJson(join(root, 'sources/seed.json'), { schemaVersion: 1, repository: 'Rhilip/BangumiExtLinker', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), rows: [] });
    await writeJson(join(root, 'state/progress.json'), { schemaVersion: 1, archive: null, subjects: {} });
    await writeFile(join(root, 'unresolved.md'), doc);
    const now = Date.parse('2026-09-15T00:00:00Z');
    await importPending(root, join(root, 'unresolved.md'), 180, now);
    const progress = await readJson(join(root, 'state/progress.json'), Progress);
    assert.deepEqual(Object.keys(progress.subjects), ['2255']);
    const entry = progress.subjects['2255']!;
    assert.equal(entry.status, 'pending');
    assert.equal(entry.retryAt, new Date(now + 180 * 86400000).toISOString());
    const { ctx } = await loadContext(root, 'default');
    assert.equal(due(progress, 2255, subjectPrint(ctx, 2255), undefined, now + 86400000), false, 'not retried before the window or a data change');
    assert.equal(due(progress, 2255, subjectPrint(ctx, 2255), undefined, now + 181 * 86400000), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
