import { describe, expect, it } from 'vitest';
import { AtlasWebAuthFlowError, signInWithWebAuthFlow, type ChromeIdentity } from './web-auth-flow';
import { createMemoryStorageArea, StorageCache } from './storage';

const BASE = 'https://fapi.example.test';
const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';

interface Seen {
  authorize?: URL;
  token?: URLSearchParams;
  exchange?: URLSearchParams;
}

/** chrome.identity that "signs in" by answering the authorize URL with `answer(authorizeUrl)`. */
function identity(seen: Seen, answer: (authorize: URL) => string | undefined | Promise<string | undefined>): ChromeIdentity {
  return {
    getRedirectURL: () => REDIRECT,
    launchWebAuthFlow: async ({ url }) => {
      seen.authorize = new URL(url);
      return answer(seen.authorize);
    },
  };
}

const ok = (authorize: URL) => `${REDIRECT}?code=code_1&state=${authorize.searchParams.get('state')}`;

function server(seen: Seen, opts: { token?: Response; exchange?: Response } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (String(input) === `${BASE}/oauth2/token` && form.get('grant_type') === 'authorization_code') {
      seen.token = form;
      return opts.token ?? Response.json({ access_token: 'op_access_1', token_type: 'Bearer' });
    }
    if (String(input) === `${BASE}/oauth2/token`) {
      seen.exchange = form;
      return (
        opts.exchange ??
        Response.json({ access_token: 'sess.jwt.1', session_id: 'sess_1', refresh_token: 'refr_1', expires_in: 60 })
      );
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

const base = { frontendApi: BASE, publishableKey: 'pk_test_x', clientId: 'ext_client' };

describe('signInWithWebAuthFlow', () => {
  it('runs authorize (PKCE S256 + state) → code → session exchange, and persists the session', async () => {
    const seen: Seen = {};
    const store = new StorageCache({ area: createMemoryStorageArea() });
    const manager = await signInWithWebAuthFlow({ ...base, identity: identity(seen, ok), fetchImpl: server(seen), store });

    const a = seen.authorize!;
    expect(`${a.origin}${a.pathname}`).toBe(`${BASE}/oauth2/authorize`);
    expect(a.searchParams.get('response_type')).toBe('code');
    expect(a.searchParams.get('client_id')).toBe('ext_client');
    expect(a.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(a.searchParams.get('code_challenge_method')).toBe('S256');

    // The verifier hashes to the challenge sent on the authorize URL.
    const verifier = seen.token!.get('code_verifier')!;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(a.searchParams.get('code_challenge')).toBe(challenge);
    expect(seen.token!.get('code')).toBe('code_1');
    expect(seen.token!.get('redirect_uri')).toBe(REDIRECT);

    expect(seen.exchange!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(seen.exchange!.get('subject_token')).toBe('op_access_1');
    expect(seen.exchange!.get('requested_token_type')).toBe('urn:atlas:token-type:session');

    expect(manager.current).toMatchObject({ sessionToken: 'sess.jwt.1', refreshToken: 'refr_1', sessionId: 'sess_1' });
    await Promise.resolve();
    expect(JSON.parse((await store.getToken())!)).toMatchObject({ sessionToken: 'sess.jwt.1' });
  });

  it('extra authorize parameters never override the security ones', async () => {
    const seen: Seen = {};
    await signInWithWebAuthFlow({
      ...base,
      identity: identity(seen, ok),
      fetchImpl: server(seen),
      store: new StorageCache({ area: createMemoryStorageArea() }),
      authorizeParams: { prompt: 'login', state: 'attacker', redirect_uri: 'https://evil.example/' },
    });
    expect(seen.authorize!.searchParams.get('prompt')).toBe('login');
    expect(seen.authorize!.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(seen.authorize!.searchParams.get('state')).not.toBe('attacker');
  });

  const failure = async (opts: Partial<Parameters<typeof signInWithWebAuthFlow>[0]>) => {
    const store = new StorageCache({ area: createMemoryStorageArea() });
    const err = await signInWithWebAuthFlow({ ...base, store, ...opts }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtlasWebAuthFlowError);
    // Nothing is stored after a failure.
    expect(await store.getToken()).toBeNull();
    return (err as AtlasWebAuthFlowError).code;
  };

  it('refuses a returned URL with the wrong state or redirect, without redeeming the code', async () => {
    const seen: Seen = {};
    expect(await failure({ identity: identity(seen, () => `${REDIRECT}?code=c&state=forged`), fetchImpl: server(seen) })).toBe('state_mismatch');
    expect(
      await failure({
        identity: identity(seen, (a) => `https://evil.example/?code=c&state=${a.searchParams.get('state')}`),
        fetchImpl: server(seen),
      }),
    ).toBe('state_mismatch');
    expect(seen.token).toBeUndefined();
  });

  it('reports a closed window, an OAuth error, a failed token call and a refused exchange', async () => {
    const seen: Seen = {};
    expect(
      await failure({
        identity: {
          getRedirectURL: () => REDIRECT,
          launchWebAuthFlow: async () => {
            throw new Error('The user did not approve access.');
          },
        },
      }),
    ).toBe('cancelled');
    expect(
      await failure({ identity: identity(seen, (a) => `${REDIRECT}?error=access_denied&state=${a.searchParams.get('state')}`) }),
    ).toBe('authorization_error');
    expect(
      await failure({
        identity: identity(seen, ok),
        fetchImpl: server(seen, { token: Response.json({ error: 'invalid_grant' }, { status: 400 }) }),
      }),
    ).toBe('token_error');
    expect(
      await failure({
        identity: identity(seen, ok),
        fetchImpl: server(seen, { exchange: Response.json({ error: 'unauthorized_client' }, { status: 403 }) }),
      }),
    ).toBe('session_exchange_failed');
  });

  it('needs chrome.identity', async () => {
    expect(await failure({})).toBe('identity_unavailable');
  });
});
