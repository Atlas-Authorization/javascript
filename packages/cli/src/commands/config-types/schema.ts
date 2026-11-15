import type { ResourceSpec } from '../config';

type Schema = Record<string, unknown>;

/** `requires`: variable names that must be set; when one is unset the entry (or section) is skipped with a warning and never pruned. */
const REQUIRES: Schema = { description: 'Variable names that must be set (environment or --secrets-file). When one is unset the entry or section is skipped with a warning and is never read as a deletion.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };

const keys = (known: readonly string[]): Schema => ({ type: 'object', properties: { ...Object.fromEntries(known.map((k) => [k, {}])), requires: REQUIRES }, additionalProperties: false });

/** A JSON Schema (draft 2020-12) for atlas.yaml / atlas.json, one section per registered resource type. */
export function configJsonSchema(specs: readonly ResourceSpec[]): Schema {
  const properties: Record<string, Schema> = {};
  for (const s of specs) {
    if (s.kind === 'collection') {
      const entries: Schema = { type: 'array', items: keys(s.fileKeys) };
      // A list section may also be written `{ requires, items }` so one variable gates the whole section.
      properties[s.type] = { oneOf: [entries, { type: 'object', properties: { requires: REQUIRES, items: entries }, required: ['items'], additionalProperties: false }] };
    } else if (s.fileKeys) {
      const base = keys(s.fileKeys) as { properties: Record<string, Schema> };
      for (const [k, nested] of Object.entries(s.nestedKeys ?? {})) base.properties[k] = keys(nested);
      properties[s.type] = base;
    } else {
      properties[s.type] = { type: 'object' };
    }
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'atlas.yaml',
    type: 'object',
    properties,
    additionalProperties: false,
  };
}
