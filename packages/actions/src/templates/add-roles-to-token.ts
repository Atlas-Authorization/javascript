import { defineAction } from '../types';

export const description =
  "Copy the user's roles from metadata into namespaced id- and access-token claims.";

/**
 * add-roles-to-token (post_login)
 *
 * Surface the roles stored on `user.metadata.roles` as a custom claim on every
 * minted token, so your API and frontend can authorize without a second lookup.
 * Claims are namespaced (configurable via the `CLAIM_NAMESPACE` secret) to avoid
 * colliding with standard OIDC claims — the same convention Auth0 recommends.
 */
export const action = defineAction('post_login', async (event, api) => {
  const ns = event.secrets.CLAIM_NAMESPACE || 'https://atlasauth.net';
  const meta = event.user.metadata || {};
  const roles = Array.isArray(meta.roles) ? meta.roles : [];

  api.idToken.setCustomClaim(`${ns}/roles`, roles);
  api.accessToken.setCustomClaim(`${ns}/roles`, roles);
});
