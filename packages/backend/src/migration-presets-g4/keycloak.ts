import type { MigrationBridgePreset } from '../migration-presets';

/**
 * Keycloak. Its browser adapter (keycloak-js) keeps the access / ID / refresh
 * tokens in memory, and server adapters (keycloak-connect, NextAuth's Keycloak
 * provider) keep them server-side or inside an encrypted cookie, so the token
 * an integrator can hand the bridge is the access or ID token itself (Bearer
 * header or the `exchangeMigrationBrowserSession` browser helper). The
 * `KEYCLOAK_IDENTITY` cookie is signed with the realm's own HMAC secret and is
 * never accepted.
 *
 * Access tokens live five minutes by default and nobody refreshes them after
 * the switch, so a validly signed token is accepted (once) for a week past `exp`.
 * Keycloak 16 and older serve under `/auth`: pass `base_url` as
 * `https://sso.example.com/auth`.
 */
export const KEYCLOAK_BRIDGE_PRESETS: readonly MigrationBridgePreset[] = [
  {
    id: 'keycloak',
    label: 'Keycloak (access or ID token)',
    mode: 'jwt',
    vars: { base_url: 'Keycloak base URL (https://sso.example.com; add /auth for Keycloak 16 and older)', realm: 'Realm name' },
    jwt: {
      issuer: '{base_url}/realms/{realm}',
      keysUrl: '{base_url}/realms/{realm}/protocol/openid-connect/certs',
      algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384'],
      // sub = the Keycloak user id (what the realm export keys users by); sid = the SSO session id.
      claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', sessionKey: 'sid', mfa: 'acr:2' },
      expiredGraceSeconds: 7 * 24 * 3600,
    },
    cookies: [],
    bearer: true,
    notes:
      'Use the access token or the ID token (both carry sub, email, sid). Realm keys must publish a signing algorithm from the list (the default RS256 does; HS512 keys are never accepted). A step-up login raises the acr claim to 2 when you map levels of authentication to "2"; otherwise an MFA sign-in is not marked.',
  },
];
