import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { ATLAS_SIGNING_ALGS } from './algs';
import { JwksCache, checkJwksCacheTuning, type Jwks, type JwksCacheTuning } from './jwks-cache';

/**
 * Verify machine and API-key credentials LOCALLY: no call to Atlas per request.
 *
 * Both are short-lived JWTs Atlas signs with the instance's keys, so a service checks the signature
 * against the instance's published keys (cached, refetched on an unknown `kid`), then the claims.
 * Revocation is bounded by the token's lifetime; pass `isRevoked` (fed by the key revocation feed
 * or the `api_key.revoked` webhook) to cut that window to your sync interval.
 */

/** Where the keys come from: a cache that fetches the instance JWKS, or a fixed key set (tests, CI). */
export type CredentialKeySource = JwksCache | Jwks | { jwksUrl: string; fetchImpl?: typeof fetch; jwksCache?: JwksCacheTuning };

export interface VerifyCredentialOptions {
  /** The instance issuer the token must carry (`issuer` in the mint response; `https://<frontend host>`). */
  issuer: string;
  keys: CredentialKeySource;
  /** The audience your service expects, when the token was minted for one. A token with an audience nobody named is refused. */
  audience?: string | string[];
  now?: Date;
}

export interface VerifyApiKeyTokenOptions extends VerifyCredentialOptions {
  /** Every one of these must be among the token's `scopes`. */
  requiredScopes?: string[];
  /** Deny-list hook: true when this API key id was revoked (the revocation feed). Called with the token's `sub`. */
  isRevoked?: (keyId: string) => boolean | Promise<boolean>;
  /**
   * For a proof-of-possession key (the token carries `cnf.jkt`): the RFC 7638 thumbprint of the key the caller
   * just proved it holds. Without it such a token is refused with `proof_required`.
   */
  holderKeyThumbprint?: string;
}

export interface VerifyMachineTokenOptions extends VerifyCredentialOptions {
  /** Every one of these must be among the token's `scope` (space-separated) or `scopes` claim. */
  requiredScopes?: string[];
  /** Accept a token that carries an audience even though {@link VerifyCredentialOptions.audience} is not set. */
  anyAudience?: boolean;
  /**
   * Deny-list hook: true when this machine (or its grant for the token's audience) was revoked at or after the
   * token was issued. Plug in `createMachineDenyList().isRevoked`, kept current by the revocation stream or the
   * `/v1/machines/revoked` feed, to cut a revoked machine token's life from its lifetime to seconds.
   */
  isRevoked?: (claims: MachineTokenClaims) => boolean | Promise<boolean>;
}

export interface VerifyDelegationTokenOptions extends Omit<VerifyCredentialOptions, 'audience'> {
  /** Your service's audience. Required: a delegation token is for one named service. */
  audience: string | string[];
  /** Every one of these must be among the token's `scope`. */
  requiredScopes?: string[];
  /** Refuse a token with no `act` claim (default true; it is always present on tokens Atlas mints). */
  requireAct?: boolean;
  /** Refuse unless the outermost actor is one of these (`act.sub`). */
  allowedActors?: string[];
  /** Called with the token id; return true to refuse a token you already know is revoked. */
  isRevoked?: (jti: string) => boolean | Promise<boolean>;
}

export interface DelegationTokenClaims extends JWTPayload {
  /** The user the token acts for. */
  sub: string;
  jti: string;
  token_use: 'delegation';
  scope: string;
  /** Who is acting for the user. */
  act: { sub: string; typ?: string; act?: unknown };
  org_id?: string;
}

export type CredentialFailure =
  | 'invalid_token'
  | 'wrong_token_type'
  | 'insufficient_scope'
  | 'revoked'
  | 'proof_required'
  | 'proof_mismatch'
  | 'keys_unavailable';

export type CredentialResult<C> = { valid: true; claims: C } | { valid: false; code: CredentialFailure };

export interface ApiKeyTokenClaims extends JWTPayload {
  /** The API key id the token was minted from. */
  sub: string;
  jti: string;
  token_use: 'api_key';
  scopes: string[];
  constraints: Record<string, unknown>;
  cnf?: { jkt: string };
  organization?: { id: string; role: string; permissions: string[] };
  /** The key's metadata, signed in when the token was minted with `include_metadata`. */
  meta?: Record<string, unknown>;
}

export interface MachineTokenClaims extends JWTPayload {
  /** The machine id. */
  sub: string;
  jti: string;
  token_use: 'm2m';
  org_id?: string;
  scope?: string;
  scopes?: string[];
}

async function keysFor(source: JwksCache | Jwks, token: string): Promise<Jwks | null> {
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    return null;
  }
  return source instanceof JwksCache ? source.get(kid) : source;
}

/** One cache per URL, so `{ jwksUrl }` callers keep their keys between calls. */
const urlCaches = new Map<string, JwksCache>();
function resolveSource(source: CredentialKeySource): JwksCache | Jwks {
  if (source instanceof JwksCache || 'keys' in source) return source;
  const tuning = checkJwksCacheTuning(source.jwksCache);
  // A different tuning is a different cache; the stale hook of the first caller with a given tuning is the one used.
  const cacheKey = `${source.jwksUrl}|${tuning?.ttlMs ?? ''}|${tuning?.maxStaleMs ?? ''}`;
  let cache = urlCaches.get(cacheKey);
  if (!cache || source.fetchImpl) {
    cache = new JwksCache({ url: source.jwksUrl, ...(source.fetchImpl ? { fetchImpl: source.fetchImpl } : {}), ...tuning });
    if (!source.fetchImpl) urlCaches.set(cacheKey, cache);
  }
  return cache;
}

async function verifySigned(
  token: string,
  opts: VerifyCredentialOptions,
): Promise<{ ok: true; payload: JWTPayload } | { ok: false; code: CredentialFailure }> {
  if (typeof token !== 'string' || token.split('.').length !== 3) return { ok: false, code: 'invalid_token' };
  const jwks = await keysFor(resolveSource(opts.keys), token);
  if (!jwks) return { ok: false, code: 'keys_unavailable' };
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks as unknown as Parameters<typeof createLocalJWKSet>[0]), {
      algorithms: [...ATLAS_SIGNING_ALGS],
      issuer: opts.issuer,
      ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      clockTolerance: 5,
      currentDate: opts.now,
    });
    return { ok: true, payload };
  } catch {
    return { ok: false, code: 'invalid_token' };
  }
}

/**
 * Verify an API-key token (`POST /v1/api_keys/token`) with no call to Atlas. Checks the signature, issuer,
 * expiry and audience, that it really is an API-key token (a session or machine token signed with the same
 * key is refused), the required scopes, the holder proof of a proof-of-possession key, and your deny-list.
 */
export async function verifyApiKeyToken(token: string, opts: VerifyApiKeyTokenOptions): Promise<CredentialResult<ApiKeyTokenClaims>> {
  const signed = await verifySigned(token, opts);
  if (!signed.ok) return { valid: false, code: signed.code };
  const claims = signed.payload as unknown as ApiKeyTokenClaims;
  if (claims.token_use !== 'api_key' || typeof claims.sub !== 'string') return { valid: false, code: 'wrong_token_type' };
  const jkt = claims.cnf?.jkt;
  if (jkt) {
    if (!opts.holderKeyThumbprint) return { valid: false, code: 'proof_required' };
    if (opts.holderKeyThumbprint !== jkt) return { valid: false, code: 'proof_mismatch' };
  }
  const held = new Set(Array.isArray(claims.scopes) ? claims.scopes : []);
  if ((opts.requiredScopes ?? []).some((s) => !held.has(s))) return { valid: false, code: 'insufficient_scope' };
  if (opts.isRevoked && (await opts.isRevoked(claims.sub))) return { valid: false, code: 'revoked' };
  return { valid: true, claims };
}

/**
 * Verify a machine token (`token_use: m2m`) with no call to Atlas: signature, issuer, expiry, the m2m marker
 * (a session token is refused), an audience nobody named, and the required scopes.
 */
export async function verifyMachineToken(token: string, opts: VerifyMachineTokenOptions): Promise<CredentialResult<MachineTokenClaims>> {
  const signed = await verifySigned(token, opts);
  if (!signed.ok) return { valid: false, code: signed.code };
  const claims = signed.payload as unknown as MachineTokenClaims;
  if (claims.token_use !== 'm2m' || typeof claims.sub !== 'string') return { valid: false, code: 'wrong_token_type' };
  // A token bound to a resource server is for that server alone.
  if (claims.aud !== undefined && opts.audience === undefined && !opts.anyAudience) return { valid: false, code: 'invalid_token' };
  const held = new Set([
    ...(typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : []),
    ...(Array.isArray(claims.scopes) ? claims.scopes : []),
  ]);
  if ((opts.requiredScopes ?? []).some((s) => !held.has(s))) return { valid: false, code: 'insufficient_scope' };
  if (opts.isRevoked && (await opts.isRevoked(claims))) return { valid: false, code: 'revoked' };
  return { valid: true, claims };
}

/**
 * Verify a delegation token (`POST /v1/users/{id}/delegation_tokens`) with no call to Atlas: signature, issuer, expiry,
 * that it really is a delegation token (a session, machine or API-key token signed with the same key is refused), that
 * it was minted for YOUR audience, the required scopes, and an `act` claim naming who is acting. The result's `claims.sub`
 * is the user and `claims.act.sub` the actor.
 */
export async function verifyDelegationToken(token: string, opts: VerifyDelegationTokenOptions): Promise<CredentialResult<DelegationTokenClaims>> {
  if (opts.audience === undefined || opts.audience === '' || (Array.isArray(opts.audience) && opts.audience.length === 0)) {
    throw new TypeError('verifyDelegationToken: audience is required');
  }
  const signed = await verifySigned(token, opts);
  if (!signed.ok) return { valid: false, code: signed.code };
  const claims = signed.payload as unknown as DelegationTokenClaims;
  if (claims.token_use !== 'delegation' || typeof claims.sub !== 'string' || typeof claims.jti !== 'string') {
    return { valid: false, code: 'wrong_token_type' };
  }
  const actSub = claims.act && typeof claims.act === 'object' ? (claims.act as { sub?: unknown }).sub : undefined;
  if ((opts.requireAct ?? true) && typeof actSub !== 'string') return { valid: false, code: 'wrong_token_type' };
  if (opts.allowedActors && (typeof actSub !== 'string' || !opts.allowedActors.includes(actSub))) {
    return { valid: false, code: 'wrong_token_type' };
  }
  const held = new Set(typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : []);
  if ((opts.requiredScopes ?? []).some((x) => !held.has(x))) return { valid: false, code: 'insufficient_scope' };
  if (opts.isRevoked && (await opts.isRevoked(claims.jti))) return { valid: false, code: 'revoked' };
  return { valid: true, claims };
}
