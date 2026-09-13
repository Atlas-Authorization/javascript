import {
  AtlasBackend,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type SessionClaims,
} from '@atlasauth/backend';
import { createError } from 'h3';

/**
 * The server-side auth surface exposed to Nitro routes — the Nuxt peer of the
 * Next.js `auth()` helper (`@atlasauth/nextjs`'s `createAuthHelper`).
 *
 * A signed-out request is NOT an error: it produces a state with
 * `isSignedIn: false` and every id null, because a route that renders
 * differently for anonymous visitors is the normal case. `protect()` is the
 * opt-in hard stop for routes that must refuse anonymous or under-privileged
 * callers, and it throws a properly-typed HTTP error rather than a bare
 * exception so Nitro maps it to 401/403.
 */
export interface AtlasAuth {
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  isSignedIn: boolean;
  claims: SessionClaims | null;
  /**
   * True when the claims satisfy the condition (an empty condition means
   * "signed in"). Delegates to the shared `@atlasauth/authz` primitive — identical
   * to the client `useAuth().has()` and the React/Next `<Protect>`.
   */
  has(condition?: ProtectCondition): boolean;
  /**
   * Assert access, throwing an HTTP error when unmet: 401 for a signed-out
   * caller, 403 when signed in but missing the role/permission. With no argument
   * it asserts merely "signed in".
   */
  protect(condition?: ProtectCondition): void;
}

/** The signed-out state, shared so a token-less request always returns the same shape. */
function signedOut(): AtlasAuth {
  return build(null);
}

/** Build the `AtlasAuth` view over a (possibly null) verified claims set. */
export function build(claims: SessionClaims | null): AtlasAuth {
  return {
    userId: claims?.sub ?? null,
    sessionId: claims?.sid ?? null,
    orgId: claims?.org_id ?? null,
    orgRole: claims?.org_role ?? null,
    isSignedIn: claims !== null,
    claims,
    has(condition: ProtectCondition = {}) {
      return hasFromClaims(claims, condition);
    },
    protect(condition: ProtectCondition = {}) {
      const outcome = evaluate(claims, condition);
      if (outcome.allowed) return;
      // signed_out → 401 (authenticate); everything else → 403 (authorized but
      // insufficient). This mirrors `@atlasauth/nextjs`'s protect()/ForbiddenError,
      // routed through h3 so Nitro returns the right status.
      throw createError({
        statusCode: outcome.reason === 'signed_out' ? 401 : 403,
        statusMessage: outcome.reason === 'signed_out' ? 'Unauthorized' : 'Forbidden',
        data: { reason: outcome.reason },
      });
    },
  };
}

/**
 * Verify whatever token a request carries and produce the `AtlasAuth` state.
 *
 * Mirrors `@atlasauth/backend`'s carrier rules: an `Authorization: Bearer` header
 * wins over the `__session` cookie, because a caller that set the header did so
 * deliberately. A token that fails verification yields the signed-out state —
 * never a throw — so a bad or expired token degrades to "not signed in" rather
 * than taking the whole request down (the Nitro peer of `@atlasauth/nextjs`'s
 * `resolveAuth`).
 */
export async function verifyCarriers(
  backend: AtlasBackend,
  carriers: { authorization?: string | null; sessionCookie?: string | null },
): Promise<AtlasAuth> {
  const header = carriers.authorization ?? undefined;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = bearer ?? carriers.sessionCookie ?? undefined;
  if (!token) return signedOut();

  const result = await backend.verify(token);
  if (!result.ok) return signedOut();

  return build(result.claims);
}
