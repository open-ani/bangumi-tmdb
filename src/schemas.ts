import { z } from 'zod';
import { Mapping, Research, Progress, Seeds, AnidbReport } from './model.js';
import { writeJson } from './io.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Strict structured outputs accept a JSON Schema subset: anyOf rather than oneOf, and no length or
// range keywords. Our discriminator branches are disjoint literals, so the rewrite preserves meaning;
// the dropped constraints are still enforced when the decision is parsed with Zod.
const UNSUPPORTED = new Set(['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems']);
export function researchSchema(): unknown {
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, v]) => [k === 'oneOf' ? 'anyOf' : k, rewrite(v)]));
    return value;
  };
  return rewrite(z.toJSONSchema(Research));
}
export const schemas = () => ({
  mapping: z.toJSONSchema(Mapping), research: researchSchema(),
  progress: z.toJSONSchema(Progress), seed: z.toJSONSchema(Seeds),
  anidb: z.toJSONSchema(AnidbReport),
});
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, value] of Object.entries(schemas())) await writeJson(`schemas/${name}.schema.json`, value);
}
