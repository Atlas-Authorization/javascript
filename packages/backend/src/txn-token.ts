import { createRemoteJWKSet, createLocalJWKSet, jwtVerify, type JWK } from 'jose';

/**
 * Verify a Transaction Token (draft-ietf-oauth-transaction-tokens-11) a service received: `typ txntoken+jwt`, signed
 * by the issuer's keys, for THIS trust domain, unexpired, with the required claims. Recipients must refuse a token
 * whose `aud` is not their own trust domain.
 */
export interface TxnTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  txn: string;
  scope: string;
  req_wl: string;
  tctx?: Record<string, unknown>;
  rctx?: Record<string, unknown>;
  [claim: string]: unknown;
}

export type TxnTokenResult = { ok: true; claims: TxnTokenClaims; scopes: string[] } | { ok: false; error: string };

export async function verifyTransactionToken(
  token: string,
  opts: { issuer: string; trustDomain: string; jwks?: { keys: JWK[] }; jwksUrl?: string; now?: Date },
): Promise<TxnTokenResult> {
  const issuer = opts.issuer.replace(/\/+$/, '');
  const keys = opts.jwks
    ? createLocalJWKSet(opts.jwks)
    : createRemoteJWKSet(new URL(opts.jwksUrl ?? `${issuer}/.well-known/jwks.json`));
  try {
    const { payload, protectedHeader } = await jwtVerify(token, keys, {
      issuer,
      audience: opts.trustDomain,
      typ: 'txntoken+jwt',
      clockTolerance: 5,
      currentDate: opts.now,
    });
    void protectedHeader;
    for (const c of ['txn', 'sub', 'scope', 'req_wl', 'iat', 'exp'] as const) {
      if (payload[c] === undefined) return { ok: false, error: `The transaction token has no ${c}.` };
    }
    const claims = payload as unknown as TxnTokenClaims;
    return { ok: true, claims, scopes: claims.scope.split(' ').filter(Boolean) };
  } catch {
    return { ok: false, error: 'The transaction token is invalid, expired, or for another trust domain.' };
  }
}
