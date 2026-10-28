import type { BridgeCookie } from './better-auth';
import { cookieNameMatches, getMigrationBridgePreset, resolveMigrationBridgePreset, type TokenFormat } from './migration-presets';

/**
 * Moving to Atlas from ANY auth vendor without signing anyone out — the
 * vendor-neutral zero-logout bridge (Better Auth's `betterAuthBridge` is now an
 * alias of this with `source: 'better_auth'`).
 *
 * During the migration window a returning user still carries the old vendor's
 * session cookie (or bearer token). The bridge reads it, exchanges it ONCE with
 * Atlas (`POST /v1/migrations/{source}/exchange` with the secret key, or the
 * Frontend API twin `POST /v1/client/migrations/{source}/exchange`), sets the
 * Atlas session as your own first-party cookies and clears the old ones. Atlas
 * verifies the old token (a JWT against the vendor's keys, or an opaque token
 * against the sessions you imported) and runs the normal sign-in path on it —
 * MFA policy included.
 *
 * Framework-neutral: {@link createMigrationBridge} returns a decision with the
 * cookies to set and clear; the Next.js middleware and the Express / Fastify /
 * Hono adapters render it (`migrationBridge({ source })`).
 */

/** Default Backend API origin. */
const DEFAULT_BAPI_URL = 'https://api.atlasauth.net';

/** The Frontend API exchange path for a source. */
export function migrationExchangePath(source: string): string {
  return `/v1/client/migrations/${encodeURIComponent(source)}/exchange`;
}

/** The Backend API (secret-key) exchange path for a source. */
export function migrationBapiExchangePath(source: string): string {
  return `/v1/migrations/${encodeURIComponent(source)}/exchange`;
}

/** Why Atlas refused an exchange (`meta.bridge_outcome`). */
export type MigrationBridgeRefusal =
  | 'closed'
  | 'invalid'
  | 'signature_invalid'
  | 'expired'
  | 'reused'
  | 'user_unavailable'
  | 'user_unknown'
  | 'rate_limited'
  | 'unavailable';

export type MigrationExchangeResult =
  | { kind: 'session'; jwt: string; refreshToken: string; sessionId: string; userId: string; expiresIn: number }
  /** The user still owes a second factor (or MFA enrolment) — the old session is spent. */
  | { kind: 'needs_mfa'; attemptId: string; status: 'needs_second_factor' | 'needs_mfa_enrollment' }
  | { kind: 'refused'; outcome: MigrationBridgeRefusal; status: number };

export interface ExchangeMigrationSessionOptions {
  /** The migration source (`auth0`, `clerk`, `cognito`, `better_auth` …). */
  source: string;
  /** The instance's Frontend API origin. */
  fapiOrigin: string;
  publishableKey: string;
  /**
   * The instance secret key. When set (recommended on a server) the exchange
   * goes to the Backend API — limited per instance with a ceiling sized for a
   * bulk cutover, not per IP — and takes the user's IP / user agent from
   * `clientIp` / `userAgent`.
   */
  secretKey?: string;
  /** Backend API origin for the secret-key path. Default `https://api.atlasauth.net`. */
  bapiBaseUrl?: string;
  clientIp?: string;
  /** The old session token as read from the cookie / header (after the preset's token format). */
  token: string;
  remember?: boolean;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const KNOWN_REFUSALS: MigrationBridgeRefusal[] = ['closed', 'invalid', 'signature_invalid', 'expired', 'reused', 'user_unavailable', 'user_unknown', 'rate_limited'];

/**
 * Exchange an old vendor session for an Atlas session, server to server
 * (`delivery: "body"`). Never throws: a transport failure is
 * `{ kind: 'refused', outcome: 'unavailable' }`, so the caller keeps the old
 * cookie and tries again on a later request.
 */
export async function exchangeMigrationSession(options: ExchangeMigrationSessionOptions): Promise<MigrationExchangeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const viaSecretKey = Boolean(options.secretKey);
  const url = viaSecretKey
    ? `${(options.bapiBaseUrl ?? DEFAULT_BAPI_URL).replace(/\/+$/, '')}${migrationBapiExchangePath(options.source)}`
    : new URL(migrationExchangePath(options.source), options.fapiOrigin).toString();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (viaSecretKey) {
    headers.authorization = `Bearer ${options.secretKey}`;
    if (options.clientIp) headers['x-atlas-client-ip'] = options.clientIp;
    if (options.userAgent) headers['x-atlas-client-user-agent'] = options.userAgent;
  } else {
    headers['x-publishable-key'] = options.publishableKey;
    if (options.userAgent) headers['user-agent'] = options.userAgent;
  }
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token: options.token,
        ...(viaSecretKey ? {} : { delivery: 'body' }),
        ...(options.remember === false ? { remember: false } : {}),
      }),
    });
  } catch {
    return { kind: 'refused', outcome: 'unavailable', status: 0 };
  }
  const data = (await res.json().catch(() => null)) as {
    object?: string;
    id?: string;
    status?: string;
    jwt?: string;
    refresh_token?: string;
    session_id?: string;
    user_id?: string;
    expires_in?: number;
    errors?: Array<{ meta?: { bridge_outcome?: string } }>;
  } | null;
  if (res.ok && data?.object === 'session_tokens' && data.jwt && data.refresh_token) {
    return { kind: 'session', jwt: data.jwt, refreshToken: data.refresh_token, sessionId: data.session_id ?? '', userId: data.user_id ?? '', expiresIn: data.expires_in ?? 0 };
  }
  if (res.ok && data?.object === 'sign_in_attempt' && data.id && (data.status === 'needs_second_factor' || data.status === 'needs_mfa_enrollment')) {
    return { kind: 'needs_mfa', attemptId: data.id, status: data.status };
  }
  if (res.status === 429) return { kind: 'refused', outcome: 'rate_limited', status: 429 };
  const outcome = data?.errors?.[0]?.meta?.bridge_outcome;
  if (outcome && (KNOWN_REFUSALS as string[]).includes(outcome)) return { kind: 'refused', outcome: outcome as MigrationBridgeRefusal, status: res.status };
  // Anything else (a 5xx, a guard refusal, an unparsable body) is not a verdict on the old session: keep it.
  return { kind: 'refused', outcome: 'unavailable', status: res.status };
}

type HeaderBag = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

/** Everything the bridge sees of a request. */
export interface MigrationBridgeRequest {
  headers: HeaderBag;
  /** The end user's IP as your framework resolved it (forwarded on the secret-key path). */
  ip?: string;
}

/**
 * Pull the old token out of a request yourself — for a vendor whose cookie is
 * encrypted with a secret only your server has (nextjs-auth0, WorkOS AuthKit,
 * Auth.js JWT sessions): open it locally and return the JWT inside. Return
 * undefined when the request carries no old session.
 */
export type MigrationTokenExtractor = (input: { cookies: Record<string, string>; headers: HeaderBag }) => string | undefined | Promise<string | undefined>;

export interface MigrationBridgeOptions {
  /** The migration source (`auth0`, `clerk`, `cognito`, `supabase`, `better_auth` …). */
  source: string;
  fapiOrigin: string;
  publishableKey: string;
  /** The instance secret key: exchanges go through the Backend API (recommended). */
  secretKey?: string;
  bapiBaseUrl?: string;
  /** The bridge preset (default: the preset named like the source). */
  preset?: string;
  /** Variables the preset's cookie names need (`project_ref`, `client_id`, `cookie_prefix` …). */
  presetVars?: Record<string, string>;
  /** Cookie names to read, instead of the preset's (`*` wildcards allowed). */
  cookieNames?: string[];
  /** Cookie names to clear after an exchange, instead of the preset's. */
  clearCookieNames?: string[];
  /** How the cookie holds the token (`raw`, `supabase`); default the preset's. */
  tokenFormat?: TokenFormat;
  /** A custom extractor; replaces cookie reading entirely. */
  extractToken?: MigrationTokenExtractor;
  /** Also read `Authorization: Bearer` (default: the preset's choice). */
  bearer?: boolean;
  /** The `domain` the old cookies were set on, so they clear. */
  oldCookieDomain?: string;
  /** Mark the Atlas cookies `Secure`. Default true; false only for plain-http local development. */
  secure?: boolean;
  fetchImpl?: typeof fetch;
}

/** What the bridge decided for one request. */
export type MigrationBridgeDecision =
  /** No old session, or an Atlas session already present: carry on. */
  | { action: 'none' }
  /** Exchanged: set these cookies and re-enter (redirect to the same URL) so the new session is read. */
  | { action: 'signed_in'; cookies: BridgeCookie[]; session: Extract<MigrationExchangeResult, { kind: 'session' }> }
  /** A second factor is owed: send the browser to your sign-in page carrying the attempt. */
  | { action: 'needs_mfa'; cookies: BridgeCookie[]; attemptId: string; status: string; continuationUrl: (url: string) => string }
  /** Refused. `cookies` clears the old cookies when the refusal is final. */
  | { action: 'refused'; cookies: BridgeCookie[]; outcome: MigrationBridgeRefusal };

/** Refusals that say the old session will never exchange: its cookies are cleared. */
const FINAL: MigrationBridgeRefusal[] = ['invalid', 'signature_invalid', 'expired', 'reused', 'user_unavailable', 'user_unknown'];

function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  return Array.isArray(value) ? value.join('; ') : value;
}

/** Parse a Cookie header into name → raw value (first occurrence wins). */
export function parseCookieHeader(cookieHeader: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

/** The unverified `iss` of a compact JWT (routing only; Atlas verifies). */
function peekIss(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = JSON.parse(decodeBase64Url(parts[1]!)) as { iss?: unknown };
    return typeof json.iss === 'string' ? json.iss : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The token in the PocketBase JS SDK's `authStore.exportToCookie()` cookie (`pb_auth`: JSON `{ token, record }`). */
export function readPocketBaseCookieToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw.startsWith('%7B') || raw.startsWith('%7b') ? decodeURIComponent(raw) : raw) as { token?: unknown };
    return typeof v?.token === 'string' && v.token ? v.token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Supabase SSR cookie: `sb-<ref>-auth-token` (or chunks `.0`, `.1`, … joined in
 * order), the value JSON or `base64-` + base64url(JSON), holding `access_token`.
 */
export function readSupabaseAccessToken(cookies: Record<string, string>, baseName: string): string | undefined {
  return readSupabaseCookieField(cookies, baseName, 'access_token');
}

/**
 * The refresh token in the same cookie (`refresh_token`, or the second entry
 * of the older auth-helpers array): what the `supabase_refresh_token`
 * session-table preset looks up among the sessions a dump of
 * auth.refresh_tokens imported.
 */
export function readSupabaseRefreshToken(cookies: Record<string, string>, baseName: string): string | undefined {
  return readSupabaseCookieField(cookies, baseName, 'refresh_token');
}

function readSupabaseCookieField(cookies: Record<string, string>, baseName: string, field: 'access_token' | 'refresh_token'): string | undefined {
  let raw = cookies[baseName];
  if (raw === undefined) {
    const chunks: string[] = [];
    for (let i = 0; cookies[`${baseName}.${i}`] !== undefined; i++) chunks.push(cookies[`${baseName}.${i}`]!);
    if (!chunks.length) return undefined;
    raw = chunks.join('');
  }
  try {
    let text = decodeURIComponent(raw);
    if (text.startsWith('base64-')) text = decodeBase64Url(text.slice('base64-'.length));
    const parsed = JSON.parse(text) as unknown;
    const token = Array.isArray(parsed) ? parsed[field === 'access_token' ? 0 : 1] : (parsed as Record<string, unknown> | null)?.[field];
    return typeof token === 'string' && token ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the cookie names / format / bearer flag the bridge uses for its source. */
export function bridgeCookieConfig(options: Pick<MigrationBridgeOptions, 'source' | 'preset' | 'presetVars' | 'cookieNames' | 'clearCookieNames' | 'tokenFormat' | 'bearer'>) {
  const presetId = options.preset ?? (getMigrationBridgePreset(options.source) ? options.source : undefined);
  let cookies: string[] = [];
  let clear: string[] = [];
  let format: TokenFormat = 'raw';
  let bearer = false;
  let sharesAtlasCookie = false;
  let issuer: string | null = null;
  if (presetId) {
    try {
      const r = resolveMigrationBridgePreset(presetId, options.presetVars ?? {});
      cookies = r.cookies;
      clear = r.clearCookies;
      format = r.tokenFormat;
      bearer = r.bearer;
      sharesAtlasCookie = r.sharesAtlasCookie;
      issuer = r.issuer;
    } catch {
      // A preset whose cookie names need variables the app did not pass: only explicit names work.
      const p = getMigrationBridgePreset(presetId);
      cookies = (p?.cookies ?? []).filter((c) => !c.includes('{'));
      clear = (p?.clearCookies ?? p?.cookies ?? []).filter((c) => !c.includes('{'));
      format = p?.tokenFormat ?? 'raw';
      bearer = p?.bearer === true;
      sharesAtlasCookie = p?.sharesAtlasCookie === true;
    }
  }
  if (options.cookieNames) cookies = options.cookieNames;
  if (options.clearCookieNames) clear = options.clearCookieNames;
  else if (options.cookieNames) clear = options.cookieNames;
  return {
    cookies,
    clear,
    format: options.tokenFormat ?? format,
    bearer: options.bearer ?? bearer,
    sharesAtlasCookie: sharesAtlasCookie || cookies.includes('__session'),
    issuer,
  };
}

/**
 * The bridge as a function of a request's headers. Call it from middleware
 * before your normal auth check; it does nothing (no network) for a request
 * without an old session, or with an Atlas session already present.
 */
export function createMigrationBridge(options: MigrationBridgeOptions) {
  const secure = options.secure !== false;
  const config = bridgeCookieConfig(options);

  const clearOld = (present: Record<string, string>): BridgeCookie[] => {
    const names = new Set<string>();
    for (const pattern of config.clear) {
      if (!pattern.includes('*')) {
        names.add(pattern);
        continue;
      }
      for (const name of Object.keys(present)) if (cookieNameMatches(pattern, name)) names.add(name);
    }
    return [...names].map((name) => ({
      name,
      value: '',
      options: {
        path: '/',
        maxAge: 0,
        ...(options.oldCookieDomain ? { domain: options.oldCookieDomain } : {}),
        ...(name.startsWith('__Secure-') || name.startsWith('__Host-') ? { secure: true } : {}),
      },
    }));
  };

  const readToken = async (request: MigrationBridgeRequest, cookies: Record<string, string>): Promise<{ token: string; fromAtlasCookie: boolean } | undefined> => {
    if (options.extractToken) {
      const t = await options.extractToken({ cookies, headers: request.headers });
      return t ? { token: t, fromAtlasCookie: false } : undefined;
    }
    for (const pattern of config.cookies) {
      const names = pattern.includes('*') ? Object.keys(cookies).filter((n) => cookieNameMatches(pattern, n)).sort() : [pattern];
      for (const name of names) {
        const token = config.format === 'supabase' ? readSupabaseAccessToken(cookies, name) : config.format === 'supabase_refresh' ? readSupabaseRefreshToken(cookies, name) : config.format === 'pocketbase' ? readPocketBaseCookieToken(cookies[name]) : cookies[name];
        if (token) return { token, fromAtlasCookie: name === '__session' };
      }
    }
    if (config.bearer) {
      const auth = header(request.headers, 'authorization');
      const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
      if (m && config.issuer && peekIss(m[1]!) === config.issuer) return { token: m[1]!, fromAtlasCookie: false };
    }
    return undefined;
  };

  return async function bridge(request: MigrationBridgeRequest): Promise<MigrationBridgeDecision> {
    const cookies = parseCookieHeader(header(request.headers, 'cookie'));
    const found = await readToken(request, cookies);
    if (!found) return { action: 'none' };
    // Already on Atlas: an Atlas refresh cookie means the switch happened.
    if (cookies.__atlas_rt) return { action: 'none' };
    // `__session` is Atlas's own cookie name, and a few vendors (Clerk, Firebase
    // Hosting, nextjs-auth0) use it too. A token read from it is the vendor's
    // only when it carries the vendor's issuer (which needs the preset's
    // variables); otherwise an Atlas session (a JWT with another issuer) means
    // the user is already on Atlas.
    if (found.fromAtlasCookie) {
      if (!config.issuer || peekIss(found.token) !== config.issuer) return { action: 'none' };
    } else if (cookies.__session) {
      const iss = peekIss(cookies.__session);
      const atlasSession = !config.sharesAtlasCookie || (iss !== undefined && iss !== config.issuer);
      if (atlasSession) return { action: 'none' };
    }

    const result = await exchangeMigrationSession({
      source: options.source,
      fapiOrigin: options.fapiOrigin,
      publishableKey: options.publishableKey,
      token: found.token,
      fetchImpl: options.fetchImpl,
      userAgent: header(request.headers, 'user-agent'),
      secretKey: options.secretKey,
      bapiBaseUrl: options.bapiBaseUrl,
      clientIp: request.ip ?? clientIpFrom(request.headers),
    });

    if (result.kind === 'session') {
      const old = clearOld(cookies).filter((c) => c.name !== '__session');
      return {
        action: 'signed_in',
        session: result,
        cookies: [
          { name: '__session', value: result.jwt, options: { path: '/', sameSite: 'lax', secure } },
          { name: '__atlas_rt', value: result.refreshToken, options: { path: '/', httpOnly: true, sameSite: 'lax', secure } },
          ...old,
        ],
      };
    }
    if (result.kind === 'needs_mfa') {
      return {
        action: 'needs_mfa',
        attemptId: result.attemptId,
        status: result.status,
        cookies: clearOld(cookies),
        continuationUrl: (url: string) => {
          const next = new URL(url);
          next.searchParams.set('__atlas_attempt', result.attemptId);
          next.searchParams.set('__atlas_status', result.status);
          return next.toString();
        },
      };
    }
    return { action: 'refused', outcome: result.outcome, cookies: FINAL.includes(result.outcome) ? clearOld(cookies) : [] };
  };
}

/** The client IP a proxy in front of your server recorded (first X-Forwarded-For hop, or X-Real-IP). */
function clientIpFrom(headers: HeaderBag): string | undefined {
  const xff = header(headers, 'x-forwarded-for');
  const first = xff?.split(',')[0]?.trim();
  return first || header(headers, 'x-real-ip')?.trim() || undefined;
}
