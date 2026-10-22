import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import type { Jwks } from './jwks-cache';
import type { SessionClaims } from './verify';
import {
  signAtlasReferralCall,
  signReferallyCall,
  type AtlasReferralCallOptions,
  type ReferallyCallOptions,
  type SignedReferralCall,
} from './referral-test-calls';

/**
 * §1.3(c) hermetic test fixtures.
 *
 * A customer's CI must be able to prove its `@atlasauth/backend` verification
 * works — accepts a good session token, rejects a bad one — WITHOUT reaching a
 * live Atlas instance or its JWKS URL. So this module mints tokens with an
 * ephemeral RS256 keypair it generates on the spot and hands back that key's
 * public JWKS. Feed the JWKS to `new AtlasBackend({ jwks, issuer })` and the
 * whole round trip — mint, sign, verify — happens in-process, offline.
 *
 * This is dev/test tooling shaped like Clerk's `@clerk/testing`: it lives in
 * its own module (imported only by tests that want it, never by the hot
 * verification path) and leans on `jose`, which the package already ships.
 */

/** Options for {@link createTestIssuer}. All optional — the defaults are usable as-is. */
export interface CreateTestIssuerOptions {
  /** The `iss` the fixture stamps on every token. Defaults to a local test URL. */
  issuer?: string;
  /** The `kid` on the signing key and in the published JWKS. */
  kid?: string;
  /**
   * A clock, in epoch milliseconds, for `iat`/`exp`. Pass the SAME `now` you
   * give `AtlasBackend` to make time deterministic across mint and verify.
   */
  now?: () => number;
  /** Default token lifetime in seconds, matching Atlas's 60 s default. */
  ttlSeconds?: number;
  /** The OAuth client the fake token endpoint serves. Default `client_test`. */
  clientId?: string;
  /**
   * The client's secret. When set, the fake token endpoint demands it
   * (`client_secret_basic` or `client_secret_post`); when unset it accepts a
   * public client (`client_id` in the body, PKCE only).
   */
  clientSecret?: string;
  /** ID-token lifetime in seconds. Default 3600, as Atlas issues. */
  idTokenTtlSeconds?: number;
}

/**
 * A deliberate defect for negative tests. Each one yields a token a correct
 * verifier must refuse:
 *  - `wrong_aud`: `aud` is another client.
 *  - `wrong_iss`: `iss` is another issuer.
 *  - `foreign_key`: signed by a key that is not in the JWKS (same `kid`).
 *  - `expired`: `exp` ten minutes ago, past any clock tolerance.
 *  - `wrong_nonce`: `nonce` differs from the one the sign-in sent.
 *  - `alg_none`: an unsigned token (`alg: none`).
 * For session tokens, `wrong_aud` and `wrong_nonce` only matter to a verifier
 * that checks those claims.
 */
export type TestTokenTamper =
  | 'wrong_aud'
  | 'wrong_iss'
  | 'foreign_key'
  | 'expired'
  | 'wrong_nonce'
  | 'alg_none';

/** The six {@link TestTokenTamper} cases, for a table-driven negative test. */
export const TEST_TOKEN_TAMPERS: readonly TestTokenTamper[] = [
  'wrong_aud',
  'wrong_iss',
  'foreign_key',
  'expired',
  'wrong_nonce',
  'alg_none',
];

/** Options for {@link TestIssuer.mintIdToken}. */
export interface MintIdTokenOptions {
  /** The audience. Default: the fixture's `clientId`. */
  aud?: string | string[];
  /** The nonce the sign-in sent. */
  nonce?: string;
  /** The access token this ID token accompanies; sets `at_hash`. */
  accessToken?: string;
  /** Lifetime in seconds. Default `idTokenTtlSeconds`. */
  ttlSeconds?: number;
  tamper?: TestTokenTamper;
}

/** Options for {@link TestIssuer.authorize}. */
export interface TestAuthorizeOptions {
  /** The signed-in user. Default `user_test`. */
  sub?: string;
  /** Extra ID-token claims (`email`, `email_verified`, `name`, …), or overrides. */
  claims?: Record<string, unknown>;
  /** Make the token endpoint answer with a defective ID token. */
  tamper?: TestTokenTamper;
  /** Redirect back with this OAuth `error` (e.g. `access_denied`) instead of a code. */
  error?: string;
}

/** What {@link TestIssuer.authorize} returns: the redirect back to your callback. */
export interface TestAuthorizeResult {
  /** The full callback URL, as the browser would arrive at it. */
  callbackUrl: string;
  /** Its query (`code` and `state`, or `error` and `state`). */
  query: URLSearchParams;
  code?: string;
  state: string | null;
}

/** A fixture issuer: an in-memory keypair, its public JWKS, and a token minter. */
export interface TestIssuer {
  /** The `iss` this fixture stamps — pass it straight to `AtlasBackend({ issuer })`. */
  issuer: string;
  /** The public JSON Web Key Set — pass it to `AtlasBackend({ jwks })` for offline verify. */
  jwks: Jwks;
  /** The `kid` shared by the signing key and the JWKS entry. */
  kid: string;
  /** The private signing key, for tests that need to sign something by hand. */
  privateKey: KeyLike;
  /**
   * Mint a signed session JWT. Defaults produce a token this fixture's JWKS
   * verifies as a first-party session (`token_use:'session'`, valid `iss`,
   * `sub`, `sid`, `azp`, `iat`/`exp`). Any field in `claims` overrides a
   * default — set `iss` to forge a wrong-issuer token, `exp` to forge an
   * expired one, add `org_id`/`org_permissions` to exercise authorization.
   */
  mintSession(claims?: Partial<SessionClaims>, options?: { tamper?: TestTokenTamper }): Promise<string>;
  /** The client id the fake token endpoint serves (`clientId` option). */
  clientId: string;
  /**
   * Mint an OIDC ID token as Atlas's token endpoint would: RS256, `aud` = the
   * client id, `nonce`, `iat`/`exp`, `sub`, `auth_time`, `sid`. `claims`
   * override any default; `tamper` forges one of the six negative cases.
   */
  mintIdToken(claims?: Record<string, unknown>, options?: MintIdTokenOptions): Promise<string>;
  /**
   * Play the authorization server for one sign-in. Pass the authorize URL your
   * app redirected to (e.g. `oidc.start(...).url`); get back the callback URL
   * with a single-use `code` that {@link fetch}'s token endpoint redeems for an
   * ID token bound to the request's client, redirect URI, nonce and PKCE
   * challenge.
   */
  authorize(authorizeUrl: string, options?: TestAuthorizeOptions): Promise<TestAuthorizeResult>;
  /**
   * A `fetch` that serves this issuer offline: the discovery document, the
   * JWKS, and the token endpoint. Pass it as `fetchImpl`. Any other URL
   * answers 404, so nothing reaches the network.
   */
  fetch: typeof fetch;
  /**
   * A signed call in the Atlas referral protocol, as an instance with
   * provider `webhook` sends it, for testing your referral platform's
   * receiver. Uses this issuer's clock unless `now` is given.
   */
  referralCall(options: AtlasReferralCallOptions): SignedReferralCall;
  /**
   * A signed Referally connection call, as an instance with provider
   * `referally` sends it, to run against a local Referally in your tests.
   */
  referallyCall(options: ReferallyCallOptions): SignedReferralCall;
  /** The endpoint URLs `fetch` serves (and the discovery document lists). */
  endpoints: {
    discovery: string;
    jwks: string;
    authorization: string;
    token: string;
    endSession: string;
  };
}

const DEFAULT_ISSUER = 'https://test-instance.fapi.atlas.local';
const DEFAULT_KID = 'atlas-test-key-1';
const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_CLIENT_ID = 'client_test';
const DEFAULT_ID_TOKEN_TTL_SECONDS = 3600;

/**
 * Build an offline test issuer. Generates an RS256 keypair, exposes its public
 * JWKS, and returns a `mintSession` that signs tokens with the private half.
 *
 * ```ts
 * const fx = await createTestIssuer();
 * const atlas = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer });
 * const r = await atlas.verify(await fx.mintSession({ sub: 'user_x' }));
 * // r.ok === true — no network call was made.
 * ```
 */
export async function createTestIssuer(
  options: CreateTestIssuerOptions = {},
): Promise<TestIssuer> {
  const issuer = options.issuer ?? DEFAULT_ISSUER;
  const kid = options.kid ?? DEFAULT_KID;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const clock = options.now ?? Date.now;

  const { privateKey, publicKey } = await generateKeyPair('RS256');
  // The published key: the public half plus the `kid`/`alg`/`use` a JWKS
  // consumer keys on — the same shape Atlas serves at `/.well-known/jwks.json`.
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwks: Jwks = { keys: [publicJwk] };

  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const idTokenTtl = options.idTokenTtlSeconds ?? DEFAULT_ID_TOKEN_TTL_SECONDS;
  const base = issuer.replace(/\/+$/, '');
  const endpoints = {
    discovery: `${base}/.well-known/openid-configuration`,
    jwks: `${base}/.well-known/jwks.json`,
    authorization: `${base}/oauth2/authorize`,
    token: `${base}/oauth2/token`,
    endSession: `${base}/oauth2/logout`,
  };

  // A second keypair, made on first use, for `foreign_key`: same `kid`, so the
  // verifier picks the published key and the signature check is what fails.
  let foreignKey: Promise<KeyLike> | null = null;

  async function sign(payload: Record<string, unknown>, tamper: TestTokenTamper | undefined): Promise<string> {
    if (tamper === 'alg_none') return new UnsecuredJWT(payload).encode();
    let key = privateKey;
    if (tamper === 'foreign_key') {
      foreignKey ??= generateKeyPair('RS256').then((pair) => pair.privateKey);
      key = await foreignKey;
    }
    return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).sign(key);
  }

  function applyTamper(payload: Record<string, unknown>, tamper: TestTokenTamper | undefined, nowSeconds: number) {
    if (tamper === 'wrong_aud') payload.aud = 'client_someone_else';
    if (tamper === 'wrong_iss') payload.iss = 'https://wrong-issuer.example.com';
    if (tamper === 'wrong_nonce') payload.nonce = `wrong-${randomId()}`;
    if (tamper === 'expired') {
      payload.iat = nowSeconds - 3600;
      payload.exp = nowSeconds - 600;
    }
    return payload;
  }

  async function mintSession(
    claims: Partial<SessionClaims> = {},
    mintOptions: { tamper?: TestTokenTamper } = {},
  ): Promise<string> {
    const nowSeconds = Math.floor(clock() / 1000);
    // System defaults first, caller overrides last — so `mintSession({ iss })`
    // or `mintSession({ exp })` forges exactly the token a rejection test needs.
    const payload: Record<string, unknown> = {
      iss: issuer,
      sub: 'user_test',
      sid: 'sess_test',
      azp: issuer,
      sv: 1,
      mfa: false,
      // The §13.1 marker the SDK's requireSessionToken path accepts. A fixture
      // token is a session token, never an OP access/id token.
      token_use: 'session',
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
      ...claims,
    };

    return sign(applyTamper(payload, mintOptions.tamper, nowSeconds), mintOptions.tamper);
  }

  async function mintIdToken(
    claims: Record<string, unknown> = {},
    mintOptions: MintIdTokenOptions = {},
  ): Promise<string> {
    const nowSeconds = Math.floor(clock() / 1000);
    const payload: Record<string, unknown> = {
      iss: issuer,
      sub: 'user_test',
      aud: mintOptions.aud ?? clientId,
      iat: nowSeconds,
      exp: nowSeconds + (mintOptions.ttlSeconds ?? idTokenTtl),
      auth_time: nowSeconds,
      sid: 'sess_test',
      amr: ['pwd'],
      ...(mintOptions.nonce !== undefined ? { nonce: mintOptions.nonce } : {}),
      ...(mintOptions.accessToken ? { at_hash: await atHash(mintOptions.accessToken) } : {}),
      ...claims,
    };
    return sign(applyTamper(payload, mintOptions.tamper, nowSeconds), mintOptions.tamper);
  }

  interface PendingCode {
    clientId: string;
    redirectUri: string;
    nonce?: string;
    challenge?: string;
    scope: string;
    sub: string;
    claims: Record<string, unknown>;
    tamper?: TestTokenTamper;
  }
  const codes = new Map<string, PendingCode>();

  async function authorize(authorizeUrl: string, authOptions: TestAuthorizeOptions = {}): Promise<TestAuthorizeResult> {
    const url = new URL(authorizeUrl);
    const p = url.searchParams;
    const redirectUri = p.get('redirect_uri');
    if (!redirectUri) throw new Error('createTestIssuer.authorize: the authorize URL has no redirect_uri.');
    const back = new URL(redirectUri);
    const state = p.get('state');
    if (authOptions.error) {
      back.searchParams.set('error', authOptions.error);
    } else {
      if (p.get('client_id') !== clientId) {
        throw new Error(`createTestIssuer.authorize: client_id ${p.get('client_id')} is not ${clientId}.`);
      }
      const code = `code_${randomId()}`;
      codes.set(code, {
        clientId,
        redirectUri,
        nonce: p.get('nonce') ?? undefined,
        challenge: p.get('code_challenge') ?? undefined,
        scope: p.get('scope') ?? 'openid',
        sub: authOptions.sub ?? 'user_test',
        claims: authOptions.claims ?? {},
        tamper: authOptions.tamper,
      });
      back.searchParams.set('code', code);
    }
    if (state !== null) back.searchParams.set('state', state);
    back.searchParams.set('iss', base);
    return {
      callbackUrl: back.toString(),
      query: back.searchParams,
      code: back.searchParams.get('code') ?? undefined,
      state,
    };
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function tokenEndpoint(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    // Client authentication: Basic header or body, exactly one secret source.
    let id = form.get('client_id');
    let secret = form.get('client_secret');
    const auth = request.headers.get('authorization');
    if (auth?.startsWith('Basic ')) {
      const decoded = atob(auth.slice(6));
      const at = decoded.indexOf(':');
      id = decodeURIComponent(decoded.slice(0, at));
      secret = decodeURIComponent(decoded.slice(at + 1));
    }
    if (id !== clientId) return json(401, { error: 'invalid_client' });
    if (options.clientSecret !== undefined ? secret !== options.clientSecret : secret !== null) {
      return json(401, { error: 'invalid_client' });
    }
    if (form.get('grant_type') !== 'authorization_code') return json(400, { error: 'unsupported_grant_type' });
    const code = form.get('code') ?? '';
    const pending = codes.get(code);
    codes.delete(code); // single use, like Atlas
    if (!pending || pending.redirectUri !== form.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
    if (pending.challenge) {
      const verifier = form.get('code_verifier') ?? '';
      if ((await s256(verifier)) !== pending.challenge) {
        return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
    }
    const accessToken = `at_${randomId()}`;
    const idToken = await mintIdToken(
      { sub: pending.sub, ...pending.claims },
      { nonce: pending.nonce, accessToken, tamper: pending.tamper },
    );
    return json(200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: idToken,
      scope: pending.scope,
      ...(pending.scope.split(' ').includes('offline_access') ? { refresh_token: `rt_${randomId()}` } : {}),
    });
  }

  const discoveryDoc = {
    issuer,
    authorization_endpoint: endpoints.authorization,
    token_endpoint: endpoints.token,
    jwks_uri: endpoints.jwks,
    end_session_endpoint: endpoints.endSession,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
  };

  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const target = `${url.origin}${url.pathname}`;
    if (target === endpoints.discovery && request.method === 'GET') return json(200, discoveryDoc);
    if (target === endpoints.jwks && request.method === 'GET') return json(200, jwks);
    if (target === endpoints.token && request.method === 'POST') return tokenEndpoint(request);
    return json(404, { error: 'not_found', url: request.url });
  }) as typeof fetch;

  return {
    issuer,
    jwks,
    kid,
    privateKey,
    clientId,
    mintSession,
    mintIdToken,
    referralCall: (o) => signAtlasReferralCall({ ...o, now: o.now ?? clock() }),
    referallyCall: (o) => signReferallyCall({ ...o, now: o.now ?? clock() }),
    authorize,
    fetch: fakeFetch,
    endpoints,
  };
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function s256(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

/** OIDC Core §3.1.3.6: the left half of SHA-256(access_token), base64url. */
async function atHash(accessToken: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken)));
  return b64url(digest.slice(0, 16));
}
