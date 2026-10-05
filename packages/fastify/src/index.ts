import {
  AtlasBackend,
  ForbiddenError,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type SessionClaims,
} from '@atlasauth/backend';

/**
 * `@atlasauth/fastify` — the Fastify adapter for Atlas auth, the server-side
 * twin of `@atlasauth/express`. It mirrors `@clerk/fastify`: one plugin that
 * registers a request hook, verifies the session and decorates `request.atlas`,
 * a `getAuth(request)` accessor, and a `requireAuth(request, reply)` gate.
 *
 * The design constraint that matters is §7.3: verification is LOCAL. The session
 * JWT is verified against the instance's JWKS, cached in-process by
 * `@atlasauth/backend`, so a warm server verifies every request with no network
 * call at all. A hook that phoned Atlas on each request would add a round trip to
 * every route and make Atlas's latency and availability the customer's — the
 * exact thing local verification exists to avoid. There are NO Atlas endpoints
 * called here; this is pure local JWT verification.
 */

// Re-export the shared authorization primitives and the backend verifier, so an
// integrator imports everything they need for server-side auth from
// `@atlasauth/fastify` alone — the same `has`/`protect` contract the React
// `<Protect>` and the Next.js `auth()` evaluate.
export {
  AtlasBackend,
  ForbiddenError,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type ProtectOutcome,
  type ProtectReason,
  type SessionClaims,
  type AuthorizedSession,
  type VerifyResult,
  type AtlasBackendOptions,
} from '@atlasauth/backend';

/**
 * The verified auth state attached to `request.atlas`. Mirrors Clerk's Fastify
 * `request.auth`: identity fields plus the ergonomic `has`/`protect` helpers
 * bound to the verified claims. On a signed-out request every id is `null`,
 * `has()` returns `false`, and `protect()` throws.
 */
export interface AtlasAuth {
  /** The subject (`sub`) — the signed-in user's id, or `null` when signed out. */
  userId: string | null;
  /** The session id (`sid`), or `null` when signed out. */
  sessionId: string | null;
  /** The active organization id (`org_id`), or `null`. */
  orgId: string | null;
  /** The user's role in the active organization (`org_role`), or `null`. */
  orgRole: string | null;
  /** The full verified claims, or `null` when signed out. */
  claims: SessionClaims | null;
  /** Convenience flag: `true` exactly when `userId` is non-null. */
  isSignedIn: boolean;
  /**
   * The impersonator when this is an impersonation session (RFC 8693 `act`),
   * else `null`. Read it to render the mandatory "viewing as X" banner and to
   * tag audit entries — never as an authorization input.
   */
  actor: { sub: string } | null;
  /**
   * Answer an authorization condition against the verified claims (permission /
   * role / anyPermission / allPermissions). An empty condition means "signed
   * in". Always `false` when signed out.
   */
  has(condition?: ProtectCondition): boolean;
  /**
   * Assert a condition, returning the claims on success and throwing
   * `ForbiddenError` otherwise (the app maps that to 401/403). Throws on a
   * signed-out request.
   */
  protect(condition?: ProtectCondition): SessionClaims;
}

/**
 * Options for {@link atlasPlugin}.
 *
 * `jwksUrl` + `issuer` are the whole verification contract — an unchecked issuer
 * would accept a token from any Atlas instance. `authorizedParties` optionally
 * pins `azp` so a token minted for one of the customer's apps cannot be replayed
 * against another. `publishableKey` is accepted for Clerk parity and future
 * client wiring; it plays no part in local verification. `hookName` selects the
 * lifecycle hook the plugin registers on (`preHandler` by default, as Clerk).
 */
export interface AtlasPluginOptions {
  jwksUrl: string;
  issuer: string;
  authorizedParties?: readonly string[];
  publishableKey?: string;
  /** Which Fastify request hook to run on. Default `preHandler`. */
  hookName?: 'onRequest' | 'preHandler';
  /** Injectable fetch, for tests and custom transports. */
  fetchImpl?: typeof fetch;
}

/** The lifecycle hooks {@link atlasPlugin} may attach to. */
export const ALLOWED_HOOKS = ['onRequest', 'preHandler'] as const;

/** The minimal Fastify request shape this adapter reads and decorates. Kept
 *  structural so the package needs no `fastify` type dependency at build time,
 *  exactly as `@atlasauth/express` keeps its Express types structural. A real
 *  `fastify.FastifyRequest` satisfies it. */
export interface AtlasFastifyRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Decorated by {@link atlasPlugin}; read it via {@link getAuth}. */
  atlas?: AtlasAuth | null;
  [key: string]: unknown;
}

/** The minimal Fastify reply shape {@link requireAuth} writes to. */
export interface AtlasFastifyReply {
  code(statusCode: number): AtlasFastifyReply;
  send(payload: unknown): unknown;
  [key: string]: unknown;
}

/** Fastify hook `done` callback (for non-async hooks). */
export type HookDone = (err?: unknown) => void;

/** The minimal Fastify instance shape {@link atlasPlugin} decorates and hooks. */
export interface AtlasFastifyInstance {
  decorateRequest(name: string, value: unknown): unknown;
  addHook(
    name: string,
    handler: (request: AtlasFastifyRequest, reply: AtlasFastifyReply) => Promise<void> | void,
  ): unknown;
  [key: string]: unknown;
}

/** Fastify plugin `done` callback. */
export type PluginDone = (err?: unknown) => void;

/** A Fastify plugin function, as produced by {@link atlasPlugin}. */
export type AtlasFastifyPlugin = (
  instance: AtlasFastifyInstance,
  opts: unknown,
  done: PluginDone,
) => void;

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * The signed-out auth state. `has()` is always `false` and `protect()` always
 * throws, so a route that forgets to check `userId` still fails closed.
 */
export function signedOut(): AtlasAuth {
  return {
    userId: null,
    sessionId: null,
    orgId: null,
    orgRole: null,
    claims: null,
    isSignedIn: false,
    actor: null,
    has: () => false,
    protect: (condition = {}) => {
      throw new ForbiddenError('signed_out', condition);
    },
  };
}

/** Build the signed-in auth state, binding `has`/`protect` to the claims —
 *  the same construction `@atlasauth/backend` uses for its `AuthorizedSession`. */
function signedIn(claims: SessionClaims): AtlasAuth {
  return {
    userId: claims.sub,
    sessionId: claims.sid,
    orgId: claims.org_id ?? null,
    orgRole: claims.org_role ?? null,
    claims,
    isSignedIn: true,
    actor:
      claims.act && typeof claims.act.sub === 'string' && claims.act.sub
        ? { sub: claims.act.sub }
        : null,
    has: (condition = {}) => hasFromClaims(claims, condition),
    protect: (condition = {}) => {
      const outcome = evaluate(claims, condition);
      if (!outcome.allowed) throw new ForbiddenError(outcome.reason, condition);
      return claims;
    },
  };
}

/**
 * Resolve the auth state for a request. A token that fails verification — or a
 * missing one — yields the signed-out state, NEVER a throw. This is the whole
 * reason the plugin is safe to register globally: a throwing auth hook takes the
 * whole route down on a malformed cookie, whereas degrading to "signed out"
 * simply routes the user to sign-in.
 */
export async function resolveAuth(
  backend: AtlasBackend,
  request: AtlasFastifyRequest,
): Promise<AtlasAuth> {
  try {
    const header = firstHeader(request.headers.authorization ?? request.headers.Authorization);
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookie = readCookie(firstHeader(request.headers.cookie), '__session');

    const token = bearer ?? cookie;
    if (!token) return signedOut();

    const result = await backend.verify(token);
    if (!result.ok) return signedOut();

    return signedIn(result.claims);
  } catch {
    // Any unexpected failure (a corrupt header, a JWKS transport error) still
    // degrades to signed-out rather than propagating and crashing the request.
    return signedOut();
  }
}

/**
 * A Fastify plugin that authenticates every request and attaches the auth state
 * to `request.atlas`. It reads the `__session` cookie (the short-lived Atlas
 * session JWT) or an `Authorization: Bearer` header — the header wins, because a
 * caller that set it deliberately should not be overridden by a stale cookie.
 *
 * Register it like any Fastify plugin; `atlasPlugin(options)` returns the plugin
 * function `(instance, opts, done)`. It decorates `request.atlas` and adds a
 * `preHandler` hook (or `onRequest`, via `options.hookName`) that runs
 * {@link resolveAuth}. The hook NEVER throws and NEVER blocks the request:
 * verification failure leaves a signed-out `request.atlas`. Route protection is
 * the job of {@link requireAuth} or an explicit `getAuth(request).userId` check
 * in the handler.
 *
 * @example
 * const app = Fastify();
 * app.register(atlasPlugin({ jwksUrl, issuer }));
 * app.get('/me', (request, reply) => {
 *   const { userId } = getAuth(request);
 *   reply.send({ userId });
 * });
 */
export function atlasPlugin(options: AtlasPluginOptions): AtlasFastifyPlugin {
  const hookName = options.hookName ?? 'preHandler';
  if (!ALLOWED_HOOKS.includes(hookName)) {
    throw new Error(`Unsupported hookName: ${hookName}`);
  }

  const backend = new AtlasBackend({
    jwksUrl: options.jwksUrl,
    issuer: options.issuer,
    authorizedParties: options.authorizedParties,
    fetchImpl: options.fetchImpl,
  });

  return function plugin(instance, _opts, done) {
    // Seed the decorator so every request carries the property (Fastify
    // optimises requests whose shape is declared up front).
    instance.decorateRequest('atlas', null);

    instance.addHook(hookName, async (request: AtlasFastifyRequest) => {
      // resolveAuth already fails closed, but guard the attach step too: a
      // signed-out decoration is always safe, a thrown hook is not.
      try {
        request.atlas = await resolveAuth(backend, request);
      } catch {
        request.atlas = signedOut();
      }
    });

    done();
  };
}

/**
 * Read the auth state a prior {@link atlasPlugin} attached. Returns the
 * signed-out default when the plugin has not run (or left nothing), so a caller
 * never has to null-check `request.atlas` itself — mirrors Clerk's
 * `getAuth(request)`.
 */
export function getAuth(request: AtlasFastifyRequest): AtlasAuth {
  return request.atlas ?? signedOut();
}

/**
 * Require a signed-in request. On a signed-out request it responds `401` with
 * `{ errors: [{ code: 'UNAUTHENTICATED' }] }` and returns `false`; otherwise it
 * returns `true` and sends nothing. Because sending a reply short-circuits a
 * Fastify request, it works directly as a `preHandler` — either called from one
 * or supplied as one.
 *
 * @example
 * app.get('/protected', { preHandler: requireAuth }, (request, reply) => { ... });
 * // or, imperatively:
 * app.get('/protected', (request, reply) => {
 *   if (!requireAuth(request, reply)) return;
 *   reply.send({ ok: true });
 * });
 */
export function requireAuth(request: AtlasFastifyRequest, reply: AtlasFastifyReply): boolean {
  const auth = getAuth(request);
  if (!auth.userId) {
    reply.code(401).send({ errors: [{ code: 'UNAUTHENTICATED' }] });
    return false;
  }
  return true;
}
