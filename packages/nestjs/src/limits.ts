/**
 * Rate limiting and grant-usage gates for this adapter. Both wrap the framework-neutral checks from
 * `@atlasauth/backend` (`rateLimitRequest`, `requireGrantUsage`) and accept either the limiter /
 * usage options or an already-built check. A limit store or usage call that throws is an error, never an allow.
 */
import { rateLimitRequest, requireGrantUsage, requireStepUp, requireFeature } from '@atlasauth/backend';
import { HttpException, Inject, Injectable, type CanActivate, type DynamicModule, type ExecutionContext } from '@nestjs/common';
import { getRequest, type AtlasRequest } from './request';

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

// ── NestJS ───────────────────────────────────────────────────────────────────

/** Injection token for the rate-limit gate (provide it with {@link AtlasLimitsModule}). */
export const ATLAS_RATE_LIMIT = 'ATLAS_RATE_LIMIT';
/** Injection token for the grant-usage gate (provide it with {@link AtlasLimitsModule}). */
export const ATLAS_GRANT_USAGE = 'ATLAS_GRANT_USAGE';
/** Injection token for the step-up gate (provide it with {@link AtlasLimitsModule}). */
export const ATLAS_STEP_UP = 'ATLAS_STEP_UP';

/** Injection token for the feature gate (provide it with {@link AtlasLimitsModule}). */
export const ATLAS_FEATURE = 'ATLAS_FEATURE';

type NestRequest = AtlasRequest & { atlasToken?: { claims?: object }; ip?: string; headers: Record<string, string | string[] | undefined> };
type NestResponse = { setHeader?(name: string, value: string): unknown; header?(name: string, value: string): unknown };

async function run(gate: LimitGate, context: ExecutionContext): Promise<boolean> {
  const request = getRequest(context) as NestRequest;
  const claims = request.atlasToken?.claims ?? request.atlas?.claims;
  const verdict = await gate({ claims, headers: request.headers, ip: request.ip });
  const response = context.switchToHttp().getResponse<NestResponse>();
  for (const [k, v] of Object.entries(verdict.headers ?? {})) (response.setHeader ?? response.header)?.call(response, k, v);
  if (!verdict.allowed) throw new HttpException(denialBody(verdict) as Record<string, unknown>, verdict.status);
  return true;
}

/** Guard: rate limits the route (429, `RateLimit-*` and `Retry-After` headers). Use after `AtlasGuard`. */
@Injectable()
export class AtlasRateLimitGuard implements CanActivate {
  constructor(@Inject(ATLAS_RATE_LIMIT) private readonly gate: LimitGate) {}
  canActivate(context: ExecutionContext): Promise<boolean> {
    return run(this.gate, context);
  }
}

/** Guard: consumes a grant counter (429 when spent, 403 when the grant is missing or expired). Use after `AtlasGuard`. */
@Injectable()
export class AtlasGrantUsageGuard implements CanActivate {
  constructor(@Inject(ATLAS_GRANT_USAGE) private readonly gate: LimitGate) {}
  canActivate(context: ExecutionContext): Promise<boolean> {
    return run(this.gate, context);
  }
}

/** Guard: the session must meet a named step-up policy, else 403 STEP_UP_REQUIRED with the policy and factors. Use after `AtlasGuard`. */
@Injectable()
export class AtlasStepUpGuard implements CanActivate {
  constructor(@Inject(ATLAS_STEP_UP) private readonly gate: LimitGate) {}
  canActivate(context: ExecutionContext): Promise<boolean> {
    return run(this.gate, context);
  }
}

/** Guard: the subject's plan must include the feature (401 without a subject, 403 `feature_not_entitled`). Use after `AtlasGuard`. */
@Injectable()
export class AtlasFeatureGuard implements CanActivate {
  constructor(@Inject(ATLAS_FEATURE) private readonly gate: LimitGate) {}
  canActivate(context: ExecutionContext): Promise<boolean> {
    return run(this.gate, context);
  }
}

/** Options for {@link AtlasLimitsModule.register}. */
export interface AtlasLimitsModuleOptions {
  rateLimit?: RateLimiter | RateLimitCheck;
  subjectFrom?: RateLimitSubjectFrom;
  grantUsage?: GrantUsageOptions | GrantUsageCheck;
  stepUp?: StepUpOptions | StepUpCheck;
  feature?: FeatureOptions | FeatureCheck;
}

/**
 * Provides the gates the two guards inject.
 * `AtlasLimitsModule.register({ rateLimit: limiter })`, then `@UseGuards(AtlasGuard, AtlasRateLimitGuard)`.
 */
export class AtlasLimitsModule {
  static register(options: AtlasLimitsModuleOptions): DynamicModule {
    const providers = [
      ...(options.rateLimit ? [{ provide: ATLAS_RATE_LIMIT, useValue: rateLimitGate(options.rateLimit, options.subjectFrom) }] : []),
      ...(options.grantUsage ? [{ provide: ATLAS_GRANT_USAGE, useValue: grantUsageGate(options.grantUsage) }] : []),
      ...(options.feature ? [{ provide: ATLAS_FEATURE, useValue: featureGate(options.feature) }] : []),
      ...(options.stepUp ? [{ provide: ATLAS_STEP_UP, useValue: stepUpGate(options.stepUp) }] : []),
    ];
    return { module: AtlasLimitsModule, global: true, providers, exports: providers.map((p) => p.provide) };
  }
}

function mergeHeaders(base: Headers, extra: LimitHeaders): Headers {
  const h = new Headers(base);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}
