import type { RequestFn } from './request';

/**
 * §7.7 authoritative token verification. Backend SDKs verify session JWTs
 * locally against JWKS — fast, offline, and correct within the 60-second token
 * lifetime, but blind to a revocation. This endpoint is for the requests where
 * "signed out a moment ago" has to mean now: it checks the revocation set and,
 * when the cache cannot answer, falls through to the database.
 *
 * One failure is reported as `verified: false` with a coarse `reason`; telling a
 * caller which check failed would help a forger more than a developer.
 */

export interface VerifyTokenBody {
  token: string;
  /** Expected `azp` values, if the token carries an authorized-party claim. */
  authorized_parties?: string[];
}

export interface TokenVerificationFailure {
  object: 'token_verification';
  verified: false;
  reason: 'invalid' | 'revoked';
}

export interface TokenVerificationSuccess {
  object: 'token_verification';
  verified: true;
  user_id: string;
  session_id: string;
  organization_id: string | null;
  organization_role: string | null;
  organization_permissions: string[];
  mfa: boolean;
  /** True when the cache could not answer and the database was consulted. */
  checked_authoritatively: boolean;
}

export type TokenVerification = TokenVerificationSuccess | TokenVerificationFailure;

export function tokensResource(request: RequestFn) {
  return {
    verify(body: VerifyTokenBody): Promise<TokenVerification> {
      return request({ method: 'POST', path: '/v1/tokens/verify', body });
    },
  };
}
