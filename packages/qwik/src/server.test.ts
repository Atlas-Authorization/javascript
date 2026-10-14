import { describe, expect, it } from 'vitest';
import { getAuthState, protectRoute, type GuardRequestEvent } from './server';

/**
 * The Qwik City route guard reads the `__session` cookie and decides whether to
 * redirect. The event is duck-typed, so the test supplies a tiny stub with just
 * the cookie + redirect surface the helper touches.
 */

function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

class RedirectSignal extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`redirect ${status} -> ${url}`);
  }
}

function event(cookie: string | null): GuardRequestEvent {
  return {
    cookie: {
      get: (name: string) => (name === '__session' && cookie ? { value: cookie } : null),
    },
    // Mirror Qwik City: `redirect()` returns a value the caller throws.
    redirect: (status: number, url: string) => new RedirectSignal(status, url),
    url: new URL('https://app.example/dashboard'),
  };
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 3600;

describe('getAuthState', () => {
  it('is signed-out with no cookie', () => {
    const state = getAuthState(event(null));
    expect(state.isSignedIn).toBe(false);
    expect(state.claims).toBeNull();
  });

  it('reads unverified claims from a fresh __session cookie', () => {
    const jwt = makeJwt({
      sub: 'user_1',
      sid: 'sess_1',
      exp: future(),
      org_id: 'org_7',
      org_role: 'org:admin',
    });
    const state = getAuthState(event(jwt));
    expect(state.isSignedIn).toBe(true);
    expect(state.claims?.sub).toBe('user_1');
    expect(state.has({ role: 'org:admin' })).toBe(true);
    expect(state.has({ role: 'org:member' })).toBe(false);
  });

  it('treats an expired token as signed-out', () => {
    const jwt = makeJwt({ sub: 'user_1', sid: 'sess_1', exp: past() });
    expect(getAuthState(event(jwt)).isSignedIn).toBe(false);
  });
});

describe('protectRoute', () => {
  it('redirects an unauthenticated request to the sign-in url', () => {
    try {
      protectRoute(event(null), { signInUrl: '/sign-in' });
      throw new Error('should have redirected');
    } catch (err) {
      expect(err).toBeInstanceOf(RedirectSignal);
      expect((err as RedirectSignal).url).toBe('/sign-in');
    }
  });

  it('lets an authenticated request through and returns the claims', () => {
    const jwt = makeJwt({ sub: 'user_1', sid: 'sess_1', exp: future() });
    const state = protectRoute(event(jwt));
    expect(state.isSignedIn).toBe(true);
    expect(state.claims?.sub).toBe('user_1');
  });

  it('redirects a signed-in user who fails the condition', () => {
    const jwt = makeJwt({
      sub: 'user_1',
      sid: 'sess_1',
      exp: future(),
      org_id: 'org_7',
      org_role: 'org:member',
    });
    try {
      protectRoute(event(jwt), { condition: { role: 'org:admin' }, forbiddenUrl: '/403' });
      throw new Error('should have redirected');
    } catch (err) {
      expect(err).toBeInstanceOf(RedirectSignal);
      expect((err as RedirectSignal).url).toBe('/403');
    }
  });
});
