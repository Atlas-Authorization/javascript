import {
  AtlasBackend,
  authenticateHeaders,
  type AtlasBackendOptions,
  type ProtectCondition,
  type RequestAuth,
} from '@atlasauth/backend';

export { type ProtectCondition, type RequestAuth as AtlasAuth } from '@atlasauth/backend';

/** Verification is local against the instance JWKS; `jwksUrl` + `issuer` are the whole contract. */
export type AtlasGraphQLOptions = Pick<AtlasBackendOptions, 'jwksUrl' | 'issuer' | 'authorizedParties' | 'fetchImpl'>;

/** The GraphQL context field holding the verified session. */
export interface AtlasContext {
  atlas: RequestAuth;
}

type Headers = Record<string, string | string[] | undefined>;

/** An error graphql-js and Apollo surface to the client with a stable `extensions.code`. */
export class AtlasGraphQLError extends Error {
  readonly extensions: { code: 'UNAUTHENTICATED' | 'FORBIDDEN'; http: { status: number } };
  constructor(code: 'UNAUTHENTICATED' | 'FORBIDDEN', message: string) {
    super(message);
    this.name = 'AtlasGraphQLError';
    this.extensions = { code, http: { status: code === 'UNAUTHENTICATED' ? 401 : 403 } };
  }
}

/**
 * Build a context factory that verifies the request and returns `{ atlas }`. Works with any server
 * that hands you the request headers: Apollo (`context: async ({ req }) => ctx(req.headers)`),
 * Express GraphQL / graphql-http (`context: (req) => ctx(req.headers)`), Yoga, Mercurius.
 * It never throws: a bad token is a signed-out `atlas`, so public fields keep working.
 */
export function createAtlasContext(options: AtlasGraphQLOptions): (headers: Headers) => Promise<AtlasContext> {
  const backend = new AtlasBackend(options);
  return async (headers) => ({ atlas: await authenticateHeaders(backend, headers) });
}

/** Resolver guard: returns the auth state, or throws `UNAUTHENTICATED` / `FORBIDDEN`. */
export function requireUser(context: AtlasContext, condition?: ProtectCondition): RequestAuth {
  const auth = context.atlas;
  if (!auth?.userId) throw new AtlasGraphQLError('UNAUTHENTICATED', 'You must be signed in.');
  if (condition && !auth.has(condition)) throw new AtlasGraphQLError('FORBIDDEN', 'You do not have access to this.');
  return auth;
}

/**
 * Wrap a resolver so it only runs for a signed-in user (and one satisfying `condition`).
 * @example
 * const resolvers = { Query: { me: guard((_p, _a, ctx) => ctx.atlas.userId) } };
 */
export function guard<P, A, C extends AtlasContext, R>(
  resolver: (parent: P, args: A, context: C, info: unknown) => R,
  condition?: ProtectCondition,
): (parent: P, args: A, context: C, info: unknown) => R {
  return (parent, args, context, info) => {
    requireUser(context, condition);
    return resolver(parent, args, context, info);
  };
}
