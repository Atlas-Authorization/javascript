/**
 * Rate limiting and grant-usage gates for this adapter. Both wrap the framework-neutral checks from
 * `@atlasauth/backend` (`rateLimitRequest`, `requireGrantUsage`) and accept either the limiter /
 * usage options or an already-built check. A limit store or usage call that throws is an error, never an allow.
 */
import { rateLimitRequest, requireGrantUsage, requireStepUp, requireFeature } from '@atlasauth/backend';
import type { KoaContextLike, KoaMiddleware } from './index';

/** Options for the usage gate (`requireGrantUsage` in `@atlasauth/backend`). */
export type GrantUsageOptions = Parameters<typeof requireGrantUsage>[0];
/** The framework-neutral usage check `requireGrantUsage(opts)` returns. */
export type GrantUsageCheck = ReturnType<typeof requireGrantUsage>;
/** Options for the step-up gate (`requireStepUp` in `@atlasauth/backend`). */
export type StepUpOptions = Parameters<typeof requireStepUp>[0];
/** The framework-neutral step-up check `requireStepUp(opts)` returns. */
export type StepUpCheck = ReturnType<typeof requireStepUp>;
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

/** Turn step-up options (or an already-built `requireStepUp` check) into a gate: 403 STEP_UP_REQUIRED (with the policy and factors) until the session meets the named policy. */
export function stepUpGate(options: StepUpOptions | StepUpCheck): LimitGate {
  const check = (typeof options === 'function' ? options : requireStepUp(options)) as (req: never) => Promise<LimitVerdict>;
  return (input) => check(neutral(input));
}

/** Options for the feature gate (`requireFeature` in `@atlasauth/backend`). */
export type FeatureOptions = Parameters<typeof requireFeature>[0];
/** The framework-neutral feature check `requireFeature(opts)` returns. */
export type FeatureCheck = ReturnType<typeof requireFeature>;

/** Turn feature options (or an already-built `requireFeature` check) into a gate. */
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

// ── Koa ──────────────────────────────────────────────────────────────────────

/** The extra Koa context fields the limit middleware uses. */
export type KoaLimitContext = KoaContextLike & { ip?: string; set?(headers: Record<string, string>): void };

/** Options for the Koa limit middleware. */
export interface AtlasLimitOptions extends LimitWrapOptions<KoaContextLike> {
  /** Rate limit only: pick the subject yourself instead of user/org/machine/address. */
  subjectFrom?: RateLimitSubjectFrom;
}

const claimsOf = (ctx: KoaContextLike): LimitClaims =>
  (ctx.state.atlasToken as { claims?: object } | undefined)?.claims ?? (ctx.state.atlas as { claims?: object | null } | undefined)?.claims;

function middleware(gate: LimitGate, options: AtlasLimitOptions): KoaMiddleware {
  return async (ctx, next) => {
    const c = ctx as KoaLimitContext;
    const verdict = await gate({ claims: await (options.claims ?? claimsOf)(ctx), headers: ctx.headers, ip: c.ip });
    if (verdict.headers) c.set?.(verdict.headers);
    if (!verdict.allowed) {
      ctx.status = verdict.status;
      ctx.body = denialBody(verdict);
      return;
    }
    await next();
  };
}

/** Rate limit every request behind it: 429 with `Retry-After` and `RateLimit-*` headers when over. Use after `atlasMiddleware`. */
export function atlasRateLimit(limiter: RateLimiter | RateLimitCheck, options: AtlasLimitOptions = {}): KoaMiddleware {
  return middleware(rateLimitGate(limiter, options.subjectFrom), options);
}

/** Consume a grant counter before the route runs: 429 when spent, 403 when the grant is missing or expired. */
export function atlasGrantUsage(usage: GrantUsageOptions | GrantUsageCheck, options: AtlasLimitOptions = {}): KoaMiddleware {
  return middleware(grantUsageGate(usage), options);
}

/** Require the session to meet a named step-up policy before the route runs: 403 STEP_UP_REQUIRED with the policy and the factors to ask for, so the client can run `withStepUp(policy, fn)`. Use after `atlasMiddleware`. */
export function atlasStepUp(step: StepUpOptions | StepUpCheck, options: AtlasLimitOptions = {}): KoaMiddleware {
  return middleware(stepUpGate(step), options);
}

/** Allow the request only when the subject's plan includes a feature: 401 without a subject, 403 `feature_not_entitled` otherwise. Reads through an entitlement cache (`createEntitlementCache`). */
export function atlasRequireFeature(feature: FeatureOptions | FeatureCheck, options: AtlasLimitOptions = {}): KoaMiddleware {
  return middleware(featureGate(feature), options);
}

function mergeHeaders(base: Headers, extra: LimitHeaders): Headers {
  const h = new Headers(base);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}
