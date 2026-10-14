import { defineAction } from '../types';

export const description =
  'Enrich the profile/token with a plan tier looked up from a pre-provisioned secret map.';

/**
 * enrich-profile-from-secrets (post_login)
 *
 * The Auth0 "enrich from an external API" pattern, adapted to the Atlas sandbox.
 * Atlas Actions run with NO network (no `fetch`, no `require`), so instead of
 * calling an API at login time you pre-fetch the data and stash it in a secret —
 * here `PLAN_BY_DOMAIN`, a JSON object keyed by email domain. The action reads
 * that map, derives the user's plan, stamps it as an id-token claim, and merges
 * it into app metadata for later reads. Swap the source secret for whatever your
 * pipeline syncs (entitlements, region, account tier, …).
 */
export const action = defineAction('post_login', async (event, api) => {
  const ns = event.secrets.CLAIM_NAMESPACE || 'https://atlasauth.net';

  let plans: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(event.secrets.PLAN_BY_DOMAIN || '{}');
    if (parsed && typeof parsed === 'object') plans = parsed;
  } catch {
    // Malformed secret → fall back to the default plan rather than failing login.
  }

  const email = (event.user.email || '').toLowerCase();
  const at = email.lastIndexOf('@');
  const domain = at >= 0 ? email.slice(at + 1) : '';
  const plan = typeof plans[domain] === 'string' ? plans[domain] : 'free';

  api.idToken.setCustomClaim(`${ns}/plan`, plan);
  api.user.setAppMetadata('plan', plan);
});
