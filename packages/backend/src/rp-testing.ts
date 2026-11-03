/**
 * `@atlasauth/rp/testing`: an offline issuer for testing an app built on
 * `createRelyingParty`, with no network and no Atlas account.
 *
 *   const issuer = await mockIssuer({ issuer: 'https://atlasauth.net', clientId: 'client_test' });
 *   const rp = createRelyingParty({ ...settings, issuer: issuer.issuer, clientId: issuer.clientId, fetchImpl: issuer.fetch });
 *   const started = await rp.start(new Request('https://app.test/auth/sign-in'));
 *   const callbackUrl = issuer.authorize(started.headers.get('location')!); // the user signs in
 *
 * Web standards and `jose` only, like the relying party itself.
 */
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { BACKCHANNEL_LOGOUT_EVENT } from './logout-token';

export interface MockIssuerOptions {
  /** The issuer URL (`https://...`), e.g. `https://atlasauth.net` for Sign in with Atlas. */
  issuer: string;
  clientId: string;
  /** Signing algorithm. Default `RS256`. */
  alg?: 'RS256' | 'ES256';
  /** A clock in epoch milliseconds, for `iat` / `exp`. */
  now?: () => number;
}

export interface MockIssuer {
  issuer: string;
  clientId: string;
  /** A `fetch` serving discovery, the JWKS, the token endpoint and `/oauth2/session/touch` / `/end`; 404 otherwise. Pass it as `fetchImpl`. */
  fetch: typeof fetch;
  /** The public key set. */
  jwks: { keys: Record<string, unknown>[] };
  /** The discovery document `fetch` serves. */
  discovery: Record<string, unknown>;
  /** Claims merged into the ID token of the next code redeemed at the token endpoint (then cleared). */
  nextClaims: Record<string, unknown>;
  /**
   * Play the user signing in: pass the authorize URL `rp.start` redirected to,
   * get the callback URL (`code`, `state`, `iss`) to request with the sign-in cookie.
   */
  authorize(authorizeUrl: string): string;
  /** A signed ID token: `iss`, `aud`, `sub`, `iat`, `exp`, `auth_time`, `sid`, `email`, `email_verified`, then `claims`. Its `sid` becomes live for touch/end. */
  idToken(claims?: Record<string, unknown>): Promise<string>;
  /** A signed back-channel logout token for `sid` (and `sub`), as Atlas POSTs it. */
  logoutToken(options: { sid: string; sub?: string }): Promise<string>;
  /** The sids `/oauth2/session/touch` and `/end` treat as live sign-ins. */
  liveSids: Set<string>;
}

export async function mockIssuer(options: MockIssuerOptions): Promise<MockIssuer> {
  const issuer = options.issuer.replace(/\/+$/, '');
  const { clientId } = options;
  const alg = options.alg ?? 'RS256';
  const clock = options.now ?? Date.now;
  const kid = 'mock-key-1';
  const { privateKey, publicKey } = await generateKeyPair(alg);
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg, use: 'sig' }] };
  const discovery = {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    end_session_endpoint: `${issuer}/oauth2/logout`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [alg],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  };
  const liveSids = new Set<string>();
  const codes = new Map<string, { redirectUri: string; nonce: string | null; challenge: string | null }>();

  const sign = (payload: Record<string, unknown>, typ: string) =>
    new SignJWT(payload).setProtectedHeader({ alg, kid, typ }).sign(privateKey as KeyLike);

  const mock: MockIssuer = {
    issuer,
    clientId,
    jwks,
    discovery,
    nextClaims: {},
    liveSids,
    fetch: undefined as unknown as typeof fetch,
    authorize(authorizeUrl) {
      const p = new URL(authorizeUrl).searchParams;
      const redirectUri = p.get('redirect_uri');
      if (!redirectUri) throw new Error('mockIssuer.authorize: the authorize URL has no redirect_uri.');
      if (p.get('client_id') !== clientId) throw new Error(`mockIssuer.authorize: client_id ${p.get('client_id')} is not ${clientId}.`);
      const code = `code_${randomId()}`;
      codes.set(code, { redirectUri, nonce: p.get('nonce'), challenge: p.get('code_challenge') });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      if (p.get('state') !== null) back.searchParams.set('state', p.get('state')!);
      back.searchParams.set('iss', issuer);
      return back.toString();
    },
    async idToken(claims = {}) {
      const iat = Math.floor(clock() / 1000);
      const payload = {
        iss: issuer,
        aud: clientId,
        sub: 'user_test',
        iat,
        exp: iat + 3600,
        auth_time: iat,
        sid: 'sid_test',
        email: 'user@example.com',
        email_verified: true,
        ...claims,
      };
      if (typeof payload.sid === 'string') liveSids.add(payload.sid);
      return sign(payload, 'JWT');
    },
    async logoutToken({ sid, sub }) {
      const iat = Math.floor(clock() / 1000);
      return sign(
        { iss: issuer, aud: clientId, iat, exp: iat + 120, jti: randomId(), sid, ...(sub ? { sub } : {}), events: { [BACKCHANNEL_LOGOUT_EVENT]: {} } },
        'logout+jwt',
      );
    },
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

  async function token(form: URLSearchParams): Promise<Response> {
    if (form.get('grant_type') !== 'authorization_code') return json(400, { error: 'unsupported_grant_type' });
    const code = form.get('code') ?? '';
    const pending = codes.get(code);
    codes.delete(code); // single use
    if (!pending || pending.redirectUri !== form.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
    if (pending.challenge && (await s256(form.get('code_verifier') ?? '')) !== pending.challenge) {
      return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    const claims = mock.nextClaims;
    mock.nextClaims = {};
    const idToken = await mock.idToken({ ...(pending.nonce ? { nonce: pending.nonce } : {}), ...claims });
    return json(200, { access_token: `at_${randomId()}`, token_type: 'Bearer', expires_in: 3600, id_token: idToken });
  }

  function session(action: 'touch' | 'end', form: URLSearchParams): Response {
    const sid = form.get('sid')?.trim() ?? '';
    if (!sid) return json(400, { error: 'invalid_request', error_description: 'Missing sid.' });
    if (!liveSids.has(sid)) return json(404, { error: 'session_not_found', error_description: 'No live sign-in of this app has that sid.' });
    if (action === 'touch') {
      return json(200, { object: 'oauth_session', sid, active: true, grants_touched: 0, idle_expires_at: clock() + 30 * 86_400_000, expires_at: null });
    }
    liveSids.delete(sid);
    return json(200, { object: 'oauth_session', sid, active: false, ended: true, grants_revoked: 0, backchannel_logouts: 1 });
  }

  mock.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const target = `${url.origin}${url.pathname}`;
    if (request.method === 'GET' && target === `${issuer}/.well-known/openid-configuration`) return json(200, discovery);
    if (request.method === 'GET' && target === discovery.jwks_uri) return json(200, jwks);
    if (request.method === 'POST' && target.startsWith(`${issuer}/oauth2/`)) {
      const form = new URLSearchParams(await request.text());
      // Confidential clients only, like the token endpoint: Basic or client_secret in the body.
      const basic = request.headers.get('authorization')?.startsWith('Basic ');
      const id = basic ? decodeURIComponent(atob(request.headers.get('authorization')!.slice(6)).split(':')[0]!) : form.get('client_id');
      if (id !== clientId || (!basic && !form.get('client_secret'))) return json(401, { error: 'invalid_client' });
      const path = target.slice(issuer.length);
      if (path === '/oauth2/token') return token(form);
      if (path === '/oauth2/session/touch') return session('touch', form);
      if (path === '/oauth2/session/end') return session('end', form);
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;

  return mock;
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function s256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
