import { defineAction } from '../types';

export const description =
  'Gate sign-in to known networks by IP prefix (the geo/network-based access control).';

/**
 * restrict-signin-by-ip (post_login)
 *
 * The network-based access-control template. Auth0's canonical example here is
 * "geo-based MFA", but Atlas's Actions api does not (yet) expose an MFA step-up
 * trigger or a geo-IP database, so the faithful control with the primitives
 * available is an IP allowlist: the action denies a sign-in whose source IP is
 * not on an approved network. Configure `ALLOWED_IP_PREFIXES` as a
 * comma-separated list of leading octets / prefixes, e.g.
 * `10.,192.168.,203.0.113.`. Unset → allow all (the control is opt-in).
 *
 * When Atlas adds an MFA step-up api, this is the hook that would call it
 * instead of denying outright.
 */
export const action = defineAction('post_login', async (event, api) => {
  const prefixes = (event.secrets.ALLOWED_IP_PREFIXES || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (prefixes.length === 0) return;

  const ip = event.request.ip || '';
  const allowed = prefixes.some((p) => ip.startsWith(p));
  if (!allowed) {
    api.access.deny('Sign-in is not permitted from this network.');
  }
});
