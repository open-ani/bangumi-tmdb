import { execFileSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Mapping } from './model.js';
import { stable } from './io.js';

export const allowedChange = (path: string): boolean => /^(data\/[1-9]\d*\.json|state\/progress\.json|sources\/(seed|import-report|anidb-check|coverage)\.json|README\.md)$/.test(path);
// README.md carries one generated block; automation may rewrite that block and nothing else.
export const STATS_START = '<!-- stats:start -->';
export const STATS_END = '<!-- stats:end -->';
export function outsideStats(text: string): string {
  const start = text.indexOf(STATS_START), end = text.indexOf(STATS_END);
  if (start === -1 || end === -1 || end < start) throw new Error('README.md is missing the generated stats markers');
  return text.slice(0, start) + text.slice(end + STATS_END.length);
}
export async function guard(root: string, base: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Guard requires an exact base SHA');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  if (git(['rev-parse', 'HEAD']).trim() !== base) throw new Error('HEAD changed during update');
  const changed = [...new Set([
    ...git(['diff', '--name-only', '-z', base]).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))];
  for (const path of changed) {
    if (!allowedChange(path)) throw new Error(`Automation cannot change ${path}`);
    if (!(await lstat(join(root, path))).isFile()) throw new Error('Automation cannot delete files or introduce symlinks');
    if (path === 'README.md') {
      if (outsideStats(git(['show', `${base}:README.md`])) !== outsideStats(await readFile(join(root, path), 'utf8')))
        throw new Error('Automation may only change the generated stats block of README.md');
      continue;
    }
    if (!path.startsWith('data/')) continue;
    let before;
    try { before = git(['show', `${base}:${path}`]); } catch { continue; }
    const previous = Mapping.parse(JSON.parse(before));
    if (previous.locked && stable(previous) !== await readFile(join(root, path), 'utf8')) throw new Error(`Locked record modified: ${path}`);
  }
}
