import type { MigrationBridgePreset } from '../migration-presets';

/**
 * Ory Kratos bridge presets. A Kratos session is opaque: the token (or the
 * cookie that wraps it, sealed with `secrets.cookie`) says nothing offline. So
 * there are two ways to recognise one:
 *
 *   - `ory` (session_table): the session tokens (`ory_st_…`, the
 *     `X-Session-Token` / bearer value API-flow clients hold) imported from a
 *     database export, looked up by sha256. Self-hosted only; Ory Network has no
 *     database access.
 *   - `ory_whoami` / `ory_whoami_token` (remote): Atlas asks Kratos itself,
 *     `GET /sessions/whoami`, with the cookie (or the session token) the browser
 *     presented. Works on self-hosted Kratos and Ory Network, needs Kratos
 *     running (and reachable from Atlas) for the bridge window, and needs no
 *     export. The identity id in the answer is the user id the export keyed by.
 *
 * Kratos answers 401 for an unknown / expired session and 403
 * (`session_aal2_required`) when a second factor is still owed: both are
 * refusals, so a half-authenticated session never becomes an Atlas session.
 * The remote preset reads the session's own identity: `identity.id`,
 * `identity.traits.email` (the common schema; others rely on the imported
 * user's email) and the first verifiable address.
 */

const WHOAMI_NOTES =
  'Kratos stays up for the bridge window: Atlas calls its /sessions/whoami with the presented session. Point base_url at the public URL (https://<slug>.projects.oryapis.com on Ory Network). A session that still owes a second factor (aal2) is refused.';

const IDENTITY = {
  subjectPath: 'identity.id',
  emailPath: 'identity.traits.email',
  emailVerifiedPath: 'identity.verifiable_addresses.0.verified',
  namePath: 'identity.traits.name',
};

export const ORY_BRIDGE_PRESETS: readonly MigrationBridgePreset[] = [
  {
    id: 'ory',
    label: 'Ory Kratos (session tokens imported from the database)',
    mode: 'session_table',
    // The browser cookie is sealed with Kratos' cookie secret and cannot be hashed
    // to a stored token: only the raw session token (ory_st_…) matches.
    cookies: [],
    bearer: true,
    notes:
      'Matches the session tokens (ory_st_…) from a database export: API-flow clients (native apps, SPAs holding the token) send them as a bearer token. Browser cookies are sealed with Kratos\' cookie secret, so cookie sessions use the ory_whoami preset. If your app keeps the token in a cookie of its own, pass that name as cookieNames to the middleware.',
  },
  {
    id: 'ory_whoami',
    label: 'Ory Kratos (session cookie, checked with Kratos)',
    mode: 'remote',
    vars: {
      base_url: 'Kratos public URL (https://auth.example.com, or https://<project slug>.projects.oryapis.com)',
      cookie_name: 'The session cookie name (ory_kratos_session; ory_session_<project slug> on Ory Network)',
    },
    remote: { url: '{base_url}/sessions/whoami', method: 'GET', headers: { cookie: '{cookie_name}={token}' }, ...IDENTITY },
    cookies: ['ory_kratos_session', 'ory_session_*'],
    notes: `${WHOAMI_NOTES} The cookie must reach your app: serve it on a domain your app shares (Ory Network custom domain or Kratos behind your domain).`,
  },
  {
    id: 'ory_whoami_token',
    label: 'Ory Kratos (session token, checked with Kratos)',
    mode: 'remote',
    vars: { base_url: 'Kratos public URL (https://auth.example.com, or https://<project slug>.projects.oryapis.com)' },
    remote: { url: '{base_url}/sessions/whoami', method: 'GET', headers: { 'x-session-token': '{token}' }, ...IDENTITY },
    cookies: [],
    bearer: true,
    notes: WHOAMI_NOTES,
  },
];
