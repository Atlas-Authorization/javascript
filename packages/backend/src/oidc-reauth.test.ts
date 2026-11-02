import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasOidcError, isSafeReturnTo, oidcCallback, oidcStart, resetOidcCaches } from './oidc';
import { createTestIssuer, type TestIssuer } from './testing';

vi.setConfig({ testTimeout: 30_000 });

/** `uiLocales`, `maxAge` (auth_time enforced), `returnTo` and `expectedSub` on oidc.start / oidc.callback. */

const REDIRECT = 'https://app.example.com/auth/callback';
const SECRET = 'a-test-secret-that-is-at-least-32-characters';

beforeEach(() => resetOidcCaches());

async function run(fx: TestIssuer, start: Partial<Parameters<typeof oidcStart>[0]>, authorize: Parameters<TestIssuer['authorize']>[1] = {}) {
  const started = await oidcStart({ issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, secret: SECRET, fetchImpl: fx.fetch, ...start });
  const back = await fx.authorize(started.url, authorize);
  const callback = () =>
    oidcCallback({ issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, query: back.query, cookie: started.cookie, secret: SECRET, fetchImpl: fx.fetch });
  return { started, callback };
}

async function failure(promise: Promise<unknown>): Promise<AtlasOidcError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AtlasOidcError);
  return error as AtlasOidcError;
}

describe('oidc start/callback: re-authentication and return path', () => {
  it('sends ui_locales and max_age, and returns sid, authTime and returnTo', async () => {
    const fx = await createTestIssuer();
    const { started, callback } = await run(fx, { uiLocales: 'fr', maxAge: 300, returnTo: '/settings?tab=security' }, { claims: { sid: 'sess_42' } });
    const u = new URL(started.url);
    expect(u.searchParams.get('ui_locales')).toBe('fr');
    expect(u.searchParams.get('max_age')).toBe('300');
    expect(started.cookie).not.toContain('settings');
    const id = await callback();
    expect(id.sid).toBe('sess_42');
    expect(typeof id.authTime).toBe('number');
    expect(id.returnTo).toBe('/settings?tab=security');
  });

  it('refuses a token whose auth_time is older than max_age, or that has none', async () => {
    const fx = await createTestIssuer();
    const old = Math.floor(Date.now() / 1000) - 3600;
    const stale = await run(fx, { maxAge: 300 }, { claims: { auth_time: old } });
    expect((await failure(stale.callback())).code).toBe('reauthentication_required');
    const none = await run(fx, { maxAge: 0 }, { claims: { auth_time: undefined } });
    expect((await failure(none.callback())).code).toBe('reauthentication_required');
    // Without max_age an old auth_time is fine: it is the app's call.
    const free = await run(fx, {}, { claims: { auth_time: old } });
    expect((await free.callback()).authTime).toBe(old);
  });

  it('max_age=0 accepts a sign-in made just now', async () => {
    const fx = await createTestIssuer();
    const { callback } = await run(fx, { maxAge: 0 });
    expect((await callback()).authTime).not.toBeNull();
  });

  it('refuses a different user than expectedSub', async () => {
    const fx = await createTestIssuer();
    const other = await run(fx, { expectedSub: 'user_a' }, { sub: 'user_b' });
    expect((await failure(other.callback())).code).toBe('subject_mismatch');
    const same = await run(fx, { expectedSub: 'user_a' }, { sub: 'user_a' });
    expect((await same.callback()).sub).toBe('user_a');
  });

  it('refuses a bad maxAge or a returnTo that is not a plain path', async () => {
    const fx = await createTestIssuer();
    const base = { issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, secret: SECRET, fetchImpl: fx.fetch };
    await expect(oidcStart({ ...base, maxAge: -1 })).rejects.toThrow(/maxAge/);
    await expect(oidcStart({ ...base, maxAge: 1.5 })).rejects.toThrow(/maxAge/);
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'relative', '/a\nb', '']) {
      await expect(oidcStart({ ...base, returnTo: bad })).rejects.toThrow(/returnTo/);
    }
  });

  it('isSafeReturnTo accepts only same-site paths', () => {
    for (const ok of ['/', '/a', '/a/b?c=d#e', '/%2F%2Fevil']) expect(isSafeReturnTo(ok)).toBe(true);
    for (const bad of ['', 'a', '//a', '/\\a', '/a\\b', 'javascript:alert(1)', '/a\u0000']) expect(isSafeReturnTo(bad)).toBe(false);
  });
});
