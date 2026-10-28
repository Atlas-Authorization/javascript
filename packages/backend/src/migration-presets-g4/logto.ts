import type { MigrationBridgePreset } from '../migration-presets';

/**
 * Logto. The tenant's OIDC issuer is `{endpoint}/oidc` (`https://auth.example.com/oidc`,
 * `https://abc123.logto.app/oidc` on Logto Cloud); its signing keys are at
 * `/oidc/jwks` and default to ES384. The token to exchange is the application's
 * ID token (`aud` = the Logto application id) — what `@logto/*` SDKs keep in
 * the app's own session. The SDKs store that session encrypted with the app's
 * cookie secret (or in the server's session store), so no cookie is named here:
 * hand the middleware a token extractor that opens the session locally, or send
 * the ID token as a bearer token from the client.
 */
export const LOGTO_BRIDGE_PRESETS: readonly MigrationBridgePreset[] = [
  {
    id: 'logto',
    label: 'Logto',
    mode: 'jwt',
    vars: {
      base_url: 'Your Logto endpoint (https://auth.example.com or https://abc123.logto.app)',
      client_id: 'The id of your Logto application (the audience of its ID tokens)',
    },
    jwt: {
      issuer: '{base_url}/oidc',
      keysUrl: '{base_url}/oidc/jwks',
      audience: ['{client_id}'],
      algorithms: ['ES384', 'ES256', 'RS256', 'PS256', 'EdDSA'],
      claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', sessionKey: 'sid' },
    },
    cookies: [],
    bearer: true,
    notes:
      'Exchange the ID token. Logto SDK sessions are encrypted with your cookie secret (or kept in your session store): pass the middleware a token extractor that reads the idToken from the session locally. API access tokens carry the API resource as their audience and are not accepted here.',
  },
];
