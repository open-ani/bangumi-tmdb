import { z } from 'zod';
import { Mapping, Decision, Progress, Seeds } from './model.js';
import { writeJson } from './io.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function decisionSchema(): unknown {
  // Codex strict outputs allow anyOf, not oneOf. Our branches have disjoint
  // literal discriminators, so this rewrite preserves their meaning.
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k === 'oneOf' ? 'anyOf' : k, rewrite(v)]));
    return value;
  };
  return rewrite(z.toJSONSchema(Decision));
}
export const schemas = () => ({
  mapping: z.toJSONSchema(Mapping), decision: decisionSchema(),
  progress: z.toJSONSchema(Progress), seed: z.toJSONSchema(Seeds),
});
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, value] of Object.entries(schemas())) await writeJson(`schemas/${name}.schema.json`, value);
}
