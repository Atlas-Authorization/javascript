import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { CSRF_AUDIENCE, submittedMatchingCookie, type CsrfRequest } from './csrf';
import { ATLAS_SIGNING_ALGS } from './algs';
import type { Jwks } from './jwks-cache';

export interface CsrfJwsOptions {
  /** The session id (`sid` of the verified session token). */
  sid: string;
  /** Expected `iss`: your instance's issuer. */
  issuer: string;
  /** The instance key set (what `AtlasBackend` already fetches), or a function that returns it. */
  jwks: Jwks | ((kid?: string) => Promise<Jwks | null>);
  now?: () => number;
}

/**
 * Whether `token` is a CSRF token Atlas minted for session `sid`: signed by the instance key, the right type and
 * audience, not expired. No shared secret: the signature checks against the JWKS you already verify sessions with.
 */
export async function checkCsrfJws(token: string | null | undefined, options: CsrfJwsOptions): Promise<boolean> {
  if (typeof options.sid !== 'string' || options.sid === '') throw new TypeError('csrf: sid is required');
  if (typeof token !== 'string' || token.split('.').length !== 3) return false;
  try {
    const keys = typeof options.jwks === 'function' ? await options.jwks(decodeProtectedHeader(token).kid) : options.jwks;
    if (!keys || keys.keys.length === 0) return false;
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(keys as never), {
      algorithms: ATLAS_SIGNING_ALGS,
      issuer: options.issuer,
      audience: CSRF_AUDIENCE,
      typ: 'csrf+jwt',
      clockTolerance: 5,
      currentDate: options.now ? new Date(options.now()) : undefined,
    });
    return protectedHeader.typ === 'csrf+jwt' && payload.token_use === 'csrf' && payload.sid === options.sid;
  } catch {
    return false;
  }
}

/**
 * Verify a state-changing request with Atlas's CSRF cookie (`session.csrfCookie`): the submitted token (header
 * `x-atlas-csrf`, else the `atlas_csrf` form field) must equal the `__atlas_csrf` cookie AND be a token Atlas signed
 * for this session. Reads a form body from a clone, so your handler can still read it.
 */
export async function verifyCsrfJws(request: CsrfRequest, options: CsrfJwsOptions): Promise<boolean> {
  const submitted = await submittedMatchingCookie(request);
  return submitted !== null && checkCsrfJws(submitted, options);
}
