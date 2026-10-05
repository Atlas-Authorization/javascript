import {
  AtlasBackend,
  ForbiddenError,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type SessionClaims,
} from '@atlasauth/backend';

/**
 * `@atlasauth/express` — the Express.js adapter for Atlas auth, the server-side
 * twin of `@atlasauth/nextjs`. It mirrors `@clerk/express`: one middleware that
 * verifies the session and decorates the request, a `getAuth(req)` accessor, and
 * a `requireAuth()` gate.
 *
 * The design constraint that matters is §7.3: verification is LOCAL. The session
 * JWT is verified against the instance's JWKS, cached in-process by
 * `@atlasauth/backend`, so a warm server verifies every request with no network
 * call at all. A middleware that phoned Atlas on each request would add a round
 * trip to every route and make Atlas's latency and availability the customer's —
 * the exact thing local verification exists to avoid. There are NO Atlas
 * endpoints called here; this is pure local JWT verification.
 */

// Re-export the shared authorization primitives and the backend verifier, so an
// integrator imports everything they need for server-side auth from
// `@atlasauth/express` alone — the same `has`/`protect` contract the React
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
 * The verified auth state attached to `req.atlas`. Mirrors Clerk's Express
 * `req.auth`: identity fields plus the ergonomic `has`/`protect` helpers bound
 * to the verified claims. On a signed-out request every id is `null`, `has()`
 * returns `false`, and `protect()` throws.
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
 * Options for {@link atlasMiddleware} and {@link requireAuth}.
 *
 * `jwksUrl` + `issuer` are the whole verification contract — an unchecked issuer
 * would accept a token from any Atlas instance. `authorizedParties` optionally
 * pins `azp` so a token minted for one of the customer's apps cannot be replayed
 * against another. `publishableKey` is accepted for Clerk parity and future
 * client wiring; it plays no part in local verification.
 */
export interface AtlasMiddlewareOptions {
  jwksUrl: string;
  issuer: string;
  authorizedParties?: readonly string[];
  publishableKey?: string;
  /** Injectable fetch, for tests and custom transports. */
  fetchImpl?: typeof fetch;
}

/** The minimal Express request shape this adapter reads and decorates. Kept
 *  structural so the package needs no `@types/express` at build time, exactly
 *  as `@atlasauth/nextjs` avoids a hard Next.js dependency. A real
 *  `express.Request` satisfies it. */
export interface AtlasExpressRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Decorated by {@link atlasMiddleware}; read it via {@link getAuth}. */
  atlas?: AtlasAuth;
  [key: string]: unknown;
}

/** The minimal Express response shape {@link requireAuth} writes to. */
export interface AtlasExpressResponse {
  status(code: number): AtlasExpressResponse;
  json(body: unknown): unknown;
  [key: string]: unknown;
}

/** Express `next` callback. */
export type NextFunction = (err?: unknown) => void;

/** Express-style request handler. */
export type RequestHandler = (
  req: AtlasExpressRequest,
  res: AtlasExpressResponse,
  next: NextFunction,
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
 * reason the middleware is safe to `app.use()` globally: a throwing auth
 * middleware takes the entire app down on a malformed cookie, whereas degrading
 * to "signed out" simply routes the user to sign-in.
 */
export async function resolveAuth(
  backend: AtlasBackend,
  req: AtlasExpressRequest,
): Promise<AtlasAuth> {
  try {
    const header = firstHeader(req.headers.authorization ?? req.headers.Authorization);
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookie = readCookie(firstHeader(req.headers.cookie), '__session');

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
 * Express middleware that authenticates the request and attaches the auth state
 * to `req.atlas`. Reads the `__session` cookie (the short-lived Atlas session
 * JWT) or an `Authorization: Bearer` header — the header wins, because a caller
 * that set it deliberately should not be overridden by a stale cookie.
 *
 * It NEVER throws and NEVER blocks the request: verification failure leaves a
 * signed-out `req.atlas` and calls `next()`. Route protection is the job of
 * {@link requireAuth} or an explicit `getAuth(req).userId` check in the handler.
 *
 * @example
 * app.use(atlasMiddleware({ jwksUrl, issuer }));
 * app.get('/me', (req, res) => {
 *   const { userId } = getAuth(req);
 *   res.json({ userId });
 * });
 */
export function atlasMiddleware(options: AtlasMiddlewareOptions): RequestHandler {
  const backend = new AtlasBackend({
    jwksUrl: options.jwksUrl,
    issuer: options.issuer,
    authorizedParties: options.authorizedParties,
    fetchImpl: options.fetchImpl,
  });

  return function middleware(req, _res, next) {
    resolveAuth(backend, req)
      .then((auth) => {
        req.atlas = auth;
        next();
      })
      .catch(() => {
        // resolveAuth already fails closed, but guard the attach/next step too:
        // a signed-out decoration is always safe, a thrown middleware is not.
        req.atlas = signedOut();
        next();
      });
  };
}

/**
 * Read the auth state a prior {@link atlasMiddleware} attached. Returns the
 * signed-out default when the middleware has not run (or left nothing), so a
 * caller never has to null-check `req.atlas` itself — mirrors Clerk's
 * `getAuth(req)`.
 */
export function getAuth(req: AtlasExpressRequest): AtlasAuth {
  return req.atlas ?? signedOut();
}

/**
 * Middleware that requires a signed-in request. On a signed-out request it
 * responds `401` with `{ errors: [{ code: 'UNAUTHENTICATED' }] }` and does NOT
 * call `next()`; otherwise it calls `next()`. Chain it after
 * {@link atlasMiddleware}; if that has not run for this request, it authenticates
 * inline first (given `jwksUrl`/`issuer`), so `requireAuth(options)` also works
 * standalone on a single route.
 *
 * @example
 * app.use(atlasMiddleware({ jwksUrl, issuer }));
 * app.get('/protected', requireAuth(), (req, res) => { ... });
 */
export function requireAuth(options?: AtlasMiddlewareOptions): RequestHandler {
  const backend =
    options?.jwksUrl && options.issuer
      ? new AtlasBackend({
          jwksUrl: options.jwksUrl,
          issuer: options.issuer,
          authorizedParties: options.authorizedParties,
          fetchImpl: options.fetchImpl,
        })
      : null;

  return function requireAuthHandler(req, res, next) {
    const gate = (auth: AtlasAuth): void => {
      if (!auth.userId) {
        res.status(401).json({ errors: [{ code: 'UNAUTHENTICATED' }] });
        return;
      }
      next();
    };

    // Already decorated by atlasMiddleware upstream — the common case.
    if (req.atlas) {
      gate(req.atlas);
      return;
    }

    // Standalone use: authenticate inline when we were given the config, else
    // treat as signed out (fails closed with a 401 rather than crashing).
    if (!backend) {
      gate(signedOut());
      return;
    }

    resolveAuth(backend, req)
      .then((auth) => {
        req.atlas = auth;
        gate(auth);
      })
      .catch(() => gate(signedOut()));
  };
}
