import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { ForbiddenError } from '@atlasauth/backend';
import { atlasPlugin, getAuth, requireAuth, signedOut } from './index';
import type { AtlasPluginOptions } from './index';
// The adapter now types against the REAL Fastify types; the lightweight doubles
// below are cast to them (legitimate test-double casts, not a consumer cast).
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';

const ISSUER = 'https://fox.fapi.atlas.test';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

async function keyring() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'RS256', use: 'sig' };
  return { privateKey, jwks: { keys: [jwk] } };
}

async function token(privateKey: unknown, claims: Record<string, unknown> = {}) {
  return new SignJWT({ sid: 'sess_1', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'kid-1' })
    .setSubject('user_1')
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(privateKey as never);
}

// A networkless fetch that serves the JWKS — the plugin never touches a real
// network, and JWKS transport is a stub.
const serving = (jwks: unknown) =>
  (async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;

const request = (headers: Record<string, string> = {}): FastifyRequest =>
  ({
    // Fastify lower-cases header names; mirror that.
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  }) as unknown as FastifyRequest;

/** A minimal Fastify reply double that records the last code()/send(). */
function responder() {
  const state: { code: number | null; body: unknown } = { code: null, body: null };
  const reply = {
    code(statusCode: number) {
      state.code = statusCode;
      return reply;
    },
    send(payload: unknown) {
      state.body = payload;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

/**
 * A minimal Fastify instance double: it records the request decorator seed and
 * the hook the plugin registers, so a test can drive that hook directly. Mirrors
 * how a real Fastify instance would call the plugin `(instance, opts, done)`.
 */
function harness() {
  const hooks: Record<
    string,
    Array<(req: FastifyRequest, reply: FastifyReply) => Promise<void> | void>
  > = {};
  const instance = {
    decorateRequest() {
      return instance;
    },
    addHook(name: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void> | void) {
      (hooks[name] ||= []).push(handler);
      return instance;
    },
  };
  return { instance: instance as unknown as FastifyInstance, hooks };
}

/**
 * Register the plugin against the harness and return a function that runs the
 * registered hook (default `preHandler`) against a request/reply pair.
 */
function register(options: AtlasPluginOptions) {
  const { instance, hooks } = harness();
  let pluginDone = false;
  atlasPlugin(options)(instance, {}, () => {
    pluginDone = true;
  });
  const hookName = options.hookName ?? 'preHandler';
  return {
    pluginDone: () => pluginDone,
    run: async (req: FastifyRequest, reply: FastifyReply) => {
      for (const hook of hooks[hookName] ?? []) {
        await hook(req, reply);
      }
    },
  };
}

describe('atlasPlugin', () => {
  it('calls the plugin done() callback on registration', () => {
    const { pluginDone } = register({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving({ keys: [] }),
    });
    expect(pluginDone()).toBe(true);
  });

  it('attaches signed-in auth for a valid __session cookie', async () => {
    const { privateKey, jwks } = await keyring();
    const { run } = register({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const req = request({ cookie: `__session=${await token(privateKey)}` });
    const { reply } = responder();
    await run(req, reply);

    const auth = getAuth(req);
    expect(auth.userId).toBe('user_1');
    expect(auth.sessionId).toBe('sess_1');
    expect(auth.isSignedIn).toBe(true);
  });

  it('attaches signed-in auth for a valid Bearer token (header wins)', async () => {
    const { privateKey, jwks } = await keyring();
    const { run } = register({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const req = request({ authorization: `Bearer ${await token(privateKey)}` });
    const { reply } = responder();
    await run(req, reply);

    expect(getAuth(req).userId).toBe('user_1');
  });

  it('populates org fields and a working has() from claims', async () => {
    const { privateKey, jwks } = await keyring();
    const { run } = register({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const req = request({
      cookie: `__session=${await token(privateKey, {
        org_id: 'org_1',
        org_role: 'admin',
        org_permissions: ['org:billing:manage'],
      })}`,
    });
    const { reply } = responder();
    await run(req, reply);

    const auth = getAuth(req);
    expect(auth.orgId).toBe('org_1');
    expect(auth.orgRole).toBe('admin');
    expect(auth.has({ permission: 'org:billing:manage' })).toBe(true);
    expect(auth.has({ permission: 'org:members:delete' })).toBe(false);
  });

  it('yields signed-out for a missing token, and never throws', async () => {
    const { jwks } = await keyring();
    const { run } = register({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const req = request();
    const { reply } = responder();
    await run(req, reply);

    const auth = getAuth(req);
    expect(auth.userId).toBeNull();
    expect(auth.isSignedIn).toBe(false);
    expect(auth.has()).toBe(false);
    expect(() => auth.protect()).toThrow(ForbiddenError);
  });

  it('yields signed-out for an invalid/garbage token (does not throw)', async () => {
    const { jwks } = await keyring();
    const { run } = register({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const req = request({ authorization: 'Bearer not.a.jwt' });
    const { reply } = responder();
    await run(req, reply);

    expect(getAuth(req).userId).toBeNull();
  });

  it('yields signed-out for a token from an unexpected issuer', async () => {
    const { privateKey, jwks } = await keyring();
    const { run } = register({
      jwksUrl: JWKS_URL,
      issuer: 'https://someone-else.fapi.atlas.test',
      fetchImpl: serving(jwks),
    });

    const req = request({ cookie: `__session=${await token(privateKey)}` });
    const { reply } = responder();
    await run(req, reply);

    expect(getAuth(req).userId).toBeNull();
  });

  it('honours the onRequest hookName', async () => {
    const { privateKey, jwks } = await keyring();
    const { run } = register({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      hookName: 'onRequest',
      fetchImpl: serving(jwks),
    });

    const req = request({ cookie: `__session=${await token(privateKey)}` });
    const { reply } = responder();
    await run(req, reply);

    expect(getAuth(req).userId).toBe('user_1');
  });

  it('rejects an unsupported hookName at construction', () => {
    expect(() =>
      atlasPlugin({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        // @ts-expect-error deliberately invalid hook
        hookName: 'preValidation',
      }),
    ).toThrow(/Unsupported hookName/);
  });
});

describe('getAuth', () => {
  it('returns the signed-out default when the plugin never ran', () => {
    const auth = getAuth(request());
    expect(auth.userId).toBeNull();
    expect(auth.isSignedIn).toBe(false);
    expect(auth.has()).toBe(false);
  });
});

describe('signedOut', () => {
  it("has() is always false and protect() always throws", () => {
    const auth = signedOut();
    expect(auth.has({ role: 'admin' })).toBe(false);
    expect(() => auth.protect()).toThrow(ForbiddenError);
  });
});

describe('requireAuth', () => {
  it('401s with UNAUTHENTICATED (sending a reply short-circuits) when signed out', async () => {
    const req = request();
    req.atlas = signedOut();
    const { reply, state } = responder();

    await requireAuth(req, reply);

    expect(state.code).toBe(401);
    expect(state.body).toEqual({ errors: [{ code: 'UNAUTHENTICATED' }] });
  });

  it('401s when no plugin ran (undecorated request)', async () => {
    const req = request();
    const { reply, state } = responder();

    await requireAuth(req, reply);
    expect(state.code).toBe(401);
  });

  it('sends nothing (lets the handler run) when a signed-in auth is attached', async () => {
    const { privateKey, jwks } = await keyring();
    const { run } = register({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });
    const req = request({ cookie: `__session=${await token(privateKey)}` });
    const { reply } = responder();
    await run(req, reply);

    const gate = responder();
    await requireAuth(req, gate.reply);
    expect(gate.state.code).toBeNull();
  });

  it('types: wires into a real Fastify route with no cast', () => {
    // Compile-only proof. `requireAuth` IS a preHandler, and `getAuth` takes the
    // route's own `FastifyRequest` directly — neither needs an `as` adapter.
    const preHandler: preHandlerHookHandler = requireAuth;
    const handler = (req: FastifyRequest, reply: FastifyReply): void => {
      const auth = getAuth(req);
      reply.send({ userId: auth.userId, signedIn: auth.isSignedIn });
    };
    expect(typeof preHandler).toBe('function');
    expect(typeof handler).toBe('function');
  });
});
