import {
  AtlasBackend,
  ForbiddenError,
  createAccessTokenVerifier,
  createWebhookHandler,
  evaluate,
  hasFromClaims,
  rateLimitRequest,
  requireGrantUsage,
  type AccessTokenVerifierOptions,
  type AtlasBackendOptions,
  type ProtectCondition,
  type SessionClaims,
  type WebhookHandlerOptions,
} from '@atlasauth/backend';

/**
 * `@atlasauth/workers`: Atlas for Cloudflare Workers, Deno, Bun and any runtime that speaks Web `Request` /
 * `Response`, without a framework. Everything here is networkless on the hot path: the session or access token
 * is verified locally against cached JWKS (the only outbound call is a cold JWKS fetch on an unknown `kid`).
 *
 * ```ts
 * import { createAtlas } from '@atlasauth/workers';
 *
 * const atlas = createAtlas((env: Env) => ({ jwksUrl: env.ATLAS_JWKS_URL, issuer: env.ATLAS_ISSUER }));
 *
 * export default {
 *   fetch: atlas.withAuth(async (request, { auth }) => Response.json({ userId: auth.userId }), { permission: 'org:billing:read' }),
 * };
 * ```
 */

export { ForbiddenError, evaluate, hasFromClaims, verifyAtlasWebhook, verifyAtlasWebhookRequest } from '@atlasauth/backend';
export type { SessionClaims, ProtectCondition, ProtectOutcome, AccessTokenVerifierOptions } from '@atlasauth/backend';

/** The session cookie name, the same across every Atlas SDK. */
export const SESSION_COOKIE = '__session' as const;

/** The verified claims of the signed-in user (or nothing) with the same `has` / `protect` helpers as every adapter. */
export interface AtlasAuth {
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  claims: SessionClaims | null;
  /** `true` exactly when `userId` is set. */
  isSignedIn: boolean;
  /** True when the claims satisfy the condition (an empty condition means signed in). */
  has(condition?: ProtectCondition): boolean;
  /** Throws `ForbiddenError` when the condition is unmet (signed in when no condition is given). */
  protect(condition?: ProtectCondition): asserts this is AtlasAuth & { userId: string };
}

function buildAuth(claims: SessionClaims | null): AtlasAuth {
  return {
    userId: claims?.sub ?? null,
    sessionId: claims?.sid ?? null,
    orgId: claims?.org_id ?? null,
    orgRole: claims?.org_role ?? null,
    claims,
    isSignedIn: claims !== null,
    has: (condition = {}) => hasFromClaims(claims, condition),
    protect(condition = {}) {
      const outcome = evaluate(claims, condition);
      if (!outcome.allowed) throw new ForbiddenError(outcome.reason, condition);
    },
  };
}

/** The signed-out auth object: every field null, `has()` false, `protect()` throws. */
export const SIGNED_OUT: AtlasAuth = buildAuth(null);

/** What `createAtlas` needs. `jwksUrl` and `issuer` are required: an unchecked issuer accepts any Atlas instance. */
export interface AtlasWorkerOptions {
  jwksUrl: string;
  issuer: string;
  previousIssuers?: string[];
  /** Refuse a token minted for a different origin (`azp`). */
  authorizedParties?: readonly string[];
  /** Instance secret key; needed by `revocation` and `legacyIssuers`. */
  secretKey?: string;
  bapiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  legacyIssuers?: AtlasBackendOptions['legacyIssuers'];
  /** Also reject a token whose session Atlas has revoked, within the poll interval. Needs `secretKey` with `sessions:read`. */
  revocation?: boolean | { intervalMs?: number };
}

/** Options as an object, or a function of the runtime's bindings (a Worker's `env`, read per request). */
export type AtlasWorkerConfig<Env> = AtlasWorkerOptions | ((env: Env) => AtlasWorkerOptions);

/** What a limit gate decided. A denial carries the status (429 or 403) and body to send. */
export type LimitVerdict =
  | { allowed: true; headers?: Record<string, string> }
  | { allowed: false; status: number; headers?: Record<string, string>; body?: unknown };

/** A limiter from `createRateLimiter` in `@atlasauth/backend`, or an already-built `rateLimitRequest` check. */
export type RateLimiter = Parameters<typeof rateLimitRequest>[0];
export type RateLimitCheck = ReturnType<typeof rateLimitRequest>;
export type RateLimitSubjectFrom = Parameters<typeof rateLimitRequest>[1];
/** Options for `requireGrantUsage` in `@atlasauth/backend`, or an already-built check. */
export type GrantUsageOptions = Parameters<typeof requireGrantUsage>[0];
export type GrantUsageCheck = ReturnType<typeof requireGrantUsage>;

/** Whatever a gate needs to see of a request. */
export interface GateInput {
  claims: object | null | undefined;
  headers: Record<string, string>;
  ip?: string;
}

/** The context every `withAuth` handler receives. */
export interface AuthContext<Env> {
  auth: AtlasAuth;
  env: Env;
}

/** A Worker-style handler: the request, then the bindings and execution context the runtime passes (both optional). */
export type FetchHandler<Env> = (request: Request, env: Env, ctx?: unknown) => Response | Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const readCookie = (header: string | null, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
};

const headerRecord = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

/** The client address from the headers Cloudflare and common proxies set. Only trust these behind such a proxy. */
export function clientIp(headers: Record<string, string>): string | undefined {
  return headers['cf-connecting-ip'] || headers['x-forwarded-for']?.split(',')[0]?.trim() || headers['x-real-ip'] || undefined;
}

function withHeaders(response: Response, headers?: Record<string, string>): Response {
  if (!headers || Object.keys(headers).length === 0) return response;
  // A response from fetch() has frozen headers, so build a fresh one.
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

function denial(v: Extract<LimitVerdict, { allowed: false }>): Response {
  return json(v.status, v.body ?? { errors: [{ code: v.status === 429 ? 'RATE_LIMITED' : 'FORBIDDEN' }] }, v.headers);
}

const defaultSubject = (req: { claims?: Record<string, unknown> | null; ip?: string }) => {
  const c = req.claims ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return { userId: str(c.sub), orgId: str(c.org_id), machineId: str(c.machine_id), ip: req.ip };
};

/** The Atlas helpers for one configuration. Build once at module scope. */
export interface AtlasWorker<Env> {
  /** Resolve the signed-in user from `Authorization: Bearer` (wins) or the `__session` cookie. Never throws: an unverifiable token is signed out. */
  authenticate(request: Request, env?: Env): Promise<AtlasAuth>;
  /**
   * The auth object, or a 401 (signed out) / 403 (`condition` unmet) `Response` to return as is.
   * A signed-out browser navigation is not redirected: that is your app's decision.
   */
  requireAuth(request: Request, condition?: ProtectCondition, env?: Env): Promise<AtlasAuth | Response>;
  /** Wrap a handler so it only runs for a request that satisfies `condition`; it receives `{ auth, env }`. */
  withAuth(handler: (request: Request, context: AuthContext<Env>, ctx?: unknown) => Response | Promise<Response>, condition?: ProtectCondition): FetchHandler<Env>;
  /** Rate limit by user, org, machine and address (or your `subjectFrom`): a denial `Response` or `{ headers }` to add to yours. */
  rateLimit(limiter: RateLimiter | RateLimitCheck, options?: { subjectFrom?: RateLimitSubjectFrom; ip?: (request: Request) => string | undefined }): (request: Request, auth?: AtlasAuth) => Promise<Response | { headers: Record<string, string> }>;
  /** Spend a metered counter on a machine or agent grant: 429 when spent, 403 when the grant is missing or expired. */
  grantUsage(usage: GrantUsageOptions | GrantUsageCheck, options?: { claims?: (request: Request) => object | null | undefined | Promise<object | null | undefined> }): (request: Request, claims?: object | null) => Promise<Response | { headers: Record<string, string> }>;
  /** Gate a route on an Atlas-issued OAuth access token for YOUR API: a 401/403 `Response` with the RFC 6750 challenge, or the verified token. */
  requireAccessToken(options: AccessTokenVerifierOptions): (request: Request) => Promise<Response | { claims: object; subject: string; clientId: string; scopes: string[] }>;
  /** A `POST` handler for Atlas webhooks: verifies the signature, dedupes by event id and runs `onEvent`. */
  webhook(options: WebhookHandlerOptions): (request: Request) => Promise<Response>;
  /** Add the headers a gate returned to a response you built. */
  withHeaders: typeof withHeaders;
}

/**
 * Build the Atlas helpers. Pass the options, or a function of the runtime's bindings when they come from `env`
 * (the backend is built once per `env` object and reused).
 */
export function createAtlas<Env = unknown>(config: AtlasWorkerConfig<Env>): AtlasWorker<Env> {
  const cache = new WeakMap<object, { backend: AtlasBackend; revocation: { intervalMs?: number } | undefined }>();
  let fixed: { backend: AtlasBackend; revocation: { intervalMs?: number } | undefined } | undefined;

  const build = (options: AtlasWorkerOptions) => ({
    backend: new AtlasBackend({
      jwksUrl: options.jwksUrl,
      issuer: options.issuer,
      previousIssuers: options.previousIssuers,
      authorizedParties: options.authorizedParties,
      fetchImpl: options.fetchImpl,
      legacyIssuers: options.legacyIssuers,
      secretKey: options.secretKey,
      bapiBaseUrl: options.bapiBaseUrl,
    }),
    revocation: options.revocation ? (options.revocation === true ? {} : options.revocation) : undefined,
  });

  const resolve = (env: Env | undefined) => {
    if (typeof config !== 'function') return (fixed ??= build(config));
    if (env === undefined || env === null || typeof env !== 'object') throw new Error('createAtlas was given a function of `env`: pass the bindings to authenticate / requireAuth / withAuth.');
    let entry = cache.get(env as object);
    if (!entry) {
      entry = build(config(env));
      cache.set(env as object, entry);
    }
    return entry;
  };

  const authenticate = async (request: Request, env?: Env): Promise<AtlasAuth> => {
    const header = request.headers.get('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    const token = bearer ?? cookie;
    if (!token) return SIGNED_OUT;
    try {
      const { backend, revocation } = resolve(env);
      const result = revocation
        ? await backend.authenticateRequest(
            { headers: { authorization: bearer ? `Bearer ${bearer}` : undefined, cookie: bearer ? undefined : `${SESSION_COOKIE}=${cookie}` } },
            { revocation: { mode: 'sid_list', ...revocation } },
          )
        : await backend.verify(token);
      return result.ok ? buildAuth(result.claims) : SIGNED_OUT;
    } catch (err) {
      // A misconfiguration (function config without env) must surface; a verification failure is signed out.
      if (err instanceof Error && err.message.startsWith('createAtlas was given')) throw err;
      return SIGNED_OUT;
    }
  };

  const requireAuth = async (request: Request, condition?: ProtectCondition, env?: Env): Promise<AtlasAuth | Response> => {
    const auth = await authenticate(request, env);
    if (!auth.isSignedIn) return json(401, { errors: [{ code: 'UNAUTHENTICATED' }] }, { 'www-authenticate': 'Bearer' });
    if (condition) {
      const outcome = evaluate(auth.claims, condition);
      if (!outcome.allowed) return json(403, { errors: [{ code: 'FORBIDDEN', reason: outcome.reason }] });
    }
    return auth;
  };

  const gateInput = (request: Request, claims: object | null | undefined, ip?: string): GateInput => {
    const headers = headerRecord(request.headers);
    return { claims, headers, ip: ip ?? clientIp(headers) };
  };

  return {
    authenticate,
    requireAuth,
    withAuth(handler, condition) {
      return async (request, env, ctx) => {
        const auth = await requireAuth(request, condition, env);
        if (auth instanceof Response) return auth;
        return handler(request, { auth, env }, ctx);
      };
    },
    rateLimit(limiter, options = {}) {
      const check = (
        typeof limiter === 'function' ? limiter : rateLimitRequest(limiter, options.subjectFrom ?? (defaultSubject as unknown as RateLimitSubjectFrom))
      ) as (req: never) => Promise<LimitVerdict>;
      return async (request, auth) => {
        const verdict = await check(gateInput(request, auth?.claims, options.ip?.(request)) as never);
        return verdict.allowed ? { headers: verdict.headers ?? {} } : denial(verdict);
      };
    },
    grantUsage(usage, options = {}) {
      const check = (typeof usage === 'function' ? usage : requireGrantUsage(usage)) as (req: never) => Promise<LimitVerdict>;
      return async (request, claims) => {
        const verdict = await check(gateInput(request, claims ?? (await options.claims?.(request))) as never);
        return verdict.allowed ? { headers: verdict.headers ?? {} } : denial(verdict);
      };
    },
    requireAccessToken(options) {
      const verify = createAccessTokenVerifier(options);
      return async (request) => {
        const result = await verify({ method: request.method, url: request.url, headers: { get: (name: string) => request.headers.get(name) } });
        if (!result.ok) {
          return json(result.status, result.error ? { error: result.error, error_description: result.description } : { error: 'unauthorized' }, {
            'www-authenticate': result.wwwAuthenticate,
            ...(result.dpopNonce ? { 'dpop-nonce': result.dpopNonce } : {}),
          });
        }
        return { claims: result.claims, subject: result.subject, clientId: result.clientId, scopes: result.scopes } as never;
      };
    },
    webhook: (options) => createWebhookHandler(options),
    withHeaders,
  };
}
