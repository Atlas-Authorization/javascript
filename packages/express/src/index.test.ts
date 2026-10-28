import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { ForbiddenError } from '@atlasauth/backend';
import { atlasMiddleware, getAuth, requireAuth, signedOut } from './index';
// The adapter now types against the REAL Express types; the lightweight doubles
// below are cast to them (legitimate test-double casts, not a consumer cast).
import type { Request, Response, NextFunction, RequestHandler } from 'express';

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

// A networkless fetch that serves the JWKS — the middleware never touches a
// real network, and JWKS transport is a stub.
const serving = (jwks: unknown) =>
  (async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;

const request = (headers: Record<string, string> = {}): Request =>
  ({
    // Express lower-cases header names; mirror that.
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  }) as unknown as Request;

/** A minimal Express response double that records the last status()/json(). */
function responder() {
  const state: { status: number | null; body: unknown } = { status: null, body: null };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, state };
}

/** Run a middleware to completion, capturing whether next() was called. */
function run(
  handler: RequestHandler,
  req: Request,
  res: Response,
): Promise<{ nextCalled: boolean; nextError: unknown }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (nextCalled: boolean, nextError: unknown) => {
      if (settled) return;
      settled = true;
      resolve({ nextCalled, nextError });
    };
    // Settle on whichever the middleware does: call next(), or answer through
    // res.json() (a 401). No timer: under load, JWKS + RS256 verification can
    // take far longer than a fixed tick, and a timer turned that into a failure.
    const answer = res.json.bind(res);
    (res as unknown as { json: (body: unknown) => Response }).json = (body: unknown) => {
      const out = answer(body);
      finish(false, undefined);
      return out;
    };
    handler(req, res, (err?: unknown) => finish(true, err));
  });
}

describe('atlasMiddleware', () => {
  it('attaches signed-in auth for a valid __session cookie', async () => {
    const { privateKey, jwks } = await keyring();
    const mw = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const req = request({ cookie: `__session=${await token(privateKey)}` });
    const { res } = responder();
    const { nextCalled } = await run(mw, req, res);

    expect(nextCalled).toBe(true);
    const auth = getAuth(req);
    expect(auth.userId).toBe('user_1');
    expect(auth.sessionId).toBe('sess_1');
    expect(auth.isSignedIn).toBe(true);
  });

  it('attaches signed-in auth for a valid Bearer token (header wins)', async () => {
    const { privateKey, jwks } = await keyring();
    const mw = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const req = request({ authorization: `Bearer ${await token(privateKey)}` });
    const { res } = responder();
    const { nextCalled } = await run(mw, req, res);

    expect(nextCalled).toBe(true);
    expect(getAuth(req).userId).toBe('user_1');
  });

  it('populates org fields and a working has() from claims', async () => {
    const { privateKey, jwks } = await keyring();
    const mw = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const req = request({
      cookie: `__session=${await token(privateKey, {
        org_id: 'org_1',
        org_role: 'admin',
        org_permissions: ['org:billing:manage'],
      })}`,
    });
    const { res } = responder();
    await run(mw, req, res);

    const auth = getAuth(req);
    expect(auth.orgId).toBe('org_1');
    expect(auth.orgRole).toBe('admin');
    expect(auth.has({ permission: 'org:billing:manage' })).toBe(true);
    expect(auth.has({ permission: 'org:members:delete' })).toBe(false);
  });

  it('yields signed-out for a missing token, and never throws', async () => {
    const { jwks } = await keyring();
    const mw = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const req = request();
    const { res } = responder();
    const { nextCalled } = await run(mw, req, res);

    expect(nextCalled).toBe(true);
    const auth = getAuth(req);
    expect(auth.userId).toBeNull();
    expect(auth.isSignedIn).toBe(false);
    expect(auth.has()).toBe(false);
    expect(() => auth.protect()).toThrow(ForbiddenError);
  });

  it('yields signed-out for an invalid/garbage token (does not throw)', async () => {
    const { jwks } = await keyring();
    const mw = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const req = request({ authorization: 'Bearer not.a.jwt' });
    const { res } = responder();
    const { nextCalled } = await run(mw, req, res);

    expect(nextCalled).toBe(true);
    expect(getAuth(req).userId).toBeNull();
  });

  it('yields signed-out for a token from an unexpected issuer', async () => {
    const { privateKey, jwks } = await keyring();
    const mw = atlasMiddleware({
      jwksUrl: JWKS_URL,
      issuer: 'https://someone-else.fapi.atlas.test',
      fetchImpl: serving(jwks),
    });

    const req = request({ cookie: `__session=${await token(privateKey)}` });
    const { res } = responder();
    await run(mw, req, res);

    expect(getAuth(req).userId).toBeNull();
  });
});

describe('getAuth', () => {
  it('returns the signed-out default when the middleware never ran', () => {
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
  it('401s with UNAUTHENTICATED and does not call next() when signed out', async () => {
    const req = request();
    req.atlas = signedOut();
    const { res, state } = responder();
    const { nextCalled } = await run(requireAuth(), req, res);

    expect(nextCalled).toBe(false);
    expect(state.status).toBe(401);
    expect(state.body).toEqual({ errors: [{ code: 'UNAUTHENTICATED' }] });
  });

  it('calls next() when a signed-in auth is already attached', async () => {
    const { privateKey, jwks } = await keyring();
    const mw = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });
    const req = request({ cookie: `__session=${await token(privateKey)}` });
    const { res } = responder();
    await run(mw, req, res);

    const gate = responder();
    const { nextCalled } = await run(requireAuth(), req, gate.res);
    expect(nextCalled).toBe(true);
    expect(gate.state.status).toBeNull();
  });

  it('authenticates inline (standalone) when given options and no upstream middleware', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({ cookie: `__session=${await token(privateKey)}` });
    const { res } = responder();
    const { nextCalled } = await run(
      requireAuth({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) }),
      req,
      res,
    );

    expect(nextCalled).toBe(true);
    expect(getAuth(req).userId).toBe('user_1');
  });

  it('401s standalone when the inline token is invalid', async () => {
    const { jwks } = await keyring();
    const req = request({ authorization: 'Bearer not.a.jwt' });
    const { res, state } = responder();
    const { nextCalled } = await run(
      requireAuth({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) }),
      req,
      res,
    );

    expect(nextCalled).toBe(false);
    expect(state.status).toBe(401);
  });
});

describe('framework typing', () => {
  it('types: a real Express handler reads getAuth with no cast', () => {
    // Compile-only proof. `req` is the route's own Express `Request` and feeds
    // `getAuth` directly; `atlasMiddleware`/`requireAuth` are real `RequestHandler`s.
    const handler: RequestHandler = (req, res, next: NextFunction) => {
      const auth = getAuth(req);
      res.status(200).json({ userId: auth.userId, signedIn: auth.isSignedIn });
      next();
    };
    const mw: RequestHandler = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER });
    const gate: RequestHandler = requireAuth();
    expect([handler, mw, gate].every((h) => typeof h === 'function')).toBe(true);
  });
});
