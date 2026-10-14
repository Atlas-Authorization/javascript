import { describe, expect, it, vi } from 'vitest';
import type { AppPlugin, BrowserPlugin, CapacitorGlobal, PluginListenerHandle } from './plugins';
import { createInMemoryTokenStore } from './token-store';
import {
  buildAuthorizeUrl,
  completeRedirectSignIn,
  parseAuthCallback,
  redeemAuthorizationCode,
  signInWithBrowser,
} from './sign-in';

const FRONTEND = 'https://fapi.example.test';
const CLIENT = 'client_abc';
const REDIRECT = 'com.acme.app://auth';
const STATE = 'test-state';

const fixedPkce = () => Promise.resolve({ verifier: 'the-verifier', challenge: 'the-challenge' });
const fixedState = () => STATE;

/** A fake `@capacitor/app` App that captures the appUrlOpen listener and can emit. */
function fakeApp(): AppPlugin & { emit(url: string): void; removed: boolean } {
  let listener: ((event: { url: string }) => void) | null = null;
  const handle: PluginListenerHandle = {
    remove: () => {
      state.removed = true;
    },
  };
  const state = {
    removed: false,
    addListener: (_name: 'appUrlOpen', cb: (event: { url: string }) => void) => {
      listener = cb;
      return handle;
    },
    emit: (url: string) => listener?.({ url }),
  };
  return state;
}

const nativeCapacitor: CapacitorGlobal = { isNativePlatform: () => true };

/**
 * A fetch router for the two `/oauth2/token` steps: the `authorization_code`
 * grant (code → OAuth access token) and the RFC 8693 token-exchange
 * (exchangeForSession: access token → Atlas session).
 */
function tokenRouter(onBody?: (grant: string, params: URLSearchParams) => void): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    const grant = params.get('grant_type') ?? '';
    onBody?.(grant, params);
    if (grant === 'authorization_code') {
      return new Response(JSON.stringify({ access_token: 'oauth-access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // token-exchange
    return new Response(
      JSON.stringify({
        access_token: 'sess.jwt.1',
        session_id: 'sess_1',
        refresh_token: 'refr_1',
        expires_in: 60,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

describe('buildAuthorizeUrl', () => {
  it('builds a PKCE S256 authorize URL', () => {
    const url = new URL(
      buildAuthorizeUrl({
        frontendApi: FRONTEND,
        clientId: CLIENT,
        redirectUri: REDIRECT,
        codeChallenge: 'the-challenge',
        state: STATE,
      }),
    );
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge')).toBe('the-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(STATE);
    expect(url.searchParams.get('scope')).toContain('openid');
  });
});

describe('parseAuthCallback', () => {
  it('returns the code when state matches', () => {
    expect(parseAuthCallback(`${REDIRECT}?code=abc&state=${STATE}`, STATE)).toEqual({ code: 'abc' });
  });
  it('is null on a state mismatch (a foreign deep link)', () => {
    expect(parseAuthCallback(`${REDIRECT}?code=abc&state=other`, STATE)).toBeNull();
  });
  it('surfaces a server error (state-checked)', () => {
    expect(parseAuthCallback(`${REDIRECT}?error=access_denied&state=${STATE}`, STATE)).toEqual({
      error: 'access_denied',
    });
  });
  it('is null when the URL is unparseable', () => {
    expect(parseAuthCallback('not a url', STATE)).toBeNull();
  });
});

describe('redeemAuthorizationCode', () => {
  it('returns the access token on success', async () => {
    const token = await redeemAuthorizationCode({
      frontendApi: FRONTEND,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      code: 'the-code',
      codeVerifier: 'the-verifier',
      fetchImpl: tokenRouter(),
    });
    expect(token).toBe('oauth-access-token');
  });

  it('returns null on a non-2xx', async () => {
    const token = await redeemAuthorizationCode({
      frontendApi: FRONTEND,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      code: 'the-code',
      codeVerifier: 'the-verifier',
      fetchImpl: (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch,
    });
    expect(token).toBeNull();
  });
});

describe('signInWithBrowser (native)', () => {
  it('opens the browser with a PKCE URL and completes the exchange from the callback', async () => {
    const app = fakeApp();
    let openedUrl = '';
    const browser: BrowserPlugin = {
      open: vi.fn(async ({ url }: { url: string }) => {
        openedUrl = url;
        // Simulate the OS reopening the app with the deep-link callback.
        app.emit(`${REDIRECT}?code=the-code&state=${STATE}`);
      }),
      close: vi.fn(async () => undefined),
    };
    const grants: string[] = [];
    const sentVerifier = { value: '' };

    const outcome = await signInWithBrowser({
      frontendApi: FRONTEND,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      browser,
      app,
      capacitor: nativeCapacitor,
      pkceStore: createInMemoryTokenStore(),
      makePkce: fixedPkce,
      makeState: fixedState,
      fetchImpl: tokenRouter((grant, params) => {
        grants.push(grant);
        if (grant === 'authorization_code') sentVerifier.value = params.get('code_verifier') ?? '';
      }),
    });

    // Browser opened with the PKCE authorize URL.
    expect(browser.open).toHaveBeenCalledOnce();
    const u = new URL(openedUrl);
    expect(u.pathname).toBe('/oauth2/authorize');
    expect(u.searchParams.get('code_challenge')).toBe('the-challenge');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(STATE);

    // The code was redeemed (with the PKCE verifier) then exchanged for a session.
    expect(grants).toEqual(['authorization_code', 'urn:ietf:params:oauth:grant-type:token-exchange']);
    expect(sentVerifier.value).toBe('the-verifier');

    expect(outcome.session).toMatchObject({
      sessionToken: 'sess.jwt.1',
      refreshToken: 'refr_1',
      sessionId: 'sess_1',
    });
    // Listener removed + browser closed on completion.
    expect(app.removed).toBe(true);
    expect(browser.close).toHaveBeenCalled();
  });

  it('returns a null session when the browser cannot open', async () => {
    const app = fakeApp();
    const browser: BrowserPlugin = { open: async () => Promise.reject(new Error('no browser')) };
    const outcome = await signInWithBrowser({
      frontendApi: FRONTEND,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      browser,
      app,
      capacitor: nativeCapacitor,
      pkceStore: createInMemoryTokenStore(),
      makePkce: fixedPkce,
      makeState: fixedState,
      fetchImpl: tokenRouter(),
    });
    expect(outcome.session).toBeNull();
  });
});

describe('signInWithBrowser (web fallback) + completeRedirectSignIn', () => {
  it('stashes PKCE + navigates, then completes from the redirect URL', async () => {
    const webCapacitor: CapacitorGlobal = { isNativePlatform: () => false };
    const pkceStore = createInMemoryTokenStore();
    let navigatedTo = '';

    const outcome = await signInWithBrowser({
      frontendApi: FRONTEND,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      browser: null,
      app: null,
      capacitor: webCapacitor,
      pkceStore,
      navigate: (url) => {
        navigatedTo = url;
      },
      makePkce: fixedPkce,
      makeState: fixedState,
      fetchImpl: tokenRouter(),
    });

    // Navigated to the authorize URL; nothing resolved inline (page is leaving).
    expect(outcome).toEqual({ session: null, pending: true });
    expect(new URL(navigatedTo).pathname).toBe('/oauth2/authorize');
    // The verifier + state were stashed for the next load.
    expect(JSON.parse((await pkceStore.getToken())!)).toEqual({
      verifier: 'the-verifier',
      state: STATE,
    });

    // Next load: finish from the callback URL.
    const session = await completeRedirectSignIn({
      frontendApi: FRONTEND,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      url: `${REDIRECT}?code=the-code&state=${STATE}`,
      pkceStore,
      fetchImpl: tokenRouter(),
    });
    expect(session).toMatchObject({ sessionToken: 'sess.jwt.1', sessionId: 'sess_1' });
    // The single-use stash is cleared.
    expect(await pkceStore.getToken()).toBeNull();
  });
});
