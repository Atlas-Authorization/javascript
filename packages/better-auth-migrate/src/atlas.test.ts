import { afterEach, describe, expect, it } from 'vitest';
import { fetchImportKey } from './atlas';

const saved = { base: process.env.ATLAS_API_BASE, url: process.env.ATLAS_API_URL };
afterEach(() => {
  for (const [k, v] of [['ATLAS_API_BASE', saved.base], ['ATLAS_API_URL', saved.url]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function target(): Promise<string> {
  let seen = '';
  const fetch = (async (url: string) => {
    seen = String(url);
    return new Response(JSON.stringify({ kid: 'k', public_key: 'p', alg: 'x25519' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  await fetchImportKey({ secretKey: 'sk_test_x', fetch });
  return seen;
}

describe('the Atlas API base from the environment', () => {
  it('reads ATLAS_API_BASE, falls back to ATLAS_API_URL, and BASE wins when both are set', async () => {
    delete process.env.ATLAS_API_BASE;
    process.env.ATLAS_API_URL = 'https://url.test';
    expect(await target()).toBe('https://url.test/v1/better_auth_imports/public_key');
    process.env.ATLAS_API_BASE = 'https://base.test/';
    expect(await target()).toBe('https://base.test/v1/better_auth_imports/public_key');
  });
});
