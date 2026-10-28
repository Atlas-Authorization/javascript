import type { MigrationBridgePreset } from './migration-presets';

/**
 * Bridge presets for Firebase / Identity Platform, Supabase, Amazon Cognito,
 * Azure AD B2C, Entra External ID, Appwrite, PocketBase and Nhost, checked against each vendor's
 * token documentation. Registered (replacing the starters) at the end of
 * migration-presets.ts; only a type is imported from there, so there is no
 * import cycle at runtime.
 *
 * A vendor whose browser SDK keeps the session in localStorage / IndexedDB
 * (Firebase, Amplify, MSAL, Supabase SPA, Nhost) has no cookie for a server
 * middleware to read: the browser helpers in `@atlasauth/js`
 * (`exchangeMigrationBrowserSession` with the vendor readers) pick the token up
 * there and call the Frontend API exchange.
 */

/** Short-lived vendor tokens nobody refreshes after the switch: accept them (once) for a week past `exp`. */
const WEEK = 7 * 24 * 3600;

export const G3_BRIDGE_PRESETS: readonly MigrationBridgePreset[] = [
  {
    id: 'firebase',
    label: 'Firebase Authentication / Identity Platform (ID tokens)',
    mode: 'jwt',
    vars: { project_id: 'Firebase / Google Cloud project id' },
    jwt: {
      issuer: 'https://securetoken.google.com/{project_id}',
      keysUrl: 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
      audience: ['{project_id}'],
      algorithms: ['RS256'],
      // `sub` and `user_id` both carry the uid. Firebase ID tokens have no jti:
      // the whole token is spent in the single-use ledger.
      claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name' },
      // ID tokens live an hour and the Firebase SDK refreshes them; after the switch nothing does.
      expiredGraceSeconds: WEEK,
    },
    // Firebase keeps sessions in IndexedDB; `__session` is the cookie apps behind
    // Firebase Hosting conventionally copy the ID token into.
    cookies: ['__session'],
    sharesAtlasCookie: true,
    bearer: true,
    notes:
      'Identity Platform tenants sign with the same issuer (the tenant is the firebase.tenant claim); export each tenant into its own organization. Browser sessions (IndexedDB) are exchanged with readFirebaseBrowserSession from @atlasauth/js.',
  },
  {
    id: 'firebase_session_cookie',
    label: 'Firebase session cookies (Admin SDK createSessionCookie)',
    mode: 'jwt',
    vars: { project_id: 'Firebase / Google Cloud project id' },
    defaults: { cookie_name: 'session' },
    jwt: {
      issuer: 'https://session.firebase.google.com/{project_id}',
      keysUrl: 'https://www.googleapis.com/identitytoolkit/v3/relyingparty/publicKeys',
      keysFormat: 'x509',
      audience: ['{project_id}'],
      algorithms: ['RS256'],
      claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name' },
    },
    cookies: ['{cookie_name}', '__session'],
    sharesAtlasCookie: true,
    notes: 'Session cookies live up to two weeks and verify against the x509 key map; set cookie_name when your app named it something else.',
  },
  {
    id: 'supabase',
    label: 'Supabase Auth (hosted)',
    mode: 'jwt',
    vars: { project_ref: 'Project ref (the subdomain of <ref>.supabase.co)' },
    jwt: {
      issuer: 'https://{project_ref}.supabase.co/auth/v1',
      keysUrl: 'https://{project_ref}.supabase.co/auth/v1/.well-known/jwks.json',
      audience: ['authenticated'],
      // ES256/RS256 with the new signing keys; HS256 with the legacy JWT secret (stored in the bridge settings).
      algorithms: ['ES256', 'RS256', 'HS256'],
      // `amr` is a list of { method, timestamp } objects and `aal` a level, so
      // the second factor is not mapped: Atlas applies its own MFA policy.
      claims: { subject: 'sub', email: 'email', sessionKey: 'session_id' },
      expiredGraceSeconds: WEEK,
      allowSharedSecret: true,
    },
    cookies: ['sb-{project_ref}-auth-token'],
    tokenFormat: 'supabase',
    clearCookies: ['sb-{project_ref}-auth-token', 'sb-{project_ref}-auth-token.*', 'sb-{project_ref}-auth-token-code-verifier'],
    bearer: true,
    notes: 'Anonymous users (is_anonymous) are refused like any user the import did not create.',
  },
  {
    id: 'supabase_refresh_token',
    label: 'Supabase Auth (refresh tokens from a dump)',
    mode: 'session_table',
    vars: { project_ref: 'Project ref (the subdomain of <ref>.supabase.co)' },
    // The export keys each live auth.refresh_tokens row by sha256(token): the
    // refresh token in the SSR cookie finds it however long the user was away
    // (the supabase JWT preset covers access tokens up to a week past expiry).
    cookies: ['sb-{project_ref}-auth-token'],
    tokenFormat: 'supabase_refresh',
    clearCookies: ['sb-{project_ref}-auth-token', 'sb-{project_ref}-auth-token.*', 'sb-{project_ref}-auth-token-code-verifier'],
    notes: 'Needs a dump of auth.refresh_tokens taken close to cutover. Refresh tokens Supabase issued after the dump are not known: keep the supabase preset for those, or re-import.',
  },
  {
    id: 'supabase_self_hosted',
    label: 'Supabase Auth (self-hosted or custom domain)',
    mode: 'jwt',
    vars: { auth_url: 'The Auth URL (https://db.example.com/auth/v1)', cookie_name: 'The SSR cookie name (sb-<first label of the host>-auth-token)' },
    jwt: {
      issuer: '{auth_url}',
      keysUrl: '{auth_url}/.well-known/jwks.json',
      audience: ['authenticated'],
      algorithms: ['ES256', 'RS256', 'HS256'],
      claims: { subject: 'sub', email: 'email', sessionKey: 'session_id' },
      expiredGraceSeconds: WEEK,
      allowSharedSecret: true,
    },
    cookies: ['{cookie_name}'],
    tokenFormat: 'supabase',
    clearCookies: ['{cookie_name}', '{cookie_name}.*'],
    bearer: true,
  },
  {
    id: 'cognito',
    label: 'Amazon Cognito (ID tokens)',
    mode: 'jwt',
    vars: { region: 'AWS region (us-east-1)', user_pool_id: 'User pool id (us-east-1_AbCdEf)', client_id: 'App client id' },
    jwt: {
      issuer: 'https://cognito-idp.{region}.amazonaws.com/{user_pool_id}',
      keysUrl: 'https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json',
      // ID tokens carry aud = the app client id (access tokens carry client_id and no aud).
      audience: ['{client_id}'],
      algorithms: ['RS256'],
      claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', sessionKey: 'origin_jti' },
      // ID tokens live an hour by default; Amplify refreshed them.
      expiredGraceSeconds: WEEK,
    },
    // @aws-amplify/adapter-nextjs keeps the tokens in cookies named like Amplify's localStorage keys.
    cookies: ['CognitoIdentityServiceProvider.{client_id}.*.idToken'],
    clearCookies: ['CognitoIdentityServiceProvider.{client_id}.*'],
    bearer: true,
    notes: 'Users are matched on sub (the export keys users by sub). SPA sessions in localStorage are exchanged with readAmplifyBrowserSession from @atlasauth/js.',
  },
  {
    id: 'azure_ad_b2c',
    label: 'Azure AD B2C (ID tokens)',
    mode: 'jwt',
    vars: {
      tenant: 'Tenant name (contoso for contoso.b2clogin.com)',
      tenant_id: 'Directory (tenant) id GUID',
      policy: 'The user flow / custom policy that issued the tokens (B2C_1_signupsignin)',
      client_id: 'Application (client) id',
    },
    jwt: {
      issuer: 'https://{tenant}.b2clogin.com/{tenant_id}/v2.0/',
      keysUrl: 'https://{tenant}.b2clogin.com/{tenant}.onmicrosoft.com/{policy}/discovery/v2.0/keys',
      audience: ['{client_id}'],
      algorithms: ['RS256'],
      // B2C's sub is the user's object id by default, which the Graph export uses as the user id.
      claims: { subject: 'sub', name: 'name' },
      expiredGraceSeconds: WEEK,
    },
    cookies: [],
    bearer: true,
    notes:
      'Keys are published per policy: run one bridge per user flow that issued tokens. MSAL keeps tokens in browser storage (encrypted from msal-browser v4): exchange v2/v3 caches with readMsalBrowserSession from @atlasauth/js; v4 apps rely on lazy migration.',
  },
  {
    id: 'entra_external_id',
    label: 'Microsoft Entra External ID (ID tokens)',
    mode: 'jwt',
    vars: {
      tenant: 'Tenant subdomain (contoso for contoso.ciamlogin.com)',
      tenant_id: 'Directory (tenant) id GUID',
      client_id: 'Application (client) id',
    },
    jwt: {
      issuer: 'https://{tenant_id}.ciamlogin.com/{tenant_id}/v2.0',
      keysUrl: 'https://{tenant}.ciamlogin.com/{tenant_id}/discovery/v2.0/keys',
      audience: ['{client_id}'],
      algorithms: ['RS256'],
      // `sub` differs per application; `oid` is the directory object id the Graph export keys users by.
      claims: { subject: 'oid', email: 'email', name: 'name', sessionKey: 'uti' },
      expiredGraceSeconds: WEEK,
    },
    cookies: [],
    bearer: true,
    notes: 'MSAL keeps tokens in browser storage (encrypted from msal-browser v4): exchange v2/v3 caches with readMsalBrowserSession from @atlasauth/js.',
  },
  {
    id: 'appwrite',
    label: 'Appwrite (session cookie, checked with Appwrite)',
    mode: 'remote',
    vars: { endpoint_url: 'API endpoint including /v1 (https://cloud.appwrite.io/v1, or your own)', project_id: 'Project id' },
    // Appwrite keeps only a hash of each session secret, so sessions cannot be
    // exported or verified offline: Atlas asks Appwrite who the session is. The
    // cookie value (base64 of {id, secret}) is what X-Appwrite-Session takes.
    remote: {
      url: '{endpoint_url}/account',
      method: 'GET',
      headers: { 'x-appwrite-project': '{project_id}', 'x-appwrite-session': '{token}' },
      subjectPath: '$id',
      emailPath: 'email',
      emailVerifiedPath: 'emailVerification',
      namePath: 'name',
    },
    // a_session_<project id, lowercased> and its _legacy twin.
    cookies: ['a_session_*'],
    notes:
      'The browser must send the Appwrite cookie to your app, so this works when Appwrite is on a subdomain of your app (custom domain) or your app does SSR with the session secret in its own cookie (pass its name as cookieNames). Client-only apps keep the session in localStorage (cookieFallback): exchange it with readAppwriteBrowserSession from @atlasauth/js. Keep the Appwrite project running for the bridge window.',
  },
  {
    id: 'pocketbase',
    label: 'PocketBase (auth token, checked with PocketBase)',
    mode: 'remote',
    vars: { url: 'PocketBase URL (https://pb.example.com)' },
    defaults: { collection: 'users' },
    // Tokens are signed with a per-user tokenKey plus a per-collection secret, so
    // nothing outside PocketBase can verify one: auth-refresh vouches for it.
    remote: {
      url: '{url}/api/collections/{collection}/auth-refresh',
      method: 'POST',
      headers: { authorization: '{token}' },
      subjectPath: 'record.id',
      emailPath: 'record.email',
      emailVerifiedPath: 'record.verified',
      namePath: 'record.name',
    },
    // pb_auth is the cookie the JS SDK's authStore.exportToCookie() writes (JSON with the token).
    cookies: ['pb_auth'],
    tokenFormat: 'pocketbase',
    notes: 'Client-only apps keep the token in localStorage (pocketbase_auth): exchange it with readPocketBaseBrowserSession from @atlasauth/js. Keep PocketBase running for the bridge window.',
  },
  {
    id: 'nhost',
    label: 'Nhost (refresh tokens)',
    mode: 'session_table',
    // The export stores sha256(refresh token) — exactly what auth.refresh_tokens keeps.
    cookies: ['nhostRefreshToken'],
    clearCookies: ['nhostRefreshToken', 'nhostRefreshTokenExpiresAt', 'nhostSession'],
    notes: 'SPA sessions keep the refresh token in localStorage (nhostRefreshToken): exchange them with readNhostBrowserSession from @atlasauth/js.',
  },
  {
    id: 'nhost_jwt',
    label: 'Nhost (access tokens)',
    mode: 'jwt',
    vars: { auth_url: 'The Auth URL (https://<subdomain>.auth.<region>.nhost.run/v1)' },
    // Legacy Hasura Auth signs with iss "hasura-auth"; current versions use the server URL.
    defaults: { issuer: 'hasura-auth' },
    jwt: {
      issuer: '{issuer}',
      keysUrl: '{auth_url}/.well-known/jwks.json',
      algorithms: ['RS256', 'HS256', 'HS512'],
      claims: { subject: 'sub', sessionKey: 'jti' },
      expiredGraceSeconds: WEEK,
      // Most projects sign with the shared HASURA_GRAPHQL_JWT_SECRET key.
      allowSharedSecret: true,
    },
    cookies: [],
    bearer: true,
  },
];
