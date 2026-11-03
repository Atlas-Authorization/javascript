import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_DATA_SCHEMAS,
  WEBHOOK_EVENT_DATA,
  WEBHOOK_EVENT_SCHEMAS,
} from '../../../apps/api/src/openapi/route-docs/webhook-event-schemas';
import { renderWebhookEvents, tsType, type Schema } from './gen-webhook-events';

const target = join(__dirname, '../src/webhook-events.generated.ts');

describe('AtlasWebhookEvent is generated from the server catalogue', () => {
  const rendered = renderWebhookEvents(
    WEBHOOK_DATA_SCHEMAS as Record<string, Schema>,
    WEBHOOK_EVENT_DATA as Record<string, string>,
  );
  if (process.env.ATLAS_WRITE_GENERATED === '1') writeFileSync(target, rendered);

  it('the committed file matches the catalogue (rerun with ATLAS_WRITE_GENERATED=1 to update)', () => {
    expect(readFileSync(target, 'utf8')).toBe(rendered);
  });

  it('covers every canonical event', () => {
    const canonical = Object.keys(WEBHOOK_EVENT_SCHEMAS).map((k) => k.replace(/^WebhookEvent\./, '')).sort();
    expect(Object.keys(WEBHOOK_EVENT_DATA).sort()).toEqual(canonical);
    for (const name of canonical) expect(rendered).toContain(`AtlasWebhookEnvelope<${JSON.stringify(name)},`);
  });

  it('converts the schema subset', () => {
    expect(tsType({ type: ['string', 'null'] })).toBe('string | null');
    expect(tsType({ enum: ['a', 'b'] })).toBe('"a" | "b"');
    expect(tsType({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(tsType({ type: 'object', additionalProperties: { type: 'integer' } })).toBe('Record<string, number>');
    expect(tsType({ type: 'object', required: ['a'], properties: { a: { const: 'x' }, 'b-c': { type: 'boolean' } } })).toBe(
      '{\n  a: "x";\n  "b-c"?: boolean;\n  [key: string]: unknown;\n}',
    );
  });
});
