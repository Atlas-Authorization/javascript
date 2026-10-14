import { describe, expect, it, vi } from 'vitest';
import {
  atlasSetup,
  getTestingToken,
  setupAtlasTestingToken,
  createTestingTokenRoute,
  addAtlasCommands,
  TESTING_TOKEN_PARAM,
} from './index';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('atlasSetup', () => {
  it('mints the token once and shares it across N getToken() calls', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token: 'tt_cached' })) as unknown as typeof fetch;
    const atlas = atlasSetup({ secretKey: 'sk_test', fetchImpl });

    const results = await Promise.all([atlas.getToken(), atlas.getToken(), atlas.getToken()]);

    expect(results).toEqual(['tt_cached', 'tt_cached', 'tt_cached']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A later call still re-uses the cached value — no second round-trip.
    expect(await atlas.getToken()).toBe('tt_cached');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('is lazy — nothing is minted until getToken() is first called', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token: 't' })) as unknown as typeof fetch;
    atlasSetup({ secretKey: 'sk_test', fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches a null result too (one failed mint, not one per call)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    const atlas = atlasSetup({ secretKey: 'sk_test', fetchImpl });
    expect(await atlas.getToken()).toBeNull();
    expect(await atlas.getToken()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('package surface', () => {
  it('re-exports the core + both framework adapters from the root', () => {
    expect(typeof getTestingToken).toBe('function');
    expect(typeof setupAtlasTestingToken).toBe('function');
    expect(typeof createTestingTokenRoute).toBe('function');
    expect(typeof addAtlasCommands).toBe('function');
    expect(TESTING_TOKEN_PARAM).toBe('__atlas_testing_token');
  });
});
