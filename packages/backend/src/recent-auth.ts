/**
 * Step-up checks on a verified Atlas token. Session and template tokens carry
 * `auth_time` (the first-factor sign-in, or the last step-up), `amr` and `acr`
 * (`urn:atlas:acr:basic`, `urn:atlas:acr:mfa`, `urn:atlas:acr:step_up`).
 *
 *   const auth = await atlas.authenticateRequest(req);
 *   if (!auth.ok) return res.status(401).end();
 *   if (!authenticatedWithin(auth.claims, 300)) {
 *     // Ask the browser to step up (POST /v1/client/me/step_up) and retry.
 *     return res.status(401).json({ error: 'reauthentication_required', max_age: 300 });
 *   }
 */

/** Whether `auth_time` is within `maxAgeSeconds` of now. A token without `auth_time` never is. */
export function authenticatedWithin(claims: { auth_time?: unknown }, maxAgeSeconds: number, nowMs: number = Date.now()): boolean {
  const at = claims.auth_time;
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  return nowMs / 1000 - at <= maxAgeSeconds;
}

/** Whether the session proved a second factor (`acr` is mfa or step_up after an MFA method, or `amr` includes `mfa`). */
export function usedMultiFactor(claims: { acr?: unknown; amr?: unknown }): boolean {
  if (claims.acr === 'urn:atlas:acr:mfa') return true;
  return Array.isArray(claims.amr) && claims.amr.includes('mfa');
}
