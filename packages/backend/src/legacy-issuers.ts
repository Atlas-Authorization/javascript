import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { JwksCache, readKid, type Jwks } from './jwks-cache';

/**
 * Accepting your OLD auth provider's JWTs during a cutover — today, Better
 * Auth's `jwt` plugin tokens.
 *
 * When you move to Atlas, API clients may still hold short-lived JWTs your
 * Better Auth app minted. With `legacyIssuers` on an {@link AtlasBackend}, a
 * token whose `iss` is one of these issuers is verified against THAT issuer's
 * key set (the JWKS you imported into Atlas, or the old app's `/api/auth/jwks`)
 * for a bounded window, and its `sub` (the Better Auth user id) is mapped to the
 * Atlas user id — Atlas keeps the Better Auth id as the user's `external_id`.
 * After `until`, those tokens are refused like any other foreign token.
 */
export interface LegacyIssuer {
  /**
   * The old provider: `better_auth`, or one of the JWT vendors with a preset
   * in legacy-issuer-presets.ts (`clerk`, `auth0`, `okta`, `kinde`, `descope`).
   */
  kind?: LegacyIssuerKind;
  /** The `iss` the old tokens carry (Better Auth: its `baseURL`, unless `jwt.issuer` was set). */
  issuer: string;
  /** The imported key set. Exactly one of `jwks` / `jwksUrl`. */
  jwks?: Jwks;
  /** Where to fetch the old key set (e.g. `https://app.example.com/api/auth/jwks`). */
  jwksUrl?: string;
  /** Expected `aud` (Better Auth: its `baseURL`, unless `jwt.audience` was set). Unchecked when unset. */
  audience?: string | readonly string[];
  /** The end of the acceptance window. Required: a legacy issuer is never accepted forever. */
  until: Date | string | number;
  /** Signing algorithms to accept. Default: Better Auth's (EdDSA, ES256, ES512, RS256, PS256). */
  algorithms?: readonly string[];
  /**
   * Map the old `sub` to the Atlas user id. Default: look the user up by
   * `external_id` through the Backend API (needs `secretKey` + `bapiBaseUrl`
   * on the backend), cached in memory. Return null to refuse the token.
   */
  resolveSubject?: (legacySub: string, claims: Record<string, unknown>) => Promise<string | null> | string | null;
  /**
   * The claim that carries the old provider's user id. Default `sub`. Okta
   * access tokens put the login in `sub` and the user id in `uid`.
   */
  subjectClaim?: string;
  /**
   * Extra vendor checks on the verified claims (Clerk's `azp` against the
   * authorized parties, say). Return false to refuse the token.
   */
  checkClaims?: (claims: Record<string, unknown>) => boolean;
}

export type LegacyIssuerKind = 'better_auth' | 'clerk' | 'auth0' | 'okta' | 'kinde' | 'descope';

/** Better Auth's `jwt` plugin key algorithms. */
export const BETTER_AUTH_JWT_ALGS = ['EdDSA', 'ES256', 'ES512', 'RS256', 'PS256'];

/** How long a resolved sub → Atlas id mapping is reused. */
const SUBJECT_TTL_MS = 5 * 60_000;
/** Cap on cached subjects, so a stream of distinct tokens can't grow memory without bound. */
const SUBJECT_CACHE_MAX = 10_000;

export interface LegacyVerifierDeps {
  issuers: readonly LegacyIssuer[];
  secretKey?: string;
  bapiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  clockToleranceSeconds: number;
}

export type LegacyVerifyOutcome =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: 'invalid' | 'no_keys' };

/** The unverified `iss` of a compact JWT, for routing only — never trusted on its own. */
export function peekIssuer(token: string): string | undefined {
  try {
    const iss = decodeJwt(token).iss;
    return typeof iss === 'string' ? iss : undefined;
  } catch {
    return undefined;
  }
}

function safeCheck(check: (claims: Record<string, unknown>) => boolean, claims: Record<string, unknown>): boolean {
  try {
    return check(claims) === true;
  } catch {
    return false;
  }
}

function untilMs(until: LegacyIssuer['until']): number {
  const t = until instanceof Date ? until.getTime() : typeof until === 'number' ? until : Date.parse(until);
  return Number.isFinite(t) ? t : 0;
}

export class LegacyIssuerVerifier {
  private readonly caches = new Map<string, JwksCache>();
  private readonly subjects = new Map<string, { id: string | null; at: number }>();

  constructor(private readonly deps: LegacyVerifierDeps) {
    for (const entry of deps.issuers) {
      const hasUrl = typeof entry.jwksUrl === 'string' && entry.jwksUrl.length > 0;
      if (hasUrl === (entry.jwks !== undefined)) {
        throw new Error(`legacyIssuers: "${entry.issuer}" needs exactly one of \`jwks\` or \`jwksUrl\`.`);
      }
      if (!entry.issuer) throw new Error('legacyIssuers: every entry needs `issuer`.');
      if (!untilMs(entry.until)) throw new Error(`legacyIssuers: "${entry.issuer}" needs a valid \`until\` (the end of the window).`);
      if (!entry.resolveSubject && (!deps.secretKey || !deps.bapiBaseUrl)) {
        throw new Error(
          `legacyIssuers: "${entry.issuer}" maps its \`sub\` to an Atlas user through the Backend API, which needs \`secretKey\` and \`bapiBaseUrl\` on AtlasBackend — or give the issuer a \`resolveSubject\`.`,
        );
      }
      this.caches.set(
        entry.issuer,
        new JwksCache({
          url: hasUrl ? entry.jwksUrl : undefined,
          staticJwks: entry.jwks,
          fetchImpl: deps.fetchImpl,
          now: deps.now,
        }),
      );
    }
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The configured entry for this `iss`, when its window is still open. */
  match(iss: string | undefined): LegacyIssuer | undefined {
    if (!iss) return undefined;
    const entry = this.deps.issuers.find((e) => e.issuer === iss);
    if (!entry) return undefined;
    return untilMs(entry.until) > this.now ? entry : undefined;
  }

  async verify(token: string, entry: LegacyIssuer): Promise<LegacyVerifyOutcome> {
    const cache = this.caches.get(entry.issuer)!;
    const keys = await cache.get(readKid(token));
    if (!keys || keys.keys.length === 0) return { ok: false, reason: 'no_keys' };

    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(token, createLocalJWKSet(keys as never), {
        algorithms: [...(entry.algorithms ?? BETTER_AUTH_JWT_ALGS)],
        issuer: entry.issuer,
        ...(entry.audience !== undefined ? { audience: entry.audience as string | string[] } : {}),
        clockTolerance: this.deps.clockToleranceSeconds,
        currentDate: this.deps.now ? new Date(this.deps.now()) : undefined,
      });
      payload = verified.payload as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    // A legacy token without an expiry would outlive the window it is accepted in.
    if (typeof payload.exp !== 'number') return { ok: false, reason: 'invalid' };

    if (entry.checkClaims && !safeCheck(entry.checkClaims, payload)) return { ok: false, reason: 'invalid' };

    const subject = payload[entry.subjectClaim ?? 'sub'];
    const legacySub =
      typeof subject === 'string' && subject
        ? subject
        : !entry.subjectClaim && typeof payload.id === 'string'
          ? payload.id
          : '';
    if (!legacySub) return { ok: false, reason: 'invalid' };
    const atlasId = await this.resolve(legacySub, payload, entry);
    if (!atlasId) return { ok: false, reason: 'invalid' };

    return {
      ok: true,
      claims: {
        ...payload,
        sub: atlasId,
        sid: typeof payload.sid === 'string' ? payload.sid : '',
        external_id: legacySub,
        legacy: { kind: entry.kind ?? 'better_auth', issuer: entry.issuer, sub: legacySub },
      },
    };
  }

  private async resolve(legacySub: string, claims: Record<string, unknown>, entry: LegacyIssuer): Promise<string | null> {
    if (entry.resolveSubject) {
      try {
        return (await entry.resolveSubject(legacySub, claims)) || null;
      } catch {
        return null;
      }
    }
    const key = `${entry.issuer}\u0000${legacySub}`;
    const hit = this.subjects.get(key);
    if (hit && this.now - hit.at < SUBJECT_TTL_MS) return hit.id;

    let id: string | null = null;
    try {
      const url = new URL('/v1/users', this.deps.bapiBaseUrl!);
      url.searchParams.set('external_id', legacySub);
      url.searchParams.set('limit', '1');
      const res = await (this.deps.fetchImpl ?? fetch)(url.toString(), {
        headers: { authorization: `Bearer ${this.deps.secretKey!}` },
      });
      if (!res.ok) return null; // not cached: a transient failure should not stick
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      id = body.data?.[0]?.id ?? null;
    } catch {
      return null;
    }
    if (this.subjects.size >= SUBJECT_CACHE_MAX) this.subjects.clear();
    this.subjects.set(key, { id, at: this.now });
    return id;
  }
}
