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

/**
 * Whether the session satisfies a "requires MFA" rule. The rule, in order:
 *
 * 1. `mfa_satisfied` — the server's own verdict, final whenever the token carries it
 *    (true or false). Tokens minted before the claim existed fall back to:
 * 2. `mfa === true` (a second factor was verified at sign-in),
 * 3. or {@link usedMultiFactor} (`acr` is `urn:atlas:acr:mfa`, or `amr` includes `mfa`),
 * 4. or `sso_connection_id` is a string (an enterprise SSO sign-in: the identity
 *    provider owns the second factor).
 */
export function mfaSatisfied(claims: {
  mfa_satisfied?: unknown;
  mfa?: unknown;
  acr?: unknown;
  amr?: unknown;
  sso_connection_id?: unknown;
}): boolean {
  if (typeof claims.mfa_satisfied === 'boolean') return claims.mfa_satisfied;
  return claims.mfa === true || usedMultiFactor(claims) || typeof claims.sso_connection_id === 'string';
}

/**
 * Whether the session meets the active organization's MFA policy (`requireMfa`,
 * `mfaMaxAgeSeconds`, `allowedMfaFactors`): true when the organization does not
 * require MFA, or the token says `org_mfa_ok`. The organization's policy only
 * withholds org claims from the token; it does NOT stop a request that never
 * reads them, so an app that authorizes from its own tables must call this
 * itself. The claims describe the ACTIVE organization only: pass the
 * organization you are authorizing for (its Atlas id or external id) and a token
 * whose active organization is another one answers false.
 */
export function mfaOrgSatisfied(
  claims: { org_id?: unknown; org_external_id?: unknown; org_mfa_required?: unknown; org_mfa_ok?: unknown },
  orgIdOrExternalId?: string,
): boolean {
  const required = claims.org_mfa_required === true;
  if (orgIdOrExternalId === undefined) return !required || claims.org_mfa_ok === true;
  const matches = claims.org_id === orgIdOrExternalId || claims.org_external_id === orgIdOrExternalId;
  // Withheld claims carry no org_id: the MFA fields are then all the token says.
  if (required) return claims.org_mfa_ok === true && (matches || claims.org_id === undefined);
  return matches;
}
