import { describe, expect, it, vi } from 'vitest';
import { AtlasSignInError, getSignInUrl } from './sign-in-as';
import { signInAs, type PlaywrightNavigablePage } from './playwright';
import { getTestingToken } from './testing-token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MINTED = {
  object: 'testing_sign_in_url',
  url: 'https://fapi.acme.test/v1/client/sign_in_tickets/redeem?ticket=tkt&publishable_key=pk_test_x',
  ticket: 'tkt',
  expires_at: '2026-10-30T12:00:00.000Z',
};

describe('getSignInUrl', () => {
  it('POSTs /v1/testing/sign_in_url with the secret key and returns the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MINTED, 201)) as unknown as typeof fetch;
    const out = await getSignInUrl({ secretKey: 'sk_test_1', userId: 'user_1', redirectUrl: 'http://localhost:3000/', apiUrl: 'https://api.acme.test/', fetchImpl });
    expect(out).toEqual({ url: MINTED.url, ticket: 'tkt', expiresAt: MINTED.expires_at });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://api.acme.test/v1/testing/sign_in_url');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_test_1');
    expect(JSON.parse(String(init.body))).toEqual({ user_id: 'user_1', redirect_url: 'http://localhost:3000/' });
  });

  it('throws with the API status and code (never a silent signed-out browser)', async () => {
    const fetchImpl = (async () => jsonResponse({ errors: [{ code: 'TESTING_UNAVAILABLE', message: 'dev only' }] }, 403)) as unknown as typeof fetch;
    const err = await getSignInUrl({ secretKey: 'sk_live_1', userId: 'u', redirectUrl: 'https://app.acme.test/', fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtlasSignInError);
    expect((err as AtlasSignInError).status).toBe(403);
    expect((err as AtlasSignInError).code).toBe('TESTING_UNAVAILABLE');
  });
});

describe('signInAs (Playwright)', () => {
  function pageStub(current = 'http://localhost:3000/dashboard') {
    const visited: string[] = [];
    let waited = false;
    const page: PlaywrightNavigablePage = {
      url: () => current,
      goto: async (u: string) => void visited.push(u),
      waitForURL: async (pred) => {
        waited = true;
        expect(pred(new URL('http://localhost:3000/dashboard?__atlas_attempt=a&__atlas_ticket=t'))).toBe(false);
        expect(pred(new URL('http://localhost:3000/dashboard'))).toBe(true);
      },
    };
    return { page, visited, waited: () => waited };
  }

  it('mints for the current page, opens the URL and waits for the exchange', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MINTED, 201)) as unknown as typeof fetch;
    const { page, visited, waited } = pageStub();
    await signInAs(page, 'user_1', { secretKey: 'sk_test_1', fetchImpl });
    expect(visited).toEqual([MINTED.url]);
    expect(waited()).toBe(true);
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect(JSON.parse(String(init.body)).redirect_url).toBe('http://localhost:3000/dashboard');
  });

  it('needs an http(s) redirect when the page is blank', async () => {
    const { page } = pageStub('about:blank');
    await expect(signInAs(page, 'user_1', { secretKey: 'sk_test_1', fetchImpl: vi.fn() as unknown as typeof fetch })).rejects.toBeInstanceOf(AtlasSignInError);
  });
});

describe('getTestingToken response shape', () => {
  it('reads the jwt the Backend API returns', async () => {
    const fetchImpl = (async () => jsonResponse({ object: 'testing_token', jwt: 'eyJ.x.y', token_use: 'testing', expires_in: 300 }, 201)) as unknown as typeof fetch;
    expect(await getTestingToken({ secretKey: 'sk_test_1', fetchImpl })).toBe('eyJ.x.y');
  });
});
