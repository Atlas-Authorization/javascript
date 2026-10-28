/**
 * ZERO-LOGOUT BRIDGE PRESETS — per vendor, how an old session is recognised.
 *
 * Shared by the Atlas API (which verifies the token and resolves the user) and
 * the SDK middleware (which knows which cookie / header carries it), so both
 * read one table. Pure data plus a few string templates: safe on every runtime.
 *
 * Three modes:
 *   - `jwt`: the vendor's session (or a token inside it) is a JWT. Atlas
 *     verifies it against the vendor's issuer and keys (JWKS, or an X.509 map
 *     like Firebase session cookies use), maps `claims.subject` to the imported
 *     user (`external_id` = the source user id), and spends `claims.sessionKey`
 *     (`jti` / `sid`, falling back to the whole token) in the single-use ledger.
 *   - `session_table`: an opaque token; Atlas looks up sha256(token) among the
 *     sessions imported in the migration bundle.
 *   - `remote`: the vendor's session can only be checked by asking the vendor
 *     with the user's own token (Appwrite, PocketBase): Atlas calls
 *     `remote.url` with the token filled into `{token}` and reads the subject
 *     (and profile) from the JSON answer by dot path.
 *
 * Templates use `{var}` placeholders filled from the bridge settings'
 * `preset_vars` (e.g. `{domain}`, `{region}`); {@link resolveMigrationBridgePreset}
 * refuses a template with a missing variable.
 *
 * Vendor tracks register their preset (or refine the starter below) with
 * {@link registerMigrationBridgePreset}; a test checks every preset resolves.
 */

export interface MigrationBridgeClaims {
  /** Claim holding the source user id (default `sub`). */
  subject: string;
  email?: string;
  emailVerified?: string;
  name?: string;
  /** Claim whose value spends the token in the single-use ledger (`jti`, `sid`); the whole token when absent. */
  sessionKey?: string;
  /**
   * How the vendor says a second factor was passed: `amr:mfa` (the `amr` array
   * contains `mfa`), `acr:<value>`, or `claim:<name>` (a truthy claim).
   */
  mfa?: string;
}

/**
 * How the middleware gets the token out of the cookie: `raw` (the cookie value
 * is the token), `supabase` (Supabase SSR's `base64-` JSON cookie, possibly
 * chunked `.0`/`.1`, holding `access_token`), or a custom extractor a vendor
 * track registers on the middleware side.
 */
export type TokenFormat = 'raw' | 'supabase' | (string & {});

export interface MigrationBridgePreset {
  id: string;
  label: string;
  mode: 'jwt' | 'session_table' | 'remote';
  /** Variables the templates need, with a one-line hint each. */
  vars?: Record<string, string>;
  /** Optional variables and their defaults. */
  defaults?: Record<string, string>;
  jwt?: {
    issuer: string;
    /** Where the keys are. Omitted → OIDC discovery from the issuer. */
    keysUrl?: string;
    /** `jwks` (default) or `x509` (a `{ kid: PEM certificate }` map). */
    keysFormat?: 'jwks' | 'x509';
    /** Expected `aud` template(s); unchecked when absent. */
    audience?: string[];
    algorithms: string[];
    claims: MigrationBridgeClaims;
    /**
     * Accept a validly signed token this many seconds past `exp` (each one still
     * exchanges once). For vendors whose cookie holds a short-lived token that
     * their client SDK refreshes and nothing refreshes after the switch. 0 by default.
     */
    expiredGraceSeconds?: number;
    /** The vendor may sign with a shared secret (HS256) instead of keys (Supabase legacy JWT secret). */
    allowSharedSecret?: boolean;
    /**
     * The token is not a JWT but another signed token Atlas checks natively:
     * `magic_did` (Magic DID tokens — signed by the user's own key, subject the
     * `iss` DID, audience the Magic client id). Default `jwt`.
     */
    tokenType?: 'jwt' | 'magic_did';
  };
  /**
   * Mode `remote`: the vendor call that vouches for a token. Templates take the
   * preset variables; `{token}` is the presented token and is filled only at
   * call time, by the server.
   */
  remote?: MigrationBridgeRemote;
  /**
   * Cookies that may carry the token, most specific first. `*` matches any run
   * of characters (Amplify names cookies per client id and username).
   */
  cookies: string[];
  tokenFormat?: TokenFormat;
  /** Read `Authorization: Bearer` too (API clients holding the old token). */
  bearer?: boolean;
  /** Cookies to clear once exchanged (defaults to `cookies`). */
  clearCookies?: string[];
  /**
   * The cookie name collides with Atlas's own (`__session`): the middleware
   * only treats it as the old vendor's when the token's `iss` is the vendor's.
   */
  sharesAtlasCookie?: boolean;
  /** Integrator-facing notes (what must be configured at the vendor, caveats). */
  notes?: string;
}

/** How a `remote` preset asks the vendor about a token. */
export interface MigrationBridgeRemote {
  /** URL template (`{var}` from the preset variables, `{token}` at call time). */
  url: string;
  method: 'GET' | 'POST';
  /** Header templates, e.g. `{ authorization: 'Bearer {token}' }`. */
  headers?: Record<string, string>;
  /** Body template (POST). */
  body?: string;
  /** Dot path into the JSON answer holding the source user id (`record.id`, `$id`). */
  subjectPath: string;
  emailPath?: string;
  emailVerifiedPath?: string;
  namePath?: string;
}

const OIDC_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384', 'EdDSA'];

const presets = new Map<string, MigrationBridgePreset>();

export function registerMigrationBridgePreset(preset: MigrationBridgePreset, options: { replace?: boolean } = {}): void {
  if (!/^[a-z0-9_]+$/.test(preset.id)) throw new Error(`Invalid bridge preset id "${preset.id}".`);
  if (presets.has(preset.id) && !options.replace) throw new Error(`Bridge preset "${preset.id}" is already registered.`);
  if (preset.mode === 'jwt' && !preset.jwt) throw new Error(`Bridge preset "${preset.id}" is mode jwt but has no jwt settings.`);
  if (preset.mode === 'remote' && !preset.remote) throw new Error(`Bridge preset "${preset.id}" is mode remote but has no remote settings.`);
  presets.set(preset.id, preset);
}

export function getMigrationBridgePreset(id: string): MigrationBridgePreset | undefined {
  return presets.get(id);
}

export function listMigrationBridgePresets(): MigrationBridgePreset[] {
  return [...presets.values()];
}

/** The bridge settings a preset resolves to, every template filled in. */
export interface ResolvedBridgePreset {
  preset: string;
  mode: 'jwt' | 'session_table' | 'remote';
  issuer: string | null;
  keysUrl: string | null;
  keysFormat: 'jwks' | 'x509';
  audience: string[] | null;
  algorithms: string[];
  claims: MigrationBridgeClaims;
  expiredGraceSeconds: number;
  cookies: string[];
  tokenFormat: TokenFormat;
  bearer: boolean;
  clearCookies: string[];
  sharesAtlasCookie: boolean;
  /** Mode `remote`: the vendor call, preset variables filled, `{token}` left for the server. */
  remote: MigrationBridgeRemote | null;
}

export class PresetVariableError extends Error {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = 'PresetVariableError';
  }
}

/** A preset variable must be a plain value: no scheme, path tricks or whitespace sneak into a URL. */
const VAR_VALUE = /^[A-Za-z0-9._:\-/]{1,253}$/;

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (match, name: string) => {
    // `{token}` is the presented session token, filled by the server at call time.
    if (name === 'token') return match;
    const v = vars[name];
    if (v === undefined || v === '') throw new PresetVariableError(name, `The preset needs "${name}".`);
    return v;
  });
}

/**
 * Fill a preset's templates. Throws {@link PresetVariableError} for a missing or
 * malformed variable. Values are trimmed; a trailing slash on a URL-ish value
 * is removed (`https://example.com/` → `https://example.com`).
 */
export function resolveMigrationBridgePreset(id: string, rawVars: Record<string, string> = {}): ResolvedBridgePreset {
  const p = presets.get(id);
  if (!p) throw new PresetVariableError('preset', `Unknown bridge preset "${id}".`);
  const vars: Record<string, string> = { ...(p.defaults ?? {}) };
  for (const [k, v] of Object.entries(rawVars)) {
    if (typeof v !== 'string') continue;
    const value = v.trim().replace(/\/+$/, '');
    if (!value) continue;
    // Base URLs (`base_url`, `issuer`, `*_url`) keep their https scheme; every
    // other variable is a bare value (a pasted `https://` is dropped, so
    // `https://{domain}/` never doubles it).
    const bare = value.replace(/^https:\/\//, '');
    if (!VAR_VALUE.test(bare) || bare.includes('..') || bare.includes('//')) throw new PresetVariableError(k, `"${k}" has characters a ${p.label} value never has.`);
    const keepsScheme = k === 'issuer' || k.endsWith('url');
    if (keepsScheme && !value.startsWith('https://')) throw new PresetVariableError(k, `"${k}" must be an https URL.`);
    vars[k] = keepsScheme ? value : bare;
  }
  const jwt = p.jwt;
  return {
    preset: p.id,
    mode: p.mode,
    issuer: jwt ? fill(jwt.issuer, vars) : null,
    keysUrl: jwt?.keysUrl ? fill(jwt.keysUrl, vars) : null,
    keysFormat: jwt?.keysFormat ?? 'jwks',
    audience: jwt?.audience?.length ? jwt.audience.map((a) => fill(a, vars)) : null,
    algorithms: jwt?.algorithms ?? [],
    claims: jwt?.claims ?? { subject: 'sub' },
    expiredGraceSeconds: jwt?.expiredGraceSeconds ?? 0,
    cookies: p.cookies.map((c) => fill(c, vars)),
    tokenFormat: p.tokenFormat ?? 'raw',
    bearer: p.bearer === true,
    clearCookies: (p.clearCookies ?? p.cookies).map((c) => fill(c, vars)),
    sharesAtlasCookie: p.sharesAtlasCookie === true,
    remote: p.remote
      ? {
          ...p.remote,
          url: fill(p.remote.url, vars),
          ...(p.remote.headers ? { headers: Object.fromEntries(Object.entries(p.remote.headers).map(([k, v]) => [k, fill(v, vars)])) } : {}),
          ...(p.remote.body !== undefined ? { body: fill(p.remote.body, vars) } : {}),
        }
      : null,
  };
}

// ── the starter presets ─────────────────────────────────────────────────────

const OIDC_CLAIMS: MigrationBridgeClaims = { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', sessionKey: 'jti', mfa: 'amr:mfa' };

for (const preset of [
  {
    id: 'oidc',
    label: 'Any OpenID Connect provider',
    mode: 'jwt',
    vars: { issuer: 'The issuer URL (keys are found by OIDC discovery)' },
    jwt: { issuer: '{issuer}', algorithms: OIDC_ALGS, claims: OIDC_CLAIMS },
    cookies: [],
    bearer: true,
  },
  {
    id: 'auth0',
    label: 'Auth0',
    mode: 'jwt',
    vars: {
      domain: 'Your Auth0 domain (tenant.us.auth0.com, or the custom domain your tokens are issued from)',
      client_id: 'The application client id (the ID token audience)',
    },
    defaults: {},
    jwt: {
      issuer: 'https://{domain}/',
      keysUrl: 'https://{domain}/.well-known/jwks.json',
      // The bridge exchanges the ID token from the app session: its audience is the client id.
      audience: ['{client_id}'],
      algorithms: ['RS256', 'PS256'],
      claims: { ...OIDC_CLAIMS, sessionKey: 'sid' },
      // ID tokens live 10 hours by default while the app session rolls for days;
      // nothing renews the ID token once Auth0's SDK stops running.
      expiredGraceSeconds: 7 * 24 * 3600,
    },
    cookies: ['__session', 'appSession'],
    // nextjs-auth0 v4 chunks a large session as __session__0, __session__1; v3 and
    // express-openid-connect as appSession.0, appSession.1.
    clearCookies: ['__session', '__session__*', 'appSession', 'appSession.*', 'auth_verification', '__txn_*'],
    sharesAtlasCookie: true,
    bearer: true,
    notes: 'The nextjs-auth0 / express-openid-connect session cookie is encrypted with your AUTH0_SECRET: use auth0SessionTokenExtractor({ secret }) from @atlasauth/backend as the middleware extractToken so it is opened on your server and its ID token exchanged.',
  },
  {
    id: 'clerk',
    label: 'Clerk',
    mode: 'jwt',
    vars: { frontend_api: 'Your Clerk Frontend API host (clerk.example.com or xxx.clerk.accounts.dev — the host your publishable key encodes)' },
    jwt: {
      issuer: 'https://{frontend_api}',
      keysUrl: 'https://{frontend_api}/.well-known/jwks.json',
      algorithms: ['RS256'],
      claims: { subject: 'sub', sessionKey: 'sid', email: 'email' },
      // Clerk session tokens live 60 seconds and are refreshed by clerk-js, which no longer runs after the switch.
      expiredGraceSeconds: 7 * 24 * 3600,
    },
    cookies: ['__session'],
    // Clerk also sets suffixed copies (__session_<suffix>, __client_uat_<suffix>) on newer SDKs.
    clearCookies: ['__session', '__session_*', '__client_uat', '__client_uat_*', '__clerk_db_jwt', '__clerk_db_jwt_*', '__refresh_*'],
    sharesAtlasCookie: true,
    bearer: true,
    notes: 'Clerk session tokens are exchanged up to 7 days after they expire (each one once): run the bridge from the day you switch. Clerk\'s __client cookie lives on the Frontend API domain and is never readable by your app.',
  },
  {
    id: 'cognito',
    label: 'Amazon Cognito',
    mode: 'jwt',
    vars: { region: 'AWS region (us-east-1)', user_pool_id: 'User pool id (us-east-1_AbCdEf)', client_id: 'App client id' },
    jwt: {
      issuer: 'https://cognito-idp.{region}.amazonaws.com/{user_pool_id}',
      keysUrl: 'https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json',
      audience: ['{client_id}'],
      algorithms: ['RS256'],
      claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', sessionKey: 'origin_jti' },
    },
    cookies: ['CognitoIdentityServiceProvider.{client_id}.*.idToken'],
    clearCookies: ['CognitoIdentityServiceProvider.{client_id}.*'],
    bearer: true,
  },
  {
    id: 'firebase',
    label: 'Firebase Authentication',
    mode: 'jwt',
    vars: { project_id: 'Firebase project id' },
    jwt: {
      issuer: 'https://securetoken.google.com/{project_id}',
      keysUrl: 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
      audience: ['{project_id}'],
      algorithms: ['RS256'],
      claims: { subject: 'user_id', email: 'email', emailVerified: 'email_verified', name: 'name', sessionKey: 'jti' },
    },
    cookies: ['__session'],
    sharesAtlasCookie: true,
    bearer: true,
  },
  {
    id: 'firebase_session_cookie',
    label: 'Firebase session cookies',
    mode: 'jwt',
    vars: { project_id: 'Firebase project id' },
    jwt: {
      issuer: 'https://session.firebase.google.com/{project_id}',
      keysUrl: 'https://www.googleapis.com/identitytoolkit/v3/relyingparty/publicKeys',
      keysFormat: 'x509',
      audience: ['{project_id}'],
      algorithms: ['RS256'],
      claims: { subject: 'user_id', email: 'email', emailVerified: 'email_verified', name: 'name' },
    },
    cookies: ['__session', 'session'],
    sharesAtlasCookie: true,
  },
  {
    id: 'supabase',
    label: 'Supabase Auth',
    mode: 'jwt',
    vars: { project_ref: 'Project ref (the subdomain of <ref>.supabase.co)' },
    jwt: {
      issuer: 'https://{project_ref}.supabase.co/auth/v1',
      keysUrl: 'https://{project_ref}.supabase.co/auth/v1/.well-known/jwks.json',
      audience: ['authenticated'],
      algorithms: ['ES256', 'RS256', 'HS256'],
      claims: { subject: 'sub', email: 'email', sessionKey: 'session_id', mfa: 'claim:aal2' },
      // The access token lives an hour; supabase-js refreshes it, which no longer happens after the switch.
      expiredGraceSeconds: 7 * 24 * 3600,
      allowSharedSecret: true,
    },
    cookies: ['sb-{project_ref}-auth-token'],
    tokenFormat: 'supabase',
    clearCookies: ['sb-{project_ref}-auth-token', 'sb-{project_ref}-auth-token.*'],
    bearer: true,
  },
  {
    id: 'workos',
    label: 'WorkOS AuthKit',
    mode: 'jwt',
    vars: { client_id: 'WorkOS client id (client_…)' },
    // api.workos.com, or your custom authentication domain when the environment has one.
    defaults: { api_host: 'api.workos.com' },
    jwt: {
      issuer: 'https://{api_host}/user_management/{client_id}',
      keysUrl: 'https://{api_host}/sso/jwks/{client_id}',
      algorithms: ['RS256'],
      claims: { subject: 'sub', sessionKey: 'sid' },
      expiredGraceSeconds: 7 * 24 * 3600,
    },
    cookies: ['wos-session'],
    clearCookies: ['wos-session'],
    bearer: true,
    notes: 'The wos-session cookie is sealed with your WORKOS_COOKIE_PASSWORD: pass the middleware workosSessionTokenExtractor({ password }) from @atlasauth/backend, which unseals it on your server and returns the access token. With a custom authentication domain set api_host to it. AuthKit access tokens are short-lived and signed RS256 by WorkOS; the issuer is https://{api_host}/user_management/{client_id}.',
  },
  {
    id: 'okta',
    label: 'Okta',
    mode: 'jwt',
    vars: { domain: 'Your Okta domain (example.okta.com)' },
    defaults: { auth_server: 'default', audience: 'api://default' },
    jwt: {
      // A custom authorization server: org-server access tokens are opaque to anyone but Okta.
      issuer: 'https://{domain}/oauth2/{auth_server}',
      keysUrl: 'https://{domain}/oauth2/{auth_server}/v1/keys',
      audience: ['{audience}'],
      algorithms: ['RS256'],
      // Access tokens carry the login in `sub` and the Okta user id in `uid`.
      claims: { ...OIDC_CLAIMS, subject: 'uid', sessionKey: 'jti' },
    },
    // okta-auth-js keeps tokens in browser storage, not cookies: API calls carry them as bearer tokens.
    cookies: [],
    bearer: true,
  },
  {
    id: 'ping_identity',
    label: 'Ping Identity (PingOne)',
    mode: 'jwt',
    vars: { environment_id: 'Your PingOne environment id (a UUID)' },
    defaults: { region: 'com' },
    jwt: {
      issuer: 'https://auth.pingone.{region}/{environment_id}/as',
      keysUrl: 'https://auth.pingone.{region}/{environment_id}/as/jwks',
      algorithms: ['RS256', 'ES256'],
      claims: { ...OIDC_CLAIMS, sessionKey: 'sid' },
    },
    // PingOne sessions live in the SPA (tokens in storage): API calls carry them as bearer tokens.
    cookies: [],
    bearer: true,
  },
  {
    id: 'onelogin',
    label: 'OneLogin',
    mode: 'jwt',
    vars: { subdomain: 'Your OneLogin subdomain (acme in acme.onelogin.com)' },
    jwt: {
      issuer: 'https://{subdomain}.onelogin.com/oidc/2',
      keysUrl: 'https://{subdomain}.onelogin.com/oidc/2/certs',
      algorithms: ['RS256', 'PS256', 'ES256'],
      claims: { ...OIDC_CLAIMS, sessionKey: 'jti' },
    },
    cookies: [],
    bearer: true,
  },
  {
    id: 'stytch',
    label: 'Stytch',
    mode: 'jwt',
    vars: { project_id: 'Stytch project id (project-live-…)' },
    // api.stytch.com for live projects, test.stytch.com for test ones; jwks_path `b2b/sessions` for Stytch B2B (members), `sessions` for consumer.
    defaults: { api_host: 'api.stytch.com', jwks_path: 'sessions' },
    jwt: {
      issuer: 'stytch.com/{project_id}',
      keysUrl: 'https://{api_host}/v1/{jwks_path}/jwks/{project_id}',
      audience: ['{project_id}'],
      algorithms: ['RS256'],
      // The session id sits inside the `https://stytch.com/session` object claim (dotted path).
      claims: { subject: 'sub', sessionKey: 'https://stytch.com/session.id' },
      expiredGraceSeconds: 7 * 24 * 3600,
    },
    cookies: ['stytch_session_jwt'],
    clearCookies: ['stytch_session_jwt', 'stytch_session'],
    notes:
      'Stytch session JWTs last about five minutes and are signed by the project (RS256). Use jwks_path=b2b/sessions for Stytch B2B and api_host=test.stytch.com for a test project. The subject is the Stytch user id (consumer) or member id (B2B).',
  },
  {
    id: 'keycloak',
    label: 'Keycloak',
    mode: 'jwt',
    vars: { base_url: 'Keycloak base URL (https://sso.example.com)', realm: 'Realm name' },
    jwt: {
      issuer: '{base_url}/realms/{realm}',
      keysUrl: '{base_url}/realms/{realm}/protocol/openid-connect/certs',
      algorithms: ['RS256', 'ES256', 'PS256'],
      claims: { ...OIDC_CLAIMS, sessionKey: 'sid', mfa: 'acr:2' },
    },
    cookies: [],
    bearer: true,
  },
  {
    id: 'fusionauth',
    label: 'FusionAuth',
    mode: 'jwt',
    vars: { base_url: 'FusionAuth URL (https://auth.example.com)' },
    defaults: {},
    jwt: {
      issuer: '{base_url}',
      keysUrl: '{base_url}/.well-known/jwks.json',
      algorithms: ['RS256', 'ES256'],
      claims: { ...OIDC_CLAIMS, sessionKey: 'sid' },
    },
    cookies: ['app.at'],
    clearCookies: ['app.at', 'app.rt', 'app.idt'],
    bearer: true,
  },
  {
    id: 'kinde',
    label: 'Kinde',
    mode: 'jwt',
    vars: { domain: 'Your Kinde domain (example.kinde.com, or your custom domain)' },
    jwt: {
      issuer: 'https://{domain}',
      keysUrl: 'https://{domain}/.well-known/jwks',
      algorithms: ['RS256'],
      claims: { ...OIDC_CLAIMS, sessionKey: 'jti' },
      // The Kinde SDK refreshes its access token; nothing does after the switch.
      expiredGraceSeconds: 7 * 24 * 3600,
    },
    // The Kinde Next.js SDK keeps the raw tokens in these cookies.
    cookies: ['access_token', 'id_token'],
    clearCookies: ['access_token', 'id_token', 'refresh_token', 'refresh_token_*', 'ac-state-key', 'user', 'post_login_redirect_url'],
    bearer: true,
  },
  {
    id: 'descope',
    label: 'Descope',
    mode: 'jwt',
    vars: { project_id: 'Descope project id (P…)' },
    defaults: { base_url: 'https://api.descope.com' },
    jwt: {
      // Newer projects issue `https://api.descope.com/<project id>`; older ones the
      // bare project id (preset descope_project_issuer). Decode one DS token to check.
      issuer: '{base_url}/{project_id}',
      keysUrl: '{base_url}/v2/keys/{project_id}',
      algorithms: ['RS256'],
      claims: { subject: 'sub', email: 'email', mfa: 'amr:mfa' },
      // Session tokens live minutes and are renewed from the DSR refresh token by the Descope SDK.
      expiredGraceSeconds: 7 * 24 * 3600,
    },
    cookies: ['DS'],
    clearCookies: ['DS', 'DSR'],
    bearer: true,
  },
  {
    id: 'descope_project_issuer',
    label: 'Descope (project-id issuer)',
    mode: 'jwt',
    vars: { project_id: 'Descope project id (P…)' },
    defaults: { base_url: 'https://api.descope.com' },
    jwt: {
      issuer: '{project_id}',
      keysUrl: '{base_url}/v2/keys/{project_id}',
      algorithms: ['RS256'],
      claims: { subject: 'sub', email: 'email', mfa: 'amr:mfa' },
      expiredGraceSeconds: 7 * 24 * 3600,
    },
    cookies: ['DS'],
    clearCookies: ['DS', 'DSR'],
    bearer: true,
  },
  {
    id: 'frontegg',
    label: 'Frontegg',
    mode: 'jwt',
    vars: { base_url: 'Your Frontegg domain (https://app-xxx.frontegg.com)' },
    jwt: { issuer: '{base_url}', keysUrl: '{base_url}/.well-known/jwks.json', algorithms: ['RS256'], claims: { subject: 'sub', email: 'email', sessionKey: 'sid' } },
    cookies: [],
    bearer: true,
  },
  // ── propelauth ──
  {
    id: 'propelauth',
    label: 'PropelAuth',
    mode: 'jwt',
    vars: { auth_url: 'Your PropelAuth auth URL (https://123456.propelauthtest.com or https://auth.example.com)' },
    jwt: { issuer: '{auth_url}', keysUrl: '{auth_url}/.well-known/jwks.json', algorithms: ['RS256'], claims: { subject: 'user_id', email: 'email' }, expiredGraceSeconds: 7 * 24 * 3600 },
    cookies: ['__pa_at'],
    clearCookies: ['__pa_at', '__pa_rt'],
    bearer: true,
    notes:
      'PropelAuth signs RS256 tokens (issuer = your auth URL, subject claim user_id) and publishes the verifier key as a PEM (Dashboard → Backend Integration, or PROPELAUTH_VERIFIER_KEY), not as a JWKS. Point the bridge at a JWKS URL that serves that key (jwks_url) before enabling it.',
  },
  // ── magic ──
  {
    id: 'magic',
    label: 'Magic (magic.link)',
    mode: 'jwt',
    vars: { client_id: 'Your Magic client id (did:magic:…), the `aud` of your DID tokens' },
    jwt: {
      // Not an OIDC issuer: each DID token's `iss` is the user's own did:ethr. Kept for the settings' shape.
      issuer: 'did:ethr',
      tokenType: 'magic_did',
      audience: ['{client_id}'],
      algorithms: ['ES256K'],
      claims: { subject: 'iss', sessionKey: 'tid' },
      // DID tokens live 15 minutes by default; the app mints a fresh one whenever it asks Magic.
      expiredGraceSeconds: 24 * 3600,
    },
    cookies: [],
    bearer: true,
    notes: 'Magic DID tokens travel in the Authorization header (from magic.user.getIdToken()), not a cookie, and are not JWTs: pass the middleware magicDidTokenExtractor().',
  },
  // ── userfront ──
  // ── corbado ──
  {
    id: 'corbado',
    label: 'Corbado',
    mode: 'jwt',
    vars: { project_id: 'Your Corbado project id (pro-…)' },
    jwt: {
      issuer: 'https://{project_id}.frontendapi.corbado.io',
      keysUrl: 'https://{project_id}.frontendapi.corbado.io/.well-known/jwks',
      algorithms: ['RS256'],
      claims: { subject: 'sub', email: 'email', name: 'name' },
      expiredGraceSeconds: 7 * 24 * 3600,
    },
    cookies: ['cbo_session_token', 'cbo_short_session'],
    bearer: true,
  },
  {
    id: 'better_auth',
    label: 'Better Auth',
    mode: 'session_table',
    defaults: { cookie_prefix: 'better-auth' },
    cookies: ['__Secure-{cookie_prefix}.session_token', '{cookie_prefix}.session_token'],
    clearCookies: [
      '__Secure-{cookie_prefix}.session_token',
      '__Secure-{cookie_prefix}.session_data',
      '__Secure-{cookie_prefix}.account_data',
      '__Secure-{cookie_prefix}.dont_remember',
      '{cookie_prefix}.session_token',
      '{cookie_prefix}.session_data',
      '{cookie_prefix}.account_data',
      '{cookie_prefix}.dont_remember',
    ],
  },
  {
    id: 'authjs',
    label: 'Auth.js (database sessions)',
    mode: 'session_table',
    cookies: ['__Secure-authjs.session-token', 'authjs.session-token', '__Secure-next-auth.session-token', 'next-auth.session-token'],
    notes: 'With the JWT session strategy the cookie is encrypted with AUTH_SECRET: pass the middleware a token extractor that decrypts it locally.',
  },
  { id: 'lucia', label: 'Lucia', mode: 'session_table', defaults: { cookie_name: 'auth_session' }, cookies: ['{cookie_name}'] },
  { id: 'ory', label: 'Ory (Kratos)', mode: 'session_table', cookies: ['ory_kratos_session', 'ory_session_*'], bearer: true },
  { id: 'custom', label: 'Your own sessions', mode: 'session_table', vars: { cookie_name: 'The session cookie name' }, cookies: ['{cookie_name}'] },
] satisfies MigrationBridgePreset[]) {
  registerMigrationBridgePreset(preset as MigrationBridgePreset);
}

/** Does a cookie name match a preset pattern (`*` = any run of characters)? */
export function cookieNameMatches(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

// ── vendor-track presets ────────────────────────────────────────────────────
// Firebase, Supabase, Cognito, Azure AD B2C, Entra External ID, Nhost (replacing the starters).
import { G3_BRIDGE_PRESETS } from './migration-presets-g3';
for (const preset of G3_BRIDGE_PRESETS) registerMigrationBridgePreset(preset, { replace: true });
// ── open-source identity providers ─────────────────────────────────────────
// Keycloak, Ory, ZITADEL, Logto, SuperTokens, authentik, FusionAuth, Hanko.
import { G4_BRIDGE_PRESETS } from './migration-presets-g4';
for (const preset of G4_BRIDGE_PRESETS) registerMigrationBridgePreset(preset, { replace: true });
