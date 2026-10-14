import { describe, expect, it, vi } from 'vitest';
import {
  createTestingTokenRoute,
  setupAtlasTestingToken,
  TESTING_TOKEN_PARAM,
  DEFAULT_FAPI_GLOB,
  type PlaywrightPage,
  type PlaywrightRoute,
} from './playwright';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A route stub that records what `continue` was called with. */
function routeStub(): { route: PlaywrightRoute; calls: Array<{ url?: string } | undefined> } {
  const calls: Array<{ url?: string } | undefined> = [];
  return {
    calls,
    route: {
      continue: async (options?: { url?: string }) => {
        calls.push(options);
      },
    },
  };
}

describe('createTestingTokenRoute', () => {
  it('appends the testing token as a query param, preserving existing params', async () => {
    const handler = createTestingTokenRoute('tt_42');
    const { route, calls } = routeStub();

    await handler(route, { url: () => 'https://fapi.acme.test/v1/client?foo=bar' });

    expect(calls).toHaveLength(1);
    const rewritten = new URL(calls[0]!.url!);
    expect(rewritten.searchParams.get(TESTING_TOKEN_PARAM)).toBe('tt_42');
    expect(rewritten.searchParams.get('foo')).toBe('bar');
  });

  it('fail-soft: a bad URL lets the request continue untouched', async () => {
    const handler = createTestingTokenRoute('tt_42');
    const { route, calls } = routeStub();

    await handler(route, { url: () => 'not a url' });

    expect(calls).toEqual([undefined]); // continue() with no override
  });
});

describe('setupAtlasTestingToken', () => {
  it('mints a token and installs a route that appends it (default FAPI glob)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token: 'tt_pw' })) as unknown as typeof fetch;
    let registeredGlob: string | undefined;
    let registeredHandler: Parameters<PlaywrightPage['route']>[1] | undefined;
    const page: PlaywrightPage = {
      route: async (glob, handler) => {
        registeredGlob = glob;
        registeredHandler = handler;
      },
    };

    const token = await setupAtlasTestingToken({ page, secretKey: 'sk_test', fetchImpl });

    expect(token).toBe('tt_pw');
    expect(registeredGlob).toBe(DEFAULT_FAPI_GLOB);

    // The handler the page received appends the token.
    const { route, calls } = routeStub();
    await registeredHandler!(route, { url: () => 'https://fapi.acme.test/v1/environment' });
    expect(new URL(calls[0]!.url!).searchParams.get(TESTING_TOKEN_PARAM)).toBe('tt_pw');
  });

  it('scopes the glob to a given frontendApiUrl', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token: 'tt' })) as unknown as typeof fetch;
    let registeredGlob: string | undefined;
    const page: PlaywrightPage = {
      route: async (glob) => {
        registeredGlob = glob;
      },
    };
    await setupAtlasTestingToken({
      page,
      secretKey: 'sk_test',
      frontendApiUrl: 'https://fapi.acme.test/',
      fetchImpl,
    });
    expect(registeredGlob).toBe('https://fapi.acme.test/v1/**');
  });

  it('fail-soft: installs no route and returns null when the token cannot be minted', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 403)) as unknown as typeof fetch;
    const route = vi.fn();
    const page = { route } as unknown as PlaywrightPage;

    const token = await setupAtlasTestingToken({ page, secretKey: 'sk_test', fetchImpl });

    expect(token).toBeNull();
    expect(route).not.toHaveBeenCalled();
  });
});
