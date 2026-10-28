import type { MigrationBridgePreset } from '../migration-presets';

/**
 * authentik. An application's OAuth2/OpenID provider signs its ID and access
 * tokens with the signing key chosen on the provider (RS256 / ES256). The
 * issuer is per provider and ends in a slash — `iss` is compared as a string,
 * so the template restores the slash the variable resolver trims:
 *   https://auth.example.com/application/o/<application slug>/
 * with the keys at `<issuer>jwks/`.
 *
 * `sub` depends on the provider's "Subject mode" (hashed user id by default);
 * the export keys users by the same mode, so the two agree. `sid` is authentik's
 * session id (a hash), shared by every token of one sign-in.
 */
export const AUTHENTIK_BRIDGE_PRESETS: readonly MigrationBridgePreset[] = [
  {
    id: 'authentik',
    label: 'authentik (OAuth2 / OpenID provider tokens)',
    mode: 'jwt',
    vars: { issuer: "The provider's issuer URL without the trailing slash (https://auth.example.com/application/o/<application slug>)", client_id: "The provider's client id (the tokens' aud)" },
    jwt: {
      issuer: '{issuer}/',
      keysUrl: '{issuer}/jwks/',
      audience: ['{client_id}'],
      // A provider without a signing key signs HS256 with its client secret: no public keys exist for it.
      algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384'],
      claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', sessionKey: 'sid', mfa: 'amr:mfa' },
    },
    // authentik is the identity provider, not the app: the app's own OIDC client library keeps the token
    // (next-auth, passport-openidconnect, oauth2-proxy). Pass it as a bearer token or from your own extractor.
    cookies: [],
    bearer: true,
    notes:
      'Set the provider\'s Subject mode to the one the export used (hashed user id by default; the export records it). The provider needs a signing key: tokens signed with the client secret (HS256) cannot be verified from public keys. With the "global" issuer mode, point the preset at the per-provider URL anyway: the keys are served there.',
  },
];
