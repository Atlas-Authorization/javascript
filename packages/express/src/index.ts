import {
  AtlasBackend,
  ForbiddenError,
  createBetterAuthBridge,
  createMigrationBridge,
  serializeBridgeCookie,
  type MigrationBridgeDecision,
  type MigrationBridgeRequest,
  type MigrationTokenExtractor,
  type TokenFormat,
  type LegacyIssuer,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type SessionClaims,
} from '@atlasauth/backend';
// Real Express types, type-only so `express` is a peer dependency and is NEVER
// bundled or pinned — the middleware/handlers then type against genuine Express
// types, so a consumer passes the `req`/`res` it already has with no cast.
import type { Request, RequestHandler } from 'express';

// Re-export the real Express types so an integrator can name them from
// `@atlasauth/express` directly, the same way the backend surface is re-exported.
export type { Request, Response, NextFunction, RequestHandler } from 'express';

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
  /**
   * Moving from Better Auth: exchange a visitor's Better Auth session cookie
   * (read here, server-side) ONCE for an Atlas session on a page navigation,
   * set the Atlas cookies, clear the Better Auth ones and re-enter on the same
   * URL. Needs `publishableKey`. See {@link BetterAuthBridgeConfig}.
   */
  betterAuthBridge?: boolean | BetterAuthBridgeConfig;
  /**
   * Moving from any other vendor (Auth0, Clerk, Cognito, Firebase, Supabase …):
   * the same zero-logout exchange for that vendor's session cookie or token.
   * Needs `publishableKey`. See {@link MigrationBridgeConfig}.
   */
  migrationBridge?: MigrationBridgeConfig;
  /** The Atlas Frontend API origin. Defaults to the origin of `jwksUrl`. */
  fapiOrigin?: string;
  /** Also accept your old provider's JWTs for a bounded window (see `AtlasBackendOptions.legacyIssuers`). */
  legacyIssuers?: readonly LegacyIssuer[];
  /**
   * The instance secret key. Used by `legacyIssuers` to map an old `sub` to the Atlas user, and by
   * `betterAuthBridge` to exchange through the Backend API (limited per instance for a bulk cutover,
   * the user's IP and user agent forwarded) instead of the per-IP Frontend API.
   */
  secretKey?: string;
  bapiBaseUrl?: string;
}

/** Options for {@link AtlasMiddlewareOptions.betterAuthBridge}. */
export interface BetterAuthBridgeConfig {
  /** Better Auth's `advanced.cookiePrefix` (default `better-auth`). */
  cookiePrefix?: string;
  /** The session cookie's full name, when the old app overrode it. */
  cookieName?: string;
  /** The domain the Better Auth cookies were set on, so they clear. */
  cookieDomain?: string;
  /** Where a user who still owes a second factor finishes signing in. Default: the requested URL. */
  signInUrl?: string;
  /** Mark the Atlas cookies Secure. Default true. */
  secure?: boolean;
}

/** Options for {@link AtlasMiddlewareOptions.migrationBridge}. */
export interface MigrationBridgeConfig {
  /** The vendor you are moving from (`auth0`, `clerk`, `cognito`, `supabase`, …). */
  source: string;
  /** The bridge preset (default: the one named like `source`). */
  preset?: string;
  /** Variables the preset's cookie names need (`client_id`, `project_ref`, …). */
  presetVars?: Record<string, string>;
  /** Cookie names to read instead of the preset's (`*` wildcards allowed). */
  cookieNames?: string[];
  /** Cookie names to clear after an exchange instead of the preset's. */
  clearCookieNames?: string[];
  tokenFormat?: TokenFormat;
  /** Open an encrypted vendor cookie locally and return the token inside. */
  extractToken?: MigrationTokenExtractor;
  /** Also read `Authorization: Bearer` tokens from the vendor. */
  bearer?: boolean;
  /** The domain the old cookies were set on, so they clear. */
  cookieDomain?: string;
  /** Where a user who still owes a second factor finishes signing in. Default: the requested URL. */
  signInUrl?: string;
  /** Mark the Atlas cookies Secure. Default true. */
  secure?: boolean;
}

export {
  createBetterAuthBridge,
  createMigrationBridge,
  exchangeMigrationSession,
  type MigrationBridgeDecision,
  type MigrationExchangeResult,
  type MigrationTokenExtractor,
  exchangeBetterAuthSession,
  readBetterAuthSessionCookie,
  type BetterAuthBridgeDecision,
  type BetterAuthExchangeResult,
  type LegacyIssuer,
} from '@atlasauth/backend';

/**
 * The Better Auth session bridge as Express middleware. Mounted by
 * {@link atlasMiddleware} when `betterAuthBridge` is set; usable on its own
 * (before your auth middleware) too.
 */
export function betterAuthBridge(
  options: Pick<AtlasMiddlewareOptions, 'jwksUrl' | 'publishableKey' | 'fapiOrigin' | 'fetchImpl' | 'secretKey' | 'bapiBaseUrl'> & {
    config?: BetterAuthBridgeConfig;
  },
): RequestHandler {
  if (!options.publishableKey) throw new Error('betterAuthBridge needs `publishableKey`.');
  const config = options.config ?? {};
  const bridge = createBetterAuthBridge({
    fapiOrigin: options.fapiOrigin ?? new URL(options.jwksUrl).origin,
    publishableKey: options.publishableKey,
    cookiePrefix: config.cookiePrefix,
    cookieName: config.cookieName,
    betterAuthCookieDomain: config.cookieDomain,
    secure: config.secure,
    // With the secret key the exchange uses the Backend API (per-instance limit, user IP forwarded).
    secretKey: options.secretKey,
    bapiBaseUrl: options.bapiBaseUrl,
    fetchImpl: options.fetchImpl,
  });
  return bridgeHandler(bridge, config.signInUrl);
}

/**
 * The zero-logout bridge for any vendor as Express middleware. Mounted by
 * {@link atlasMiddleware} when `migrationBridge` is set; usable on its own
 * (before your auth middleware) too.
 *
 * @example
 * app.use(migrationBridge({ jwksUrl, publishableKey, secretKey, config: { source: 'cognito', presetVars: { client_id } } }));
 */
export function migrationBridge(
  options: Pick<AtlasMiddlewareOptions, 'jwksUrl' | 'publishableKey' | 'fapiOrigin' | 'fetchImpl' | 'secretKey' | 'bapiBaseUrl'> & {
    config: MigrationBridgeConfig;
  },
): RequestHandler {
  if (!options.publishableKey) throw new Error('migrationBridge needs `publishableKey`.');
  const config = options.config;
  const bridge = createMigrationBridge({
    source: config.source,
    preset: config.preset,
    presetVars: config.presetVars,
    cookieNames: config.cookieNames,
    clearCookieNames: config.clearCookieNames,
    tokenFormat: config.tokenFormat,
    extractToken: config.extractToken,
    bearer: config.bearer,
    oldCookieDomain: config.cookieDomain,
    secure: config.secure,
    fapiOrigin: options.fapiOrigin ?? new URL(options.jwksUrl).origin,
    publishableKey: options.publishableKey,
    secretKey: options.secretKey,
    bapiBaseUrl: options.bapiBaseUrl,
    fetchImpl: options.fetchImpl,
  });
  return bridgeHandler(bridge, config.signInUrl);
}

type BridgeFn = (request: MigrationBridgeRequest) => Promise<MigrationBridgeDecision>;

/** Render a bridge decision: a 307 back to the same URL (or the sign-in URL) carrying the cookies. */
function bridgeHandler(bridge: BridgeFn, signInUrl: string | undefined): RequestHandler {
  return function bridgeMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    bridge({ headers: req.headers, ip: req.ip })
      .then((outcome) => {
        if (outcome.action === 'none' || (outcome.action === 'refused' && outcome.cookies.length === 0)) return next();
        const here = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;
        const location =
          outcome.action === 'needs_mfa'
            ? outcome.continuationUrl(signInUrl ? new URL(signInUrl, here).toString() : here)
            : req.originalUrl;
        res.append('Set-Cookie', outcome.cookies.map(serializeBridgeCookie));
        res.redirect(307, location);
      })
      .catch(() => next());
  };
}

/**
 * Decorate the REAL Express `Request` with `req.atlas`, so a route reads
 * `req.atlas` / `getAuth(req)` on a genuine Express request with no structural
 * cast — the global-namespace augmentation idiom `@clerk/express` and Passport
 * use.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Decorated by {@link atlasMiddleware}; read it via {@link getAuth}. */
      atlas?: AtlasAuth;
    }
  }
}

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
  req: Request,
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
    legacyIssuers: options.legacyIssuers,
    secretKey: options.secretKey,
    bapiBaseUrl: options.bapiBaseUrl,
  });
  const bridges: RequestHandler[] = [];
  if (options.betterAuthBridge) bridges.push(betterAuthBridge({ ...options, config: options.betterAuthBridge === true ? {} : options.betterAuthBridge }));
  if (options.migrationBridge) bridges.push(migrationBridge({ ...options, config: options.migrationBridge }));

  return function middleware(req, res, next) {
    // Each bridge either answers (a redirect carrying the new cookies) or hands
    // on to the next one, and finally to the normal verification below.
    const run = (i: number): void => {
      const bridge = bridges[i];
      if (!bridge) return authenticate(req, next);
      bridge(req, res, () => run(i + 1));
    };
    run(0);
  };

  function authenticate(req: Request, next: (err?: unknown) => void): void {
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
  }
}

/**
 * Read the auth state a prior {@link atlasMiddleware} attached. Returns the
 * signed-out default when the middleware has not run (or left nothing), so a
 * caller never has to null-check `req.atlas` itself — mirrors Clerk's
 * `getAuth(req)`.
 */
export function getAuth(req: Request): AtlasAuth {
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

// ── Protecting an API / MCP server with Atlas-issued OAuth access tokens ────

import {
  createAccessTokenVerifier,
  type AccessTokenClaims,
  type AccessTokenVerifierOptions,
} from '@atlasauth/backend';
export {
  createAccessTokenVerifier,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
  type AccessTokenClaims,
  type AccessTokenResult,
  type AccessTokenVerifierOptions,
} from '@atlasauth/backend';

/** The verified OAuth access token on `req.atlasToken` after {@link requireAccessToken}. */
export interface AtlasAccessToken {
  claims: AccessTokenClaims;
  subject: string;
  clientId: string | null;
  scopes: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by {@link requireAccessToken}. */
      atlasToken?: AtlasAccessToken;
    }
  }
}

/**
 * Gate a route on an Atlas-issued OAuth access token for YOUR API (audience,
 * scopes, DPoP when bound). A failure answers 401/403 with the RFC 6750 /
 * RFC 9728 `WWW-Authenticate` challenge an MCP or OAuth client acts on.
 */
export function requireAccessToken(options: AccessTokenVerifierOptions): RequestHandler {
  const verify = createAccessTokenVerifier(options);
  return async (req, res, next) => {
    try {
      const url = `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
      const result = await verify({ method: req.method, url, headers: req.headers });
      // RFC 9449 §8 — the server nonce, on success and refusal alike.
      if (result.dpopNonce) res.set('DPoP-Nonce', result.dpopNonce);
      if (!result.ok) {
        res
          .status(result.status)
          .set('WWW-Authenticate', result.wwwAuthenticate)
          .json(result.error ? { error: result.error, error_description: result.description } : { error: 'unauthorized' });
        return;
      }
      req.atlasToken = { claims: result.claims, subject: result.subject, clientId: result.clientId, scopes: result.scopes };
      next();
    } catch (err) {
      next(err);
    }
  };
}
