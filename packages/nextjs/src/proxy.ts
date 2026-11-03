import {
  CSRF_COOKIE,
  checkCsrfToken,
  csrfToken,
  deriveCsrfSecret,
  readCookieValue,
  verifyCsrf,
} from '@atlasauth/backend';
import {
  SIGNED_OUT,
  UNAUTHENTICATED_BODY,
  createAtlasDecider,
  type AtlasCookie,
  type AtlasMiddlewareOptions,
  type AuthState,
  type EdgeRequest,
} from './middleware';

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts` (exporting `proxy` or a
 * default function) and made it run on the Node.js runtime by default. A proxy
 * is usually a CHAIN — auth, then i18n (next-intl), then whatever else — so the
 * shape that composes is not "Atlas returns the final response" but "Atlas
 * returns a response only when it must act, otherwise steps aside":
 *
 * ```ts
 * const atlas = atlasProxy({ ... });
 * export async function proxy(req: NextRequest) {
 *   return (await atlas(req)) ?? withAtlasHeaders(req, intl(req));
 * }
 * ```
 *
 * `atlas(req)` resolves to a `Response` (sign-in redirect, handshake bounce,
 * 401 for an API route) or `null` (let the app continue). The verified auth
 * state is remembered for that request, so {@link withAtlasHeaders} can forward
 * it to the app on WHATEVER response the rest of the chain produced — without
 * verifying the token a second time and without Atlas having to own the final
 * response.
 *
 * Everything here is Web-standard (`Response`, `Headers`, `URL`, Web Crypto),
 * so the same proxy runs on the Node.js runtime and on the Edge runtime.
 */

/** Request headers the proxy forwards to the app (server components, route
 *  handlers) describing the verified session. */
export const ATLAS_AUTH_HEADERS = {
  status: 'x-atlas-auth-status',
  userId: 'x-atlas-user-id',
  sessionId: 'x-atlas-session-id',
  orgId: 'x-atlas-org-id',
  orgRole: 'x-atlas-org-role',
  /** With `csrf`: the CSRF token valid for this session, to render into forms (`atlas_csrf`). */
  csrfToken: 'x-atlas-csrf-token',
} as const;

const ATLAS_HEADER_PREFIX = 'x-atlas-';
const OVERRIDE_LIST = 'x-middleware-override-headers';
const OVERRIDE_PREFIX = 'x-middleware-request-';

/** What `atlasProxy` needs from a request: a `NextRequest` satisfies it. */
export interface ProxyRequest extends EdgeRequest {
  headers: {
    get(name: string): string | null;
    forEach(callback: (value: string, key: string) => void): void;
  };
}

/** The request-headers slice of a response — `NextResponse` and `Response`
 *  both satisfy it. */
export interface HeaderCarryingResponse {
  status: number;
  headers: Headers;
}

export type AtlasProxy = (request: ProxyRequest) => Promise<Response | null>;

/** Options for {@link AtlasProxyOptions.csrf}. */
export interface AtlasProxyCsrfOptions {
  /**
   * The HMAC secret (16+ characters). Default `ATLAS_CSRF_SECRET`, else derived
   * from `ATLAS_SECRET_KEY` (HKDF), so `verifyCsrf` in your own handlers can use
   * the same one.
   */
  secret?: string;
  /** Your Frontend API path mount, which Atlas protects itself. Default `ATLAS_BASE_PATH` or `/atlas`. */
  mountBasePath?: string;
}

export interface AtlasProxyOptions extends AtlasMiddlewareOptions {
  /**
   * CSRF protection for signed-in browsers. The proxy keeps a session-bound
   * token in the `__atlas_csrf` cookie (readable by your JS) and refuses a
   * POST / PUT / PATCH / DELETE with 403 unless it carries the same token in
   * the `x-atlas-csrf` header or an `atlas_csrf` form field. Requests with
   * `Authorization: Bearer`, signed-out requests and the mount base path are
   * exempt. The cookie is set by {@link withAtlasHeaders}; server components
   * read the token from the `x-atlas-csrf-token` request header.
   */
  csrf?: boolean | AtlasProxyCsrfOptions;
}

/** Auth state per request, recorded by the proxy for `withAtlasHeaders` /
 *  `proxyAuth`. Weak, so a finished request's state is collected with it. */
const resolved = new WeakMap<object, AuthState>();
/** The CSRF token per request, and whether the cookie must be (re)set. */
const csrfState = new WeakMap<object, { token: string; setCookie: boolean; secure: boolean }>();

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function csrfCookie(token: string, secure: boolean): string {
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function underBase(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** The CSRF gate: a 403 to return, or null after recording the request's token. */
function createCsrfGate(option: true | AtlasProxyCsrfOptions) {
  const config = option === true ? {} : option;
  let secret: string | undefined;
  return async function gate(request: ProxyRequest, auth: AuthState): Promise<Response | null> {
    if (!auth.sessionId) return null;
    if (request.headers.get('authorization')?.startsWith('Bearer ')) return null;
    const env = readEnv();
    const base = `/${(config.mountBasePath ?? env.ATLAS_BASE_PATH ?? '/atlas').replace(/^\/+|\/+$/g, '')}`;
    if (underBase(request.nextUrl.pathname, base)) return null;
    if (!secret) {
      secret = config.secret ?? env.ATLAS_CSRF_SECRET ?? (env.ATLAS_SECRET_KEY ? deriveCsrfSecret(env.ATLAS_SECRET_KEY) : undefined);
      if (!secret) throw new Error('@atlasauth/nextjs atlasProxy({ csrf }): set ATLAS_CSRF_SECRET or ATLAS_SECRET_KEY.');
    }
    const opts = { sid: auth.sessionId, secret };
    const secure = !(request.url ?? '').startsWith('http:');
    const existing = readCookieValue(request.headers.get('cookie'), CSRF_COOKIE);
    const state =
      existing && checkCsrfToken(existing, opts)
        ? { token: existing, setCookie: false, secure }
        : { token: csrfToken(opts), setCookie: true, secure };
    csrfState.set(request, state);

    if (!UNSAFE_METHODS.has((request.method ?? 'GET').toUpperCase())) return null;
    if (await verifyCsrf(request, opts)) return null;
    const headers = new Headers({ 'content-type': 'application/json' });
    if (state.setCookie) headers.append('set-cookie', csrfCookie(state.token, secure));
    return new Response(JSON.stringify({ errors: [{ code: 'CSRF_TOKEN_INVALID' }] }), { status: 403, headers });
  };
}

function serializeCookie({ name, value, options }: AtlasCookie): string {
  // Same encoding Next's `response.cookies.set` applies, so readers agree.
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1)}`);
  }
  return parts.join('; ');
}

/**
 * The Next.js 16 `proxy.ts` entry for Atlas. Same options, same decisions as
 * `atlasMiddleware` (they share one engine) — only the calling convention
 * differs: it takes just the request and resolves to `Response | null`.
 */
export function atlasProxy(options: AtlasProxyOptions): AtlasProxy {
  const decide = createAtlasDecider(options);
  const csrfGate = options.csrf ? createCsrfGate(options.csrf) : null;

  return async function proxy(request) {
    const decision = await decide(request);
    resolved.set(request, decision.auth);

    switch (decision.kind) {
      case 'continue':
        return csrfGate ? csrfGate(request, decision.auth) : null;

      case 'unauthorized':
        return new Response(JSON.stringify(UNAUTHENTICATED_BODY), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });

      case 'redirect': {
        // Built by hand rather than `Response.redirect`, whose headers are
        // immutable — the handshake legs must also set first-party cookies.
        const headers = new Headers({ location: decision.location });
        for (const cookie of decision.cookies) headers.append('set-cookie', serializeCookie(cookie));
        return new Response(null, { status: 307, headers });
      }
    }
  };
}

/**
 * The auth state the proxy resolved for this request (signed-out if the proxy
 * hasn't run on it). For extra checks inside `proxy.ts` itself — a role gate on
 * `/admin`, say — without verifying the token again.
 */
export function proxyAuth(request: object): AuthState {
  return resolved.get(request) ?? SIGNED_OUT;
}

/** The CSRF token `atlasProxy({ csrf })` holds for this request (null without `csrf` or when signed out). */
export function proxyCsrfToken(request: object): string | null {
  return csrfState.get(request)?.token ?? null;
}

function authHeaderValues(auth: AuthState, csrf?: string): Array<[string, string]> {
  const values: Array<[string, string]> = [
    [ATLAS_AUTH_HEADERS.status, auth.userId ? 'signed-in' : 'signed-out'],
  ];
  if (auth.userId) values.push([ATLAS_AUTH_HEADERS.userId, auth.userId]);
  if (auth.sessionId) values.push([ATLAS_AUTH_HEADERS.sessionId, auth.sessionId]);
  if (auth.orgId) values.push([ATLAS_AUTH_HEADERS.orgId, auth.orgId]);
  if (auth.orgRole) values.push([ATLAS_AUTH_HEADERS.orgRole, auth.orgRole]);
  if (csrf) values.push([ATLAS_AUTH_HEADERS.csrfToken, csrf]);
  return values;
}

/**
 * Forward the verified session to the app as `x-atlas-*` REQUEST headers on a
 * response produced by any later step of the chain (`NextResponse.next()`, a
 * next-intl rewrite, …). Returns the same response, for `return withAtlasHeaders(...)`.
 *
 * It speaks Next's request-header override protocol (what
 * `NextResponse.next({ request: { headers } })` emits), MERGING with any
 * override a previous step already set rather than clobbering it, so it composes
 * with next-intl or your own header tweaks in either order.
 *
 * Any `x-atlas-*` header the CLIENT sent is always dropped — a browser can't
 * forge `x-atlas-user-id` past the proxy. Responses that don't continue to the
 * app (redirects, direct bodies) are returned untouched: there's no downstream
 * request to carry headers.
 *
 * `auth` defaults to what {@link atlasProxy} resolved for `request`, or
 * signed-out if it didn't run.
 */
export function withAtlasHeaders<R extends HeaderCarryingResponse>(
  request: ProxyRequest,
  response: R,
  auth: AuthState = proxyAuth(request),
): R {
  const csrf = csrfState.get(request);
  if (csrf?.setCookie) {
    try {
      response.headers.append('set-cookie', csrfCookie(csrf.token, csrf.secure));
    } catch {
      // Immutable headers (a bare `Response.redirect`): the next response sets it.
    }
  }
  const continues =
    response.headers.has('x-middleware-next') || response.headers.has('x-middleware-rewrite');
  if (!continues) return response;

  const existing = response.headers.get(OVERRIDE_LIST);
  const names = new Set<string>();

  if (existing !== null) {
    // An earlier step already chose the full downstream header set; keep its
    // choices and only take over the `x-atlas-*` namespace.
    for (const raw of existing.split(',')) {
      const name = raw.trim().toLowerCase();
      if (!name) continue;
      if (name.startsWith(ATLAS_HEADER_PREFIX)) {
        response.headers.delete(`${OVERRIDE_PREFIX}${name}`);
      } else {
        names.add(name);
      }
    }
  } else {
    // First override: start from the incoming request headers, as
    // `NextResponse.next({ request: { headers: new Headers(req.headers) } })` does.
    request.headers.forEach((value, key) => {
      const name = key.toLowerCase();
      if (name.startsWith(ATLAS_HEADER_PREFIX)) return;
      names.add(name);
      response.headers.set(`${OVERRIDE_PREFIX}${name}`, value);
    });
  }

  for (const [name, value] of authHeaderValues(auth, csrf?.token)) {
    names.add(name);
    response.headers.set(`${OVERRIDE_PREFIX}${name}`, value);
  }
  response.headers.set(OVERRIDE_LIST, [...names].join(','));
  return response;
}

/** The session as forwarded by {@link withAtlasHeaders}. */
export interface ForwardedAuth {
  signedIn: boolean;
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  /** With `atlasProxy({ csrf })`: the token to render as the `atlas_csrf` form field. */
  csrfToken: string | null;
}

/**
 * Read the `x-atlas-*` headers the proxy forwarded (e.g. from `await headers()`
 * in a server component). Cheap — no verification — so use it for rendering
 * decisions; keep authorization on `auth()`/`protect()`, which verify the token
 * themselves and don't depend on the proxy's matcher covering the route.
 */
export function readAtlasHeaders(headers: { get(name: string): string | null }): ForwardedAuth {
  const userId = headers.get(ATLAS_AUTH_HEADERS.userId);
  const signedIn = headers.get(ATLAS_AUTH_HEADERS.status) === 'signed-in' && Boolean(userId);
  return {
    signedIn,
    userId: signedIn ? userId : null,
    sessionId: signedIn ? headers.get(ATLAS_AUTH_HEADERS.sessionId) : null,
    orgId: signedIn ? headers.get(ATLAS_AUTH_HEADERS.orgId) : null,
    orgRole: signedIn ? headers.get(ATLAS_AUTH_HEADERS.orgRole) : null,
    csrfToken: signedIn ? headers.get(ATLAS_AUTH_HEADERS.csrfToken) : null,
  };
}
