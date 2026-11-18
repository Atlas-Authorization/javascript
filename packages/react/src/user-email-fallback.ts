import type { AtlasUser } from './types';

/**
 * A Frontend API older than 2026-11-17 sends the `/v1/client` user without `email_addresses`, while the
 * session token's `email` claim is always there. When the user has no list, build a one-entry list from
 * the claims so `useUser().user` shows the sign-in address. A list the server did send is never replaced.
 */
export function withClaimEmail(
  user: AtlasUser | null,
  sessionClaims: object | null,
): AtlasUser | null {
  const claims = sessionClaims as { email?: unknown; email_verified?: unknown } | null;
  if (!user || user.email_addresses?.length) return user;
  const email = typeof claims?.email === 'string' && claims.email !== '' ? claims.email : undefined;
  if (!email) return user;
  return { ...user, email_addresses: [{ id: '', email_address: email, verified: claims?.email_verified === true, primary: true }] };
}
