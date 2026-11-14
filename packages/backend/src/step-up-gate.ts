import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWK } from 'jose';
import type { StepUpAssertBody, StepUpAssertion } from './client/step-up';
import { sessionTokenFromHeaders } from './request-auth';

/**
 * Named step-up policies on your own API.
 *
 * `requireStepUp({ client, policy })` is the neutral check the framework adapters wrap (`atlasStepUp` in
 * `@atlasauth/express`, `@atlasauth/fastify`, `@atlasauth/hono`, `@atlasauth/koa`, `@atlasauth/nextjs`,
 * `@atlasauth/nestjs`). It reads the session token off the request, asks Atlas whether that session meets the policy
 * right now (`client.stepUp.assert`), and either lets the request through with the assertion, or answers 403
 * STEP_UP_REQUIRED carrying the policy name and the factors to ask for, which is what `withStepUp(policy, fn)` in
 * `@atlasauth/js` reacts to. A call that fails (network, 5xx) throws: it is never an allow.
 *
 * It costs one Backend API call per guarded request. For a downstream service, pass the receipt on and verify it
 * offline with {@link verifyStepUpReceipt}.
 */

export interface StepUpGateClient {
  stepUp: { assert(body: StepUpAssertBody): Promise<StepUpAssertion> };
}

export interface RequireStepUpOptions {
  client: StepUpGateClient;
  /** The policy name. */
  policy: string;
  /** Stamped as the receipt `aud`, so a receipt cannot be replayed at another service. */
  audience?: string;
  /** A shorter receipt lifetime than the policy's (10 to 300 seconds). */
  receiptTtlSeconds?: number;
  authorizedParties?: string[];
  /** Where the token is when it is not the bearer header or the `__session` cookie. */
  tokenFrom?: (req: StepUpRequest) => string | null | undefined;
}

export interface StepUpRequest {
  headers: Record<string, string | string[] | undefined>;
  claims?: unknown;
}

export type StepUpOutcome =
  | { allowed: true; assertion: StepUpAssertion & { allowed: true; receipt: string } }
  | { allowed: false; status: 401 | 403; body: { errors: Array<{ code: string; message: string; meta?: Record<string, unknown> }> } };

export function requireStepUp(opts: RequireStepUpOptions): (req: StepUpRequest) => Promise<StepUpOutcome> {
  return async (req) => {
    const token = opts.tokenFrom?.(req) ?? sessionTokenFromHeaders(req.headers);
    if (!token) return { allowed: false, status: 401, body: { errors: [{ code: 'UNAUTHENTICATED', message: 'Sign in to continue.' }] } };
    const assertion = await opts.client.stepUp.assert({
      token,
      policy: opts.policy,
      ...(opts.audience ? { audience: opts.audience } : {}),
      ...(opts.receiptTtlSeconds ? { receipt_ttl_seconds: opts.receiptTtlSeconds } : {}),
      ...(opts.authorizedParties ? { authorized_parties: opts.authorizedParties } : {}),
    });
    if (assertion.allowed && assertion.receipt) return { allowed: true, assertion: assertion as StepUpAssertion & { allowed: true; receipt: string } };
    if (assertion.reason === 'invalid_token' || assertion.reason === 'session_inactive') {
      return { allowed: false, status: 401, body: { errors: [{ code: 'UNAUTHENTICATED', message: 'Sign in to continue.' }] } };
    }
    return {
      allowed: false,
      status: 403,
      body: {
        errors: [
          {
            code: 'STEP_UP_REQUIRED',
            message: 'This action requires a recent re-authentication. Re-authenticate and try again.',
            meta: { ...(assertion.step_up ?? { action: 'policy', policy: opts.policy }), policy: opts.policy },
          },
        ],
      },
    };
  };
}

export interface StepUpReceiptClaims {
  iss: string;
  sub: string;
  sid: string;
  jti: string;
  policy: string;
  auth_time: number;
  amr: string[];
  acr: string;
  iat: number;
  exp: number;
  aud?: string | string[];
  [claim: string]: unknown;
}

export type StepUpReceiptResult = { ok: true; claims: StepUpReceiptClaims } | { ok: false; error: string };

/**
 * Verify a step-up receipt offline: signed by the instance's keys (JWKS), `typ step-up-receipt+jwt`, not expired,
 * and, when you say so, for this policy, this audience, this user or session. Keep a seen-`jti` set if a receipt must
 * authorize exactly one action.
 */
export async function verifyStepUpReceipt(
  receipt: string,
  opts: { issuer: string; jwks?: { keys: JWK[] }; jwksUrl?: string; policy?: string; audience?: string; userId?: string; sessionId?: string; now?: Date },
): Promise<StepUpReceiptResult> {
  const issuer = opts.issuer.replace(/\/+$/, '');
  const keys = opts.jwks ? createLocalJWKSet(opts.jwks) : createRemoteJWKSet(new URL(opts.jwksUrl ?? `${issuer}/.well-known/jwks.json`));
  try {
    const { payload } = await jwtVerify(receipt, keys, {
      issuer,
      ...(opts.audience ? { audience: opts.audience } : {}),
      typ: 'step-up-receipt+jwt',
      clockTolerance: 5,
      currentDate: opts.now,
    });
    const claims = payload as unknown as StepUpReceiptClaims;
    if (claims.token_use !== 'step_up_receipt') return { ok: false, error: 'This is not a step-up receipt.' };
    for (const c of ['sub', 'sid', 'jti', 'policy', 'auth_time', 'acr'] as const) {
      if (claims[c] === undefined) return { ok: false, error: `The step-up receipt has no ${c}.` };
    }
    if (opts.policy && claims.policy !== opts.policy) return { ok: false, error: 'The step-up receipt is for another policy.' };
    if (opts.userId && claims.sub !== opts.userId) return { ok: false, error: 'The step-up receipt is for another user.' };
    if (opts.sessionId && claims.sid !== opts.sessionId) return { ok: false, error: 'The step-up receipt is for another session.' };
    return { ok: true, claims };
  } catch {
    return { ok: false, error: 'The step-up receipt is invalid, expired, or for another audience.' };
  }
}
