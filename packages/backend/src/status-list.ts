import { sha256 } from '@noble/hashes/sha256';
import { DEFAULT_API_URL } from './client/request';

/**
 * Verifier for the signed session status list (`GET /v1/sessions/revocations/status-list`).
 *
 * Edge-safe: it uses only Web Crypto, `@noble/hashes`, `atob` and `TextDecoder`, so it runs unchanged in Node, Next.js
 * edge middleware, Cloudflare Workers, Deno and a browser. No `node:` import, no Buffer.
 *
 * The list is a JWT signed with the instance session key (RS256 or ES256). It carries the first `hash_bytes` bytes of the
 * SHA-256 of every session id revoked in its window, sorted, as one base64url string. {@link VerifiedStatusList.has}
 * answers whether a session id is in it.
 */

export interface StatusListKey {
  kid?: string;
  kty?: string;
  [claim: string]: unknown;
}

export interface VerifyStatusListOptions {
  /** The instance JWKS (or just its keys), or a function that returns it for a `kid`. */
  jwks: { keys: StatusListKey[] } | ((kid: string | undefined) => Promise<{ keys: StatusListKey[] } | null> | { keys: StatusListKey[] } | null);
  /** The issuer the list must carry. Strongly recommended: without it any key in the JWKS may vouch for any issuer. */
  issuer?: string;
  /** Clock in epoch ms, for tests. */
  now?: () => number;
  /** Allowed clock skew in seconds. Default 30. */
  skewSeconds?: number;
}

export interface VerifiedStatusList {
  /** True when the session id's hash is in the list. */
  has(sid: string): boolean;
  /** Sessions in the list. */
  count: number;
  /** More sessions were revoked than fit: a miss proves nothing, use the feed. */
  truncated: boolean;
  /** Epoch ms the list was issued. */
  issuedAt: number;
  /** Epoch ms the list stops being valid. */
  expiresAt: number;
  /** Epoch ms the list reaches back to. */
  since: number;
}

export class StatusListError extends Error {
  constructor(readonly reason: 'malformed' | 'unsupported' | 'no_key' | 'bad_signature' | 'bad_claims' | 'expired') {
    super(`Invalid session status list: ${reason}`);
    this.name = 'StatusListError';
  }
}

const decoder = new TextDecoder();

function b64urlToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new StatusListError('malformed');
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const v = JSON.parse(decoder.decode(bytes));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new StatusListError('malformed');
}

/** Compare two byte ranges; used by the binary search. */
function compareAt(list: Uint8Array, offset: number, needle: Uint8Array): number {
  for (let i = 0; i < needle.length; i++) {
    const d = list[offset + i]! - needle[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

/** Verify the signed list and return a lookup. Throws {@link StatusListError} on any problem; never returns a half-trusted list. */
/** The JWS algorithms an instance key can use, with the Web Crypto parameters that verify each. */
const WEBCRYPTO_ALGS: Record<string, { kty: string; crv?: string; importParams: unknown; verifyParams: unknown }> = {
  RS256: { kty: 'RSA', importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { kty: 'RSA', importParams: { name: 'RSA-PSS', hash: 'SHA-256' }, verifyParams: { name: 'RSA-PSS', saltLength: 32 } },
  ES256: { kty: 'EC', crv: 'P-256', importParams: { name: 'ECDSA', namedCurve: 'P-256' }, verifyParams: { name: 'ECDSA', hash: 'SHA-256' } },
  ES384: { kty: 'EC', crv: 'P-384', importParams: { name: 'ECDSA', namedCurve: 'P-384' }, verifyParams: { name: 'ECDSA', hash: 'SHA-384' } },
  EdDSA: { kty: 'OKP', crv: 'Ed25519', importParams: { name: 'Ed25519' }, verifyParams: { name: 'Ed25519' } },
};

export async function verifyStatusListToken(token: string, options: VerifyStatusListOptions): Promise<VerifiedStatusList> {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 4_000_000) throw new StatusListError('malformed');
  const header = parseJson(b64urlToBytes(parts[0]!));
  if (header.typ !== 'statuslist+jwt') throw new StatusListError('unsupported');
  const alg = header.alg;
  const spec = typeof alg === 'string' ? WEBCRYPTO_ALGS[alg] : undefined;
  if (!spec) throw new StatusListError('unsupported');
  const kid = typeof header.kid === 'string' ? header.kid : undefined;

  const set = typeof options.jwks === 'function' ? await options.jwks(kid) : options.jwks;
  const jwk = set?.keys.find((k) => (kid ? k.kid === kid : true) && k.kty === spec.kty && (spec.crv === undefined || k.crv === spec.crv));
  if (!jwk) throw new StatusListError('no_key');

  const subtle = globalThis.crypto.subtle;
  let valid: boolean;
  try {
    const { kid: _kid, use: _use, key_ops: _ops, alg: _alg, ...material } = jwk as Record<string, unknown>;
    const key = await subtle.importKey('jwk', material as never, spec.importParams as never, false, ['verify']);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]!);
    valid = await subtle.verify(spec.verifyParams as never, key, sig, data);
  } catch {
    throw new StatusListError('bad_signature');
  }
  if (!valid) throw new StatusListError('bad_signature');

  const claims = parseJson(b64urlToBytes(parts[1]!));
  const nowSec = (options.now ?? Date.now)() / 1000;
  const skew = options.skewSeconds ?? 30;
  const num = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new StatusListError('bad_claims');
    return v;
  };
  if (claims.aud !== 'atlas:session-status-list' || claims.token_use !== 'session_status_list') throw new StatusListError('bad_claims');
  if (options.issuer !== undefined && claims.iss !== options.issuer) throw new StatusListError('bad_claims');
  const exp = num(claims.exp);
  const iat = num(claims.iat);
  if (exp + skew < nowSec) throw new StatusListError('expired');
  if (iat - skew > nowSec) throw new StatusListError('bad_claims');
  const hashBytes = num(claims.hash_bytes);
  if (!Number.isInteger(hashBytes) || hashBytes < 4 || hashBytes > 32) throw new StatusListError('bad_claims');
  const count = num(claims.count);
  const list = typeof claims.h === 'string' ? b64urlToBytes(claims.h) : null;
  if (!list || list.length !== count * hashBytes) throw new StatusListError('bad_claims');

  return {
    count,
    truncated: claims.truncated === true,
    issuedAt: iat * 1000,
    expiresAt: exp * 1000,
    since: num(claims.since),
    has(sid: string): boolean {
      const needle = sha256(new TextEncoder().encode(sid)).subarray(0, hashBytes);
      let lo = 0;
      let hi = count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const c = compareAt(list, mid * hashBytes, needle);
        if (c === 0) return true;
        if (c < 0) lo = mid + 1;
        else hi = mid - 1;
      }
      return false;
    },
  };
}

export interface EdgeRevocationOptions {
  /** A secret key with `sessions:read`. Keep it server-side: an edge function's environment, never a browser. */
  secretKey: string;
  /** Atlas API origin. Default: the Atlas API. */
  baseUrl?: string;
  /** The instance JWKS URL. */
  jwksUrl: string;
  /** The instance issuer (the `iss` of your session tokens). */
  issuer?: string;
  /** How far back the list reaches. Use at least your longest session token lifetime. Default 3600. */
  windowSeconds?: number;
  /** Refresh the list when it is older than this. Default 30000. */
  refreshMs?: number;
  /** After this long without a successful refresh the checker is `stale`. Default 120000. */
  staleAfterMs?: number;
  /** Keep answering from the last list this much longer past `staleAfterMs` before failing closed. Default 0. */
  serveStaleForMs?: number;
  /** `reject` (default) answers `unavailable` past the stale limit; `allow` keeps using the last list. */
  onStale?: 'allow' | 'reject';
  fetchImpl?: typeof fetch;
  now?: () => number;
  onError?: (error: unknown) => void;
  onServeStale?: (info: { lastSuccessAt: number | null; staleForMs: number }) => void;
}

export type EdgeRevocationVerdict = 'ok' | 'revoked' | 'unavailable';

/**
 * A revocation check for runtimes that cannot keep a long-lived poller (edge functions, Workers). It holds the last
 * verified status list in module memory, refreshes it when older than `refreshMs`, and answers `ok`, `revoked` or
 * `unavailable` (the list is too old and `onStale` is `reject`, or the list was truncated). Concurrent calls share one
 * refresh. Fail-closed on a bad signature: a list that does not verify is never used.
 */
export function createEdgeRevocationChecker(options: EdgeRevocationOptions) {
  const now = options.now ?? Date.now;
  const f = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  let current: VerifiedStatusList | null = null;
  let lastSuccessAt: number | null = null;
  let jwks: { keys: StatusListKey[] } | null = null;
  let jwksAt = 0;
  let inflight: Promise<void> | null = null;

  async function keys(kid: string | undefined) {
    if (!jwks || now() - jwksAt > 600_000 || (kid && !jwks.keys.some((k) => k.kid === kid) && now() - jwksAt > 60_000)) {
      const res = await f(options.jwksUrl);
      if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
      jwks = (await res.json()) as { keys: StatusListKey[] };
      jwksAt = now();
    }
    return jwks;
  }

  async function refresh(): Promise<void> {
    try {
      const q = options.windowSeconds ? `?window_seconds=${options.windowSeconds}` : '';
      const res = await f(`${base}/v1/sessions/revocations/status-list${q}`, { headers: { authorization: `Bearer ${options.secretKey}` } });
      if (!res.ok) throw new Error(`status list answered ${res.status}`);
      const body = (await res.json()) as { token?: string };
      if (typeof body.token !== 'string') throw new Error('status list answer had no token');
      current = await verifyStatusListToken(body.token, { jwks: keys, issuer: options.issuer, now });
      lastSuccessAt = now();
    } catch (error) {
      options.onError?.(error);
    }
  }

  return {
    /** Epoch ms of the last list that verified; null before the first. */
    lastSuccessAt: (): number | null => lastSuccessAt,
    /** The verdict for a session id (the `sid` of a verified session token). */
    async check(sid: string): Promise<EdgeRevocationVerdict> {
      if (current === null || lastSuccessAt === null || now() - lastSuccessAt >= (options.refreshMs ?? 30_000)) {
        await (inflight ??= refresh().finally(() => (inflight = null)));
      }
      const stale = lastSuccessAt === null ? Infinity : now() - lastSuccessAt - (options.staleAfterMs ?? 120_000);
      if (current === null) return options.onStale === 'allow' ? 'ok' : 'unavailable';
      if (current.has(sid)) return 'revoked';
      if (current.truncated) return 'unavailable';
      if (stale > 0 && options.onStale !== 'allow') {
        if (stale <= (options.serveStaleForMs ?? 0)) {
          options.onServeStale?.({ lastSuccessAt, staleForMs: stale });
          return 'ok';
        }
        return 'unavailable';
      }
      return 'ok';
    },
  };
}
