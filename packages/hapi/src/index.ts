import {
  AtlasBackend,
  authenticateHeaders,
  type AtlasBackendOptions,
  type RequestAuth,
} from '@atlasauth/backend';

export { ForbiddenError, type ProtectCondition, type RequestAuth as AtlasAuth, type SessionClaims } from '@atlasauth/backend';

/** Verification is local against the instance JWKS; `jwksUrl` + `issuer` are the whole contract. */
export type AtlasHapiOptions = Pick<AtlasBackendOptions, 'jwksUrl' | 'issuer' | 'authorizedParties' | 'fetchImpl'> & {
  /** Name of the auth scheme/strategy registered by the plugin (default `atlas`). */
  name?: string;
  /** Make the strategy the server default so every route requires sign-in unless it opts out. Default false. */
  mode?: 'required' | 'try';
};

/** The slice of Hapi the plugin touches, so `@hapi/hapi` stays the app's own dependency. */
interface HapiRequestLike {
  headers: Record<string, string | string[] | undefined>;
}
interface HapiToolkitLike {
  authenticated(data: { credentials: unknown; artifacts?: unknown }): unknown;
  unauthenticated(error: Error, data?: { credentials: unknown }): unknown;
}
interface HapiServerLike {
  auth: {
    scheme(name: string, scheme: () => { authenticate: (request: HapiRequestLike, h: HapiToolkitLike) => Promise<unknown> }): void;
    strategy(name: string, scheme: string, options?: unknown): void;
    default?(strategy: string | { strategy: string; mode: string }): void;
  };
}

/** What `request.auth.credentials` holds after authentication. */
export interface AtlasCredentials {
  auth: RequestAuth;
  userId: string;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
}

/** Hapi plugin: `await server.register({ plugin: atlasPlugin, options })`. */
export const atlasPlugin = {
  name: 'atlasauth',
  register(server: HapiServerLike, options: AtlasHapiOptions): void {
    const backend = new AtlasBackend(options);
    const name = options.name ?? 'atlas';
    server.auth.scheme(name, () => ({
      async authenticate(request, h) {
        const auth = await authenticateHeaders(backend, request.headers);
        if (!auth.userId) {
          // Boom-compatible 401: hapi reads isBoom/output; plain Error with these fields suffices.
          const err = Object.assign(new Error('Missing or invalid session'), {
            isBoom: true,
            output: { statusCode: 401, payload: { statusCode: 401, error: 'Unauthorized', message: 'Missing or invalid session' }, headers: { 'WWW-Authenticate': 'Bearer' } },
          });
          return h.unauthenticated(err);
        }
        const credentials: AtlasCredentials = { auth, userId: auth.userId, sessionId: auth.sessionId, orgId: auth.orgId, orgRole: auth.orgRole };
        return h.authenticated({ credentials });
      },
    }));
    server.auth.strategy(name, name);
    if (options.mode && server.auth.default) server.auth.default({ strategy: name, mode: options.mode });
  },
};
