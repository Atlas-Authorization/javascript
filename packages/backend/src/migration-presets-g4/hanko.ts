import type { MigrationBridgePreset } from '../migration-presets';

/**
 * Hanko. The backend signs a session JWT (RS256, a rotating key set at
 * `/.well-known/jwks.json` on the public API) and writes it to the `hanko`
 * cookie (`cookie.name`); the frontend SDK and hanko-elements read the same
 * token. Claims: `sub` (the user's id — what the export keys users by),
 * `session_id`, `exp`, `iat`, `aud`, `iss` (when `session.issuer` is set) and
 * `email` / `username`. `email` is an object (`address`, `is_primary`,
 * `is_verified`), so it is not mapped to a claim; the imported user already
 * holds the addresses.
 */
export const HANKO_BRIDGE_PRESETS: readonly MigrationBridgePreset[] = [
  {
    id: 'hanko',
    label: 'Hanko (session JWT, issuer = the API URL)',
    mode: 'jwt',
    vars: { base_url: 'The Hanko API URL (https://<project id>.hanko.io, or your own https://hanko.example.com)' },
    jwt: {
      issuer: '{base_url}',
      keysUrl: '{base_url}/.well-known/jwks.json',
      algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256'],
      claims: { subject: 'sub', sessionKey: 'session_id' },
    },
    cookies: ['hanko'],
    bearer: true,
    sharesAtlasCookie: false,
    notes:
      'Hanko Cloud sets iss to the project URL. Self-hosted: use hanko_jwt when session.issuer is something else. The cookie is named by cookie.name in Hanko\'s config (default hanko).',
  },
  {
    id: 'hanko_jwt',
    label: 'Hanko (session JWT, custom issuer)',
    mode: 'jwt',
    vars: { base_url: 'The Hanko API URL (keys are read from /.well-known/jwks.json)', issuer: "The session.issuer you configured (the token's iss)" },
    jwt: {
      issuer: '{issuer}',
      keysUrl: '{base_url}/.well-known/jwks.json',
      algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256'],
      claims: { subject: 'sub', sessionKey: 'session_id' },
    },
    cookies: ['hanko'],
    bearer: true,
  },
];
