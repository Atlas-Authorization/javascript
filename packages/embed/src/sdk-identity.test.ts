import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { ATLAS_EMBED_VERSION } from './version';

describe('@atlasauth/embed names itself to the Frontend API', () => {
  it('the version constant matches package.json', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };
    expect(ATLAS_EMBED_VERSION).toBe(manifest.version);
  });

  it('sends X-Atlas-SDK: @atlasauth/embed/<version>', async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await createClient({ publishableKey: 'pk_test_x', frontendApi: 'https://fapi.example', fetchImpl }).get('/v1/appearance');
    expect(seen[0]!['x-atlas-sdk']).toBe(`@atlasauth/embed/${ATLAS_EMBED_VERSION}`);
  });
});
