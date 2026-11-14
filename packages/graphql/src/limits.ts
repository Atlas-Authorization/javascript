/**
 * Rate limiting and grant-usage gates for this adapter. Both wrap the framework-neutral checks from
 * `@atlasauth/backend` (`rateLimitRequest`, `requireGrantUsage`) and accept either the limiter /
 * usage options or an already-built check. A limit store or usage call that throws is an error, never an allow.
 */
import { rateLimitRequest, requireGrantUsage, requireFeature } from '@atlasauth/backend';
import { AtlasGraphQLError, type AtlasContext } from './index';

/** Options for the usage gate (`requireGrantUsage` in `@atlasauth/backend`). */
export type GrantUsageOptions = Parameters<typeof requireGrantUsage>[0];
/** The framework-neutral usage check `requireGrantUsage(opts)` returns. */
export type GrantUsageCheck = ReturnType<typeof requireGrantUsage>;
/** A limiter from `createRateLimiter` in `@atlasauth/backend`. */
export type RateLimiter = Parameters<typeof rateLimitRequest>[0];
/** Picks the rate-limit subject (key, user, org, machine, ip) out of a request. */
export type RateLimitSubjectFrom = Parameters<typeof rateLimitRequest>[1];
/** The framework-neutral rate-limit check `rateLimitRequest(limiter, subjectFrom)` returns. */
export type RateLimitCheck = ReturnType<typeof rateLimitRequest>;

/** Verified claims (a session or a machine/agent access token), or nothing when signed out. */
export type LimitClaims = object | null | undefined;
/** The headers a limit decision adds to the response (`RateLimit-*`, `Retry-After`). */
export type LimitHeaders = Record<string, string>;
/** What a limit gate decided. A denial carries the status (429 or 403) and body to send. */
export type LimitVerdict =
  | { allowed: true; headers?: LimitHeaders }
  | { allowed: false; status: number; headers?: LimitHeaders; body?: unknown };
/** What a gate reads from a request. `ip` is only used for the default rate-limit subject. */
export interface LimitInput {
  claims: LimitClaims;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}
/** One request-level gate: the shared shape every adapter wraps in its own idiom. */
export type LimitGate = (input: LimitInput) => Promise<LimitVerdict>;

/** Lower-case the header names and join repeated values, the shape both neutral checks expect. */
export function flattenHeaders(headers: LimitInput['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * The client address from `x-forwarded-for`. Only trust it behind a proxy that sets the header;
 * pass your own `ip` (or a `subjectFrom`) otherwise.
 */
export function forwardedIp(headers: Record<string, string>): string | undefined {
  return headers['x-forwarded-for']?.split(',')[0]?.trim() || headers['x-real-ip'] || undefined;
}

/** Default subject: the signed-in user, their active org, a machine id claim, and the address. */
function defaultSubject(req: { claims?: Record<string, unknown> | null; ip?: string }) {
  const c = req.claims ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return { userId: str(c.sub), orgId: str(c.org_id), machineId: str(c.machine_id), ip: req.ip };
}

function neutral(input: LimitInput) {
  return { claims: input.claims, headers: flattenHeaders(input.headers), ip: input.ip } as never;
}

/**
 * Turn a limiter (or an already-built `rateLimitRequest` check) into a gate.
 * Without `subjectFrom` the subject is the user, org, machine and address of the request.
 */
export function rateLimitGate(limiter: RateLimiter | RateLimitCheck, subjectFrom?: RateLimitSubjectFrom): LimitGate {
  const check = (
    typeof limiter === 'function' ? limiter : rateLimitRequest(limiter, subjectFrom ?? (defaultSubject as unknown as RateLimitSubjectFrom))
  ) as (req: never) => Promise<LimitVerdict>;
  return (input) => check(neutral(input));
}

/** Turn usage-gate options (or an already-built `requireGrantUsage` check) into a gate. */
export function grantUsageGate(options: GrantUsageOptions | GrantUsageCheck): LimitGate {
  const check = (typeof options === 'function' ? options : requireGrantUsage(options)) as (req: never) => Promise<LimitVerdict>;
  return (input) => check(neutral(input));
}

/** Options for the feature gate (`requireFeature` in `@atlasauth/backend`). */
export type FeatureOptions = Parameters<typeof requireFeature>[0];
/** The framework-neutral feature check `requireFeature(opts)` returns. */
export type FeatureCheck = ReturnType<typeof requireFeature>;

/** Turn feature options (or an already-built `requireFeature` check) into a gate: 401 without a subject, 403 `feature_not_entitled` when the plan lacks the feature. */
export function featureGate(options: FeatureOptions | FeatureCheck): LimitGate {
  const check = (typeof options === 'function' ? options : requireFeature(options)) as (req: never) => Promise<LimitVerdict>;
  return (input) => check(neutral(input));
}

/** The JSON body of a denial. */
export function denialBody(v: Extract<LimitVerdict, { allowed: false }>): unknown {
  return v.body ?? { errors: [{ code: v.status === 429 ? 'RATE_LIMITED' : 'FORBIDDEN' }] };
}

/** A fetch `Response` for a denial, for the adapters on the Web platform. */
export function denialResponse(v: Extract<LimitVerdict, { allowed: false }>): Response {
  return new Response(JSON.stringify(denialBody(v)), {
    status: v.status,
    headers: { 'content-type': 'application/json', ...(v.headers ?? {}) },
  });
}

/** Copy a Web `Headers` into the plain record the gates read. */
export function webHeaders(headers: { forEach(cb: (value: string, key: string) => void): void }): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Add the allow-path headers to a Web `Response`, ignoring one whose headers are frozen. */
export function withVerdictHeaders(response: Response, headers?: LimitHeaders): Response {
  if (!headers) return response;
  try {
    for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
    return response;
  } catch {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: mergeHeaders(response.headers, headers) });
  }
}

/** Options shared by every adapter wrapper. */
export interface LimitWrapOptions<Ctx> {
  /** Where the verified claims live on this framework's request. A sensible default is used where one exists. */
  claims?: (ctx: Ctx) => LimitClaims | Promise<LimitClaims>;
}

// ── GraphQL resolver wrappers ────────────────────────────────────────────────

/** A context that also exposes the request headers (Apollo and Yoga put them on `req`/`request`). */
type LimitContext = AtlasContext & {
  headers?: Record<string, string | string[] | undefined>;
  req?: { headers?: Record<string, string | string[] | undefined>; ip?: string };
};

/** Options for the resolver wrappers. */
export interface AtlasLimitOptions {
  /** Rate limit only: pick the subject yourself instead of user/org/machine/address. */
  subjectFrom?: RateLimitSubjectFrom;
  /** Where the headers live on your context. Default: `context.headers`, then `context.req.headers`. */
  headers?: (context: AtlasContext) => Record<string, string | string[] | undefined>;
  /** Where the verified token claims live. Default: the session on `context.atlas`. */
  claims?: (context: AtlasContext) => LimitClaims | Promise<LimitClaims>;
}

function wrap(gate: LimitGate, options: AtlasLimitOptions) {
  return <P, A, C extends AtlasContext, R>(
    resolver: (parent: P, args: A, context: C, info: unknown) => R,
  ): ((parent: P, args: A, context: C, info: unknown) => Promise<Awaited<R>>) =>
    async (parent, args, context, info): Promise<Awaited<R>> => {
      const c = context as LimitContext;
      const headers = options.headers?.(context) ?? c.headers ?? c.req?.headers ?? {};
      const claims = options.claims ? await options.claims(context) : context.atlas?.claims;
      const verdict = await gate({ claims, headers, ip: c.req?.ip });
      if (!verdict.allowed) throw new AtlasGraphQLError(verdict.status === 429 ? 'RATE_LIMITED' : 'FORBIDDEN', 'Request limit reached.', verdict.status, verdict.headers);
      return (await resolver(parent, args, context, info)) as Awaited<R>;
    };
}

/** Wrap a resolver so it is rate limited: throws `RATE_LIMITED` (HTTP 429, `extensions.http.headers` carry `Retry-After`) when over. */
export function withRateLimit(limiter: RateLimiter | RateLimitCheck, options: AtlasLimitOptions = {}) {
  return wrap(rateLimitGate(limiter, options.subjectFrom), options);
}

/** Wrap a resolver so it consumes a grant counter first: `RATE_LIMITED` (429) when spent, `FORBIDDEN` (403) when the grant is missing or expired. */
export function withGrantUsage(usage: GrantUsageOptions | GrantUsageCheck, options: AtlasLimitOptions = {}) {
  return wrap(grantUsageGate(usage), options);
}

/** Wrap a resolver so it needs a plan feature: `UNAUTHENTICATED`-style 401 without a subject, `FORBIDDEN` (403, `feature_not_entitled`) when the plan lacks it. */
export function withFeature(feature: FeatureOptions | FeatureCheck, options: AtlasLimitOptions = {}) {
  return wrap(featureGate(feature), options);
}

function mergeHeaders(base: Headers, extra: LimitHeaders): Headers {
  const h = new Headers(base);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}
