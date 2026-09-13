import type { AuthzClaims } from './claims';

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

/** The condition fields that require an active organization to satisfy. */
function wantsOrgContext(condition: ProtectCondition): boolean {
  return (
    condition.permission !== undefined ||
    condition.role !== undefined ||
    condition.anyPermission !== undefined ||
    condition.allPermissions !== undefined
  );
}

/**
 * Whether `claims` satisfy `condition`, with a reason when they do not.
 *
 * An empty condition means "signed in", which is the common case and reads
 * naturally as `<Protect>` / `has({})`. Requiring an explicit `signedIn` flag
 * would make the simplest usage the noisiest.
 *
 * A user with no active organization FAILS any organization condition rather
 * than passing it vacuously: `allPermissions: []` against no org must not render
 * an admin panel just because the empty set is trivially satisfied. (This is the
 * exact case where the old Next.js `has()` and React `has()` disagreed — they
 * now share this one rule.)
 */
export function evaluate(
  claims: AuthzClaims | null | undefined,
  condition: ProtectCondition = {},
): ProtectOutcome {
  if (!claims) return { allowed: false, reason: 'signed_out' };

  // Entitlement (plan/feature) is the subject's own — its org's in a B2B org,
  // else the user's — minted as `pla`/`fea`. It does NOT require an active
  // organization, so it is checked before the org-context gate below.
  if (condition.plan !== undefined && claims.pla !== condition.plan) {
    return { allowed: false, reason: 'missing_entitlement' };
  }
  if (condition.feature !== undefined && !(claims.fea ?? []).includes(condition.feature)) {
    return { allowed: false, reason: 'missing_entitlement' };
  }

  if (!wantsOrgContext(condition)) return { allowed: true };
  if (!claims.org_id) return { allowed: false, reason: 'no_organization' };

  const held = new Set(claims.org_permissions ?? []);

  if (condition.role !== undefined && claims.org_role !== condition.role) {
    return { allowed: false, reason: 'missing_permission' };
  }
  if (condition.permission !== undefined && !held.has(condition.permission)) {
    return { allowed: false, reason: 'missing_permission' };
  }
  if (condition.anyPermission && !condition.anyPermission.some((p) => held.has(p))) {
    return { allowed: false, reason: 'missing_permission' };
  }
  if (condition.allPermissions && !condition.allPermissions.every((p) => held.has(p))) {
    return { allowed: false, reason: 'missing_permission' };
  }

  return { allowed: true };
}

/** The boolean form — the primitive behind every surface's `has(condition)`. */
export function hasFromClaims(
  claims: AuthzClaims | null | undefined,
  condition: ProtectCondition = {},
): boolean {
  return evaluate(claims, condition).allowed;
}

/**
 * The error `protect()` throws when a condition is not met. Carrying the reason
 * (and the failed condition) lets a server framework map it to the right status:
 * `signed_out` → 401, everything else → 403/404 per the app's convention.
 */
export class ForbiddenError extends Error {
  readonly reason: ProtectReason;
  readonly condition: ProtectCondition;
  constructor(reason: ProtectReason, condition: ProtectCondition) {
    super(
      reason === 'signed_out'
        ? 'Not signed in.'
        : reason === 'no_organization'
          ? 'No active organization for this authorization check.'
          : reason === 'missing_entitlement'
            ? 'Missing the required plan or feature.'
            : 'Missing the required permission or role.',
    );
    this.name = 'ForbiddenError';
    this.reason = reason;
    this.condition = condition;
  }
}

/**
 * Assert a condition, throwing `ForbiddenError` when it fails. The imperative
 * companion to `hasFromClaims` — a server route calls this to hard-stop a
 * request, the same way Clerk's `auth().protect()` does.
 */
export function protectFromClaims(
  claims: AuthzClaims | null | undefined,
  condition: ProtectCondition = {},
): void {
  const outcome = evaluate(claims, condition);
  if (!outcome.allowed) throw new ForbiddenError(outcome.reason, condition);
}
