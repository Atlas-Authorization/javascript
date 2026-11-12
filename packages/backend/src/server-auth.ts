import { CSRF_COOKIE, checkCsrfToken, csrfToken, deriveCsrfSecret, readCookieValue, verifyCsrf } from './csrf';

/**
 * Shared by `@atlasauth/fastify`, `@atlasauth/express` and `@atlasauth/hono`:
 * the CSRF gate for cookie-authenticated browsers and the server-side initial
 * state for non-Next SSR. Same rules as the Next.js proxy.
 */

/** Options for the CSRF gate of the Fastify / Express / Hono auth plugins. */
export interface ServerCsrfOptions {
  /** HMAC secret (16+ chars). Default: `ATLAS_CSRF_SECRET`, else derived from `secretKey`. */
  secret?: string;
  /** Path where the Atlas mount lives; requests under it are skipped (default `/atlas`). */
  mountBasePath?: string;
  /** Mark the CSRF cookie Secure. Default: true unless the request is plain http. */
  secure?: boolean;
}

export type CsrfDecision =
  | { action: 'skip' }
  | { action: 'allow'; token: string; setCookie: string | null }
  | { action: 'refuse'; token: string; setCookie: string | null };

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Build the gate. Cookie-authenticated requests get a session-bound token in the
 * `__atlas_csrf` cookie; unsafe methods must echo it in `x-atlas-csrf`.
 * Bearer-authenticated, signed-out and mount-path requests are skipped.
 */
export function createServerCsrfGate(option: true | ServerCsrfOptions, secretKey?: string) {
  const config = option === true ? {} : option;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const secret = config.secret ?? env.ATLAS_CSRF_SECRET ?? (secretKey ? deriveCsrfSecret(secretKey) : undefined);
  if (!secret) throw new Error('csrf: set `csrf.secret`, ATLAS_CSRF_SECRET, or pass `secretKey`.');
  const base = `/${(config.mountBasePath ?? env.ATLAS_BASE_PATH ?? '/atlas').replace(/^\/+|\/+$/g, '')}`;

  return async function gate(req: {
    method: string;
    path: string;
    headers: { get(name: string): string | null };
    sessionId: string | null;
    https?: boolean;
  }): Promise<CsrfDecision> {
    if (!req.sessionId) return { action: 'skip' };
    if (req.headers.get('authorization')?.startsWith('Bearer ')) return { action: 'skip' };
    if (req.path === base || req.path.startsWith(`${base}/`)) return { action: 'skip' };
    const opts = { sid: req.sessionId, secret };
    const existing = readCookieValue(req.headers.get('cookie'), CSRF_COOKIE);
    const fresh = !(existing && checkCsrfToken(existing, opts));
    const token = fresh ? csrfToken(opts) : (existing as string);
    const secure = config.secure ?? req.https !== false;
    const setCookie = fresh ? `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}` : null;
    if (!UNSAFE.has(req.method.toUpperCase())) return { action: 'allow', token, setCookie };
    return (await verifyCsrf({ headers: req.headers }, opts))
      ? { action: 'allow', token, setCookie }
      : { action: 'refuse', token, setCookie };
  };
}

export interface ServerInitialStateOptions {
  publishableKey?: string;
  /** The Frontend API origin (include your mount path if path-mounted). */
  frontendApi?: string;
  /** Seconds to keep the public responses in process memory. Default 60; 0 disables. */
  cacheSeconds?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const publicCache = new Map<string, { at: number; value: unknown }>();

/**
 * The public sign-in data a client needs to hydrate without a flash: the
 * appearance and the sign-in environment (same two documents the Next.js
 * `getAtlasInitialState` fetches). Never throws; a part that cannot be fetched
 * is left out and the browser fetches it. Cached in process.
 */
export async function fetchPublicInitialState(
  options: ServerInitialStateOptions = {},
): Promise<{ appearance?: unknown; environment?: unknown }> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const publishableKey = options.publishableKey ?? env.ATLAS_PUBLISHABLE_KEY;
  const frontendApi = options.frontendApi ?? env.ATLAS_FRONTEND_API;
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!publishableKey || !frontendApi || !doFetch) return {};
  const base = frontendApi.replace(/\/+$/, '');
  const ttl = (options.cacheSeconds ?? 60) * 1000;
  const get = async (path: string): Promise<unknown> => {
    const key = `${base}${path}|${publishableKey}`;
    const hit = publicCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);
    try {
      const res = await doFetch(`${base}${path}`, {
        headers: { accept: 'application/json', 'x-publishable-key': publishableKey },
        signal: controller.signal,
      });
      const value = res.ok ? ((await res.json()) as unknown) : undefined;
      if (value && ttl > 0) publicCache.set(key, { at: Date.now(), value });
      return value;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  const [appearance, environment] = await Promise.all([get('/v1/appearance'), get('/v1/client/environment')]);
  const state: { appearance?: unknown; environment?: unknown } = {};
  if (appearance && typeof appearance === 'object') state.appearance = appearance;
  if (environment && typeof environment === 'object') state.environment = environment;
  return state;
}
