/**
 * The shared authorization condition every Atlas SDK evaluates.
 *
 * COPIED verbatim from `@atlasauth/authz` (`src/claims.ts`, `src/protect.ts`).
 * That package ships the runtime `evaluate()` / `ForbiddenError`; only the pure
 * types are mirrored here so `@atlasauth/types` stays runtime-free.
 */

/**
 * The minimal, structural view of session claims the authorization primitive
 * needs. Every SDK has its own richer `SessionClaims` (the backend verifier, the
 * React session, the Next.js middleware); each is assignable to this shape, so
 * they can all feed the SAME `evaluate()` without this package depending on any
 * of them. Keeping it structural is deliberate — it is the seam that lets one
 * primitive serve server, edge, and browser alike.
 */
export interface AuthzClaims {
  /** The active organization, if the session has one selected. */
  org_id?: string | null;
  /** The user's role key in the active organization (e.g. `org:admin`). */
  org_role?: string | null;
  /**
   * The permission keys the active-org role holds — the union of the role's
   * direct permissions and any granted through group membership, exactly as the
   * token was minted. Authorization reads this set; it never re-derives it.
   */
  org_permissions?: readonly string[] | null;
  /**
   * §billing — the active plan slug (Clerk `has({plan})`), minted as `pla` only
   * when the subject is entitled (its org's plan in a B2B org, else the user's).
   * An unsubscribed token omits it. Unlike org permissions this needs NO active
   * organization to evaluate.
   */
  pla?: string | null;
  /** §billing — the granted feature keys (Clerk `has({feature})`), minted as `fea`. */
  fea?: readonly string[] | null;
}

/**
 * The ONE authorization condition every Atlas SDK evaluates — `@atlasauth/backend`,
 * `@atlasauth/nextjs`, `@atlasauth/react`, `@atlasauth/react-native`, and `@atlasauth/js` all
 * import this exact shape and the `evaluate()` below. Before this package the
 * same `has()` meant different things on different surfaces (React understood
 * all four fields; Next.js understood only two; the backend had no `has()` at
 * all). Centralizing the contract here is what makes a check portable across
 * client and server.
 */
export interface ProtectCondition {
  /** A single permission the ACTIVE organization role must hold. */
  permission?: string;
  /** An exact role in the active organization. */
  role?: string;
  /** Any of these permissions (OR). */
  anyPermission?: readonly string[];
  /** All of these permissions (AND). */
  allPermissions?: readonly string[];
  /** The active billing plan (Clerk `has({ plan })`) — matches the `pla` claim.
   *  Needs NO active organization: it is the subject's entitlement. */
  plan?: string;
  /** A granted feature (Clerk `has({ feature })`) — an entry in the `fea` claim. */
  feature?: string;
}

export type ProtectReason =
  | 'signed_out'
  | 'no_organization'
  | 'missing_permission'
  | 'missing_entitlement';

export type ProtectOutcome =
  | { allowed: true }
  | { allowed: false; reason: ProtectReason };
