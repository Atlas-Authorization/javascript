import {
  AtlasBackend,
  authenticateHeaders,
  signedOutAuth,
  type AtlasBackendOptions,
  type ProtectCondition,
  type RequestAuth,
} from '@atlasauth/backend';

export { ForbiddenError, type ProtectCondition, type RequestAuth as AtlasAuth, type SessionClaims } from '@atlasauth/backend';

/** The slice of a Koa context the adapter touches (so Koa itself stays a peer, never bundled). */
export interface KoaContextLike {
  headers: Record<string, string | string[] | undefined>;
  state: Record<string, unknown>;
  status: number;
  body: unknown;
}
export type KoaNext = () => Promise<unknown>;
export type KoaMiddleware = (ctx: KoaContextLike, next: KoaNext) => Promise<void>;

/** Verification is local against the instance JWKS; `jwksUrl` + `issuer` are the whole contract. */
export type AtlasKoaOptions = Pick<AtlasBackendOptions, 'jwksUrl' | 'issuer' | 'authorizedParties' | 'fetchImpl'>;

/**
 * Authenticate every request and put the result on `ctx.state.atlas`. Never throws and never blocks:
 * a missing or bad token leaves the signed-out state. Gate routes with {@link requireAuth}.
 *
 * @example
 * app.use(atlasMiddleware({ jwksUrl, issuer }));
 */
export function atlasMiddleware(options: AtlasKoaOptions): KoaMiddleware {
  const backend = new AtlasBackend(options);
  return async (ctx, next) => {
    ctx.state.atlas = await authenticateHeaders(backend, ctx.headers);
    await next();
  };
}

/** The auth state a prior {@link atlasMiddleware} attached (signed out when it has not run). */
export function getAuth(ctx: Pick<KoaContextLike, 'state'>): RequestAuth {
  return (ctx.state.atlas as RequestAuth | undefined) ?? signedOutAuth();
}

/**
 * Reject a signed-out request with 401, or one failing `condition` with 403.
 * Chain it after {@link atlasMiddleware}.
 */
export function requireAuth(condition?: ProtectCondition): KoaMiddleware {
  return async (ctx, next) => {
    const auth = getAuth(ctx);
    if (!auth.userId) {
      ctx.status = 401;
      ctx.body = { errors: [{ code: 'UNAUTHENTICATED' }] };
      return;
    }
    if (condition && !auth.has(condition)) {
      ctx.status = 403;
      ctx.body = { errors: [{ code: 'FORBIDDEN' }] };
      return;
    }
    await next();
  };
}
