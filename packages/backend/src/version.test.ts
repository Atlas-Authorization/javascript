import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAtlasClient } from './client';
import { ATLAS_BACKEND_VERSION } from './version';

describe('SDK identity', () => {
  it('matches package.json', () => {
    expect(ATLAS_BACKEND_VERSION).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  });

  it('is sent as X-Atlas-SDK unless telemetry is false', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetch = (async (_u: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    await createAtlasClient({ secretKey: 'sk_test_1', fetch }).sessions.get('sess_1');
    await createAtlasClient({ secretKey: 'sk_test_1', fetch, telemetry: false }).sessions.get('sess_1');
    expect(seen[0]!['x-atlas-sdk']).toBe(`@atlasauth/backend/${ATLAS_BACKEND_VERSION}`);
    expect(seen[1]!['x-atlas-sdk']).toBeUndefined();
  });
});
