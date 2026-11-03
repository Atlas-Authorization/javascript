import {
  AtlasBackend,
  createAccessTokenVerifier,
  type AccessTokenVerifierOptions,
  type AtlasBackendOptions,
  type ProtectCondition,
} from '@atlasauth/backend';

/**
 * `@atlasauth/lambda-authorizer` — an API Gateway Lambda authorizer that checks
 * the token a request carries LOCALLY (cached JWKS, no call to Atlas on the hot
 * path) and answers with an IAM policy. Works for REST APIs (TOKEN and REQUEST
 * authorizers) and HTTP APIs (payload format 2.0, IAM policy or simple response).
 *
 * Fail closed: anything that is not a positively verified token (missing,
 * malformed, expired, wrong issuer/azp/audience, JWKS unreachable, unknown event
 * shape, a thrown error) is refused. On REST it throws `Unauthorized` (HTTP 401);
 * on HTTP APIs it answers a Deny / `isAuthorized: false` (HTTP 403).
 */

export type { AccessTokenVerifierOptions, AtlasBackendOptions, ProtectCondition } from '@atlasauth/backend';

export interface LambdaAuthorizerOptions {
  /** Verify Atlas session tokens (the `__session` cookie / Bearer session JWT). Options as for `AtlasBackend`, or an instance. */
  session?: AtlasBackendOptions | AtlasBackend;
  /** Verify OAuth access tokens (audience, requiredScopes ...). DPoP is not available through an authorizer. */
  accessToken?: Omit<AccessTokenVerifierOptions, 'requireDpop' | 'dpopNonces' | 'dpopReplayStore'>;
  /** Session tokens must also satisfy this (permission / role / org / plan / feature); a failure is a Deny (403). */
  condition?: ProtectCondition;
  /**
   * How far the Allow policy reaches. `method` (default) allows only the exact
   * method ARN the request is for; with API Gateway result caching on, a
   * second route then needs its own authorization. `stage` allows every route
   * and method of the stage, which is what cached authorizers on multi-route
   * APIs need; the token, not the route, is what you are authorizing.
   */
  policyScope?: 'method' | 'stage';
  /** HTTP API payload 2.0 response style. `iam` (default) returns a policy; `simple` returns `{ isAuthorized }` (enable simple responses on the authorizer). */
  httpApiResponse?: 'iam' | 'simple';
  /** How long a verified token result is reused inside this warm Lambda, in seconds (default 30, 0 disables; never past the token's `exp`). */
  cacheTtlSeconds?: number;
  /** Most cached results (default 1000). */
  cacheMax?: number;
  /** Extra context values handed to the backend (string/number/boolean only). */
  extraContext?: (principal: AuthorizedPrincipal) => Record<string, string | number | boolean>;
  now?: () => number;
}

/** What a verified token resolved to. */
export interface AuthorizedPrincipal {
  kind: 'session' | 'access_token';
  userId: string;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  clientId: string | null;
  scopes: string[];
  claims: Record<string, unknown>;
}

type Outcome =
  | { kind: 'allow'; principal: AuthorizedPrincipal; expMs: number | null }
  | { kind: 'deny' }
  | { kind: 'unauthorized' };

export interface PolicyResponse {
  principalId: string;
  policyDocument: {
    Version: '2012-10-17';
    Statement: { Action: 'execute-api:Invoke'; Effect: 'Allow' | 'Deny'; Resource: string }[];
  };
  context?: Record<string, string | number | boolean>;
}
export interface SimpleResponse {
  isAuthorized: boolean;
  context?: Record<string, string | number | boolean>;
}

/** Subset of the three event shapes API Gateway sends. */
export interface AuthorizerEvent {
  version?: string;
  type?: string;
  methodArn?: string;
  routeArn?: string;
  authorizationToken?: string;
  headers?: Record<string, string | undefined> | null;
  cookies?: string[];
  [key: string]: unknown;
}

function headerOf(headers: AuthorizerEvent['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower && typeof v === 'string') return v;
  return undefined;
}

function cookieValue(cookie: string, name: string): string | undefined {
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }
  return undefined;
}

/** The token a request carries: the Bearer header wins, then the `__session` cookie. Null when none. */
export function extractToken(event: AuthorizerEvent): string | null {
  const bearer = (v: string | undefined) => {
    const m = /^bearer +(\S+)$/i.exec(v?.trim() ?? '');
    return m ? m[1]! : null;
  };
  if (event.type === 'TOKEN') return bearer(event.authorizationToken);
  const fromHeader = bearer(headerOf(event.headers, 'authorization'));
  if (fromHeader) return fromHeader;
  const cookies = [...(event.cookies ?? []), headerOf(event.headers, 'cookie') ?? ''];
  for (const c of cookies) {
    const v = typeof c === 'string' ? cookieValue(c, '__session') : undefined;
    if (v) return v;
  }
  return null;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function scopeArn(arn: string, scope: 'method' | 'stage'): string {
  if (scope === 'method') return arn;
  // arn:aws:execute-api:region:account:apiId/stage/METHOD/path -> apiId/stage/*/*
  const colon = arn.split(':');
  if (colon.length < 6) return arn;
  const [apiId, stage] = colon.slice(5).join(':').split('/');
  return apiId && stage ? `${colon.slice(0, 5).join(':')}:${apiId}/${stage}/*/*` : arn;
}

function buildContext(p: AuthorizedPrincipal): Record<string, string | number | boolean> {
  const ctx: Record<string, string | number | boolean> = { tokenKind: p.kind, userId: p.userId };
  if (p.sessionId) ctx.sessionId = p.sessionId;
  if (p.orgId) ctx.orgId = p.orgId;
  if (p.orgRole) ctx.orgRole = p.orgRole;
  if (p.clientId) ctx.clientId = p.clientId;
  if (p.scopes.length) ctx.scopes = p.scopes.join(' ');
  return ctx;
}

const policy = (principalId: string, effect: 'Allow' | 'Deny', resource: string, context?: PolicyResponse['context']): PolicyResponse => ({
  principalId,
  policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }] },
  ...(context ? { context } : {}),
});

/**
 * Build the Lambda handler. Create it once, outside the handler function, so the
 * JWKS cache and the result cache live for the whole warm container.
 *
 * @example
 * ```ts
 * export const handler = createLambdaAuthorizer({
 *   session: { issuer: process.env.ATLAS_ISSUER!, authorizedParties: ['https://app.example.com'] },
 * });
 * ```
 */
export function createLambdaAuthorizer(options: LambdaAuthorizerOptions) {
  if (!options.session && !options.accessToken) {
    throw new Error('createLambdaAuthorizer needs `session` and/or `accessToken` options.');
  }
  const now = options.now ?? Date.now;
  const backend = options.session ? (options.session instanceof AtlasBackend ? options.session : new AtlasBackend(options.session)) : null;
  const verifyAccess = options.accessToken ? createAccessTokenVerifier({ ...options.accessToken, now: options.accessToken.now ?? options.now }) : null;
  const ttl = (options.cacheTtlSeconds ?? 30) * 1000;
  const max = options.cacheMax ?? 1000;
  const cache = new Map<string, { outcome: Outcome; until: number }>();

  async function resolve(token: string): Promise<Outcome> {
    let denied = false;
    if (backend) {
      const r = await backend.verify(token);
      if (r.ok) {
        if (options.condition && !r.has(options.condition)) return { kind: 'deny' };
        const c = r.claims;
        return {
          kind: 'allow',
          expMs: typeof c.exp === 'number' ? c.exp * 1000 : null,
          principal: {
            kind: 'session',
            userId: c.sub,
            sessionId: c.sid ?? null,
            orgId: c.org_id ?? null,
            orgRole: c.org_role ?? null,
            clientId: null,
            scopes: [],
            claims: c,
          },
        };
      }
    }
    if (verifyAccess) {
      const r = await verifyAccess({ headers: { authorization: `Bearer ${token}` } });
      if (r.ok) {
        return {
          kind: 'allow',
          expMs: typeof r.claims.exp === 'number' ? r.claims.exp * 1000 : null,
          principal: {
            kind: 'access_token',
            userId: r.subject,
            sessionId: null,
            orgId: null,
            orgRole: null,
            clientId: r.clientId,
            scopes: r.scopes,
            claims: r.claims,
          },
        };
      }
      denied = r.status === 403;
    }
    return denied ? { kind: 'deny' } : { kind: 'unauthorized' };
  }

  async function outcomeFor(token: string): Promise<Outcome> {
    const key = ttl > 0 ? await sha256Hex(token) : '';
    if (ttl > 0) {
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.outcome;
      if (hit) cache.delete(key);
    }
    let outcome: Outcome;
    try {
      outcome = await resolve(token);
    } catch {
      return { kind: 'unauthorized' }; // JWKS unreachable, bad config at runtime ...: never allow
    }
    // Only successes are cached: a refusal may be a transient JWKS problem, and caching Allow past `exp` is never done.
    if (ttl > 0 && outcome.kind === 'allow') {
      const until = Math.min(now() + ttl, outcome.expMs ?? Infinity);
      if (until > now()) {
        cache.set(key, { outcome, until });
        if (cache.size > max) {
          for (const [k, v] of cache) if (v.until <= now()) cache.delete(k);
          while (cache.size > max) cache.delete(cache.keys().next().value as string);
        }
      }
    }
    return outcome;
  }

  function context(p: AuthorizedPrincipal) {
    return { ...buildContext(p), ...(options.extraContext?.(p) ?? {}) };
  }

  async function handler(event: AuthorizerEvent): Promise<PolicyResponse | SimpleResponse> {
    const isV2 = event?.version === '2.0';
    const simple = isV2 && options.httpApiResponse === 'simple';
    const arn = (isV2 ? event.routeArn : event?.methodArn) ?? '';
    const refuse = (): PolicyResponse | SimpleResponse => {
      if (simple) return { isAuthorized: false };
      // REST: throwing 'Unauthorized' is the documented way to answer 401.
      if (!isV2) throw new Error('Unauthorized');
      return policy('anonymous', 'Deny', arn || '*');
    };
    if (!event || typeof event !== 'object' || typeof arn !== 'string' || !arn || (event.type !== 'TOKEN' && event.type !== 'REQUEST')) {
      return refuse();
    }
    const token = extractToken(event);
    if (!token) return refuse();
    const outcome = await outcomeFor(token);
    if (outcome.kind === 'unauthorized') return refuse();
    if (outcome.kind === 'deny') {
      if (simple) return { isAuthorized: false };
      return policy('anonymous', 'Deny', arn);
    }
    const ctx = context(outcome.principal);
    if (simple) return { isAuthorized: true, context: ctx };
    return policy(outcome.principal.userId, 'Allow', scopeArn(arn, options.policyScope ?? 'method'), ctx);
  }
  return handler;
}
