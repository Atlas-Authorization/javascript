import { describe, expect, it } from 'vitest';
import { DEFAULT_API_URL } from './request';
import { apiBaseFromEnv, atlasConfigFromEnv, createAtlasClientFromEnv } from './env';

describe('API base from the environment', () => {
  it('accepts ATLAS_API_BASE and ATLAS_API_URL; BASE wins; blanks are ignored', () => {
    expect(apiBaseFromEnv({})).toBeUndefined();
    expect(apiBaseFromEnv({ ATLAS_API_URL: 'https://url.example' })).toBe('https://url.example');
    expect(apiBaseFromEnv({ ATLAS_API_BASE: 'https://base.example' })).toBe('https://base.example');
    expect(apiBaseFromEnv({ ATLAS_API_BASE: 'https://base.example', ATLAS_API_URL: 'https://url.example' })).toBe('https://base.example');
    expect(apiBaseFromEnv({ ATLAS_API_BASE: ' ', ATLAS_API_URL: 'https://url.example' })).toBe('https://url.example');
  });

  it('atlasConfigFromEnv reads the key and base, defaults the base, and lets overrides win', () => {
    expect(atlasConfigFromEnv({ ATLAS_SECRET_KEY: 'sk_test_1' })).toEqual({ secretKey: 'sk_test_1', apiUrl: DEFAULT_API_URL });
    expect(atlasConfigFromEnv({ ATLAS_SECRET_KEY: 'sk_test_1', ATLAS_API_BASE: 'https://b.example' }).apiUrl).toBe('https://b.example');
    expect(atlasConfigFromEnv({ ATLAS_SECRET_KEY: 'sk_test_1', ATLAS_API_URL: 'https://u.example' }, { apiUrl: 'https://o.example' }).apiUrl).toBe('https://o.example');
    expect(() => atlasConfigFromEnv({})).toThrow(/ATLAS_SECRET_KEY/);
  });

  it('createAtlasClientFromEnv sends requests to the configured base', async () => {
    const urls: string[] = [];
    const client = createAtlasClientFromEnv(
      { ATLAS_SECRET_KEY: 'sk_test_1', ATLAS_API_BASE: 'https://base.example/' },
      { fetch: (async (u: unknown) => {
          urls.push(String(u));
          return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch },
    );
    await client.users.list({ limit: 1 });
    expect(urls[0]).toMatch(/^https:\/\/base\.example\/v1\/users/);
  });
});
