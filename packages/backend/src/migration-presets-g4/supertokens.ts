import type { MigrationBridgePreset } from '../migration-presets';

/**
 * SuperTokens. The session's access token is a JWT signed with the core's
 * dynamic keys; the backend SDK serves their public half at
 * `{api_domain}{api_base_path}/jwt/jwks.json` (the core also at
 * `/.well-known/jwks.json`) and stamps `iss` with `{api_domain}{api_base_path}`.
 * The `sub` is the SuperTokens user id (what the export imports as the source
 * id), `sessionHandle` identifies the session, so every token of one old
 * session exchanges once. The access token lives an hour and is refreshed by
 * the SuperTokens frontend SDK, which stops running after the switch: a token
 * up to a week past `exp` is still accepted (each exchanges once).
 */
export const SUPERTOKENS_BRIDGE_PRESETS: readonly MigrationBridgePreset[] = [
  {
    id: 'supertokens',
    label: 'SuperTokens',
    mode: 'jwt',
    vars: { base_url: 'Your SuperTokens API domain (https://api.example.com), the apiDomain of your backend config' },
    defaults: { api_base_path: 'auth' },
    jwt: {
      issuer: '{base_url}/{api_base_path}',
      keysUrl: '{base_url}/{api_base_path}/jwt/jwks.json',
      algorithms: ['RS256'],
      claims: { subject: 'sub', sessionKey: 'sessionHandle' },
      expiredGraceSeconds: 7 * 24 * 3600,
    },
    cookies: ['sAccessToken'],
    clearCookies: ['sAccessToken', 'sRefreshToken', 'sIdRefreshToken', 'sFrontToken'],
    bearer: true,
    notes:
      'Pass api_base_path (your apiBasePath without slashes, default auth) when you changed it. With header-based sessions send the access token as `Authorization: Bearer`. SuperTokens access tokens carry no email: the user is matched by the imported SuperTokens user id, so import users first.',
  },
];
