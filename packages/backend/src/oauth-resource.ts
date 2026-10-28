import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from 'jose';
import { JwksCache, readKid, type Jwks } from './jwks-cache';
import { ATLAS_SIGNING_ALGS } from './algs';

/**
 * Protecting YOUR API — or your own MCP server — with access tokens Atlas
 * issues to OAuth clients (authorization code, device, client credentials,
 * token exchange). Atlas is the authorization server; your API is the
 * resource server. This module:
 *  - verifies the access token locally against the instance JWKS (cached;
 *    no call to Atlas on the hot path): signature, `iss`, `exp`/`nbf`, that it
 *    IS an access token, and that its `aud` names your API (RFC 8707);
 *  - enforces required scopes;
 *  - enforces sender constraint: a DPoP-bound token (`cnf.jkt`) must arrive
 *    with a valid DPoP proof for the same key (RFC 9449), and is never accepted
 *    as a plain Bearer token;
 *  - answers failures with the RFC 6750 / RFC 9728 `WWW-Authenticate`
 *    challenge (`resource_metadata`, `insufficient_scope` + the scopes needed),
 *    which is exactly what an MCP client needs to discover how to sign in;
 *  - builds the RFC 9728 protected-resource metadata document to serve at
 *    `/.well-known/oauth-protected-resource` on your API's host.
 *  - accepts OPAQUE access tokens too (an API, client or instance set to the
 *    `opaque` format): with `introspection` configured, a token that is not a
 *    JWT is validated at Atlas's introspection endpoint (RFC 7662) with your
 *    API's own client credentials, and the answer is cached briefly;
 * Framework-agnostic: hand it any request with `method`, `url` and `headers`.
 */

/** Clock skew tolerated on `exp`/`nbf` and on DPoP proof `iat`. */
export const ACCESS_TOKEN_CLOCK_SKEW_SECONDS = 5;
/** How old a DPoP proof may be. */
export const DPOP_PROOF_MAX_AGE_SECONDS = 300;
const DPOP_ALGS = ['ES256', 'ES384', 'ES512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'EdDSA'];

export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud?: string | string[];
  exp: number;
  iat?: number;
  scope?: string;
  client_id?: string;
  azp?: string;
  permissions?: string[];
  cnf?: { jkt?: string; 'x5t#S256'?: string };
  token_use?: string;
  [claim: string]: unknown;
}

export interface ResourceRequestLike {
  method?: string;
  /** Absolute URL, or a path (combined with `resource` origin for the DPoP `htu` check). */
  url?: string;
  headers: Record<string, string | string[] | undefined> | { get(name: string): string | null };
}

/** Replay guard for DPoP proof `jti`s. The in-memory one is for a single process. */
export interface DpopReplayStore {
  /** Record `jti` until `expiresAt` (ms); return false when it was already seen. */
  claim(jti: string, expiresAt: number): Promise<boolean> | boolean;
}

/**
 * Server-provided DPoP nonces (RFC 9449 §8). `current()` is the nonce the API
 * hands out in the `DPoP-Nonce` response header; `valid()` accepts the nonces
 * still in force. A verifier given a source requires every DPoP proof to carry
 * one, answering `use_dpop_nonce` (with a fresh nonce) otherwise.
 */
export interface DpopNonceSource {
  current(): string | Promise<string>;
  valid(nonce: string): boolean | Promise<boolean>;
}

const DEFAULT_NONCE_WINDOW_SECONDS = 300;

/**
 * An in-process nonce source: a random nonce per window; the current and the
 * previous window's nonce are accepted. Use it when one process serves the API
 * (or with sticky routing); behind several processes, use
 * {@link hmacDpopNonceSource} with a shared secret.
 */
export function memoryDpopNonceSource(
  options: { windowSeconds?: number; now?: () => number } = {},
): DpopNonceSource {
  const window = (options.windowSeconds ?? DEFAULT_NONCE_WINDOW_SECONDS) * 1000;
  const now = options.now ?? Date.now;
  const issued = new Map<number, string>();
  const random = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const at = (epoch: number) => {
    let n = issued.get(epoch);
    if (!n) {
      n = random();
      issued.set(epoch, n);
      for (const e of issued.keys()) if (e < epoch - 1) issued.delete(e);
    }
    return n;
  };
  return {
    current: () => at(Math.floor(now() / window)),
    valid: (nonce) => {
      const epoch = Math.floor(now() / window);
      return nonce === at(epoch) || nonce === issued.get(epoch - 1);
    },
  };
}

/**
 * A stateless nonce source shared by every process holding the same secret (at
 * least 32 bytes): the nonce for a window is base64url(HMAC-SHA256(secret,
 * "atlas-dpop-nonce:" ‖ uint64-BE(window number))). A nonce is good in the window
 * it was issued in and the next one. The derivation is the same in every Atlas
 * server SDK, so services in different languages sharing the secret agree.
 */
export function hmacDpopNonceSource(
  secret: string | Uint8Array,
  options: { windowSeconds?: number; now?: () => number } = {},
): DpopNonceSource {
  const key = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  if (key.length < 32) throw new Error('The DPoP nonce secret must be at least 32 bytes.');
  const window = (options.windowSeconds ?? DEFAULT_NONCE_WINDOW_SECONDS) * 1000;
  const now = options.now ?? Date.now;
  const imported = crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const at = async (epoch: number) => {
    const prefix = new TextEncoder().encode('atlas-dpop-nonce:');
    const msg = new Uint8Array(prefix.length + 8);
    msg.set(prefix);
    new DataView(msg.buffer).setBigUint64(prefix.length, BigInt(epoch));
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await imported, msg));
    let bin = '';
    for (const b of mac) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const epoch = () => Math.floor(now() / window);
  return {
    current: () => at(epoch()),
    valid: async (nonce) => {
      const e = epoch();
      const [a, b] = await Promise.all([at(e), at(e - 1)]);
      return constantTimeEqual(nonce, a) || constantTimeEqual(nonce, b);
    },
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function memoryDpopReplayStore(max = 10_000): DpopReplayStore {
  const seen = new Map<string, number>();
  return {
    claim(jti, expiresAt) {
      const now = Date.now();
      if ((seen.get(jti) ?? 0) > now) return false;
      seen.set(jti, expiresAt);
      if (seen.size > max) {
        for (const [k, v] of seen) if (v <= now) seen.delete(k);
        while (seen.size > max) seen.delete(seen.keys().next().value as string);
      }
      return true;
    },
  };
}

export interface AccessTokenVerifierOptions {
  /** Your Atlas instance's issuer (frontend API origin), e.g. https://clerk.example.com. */
  issuer: string;
  /**
   * Your API's identifier (the Resource Server identifier registered in Atlas,
   * RFC 8707 `resource`). The token's `aud` must contain one of these. Pass
   * `false` only to accept tokens with no audience (userinfo-style tokens).
   */
  audience: string | readonly string[] | false;
  /** Scopes every request must carry (all of them). */
  requiredScopes?: readonly string[];
  /** The JWKS URL; default `${issuer}/.well-known/jwks.json`. */
  jwksUrl?: string;
  /** A static key set (tests / offline). Mutually exclusive with `jwksUrl`. */
  jwks?: Jwks;
  /**
   * Where your protected-resource metadata lives, advertised in every 401 as
   * `resource_metadata` so an MCP / OAuth client can discover Atlas. Typically
   * `https://api.example.com/.well-known/oauth-protected-resource`.
   */
  resourceMetadataUrl?: string;
  /** Require a DPoP-bound token on every request (never accept plain Bearer). */
  requireDpop?: boolean;
  /** The public origin of this API, for DPoP `htu` when `request.url` is a path. */
  publicOrigin?: string;
  dpopReplayStore?: DpopReplayStore;
  /**
   * Require a server-provided nonce in every DPoP proof (RFC 9449 §8). A proof
   * without a valid one is refused with `use_dpop_nonce`; every result carries
   * `dpopNonce`, to send as the `DPoP-Nonce` response header (the framework
   * adapters do). See {@link memoryDpopNonceSource} / {@link hmacDpopNonceSource}.
   */
  dpopNonces?: DpopNonceSource;
  /** `WWW-Authenticate` realm. */
  realm?: string;
  /**
   * Validate opaque access tokens (and, with `introspectJwts`, JWTs too) at
   * Atlas's introspection endpoint. The client must be a confidential client
   * your API lists in its `introspection_client_ids` (or the client the tokens
   * are issued to).
   */
  introspection?: IntrospectionOptions;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface IntrospectionOptions {
  clientId: string;
  clientSecret: string;
  /** Default `${issuer}/oauth2/introspect`. */
  endpoint?: string;
  /** How long an active answer is reused, in seconds (default 60; never past the token's `exp`). */
  cacheTtlSeconds?: number;
  /** How long an inactive answer is reused, in seconds (default 10; 0 disables). */
  negativeCacheTtlSeconds?: number;
  /** Most answers kept (default 10 000). */
  cacheMax?: number;
  /**
   * Also introspect JWT access tokens, so a revoked grant or a banned user is
   * refused before the token expires (one cached call per token). Default false:
   * JWTs are verified locally.
   */
  introspectJwts?: boolean;
}

/**
 * RFC 7662 introspection with a small TTL cache keyed by the token's SHA-256
 * (the token itself is never kept). Returns the claims of an active token, or
 * null for an inactive one; throws when Atlas could not be reached.
 */
export function createIntrospector(
  issuer: string,
  options: IntrospectionOptions,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): (token: string) => Promise<AccessTokenClaims | null> {
  const endpoint = options.endpoint ?? `${issuer.replace(/\/+$/, '')}/oauth2/introspect`;
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetchImpl ?? fetch;
  const ttl = (options.cacheTtlSeconds ?? 60) * 1000;
  const negativeTtl = (options.negativeCacheTtlSeconds ?? 10) * 1000;
  const max = options.cacheMax ?? 10_000;
  const cache = new Map<string, { claims: AccessTokenClaims | null; until: number }>();
  const basic = `Basic ${btoa(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`)}`;

  return async (token) => {
    const key = await sha256b64u(token);
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.claims;
    if (hit) cache.delete(key);

    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: basic,
      },
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
    });
    if (!res.ok) throw new Error(`Introspection failed with HTTP ${res.status}.`);
    const body = (await res.json()) as Record<string, unknown>;
    const claims = body.active === true && body.token_use !== 'refresh_token' ? (body as AccessTokenClaims) : null;
    const until = claims
      ? Math.min(now() + ttl, typeof claims.exp === 'number' ? claims.exp * 1000 : now() + ttl)
      : now() + negativeTtl;
    if (until > now()) {
      cache.set(key, { claims, until });
      if (cache.size > max) {
        for (const [k, v] of cache) if (v.until <= now()) cache.delete(k);
        while (cache.size > max) cache.delete(cache.keys().next().value as string);
      }
    }
    return claims;
  };
}

export type AccessTokenErrorCode =
  | 'invalid_request'
  | 'invalid_token'
  | 'insufficient_scope'
  | 'invalid_dpop_proof'
  | 'use_dpop_nonce'
  | 'insufficient_user_authentication';

export type AccessTokenResult =
  | {
      ok: true;
      claims: AccessTokenClaims;
      scopes: string[];
      subject: string;
      clientId: string | null;
      dpopBound: boolean;
      /** With `dpopNonces`: send as the `DPoP-Nonce` response header. */
      dpopNonce?: string;
    }
  | {
      ok: false;
      status: 400 | 401 | 403;
      error: AccessTokenErrorCode | null;
      description: string;
      /** Set this response header verbatim. */
      wwwAuthenticate: string;
      /** With `dpopNonces`: send as the `DPoP-Nonce` response header (always, on `use_dpop_nonce`). */
      dpopNonce?: string;
    };

function header(req: ResourceRequestLike, name: string): string | undefined {
  const h = req.headers as { get?: (n: string) => string | null } & Record<string, string | string[] | undefined>;
  if (typeof h.get === 'function') return h.get(name) ?? undefined;
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

const quote = (v: string) => `"${v.replace(/["\\]/g, '\\$&')}"`;

/**
 * Build an RFC 6750 / RFC 9449 / RFC 9728 `WWW-Authenticate` challenge.
 * Without an `error`, it is the bare "authentication required" challenge
 * (no token was sent), as RFC 6750 §3.1 asks.
 */
export function buildWwwAuthenticate(opts: {
  scheme?: 'Bearer' | 'DPoP';
  realm?: string;
  error?: AccessTokenErrorCode | null;
  description?: string;
  scope?: readonly string[];
  resourceMetadataUrl?: string;
  dpopAlgs?: readonly string[];
  /** RFC 9470: the acr values the resource will accept (step-up challenge). */
  acrValues?: readonly string[];
  /** RFC 9470: the maximum age, in seconds, of the user authentication. */
  maxAge?: number;
}): string {
  const parts: string[] = [];
  if (opts.realm) parts.push(`realm=${quote(opts.realm)}`);
  if (opts.error) parts.push(`error=${quote(opts.error)}`);
  if (opts.error && opts.description) parts.push(`error_description=${quote(opts.description)}`);
  if (opts.scope && opts.scope.length > 0) parts.push(`scope=${quote(opts.scope.join(' '))}`);
  if (opts.resourceMetadataUrl) parts.push(`resource_metadata=${quote(opts.resourceMetadataUrl)}`);
  if (opts.acrValues && opts.acrValues.length > 0) parts.push(`acr_values=${quote(opts.acrValues.join(' '))}`);
  if (opts.maxAge !== undefined) parts.push(`max_age=${Math.max(0, Math.floor(opts.maxAge))}`);
  if (opts.scheme === 'DPoP' && opts.dpopAlgs) parts.push(`algs=${quote(opts.dpopAlgs.join(' '))}`);
  return `${opts.scheme ?? 'Bearer'}${parts.length ? ` ${parts.join(', ')}` : ''}`;
}

async function sha256b64u(input: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strip query + fragment (RFC 9449 §4.3 `htu` comparison). */
function htuOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * A reusable verifier (one JWKS cache for the life of the process). Call it per
 * request; it never throws for a bad token — it returns the status + challenge.
 */
/** Per-call extras for the verifier: scopes plus the RFC 9470 step-up requirements. */
export interface AccessTokenCallOptions {
  requiredScopes?: readonly string[];
  /** Accept only these `acr` values; otherwise answer `insufficient_user_authentication`. */
  requireAcr?: readonly string[];
  /** Require `auth_time` within this many seconds; otherwise answer `insufficient_user_authentication`. */
  maxAge?: number;
}

/**
 * RFC 9470 check on verified claims. Returns null when satisfied, else the
 * `insufficient_user_authentication` challenge to send (HTTP 401).
 */
export function requireAcr(
  claims: Readonly<Record<string, unknown>>,
  req: { acrValues?: readonly string[]; maxAge?: number; scheme?: 'Bearer' | 'DPoP'; realm?: string; resourceMetadataUrl?: string; nowMs?: number },
): { status: 401; error: 'insufficient_user_authentication'; description: string; wwwAuthenticate: string } | null {
  const acrOk = !req.acrValues?.length || (typeof claims.acr === 'string' && req.acrValues.includes(claims.acr));
  const at = claims.auth_time;
  const ageOk =
    req.maxAge === undefined ||
    (typeof at === 'number' && Number.isFinite(at) && (req.nowMs ?? Date.now()) / 1000 - at <= req.maxAge);
  if (acrOk && ageOk) return null;
  const description = 'A stronger or more recent user authentication is required.';
  return {
    status: 401,
    error: 'insufficient_user_authentication',
    description,
    wwwAuthenticate: buildWwwAuthenticate({
      scheme: req.scheme,
      realm: req.realm,
      error: 'insufficient_user_authentication',
      description,
      acrValues: req.acrValues,
      maxAge: req.maxAge,
      resourceMetadataUrl: req.resourceMetadataUrl,
    }),
  };
}

export function createAccessTokenVerifier(
  options: AccessTokenVerifierOptions,
): (request: ResourceRequestLike, extra?: AccessTokenCallOptions) => Promise<AccessTokenResult> {
  if (!options.issuer) throw new Error('createAccessTokenVerifier needs `issuer`.');
  if (options.jwks && options.jwksUrl) throw new Error('Pass `jwks` or `jwksUrl`, not both.');
  const issuer = options.issuer.replace(/\/+$/, '');
  const now = () => (options.now ?? Date.now)();
  const jwks = new JwksCache({
    url: options.jwks ? undefined : (options.jwksUrl ?? `${issuer}/.well-known/jwks.json`),
    staticJwks: options.jwks,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  const audiences =
    options.audience === false ? null : typeof options.audience === 'string' ? [options.audience] : [...options.audience];
  const replay = options.dpopReplayStore ?? memoryDpopReplayStore();
  const introspect = options.introspection
    ? createIntrospector(issuer, options.introspection, { fetchImpl: options.fetchImpl, now: options.now })
    : null;

  return async (request, extra) => {
    const required = [...(options.requiredScopes ?? []), ...(extra?.requiredScopes ?? [])];
    const scheme: 'Bearer' | 'DPoP' = options.requireDpop ? 'DPoP' : 'Bearer';
    const nonce = options.dpopNonces ? await options.dpopNonces.current() : undefined;
    const fail = (
      status: 400 | 401 | 403,
      error: AccessTokenErrorCode | null,
      description: string,
      challengeScheme: 'Bearer' | 'DPoP' = scheme,
    ): AccessTokenResult => ({
      ok: false,
      status,
      error,
      description,
      wwwAuthenticate: buildWwwAuthenticate({
        scheme: challengeScheme,
        realm: options.realm,
        error,
        description,
        scope: error === 'insufficient_scope' || error === null ? required : undefined,
        resourceMetadataUrl: options.resourceMetadataUrl,
        dpopAlgs: DPOP_ALGS,
      }),
      ...(nonce ? { dpopNonce: nonce } : {}),
    });

    const authz = header(request, 'authorization');
    if (!authz) return fail(401, null, 'Authentication required.');
    const m = /^(Bearer|DPoP)\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(authz.trim());
    if (!m) return fail(400, 'invalid_request', 'Malformed Authorization header.');
    const presentedScheme = m[1]!.toLowerCase() === 'dpop' ? 'DPoP' : 'Bearer';
    const token = m[2]!;
    const isJwt = token.split('.').length === 3;

    let claims: AccessTokenClaims;
    if (!isJwt || (introspect && options.introspection?.introspectJwts)) {
      // An opaque token (or a JWT the caller wants checked live) is validated by
      // Atlas itself.
      if (!introspect) {
        return fail(401, 'invalid_token', 'The access token is not a JWT; configure `introspection` to accept opaque tokens.');
      }
      let active: AccessTokenClaims | null;
      try {
        active = await introspect(token);
      } catch {
        return fail(401, 'invalid_token', 'The access token could not be validated right now.');
      }
      if (!active) return fail(401, 'invalid_token', 'The access token is invalid or expired.');
      if (active.iss !== undefined && String(active.iss).replace(/\/+$/, '') !== issuer) {
        return fail(401, 'invalid_token', 'The access token was issued by another authorization server.');
      }
      if (typeof active.exp === 'number' && active.exp * 1000 + ACCESS_TOKEN_CLOCK_SKEW_SECONDS * 1000 <= now()) {
        return fail(401, 'invalid_token', 'The access token is invalid or expired.');
      }
      claims = active;
    } else {
      const keys = await jwks.get(readKid(token));
      if (!keys || keys.keys.length === 0) return fail(401, 'invalid_token', 'No signing keys are available to verify the token.');
      try {
        const { payload } = await jwtVerify(token, createLocalJWKSet(keys as never), {
          issuer,
          algorithms: ATLAS_SIGNING_ALGS,
          clockTolerance: ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
          currentDate: new Date(now()),
        });
        claims = payload as AccessTokenClaims;
      } catch {
        return fail(401, 'invalid_token', 'The access token is invalid or expired.');
      }
    }
    if (claims.token_use !== undefined && claims.token_use !== 'access_token') {
      return fail(401, 'invalid_token', 'The token is not an access token.');
    }
    if (audiences) {
      const aud = claims.aud === undefined ? [] : Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.some((a) => audiences.includes(a))) {
        return fail(401, 'invalid_token', 'The access token was not issued for this resource.');
      }
    }

    // Sender constraint (RFC 9449). A bound token is only ever a DPoP token.
    const jkt = claims.cnf?.jkt;
    if (jkt || options.requireDpop || presentedScheme === 'DPoP') {
      if (!jkt) return fail(401, 'invalid_token', 'This resource requires a DPoP-bound access token.', 'DPoP');
      if (presentedScheme !== 'DPoP') {
        return fail(401, 'invalid_token', 'A DPoP-bound access token must be sent with the DPoP scheme.', 'DPoP');
      }
      const proof = header(request, 'dpop');
      if (!proof) return fail(401, 'invalid_dpop_proof', 'A DPoP proof is required.', 'DPoP');
      const proofError = await checkDpopProof(proof, {
        token,
        jkt,
        method: (request.method ?? 'GET').toUpperCase(),
        url: request.url ?? '',
        publicOrigin: options.publicOrigin,
        now: now(),
        replay,
        nonces: options.dpopNonces,
      });
      if (proofError) return fail(401, proofError.code, proofError.message, 'DPoP');
    }

    const scopes = (claims.scope ?? '').split(' ').filter(Boolean);
    const granted = new Set([...scopes, ...(claims.permissions ?? [])]);
    const missing = required.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      return fail(403, 'insufficient_scope', `The access token is missing the required scope(s): ${missing.join(' ')}.`);
    }
    if (extra?.requireAcr?.length || extra?.maxAge !== undefined) {
      const step = requireAcr(claims, {
        acrValues: extra.requireAcr,
        maxAge: extra.maxAge,
        scheme: presentedScheme === 'DPoP' ? 'DPoP' : 'Bearer',
        realm: options.realm,
        resourceMetadataUrl: options.resourceMetadataUrl,
        nowMs: now(),
      });
      if (step) {
        return { ok: false, status: 401, error: step.error, description: step.description, wwwAuthenticate: step.wwwAuthenticate };
      }
    }
    return {
      ok: true,
      claims,
      scopes,
      subject: claims.sub,
      clientId: (claims.client_id ?? claims.azp ?? null) as string | null,
      dpopBound: !!jkt,
      ...(nonce ? { dpopNonce: nonce } : {}),
    };
  };
}

async function checkDpopProof(
  proof: string,
  ctx: {
    token: string;
    jkt: string;
    method: string;
    url: string;
    publicOrigin?: string;
    now: number;
    replay: DpopReplayStore;
    nonces?: DpopNonceSource;
  },
): Promise<{ code: 'invalid_dpop_proof' | 'use_dpop_nonce'; message: string } | null> {
  const refuse = (message: string) => ({ code: 'invalid_dpop_proof' as const, message });
  let jwk: JWK;
  let alg: string;
  try {
    const h = decodeProtectedHeader(proof);
    if (h.typ !== 'dpop+jwt') return refuse('The DPoP proof must have typ dpop+jwt.');
    if (!h.alg || !DPOP_ALGS.includes(h.alg)) return refuse('The DPoP proof uses an unsupported algorithm.');
    if (!h.jwk || typeof h.jwk !== 'object') return refuse('The DPoP proof must carry its public key.');
    jwk = h.jwk as JWK;
    if ('d' in jwk || 'k' in jwk) return refuse('The DPoP proof key must be a public key.');
    alg = h.alg;
  } catch {
    return refuse('The DPoP proof is malformed.');
  }
  let payload: Record<string, unknown>;
  try {
    const key = await importJWK(jwk, alg);
    ({ payload } = await jwtVerify(proof, key, { algorithms: [alg], typ: 'dpop+jwt', currentDate: new Date(ctx.now) }));
  } catch {
    return refuse('The DPoP proof signature is invalid.');
  }
  if ((await calculateJwkThumbprint(jwk, 'sha256')) !== ctx.jkt) {
    return refuse('The DPoP proof key does not match the token binding.');
  }
  if (payload.htm !== ctx.method) return refuse('The DPoP proof htm does not match the request method.');
  const absolute = /^https?:\/\//i.test(ctx.url) ? ctx.url : ctx.publicOrigin ? new URL(ctx.url, ctx.publicOrigin).toString() : null;
  const expected = absolute ? htuOf(absolute) : null;
  if (!expected || typeof payload.htu !== 'string' || htuOf(payload.htu) !== expected) {
    return refuse('The DPoP proof htu does not match the request URL.');
  }
  const iat = typeof payload.iat === 'number' ? payload.iat * 1000 : NaN;
  if (
    !Number.isFinite(iat) ||
    iat > ctx.now + ACCESS_TOKEN_CLOCK_SKEW_SECONDS * 1000 ||
    ctx.now - iat > DPOP_PROOF_MAX_AGE_SECONDS * 1000
  ) {
    return refuse('The DPoP proof is too old or from the future.');
  }
  if (payload.ath !== (await sha256b64u(ctx.token))) return refuse('The DPoP proof ath does not match the access token.');
  if (typeof payload.jti !== 'string' || !payload.jti) return refuse('The DPoP proof needs a jti.');
  if (ctx.nonces) {
    const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (!nonce || !(await ctx.nonces.valid(nonce))) {
      return { code: 'use_dpop_nonce', message: 'The DPoP proof must carry the nonce from the DPoP-Nonce header.' };
    }
  }
  if (!(await ctx.replay.claim(`${ctx.jkt}:${payload.jti}`, iat + DPOP_PROOF_MAX_AGE_SECONDS * 1000))) {
    return refuse('The DPoP proof has already been used.');
  }
  return null;
}

/** One-shot form of {@link createAccessTokenVerifier} (builds a fresh JWKS cache each call — prefer the factory). */
export function verifyAccessToken(
  request: ResourceRequestLike,
  options: AccessTokenVerifierOptions,
): Promise<AccessTokenResult> {
  return createAccessTokenVerifier(options)(request);
}

/**
 * The RFC 9728 protected-resource metadata document for your API. Serve it as
 * JSON at `https://<your api host>/.well-known/oauth-protected-resource` (and,
 * for a resource with a path, at `/.well-known/oauth-protected-resource<path>`),
 * and point `resourceMetadataUrl` at it. Atlas can also serve this document for
 * you when the API is registered with metadata publishing turned on.
 */
export function protectedResourceMetadata(opts: {
  /** Your API's identifier (the same value as the verifier's `audience`). */
  resource: string;
  /** Your Atlas instance issuer. */
  issuer: string;
  scopesSupported?: readonly string[];
  resourceName?: string;
  resourceDocumentation?: string;
  /** Advertise that tokens must be DPoP-bound. */
  dpopBoundAccessTokensRequired?: boolean;
}): Record<string, unknown> {
  return {
    resource: opts.resource,
    authorization_servers: [opts.issuer.replace(/\/+$/, '')],
    bearer_methods_supported: ['header'],
    ...(opts.scopesSupported ? { scopes_supported: [...opts.scopesSupported] } : {}),
    ...(opts.resourceName ? { resource_name: opts.resourceName } : {}),
    ...(opts.resourceDocumentation ? { resource_documentation: opts.resourceDocumentation } : {}),
    dpop_signing_alg_values_supported: DPOP_ALGS,
    ...(opts.dpopBoundAccessTokensRequired ? { dpop_bound_access_tokens_required: true } : {}),
  };
}

/** The RFC 9728 well-known path for a resource identifier (path-inserted form). */
export function protectedResourceMetadataPath(resource: string): string {
  const u = new URL(resource);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
  return `/.well-known/oauth-protected-resource${path}`;
}
