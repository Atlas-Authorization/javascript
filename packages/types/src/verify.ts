/**
 * Read-side verification types.
 *
 * COPIED verbatim from `@atlasauth/backend` (`src/verify.ts`). That package
 * ships the `AtlasBackend` client factory and pulls `jose`, so the pure result
 * types are mirrored here to keep `@atlasauth/types` standalone.
 *
 * `@atlasauth/backend` calls its read-side claims shape `SessionClaims` too; it
 * is a SUPERSET of core's mint-side claims (it adds the registered `exp`/`iat`
 * and the opt-in `act`/`email`/`external_id`). It is surfaced here as
 * **`VerifiedSessionClaims`** so it does not clash with core's `SessionClaims`.
 */
import type { ProtectCondition } from './authz';

/**
 * The claims a verifier reads off a token (`@atlasauth/backend`'s own
 * `SessionClaims`). A superset of the mint-side {@link ./session!SessionClaims}
 * — it carries the registered `exp`/`nbf`/`iat` and the opt-in
 * `act`/`email`/`external_id` claims a verifier may see.
 */
export interface VerifiedSessionClaims {
  iss: string;
  sub: string;
  sid: string;
  exp: number;
  nbf?: number;
  iat?: number;
  /**
   * §S4 audience — the instance this token is FOR (the stable instance id by
   * default, or the value pinned via `authConfig.session.audience`). Verified
   * only when `AtlasBackend` is configured with an expected `audience`.
   */
  aud?: string | string[];
  azp?: string;
  sv?: number;
  mfa?: boolean;
  org_id?: string;
  org_slug?: string;
  org_role?: string;
  org_permissions?: string[];
  /** §billing entitlement — active plan slug; gate with `has({ plan })`. */
  pla?: string;
  /** §billing entitlement — granted feature keys; gate with `has({ feature })`. */
  fea?: string[];
  /**
   * §impersonation — RFC 8693 actor claim. Present ONLY on an impersonation
   * session (the dashboard "impersonate" action, or a redeemed actor token); its
   * `sub` is the operator acting AS this user. Absent on an ordinary session.
   * Informational, never an authorization input — the operator's privilege was
   * proven when the token was minted — so read it to render the mandatory
   * "viewing as X" banner and to tag audit entries as impersonated, not to
   * grant access.
   */
  act?: { sub: string };
  /**
   * §migration R3 — the subject's primary verified email. Present ONLY when the
   * instance opted in (`session.includeEmailClaim`); absent otherwise. Lets an
   * integrator provision a first-login user from the token alone, with no
   * `GET /v1/users/:sub` round-trip. It is a snapshot at mint time, not a live
   * lookup — treat it as identity, not as an always-current address.
   */
  email?: string;
  /**
   * §migration R3 — the subject's `external_id`, when set (e.g. a SCIM
   * `externalId` or an id carried over from a migration). Present only alongside
   * `email` under the same opt-in, and only when the user carries one.
   */
  external_id?: string;
  [claim: string]: unknown;
}

/**
 * A verified session, carrying the ergonomic authorization helpers bound to its
 * claims — the server-side equivalent of Clerk's `auth()`. `has()` answers a
 * condition; `protect()` asserts one, throwing `ForbiddenError` (which the app
 * maps to 401/403). Both delegate to the shared `@atlasauth/authz` primitive, so a
 * check reads identically here, in the React `<Protect>`, and in Next.js.
 */
export interface AuthorizedSession {
  ok: true;
  claims: VerifiedSessionClaims;
  /**
   * The impersonator when this is an impersonation session — the RFC 8693 `act`
   * claim (`{ sub }`), else null. The server-side parallel of Clerk's
   * `auth().actor`: branch on it to render the mandatory "viewing as X" banner
   * and to tag audit entries, without reaching into `claims` untyped.
   */
  actor: { sub: string } | null;
  /** True when the claims satisfy the condition (empty condition = "signed in"). */
  has(condition?: ProtectCondition): boolean;
  /** Assert the condition; returns the claims on success, throws ForbiddenError otherwise. */
  protect(condition?: ProtectCondition): VerifiedSessionClaims;
}

export type VerifyResult =
  | AuthorizedSession
  | { ok: false; reason: 'malformed' | 'invalid' | 'no_keys' | 'unauthorized_party' };
