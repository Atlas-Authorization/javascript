import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishActiveAtlas, type ActiveAtlas } from './active-atlas';
import {
  OktaAuthCompat,
  OktaCompatAuthSdkError,
  oktaAuthStateFrom,
  oktaUserFrom,
  toRelativeUrlCompat,
} from './compat-okta';
import type { AtlasUser, SessionClaims } from './types';

const user: AtlasUser = {
  id: 'user_1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  username: 'ada',
  image_url: 'https://img.test/ada.png',
  public_metadata: {},
  unsafe_metadata: {},
  mfa_enabled: false,
  has_password: true,
  email_addresses: [
    { id: 'idn_2', email_address: 'old@ada.test', verified: false, primary: false },
    { id: 'idn_1', email_address: 'ada@ada.test', verified: true, primary: true },
  ],
};
const claims: SessionClaims = { sub: 'user_1', sid: 'sess_1', exp: 2_000_000_000 };

const b64url = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
/** A JWT-shaped token expiring at `exp` (seconds). */
const jwt = (exp: number) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ sub: 'user_1', exp })}.sig`;
const inAnHour = () => jwt(Math.floor(Date.now() / 1000) + 3600);

function provider(over: Partial<ActiveAtlas> = {}): ActiveAtlas & { signOut: ReturnType<typeof vi.fn> } {
  const token = inAnHour();
  return {
    status: 'signed_in',
    user,
    claims,
    getToken: async () => token,
    signOut: vi.fn(async () => ({ revoked: true })),
    reload: async () => true,
    ...over,
  } as ActiveAtlas & { signOut: ReturnType<typeof vi.fn> };
}

const assign = vi.fn();
function stubWindow() {
  vi.stubGlobal('window', { location: { assign, replace: assign, href: 'https://app.test/now' } });
}

afterEach(() => {
  publishActiveAtlas(null);
  assign.mockReset();
  vi.unstubAllGlobals();
});

describe('okta compat: user and auth state', () => {
  it('maps the user onto the OIDC user claims Okta returns', () => {
    expect(oktaUserFrom(user)).toEqual({
      sub: 'user_1',
      name: 'Ada Lovelace',
      given_name: 'Ada',
      family_name: 'Lovelace',
      preferred_username: 'ada',
      email: 'ada@ada.test',
      email_verified: true,
      picture: 'https://img.test/ada.png',
    });
    expect(oktaUserFrom(null)).toBeNull();
  });

  it('uses the email as the login when there is no username, and omits what the user lacks', () => {
    const noUsername = { ...user, first_name: null, last_name: null, username: null, image_url: null };
    expect(oktaUserFrom(noUsername)).toEqual({
      sub: 'user_1',
      preferred_username: 'ada@ada.test',
      email: 'ada@ada.test',
      email_verified: true,
    });
    expect(oktaUserFrom({ ...noUsername, email_addresses: [] })).toEqual({ sub: 'user_1' });
  });

  it('authState is null while loading or while the token is read, like Okta before its first evaluation', () => {
    expect(oktaAuthStateFrom({ status: 'loading', user: null, claims: null }, undefined)).toBeNull();
    expect(oktaAuthStateFrom({ status: 'signed_in', user, claims }, undefined)).toBeNull();
    expect(oktaAuthStateFrom({ status: 'signed_out', user: null, claims: null }, undefined)).toEqual({ isAuthenticated: false });
    expect(oktaAuthStateFrom({ status: 'signed_in', user, claims }, null)).toEqual({ isAuthenticated: true });
  });

  it('a signed-in authState carries the session token as idToken and accessToken', () => {
    const state = oktaAuthStateFrom({ status: 'signed_in', user, claims }, 'tok')!;
    expect(state.isAuthenticated).toBe(true);
    expect(state.accessToken).toEqual({ accessToken: 'tok', claims });
    expect(state.idToken?.idToken).toBe('tok');
    expect(state.idToken?.claims).toMatchObject({ sub: 'user_1', sid: 'sess_1', email: 'ada@ada.test', name: 'Ada Lovelace' });
  });
});

describe('okta compat: OktaAuthCompat', () => {
  it('signInWithRedirect opens the sign-in page and comes back to originalUri', async () => {
    stubWindow();
    const p = provider();
    await new OktaAuthCompat({}, () => p).signInWithRedirect({ originalUri: '/orders' });
    expect(assign).toHaveBeenLastCalledWith('/sign-in?redirect_url=%2Forders');
    await new OktaAuthCompat({ signInUrl: '/login', issuer: 'https://acme.okta.test/oauth2/default' }, () => p).signInWithRedirect();
    expect(assign).toHaveBeenLastCalledWith('/login');
  });

  it('signOut signs out, then goes to postLogoutRedirectUri (call, then config, then /)', async () => {
    stubWindow();
    const p = provider();
    const auth = new OktaAuthCompat({ postLogoutRedirectUri: '/goodbye' }, () => p);
    await auth.signOut({ postLogoutRedirectUri: '/bye' });
    expect(p.signOut).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenLastCalledWith('/bye');
    await auth.signOut();
    expect(assign).toHaveBeenLastCalledWith('/goodbye');
    await new OktaAuthCompat({}, () => p).signOut();
    expect(assign).toHaveBeenLastCalledWith('/');
  });

  it('isAuthenticated, getUser and token.getUserInfo read the provider', async () => {
    const auth = new OktaAuthCompat({}, () => provider());
    expect(await auth.isAuthenticated()).toBe(true);
    expect((await auth.getUser()).email).toBe('ada@ada.test');
    expect((await auth.token.getUserInfo()).sub).toBe('user_1');
  });

  it('getUser throws AuthSdkError when nobody is signed in', async () => {
    const auth = new OktaAuthCompat({}, () => provider({ status: 'signed_out', user: null, claims: null }));
    expect(await auth.isAuthenticated()).toBe(false);
    await expect(auth.getUser()).rejects.toBeInstanceOf(OktaCompatAuthSdkError);
    await expect(auth.getUser()).rejects.toMatchObject({ name: 'AuthSdkError', errorCode: 'INTERNAL' });
  });

  it('getAccessToken / getIdToken are synchronous and return the token on hand', async () => {
    const token = inAnHour();
    const auth = new OktaAuthCompat({}, () => provider({ getToken: async () => token }));
    expect(await auth.getFreshAccessToken()).toBe(token);
    expect(auth.getAccessToken()).toBe(token);
    expect(auth.getIdToken()).toBe(token);
  });

  it('never hands out an expired token, nor one minted for another user', async () => {
    const expired = jwt(Math.floor(Date.now() / 1000) - 60);
    const stale = new OktaAuthCompat({}, () => provider({ getToken: async () => expired }));
    await stale.getFreshAccessToken();
    expect(stale.getAccessToken()).toBeUndefined();

    let current = provider();
    const auth = new OktaAuthCompat({}, () => current);
    await auth.getFreshAccessToken();
    expect(auth.getAccessToken()).toBeDefined();
    current = provider({ claims: { ...claims, sub: 'user_2' } });
    expect(auth.getAccessToken()).toBeUndefined();
    current = provider({ status: 'signed_out', user: null, claims: null });
    expect(auth.getAccessToken()).toBeUndefined();
    expect(await new OktaAuthCompat({}, () => current).getFreshAccessToken()).toBeUndefined();
  });

  it('with no source given, acts on the mounted provider and keeps a token on hand', async () => {
    const token = inAnHour();
    const p = provider({ getToken: vi.fn(async () => token) });
    const auth = new OktaAuthCompat({ issuer: 'https://acme.okta.test/oauth2/default', clientId: '0oa1' });
    publishActiveAtlas(p);
    expect(p.getToken).toHaveBeenCalled();
    await auth.getFreshAccessToken();
    expect(auth.getAccessToken()).toBe(token);
    expect((await auth.getUser()).sub).toBe('user_1');
  });

  it('fails clearly with no provider mounted; the synchronous getters return undefined', async () => {
    const auth = new OktaAuthCompat();
    await expect(auth.getUser()).rejects.toThrow(/no <AtlasProvider> is mounted/);
    await expect(auth.getFreshAccessToken()).rejects.toThrow(/no <AtlasProvider> is mounted/);
    expect(auth.getAccessToken()).toBeUndefined();
  });
});

describe('okta compat: toRelativeUrl', () => {
  it('strips the base URL from an absolute URL and keeps a leading slash', () => {
    expect(toRelativeUrlCompat('https://app.test/orders?id=1', 'https://app.test')).toBe('/orders?id=1');
    expect(toRelativeUrlCompat('/orders', 'https://app.test')).toBe('/orders');
    expect(toRelativeUrlCompat('orders', 'https://app.test')).toBe('/orders');
    expect(toRelativeUrlCompat(undefined, 'https://app.test')).toBe('/');
  });
});
