/**
 * Mint-side session JWT claims.
 *
 * COPIED verbatim from `@atlasauth/core` (`src/tokens/session-jwt.ts`), the
 * canonical mint-side definition. Core pulls `jose` for the signing/verifying
 * runtime, so the shape is copied here rather than re-exported — that keeps
 * `@atlasauth/types` standalone and runtime-free.
 *
 * §7.2 session JWT claims. Field names are fixed by the spec and are part of
 * the public contract — customer backends and `@atlasauth/backend` read them.
 */
export interface SessionClaims {
  iss: string;
  sub: string;
  sid: string;
  /**
   * §S4 audience — the instance this token is FOR. Defaults to the stable
   * instance id, so a verifier can assert it independently of `iss`; set via
   * `authConfig.session.audience` to pin a specific value. A verifier enforces it
   * only when it passes an expected audience, so a token that carries one still
   * verifies for callers that don't check it.
   */
  aud?: string | string[];
  /** Authorized party — the origin the token was minted for. */
  azp?: string;
  /** Active organization, present only when the session has one set (§8.1). */
  org_id?: string;
  org_slug?: string;
  org_role?: string;
  org_permissions?: string[];
  /** §B2B2B present as 'inherited' only when org_role came from an ancestor org. */
  org_role_source?: 'inherited';
  /** User sessions_version; bumped on sign-out-everywhere. */
  sv: number;
  /** Whether a second factor was passed for this session. */
  mfa: boolean;
  /**
   * §OIDC authentication context (RFC 8176 / OIDC core §2). Emitted on the
   * session token AFTER a step-up re-authentication (P1): `auth_time` (seconds
   * since epoch) is when the user last PROVED a credential — the later of
   * first-factor sign-in and any in-place step-up; `amr` the method(s) proven
   * (e.g. `['pwd']`, `['webauthn']`, `['otp','mfa']`); `acr` the context class.
   * All optional — a session that never stepped up carries none of them, so an
   * ordinary token is unchanged.
   */
  auth_time?: number;
  amr?: string[];
  acr?: string;
  /**
   * §P0-3 (opt-in, `session.includeOrgsClaim`) — the user's organization
   * memberships, size-bounded so the token stays small: at most N orgs, `pub`
   * (a small public-metadata subset) dropped when it would bloat the claim.
   * Present ONLY when the instance opted in AND the user has at least one org,
   * so an ordinary token carries no such key. Lets a multi-tenant product skip a
   * locally-mirrored org table and read memberships off the verified token.
   */
  orgs?: Array<{
    id: string;
    slug: string;
    role: string;
    plan?: string;
    pub?: Record<string, unknown>;
    /**
     * §round-8 #2 set to `true` when an allowlisted settings key that IS set for
     * this org could not be inlined (non-primitive, or over the token byte budget).
     * It marks the inline settings subset as INCOMPLETE — do not treat a key's
     * absence as "unset"; fetch the authoritative settings. Absent when nothing was
     * dropped.
     */
    settings_partial?: true;
  }>;
  /**
   * §P1-6 the structured billing entitlement — `{ plan, features, limits }` —
   * richer than the flat `pla`/`fea` claims (which stay for back-compat). Present
   * ONLY when an entitlement resolves, so an unentitled token carries no `ent`.
   */
  ent?: { plan: string; features: string[]; limits: Record<string, unknown> };
  [claim: string]: unknown;
}
