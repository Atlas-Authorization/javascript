import type { MigrationBridgePreset } from '../migration-presets';

/**
 * ZITADEL bridge preset (ZITADEL Cloud, self-hosted, custom domains). ZITADEL
 * signs ID tokens, and access tokens of applications set to the JWT token
 * type, with RS256 keys it publishes at `{issuer}/oauth/v2/keys`. The `iss` is
 * the instance URL (`https://<instance>.zitadel.cloud`, or your custom domain
 * exactly as users reach it), `sub` the ZITADEL user id, `sid` the session id.
 * `amr` lists `mfa` after a second factor.
 *
 * Opaque access tokens (ZITADEL's default for new applications) cannot be
 * verified offline: exchange the ID token, or switch the application's access
 * token type to JWT.
 */

const WEEK = 7 * 24 * 3600;

export const ZITADEL_BRIDGE_PRESETS: readonly MigrationBridgePreset[] = [
  {
    id: 'zitadel',
    label: 'ZITADEL (ID tokens and JWT access tokens)',
    mode: 'jwt',
    vars: { issuer: 'Your ZITADEL URL, exactly as the iss claim has it (https://<instance>.zitadel.cloud, or your custom domain)' },
    jwt: {
      issuer: '{issuer}',
      keysUrl: '{issuer}/oauth/v2/keys',
      algorithms: ['RS256', 'RS384', 'RS512', 'ES256'],
      claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', sessionKey: 'sid', mfa: 'amr:mfa' },
      // Tokens live hours and the OIDC client that refreshed them is gone after the switch.
      expiredGraceSeconds: WEEK,
    },
    cookies: [],
    bearer: true,
    notes:
      'Send the ID token (or a JWT access token) as an Authorization: Bearer header. Browser OIDC clients (oidc-client-ts, react-oidc-context) keep tokens in browser storage, so the browser has to send one request with it before they are cleared; server sessions (Auth.js, express-session) hold the ID token you can pass to the middleware with extractToken. Application access tokens are opaque unless the application is set to the JWT token type.',
  },
];
