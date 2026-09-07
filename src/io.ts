import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { Mapping } from './model.js';

export function stable(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') return Object.fromEntries(
      Object.entries(v).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, x]) => [k, normalize(x)]),
    );
    return v;
  };
  return JSON.stringify(normalize(value), null, 2) + '\n';
}
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export async function readJson<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  const contents = stable(value);
  try { if (await readFile(path, 'utf8') === contents) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, contents);
  await rename(temp, path);
}
export async function mappings(root: string): Promise<Mapping[]> {
  let files: string[];
  try { files = await readdir(join(root, 'data')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result: Mapping[] = [];
  for (const file of files.sort()) {
    if (file === '.gitkeep') continue;
    if (!/^[1-9]\d*\.json$/.test(file)) throw new Error(`Unexpected data file: ${file}`);
    const path = join(root, 'data', file);
    if (!(await lstat(path)).isFile()) throw new Error(`Data must be regular files: ${file}`);
    const row = await readJson(path, Mapping);
    if (file !== `${row.bangumiId}.json`) throw new Error(`Filename/subject mismatch: ${file}`);
    if (stable(row) !== await readFile(path, 'utf8')) throw new Error(`Noncanonical JSON: ${file}; run cli format`);
    result.push(row);
  }
  return result.sort((a, b) => a.bangumiId - b.bangumiId);
}
