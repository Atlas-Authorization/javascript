import { hasFromClaims, type AuthzClaims, type ProtectCondition } from '@atlasauth/authz';
import { decodeJwtPayload } from './compat';

/**
 * `has({ feature })`, `has({ plan })`, `has({ role })` … against a token you
 * already hold (the session token or an access token). The payload is decoded,
 * not verified: use it to show or hide UI, and verify on the server to enforce.
 */
export function hasToken(token: string | null | undefined, condition: ProtectCondition): boolean {
  const claims = token ? decodeJwtPayload(token) : null;
  return hasFromClaims(claims as AuthzClaims | null, condition);
}
