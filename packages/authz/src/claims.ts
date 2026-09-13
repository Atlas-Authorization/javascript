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
