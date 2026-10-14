import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  evaluate,
  hasFromClaims,
  ForbiddenError,
  type AuthorizedSession,
  type SessionClaims,
  type VerifyResult,
} from '@atlasauth/backend';
import {
  AtlasGuard,
  AtlasAuthGuard,
  Public,
  RequirePermission,
  atlasAuthFactory,
  currentUserFactory,
  type AtlasVerifier,
  type AtlasRequest,
} from './index';

// ── test doubles ─────────────────────────────────────────────────────────────

/** Build a realistic verified session, with `has`/`protect` bound to the claims
 *  exactly as `@atlasauth/backend` binds them (reused shared `@atlasauth/authz`
 *  primitive), so the permission tests exercise real authorization semantics. */
function session(claims: Partial<SessionClaims> = {}): AuthorizedSession {
  const full = {
    iss: 'https://fox.fapi.atlas.test',
    sub: 'user_1',
    sid: 'sess_1',
    exp: 9_999_999_999,
    ...claims,
  } as SessionClaims;
  return {
    ok: true,
    claims: full,
    actor: null,
    has: (condition = {}) => hasFromClaims(full, condition),
    protect: (condition = {}) => {
      const outcome = evaluate(full, condition);
      if (!outcome.allowed) throw new ForbiddenError(outcome.reason, condition);
      return full;
    },
  };
}

/** A stub verifier: a token equal to a stored valid session JWT verifies to it,
 *  anything else is `{ ok: false }`. No network, no real crypto — the unit under
 *  test is the guard, not `@atlasauth/backend`'s verification (covered there). */
function verifier(validToken: string, result: VerifyResult): AtlasVerifier {
  return {
    verify: async (token: string): Promise<VerifyResult> =>
      token === validToken ? result : { ok: false, reason: 'invalid' },
  };
}

const request = (headers: Record<string, string> = {}): AtlasRequest => ({
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
});

/** A minimal ExecutionContext double: just the handler/class the guard reflects
 *  over and the HTTP request it switches to. No Nest app is booted. */
function context(req: AtlasRequest, handler: unknown = () => {}, cls: unknown = class {}) {
  return {
    switchToHttp: () => ({ getRequest: <T>() => req as T }),
    getHandler: () => handler as never,
    getClass: () => cls as never,
  } as unknown as ExecutionContext;
}

// A controller whose decorated members carry the metadata the guard reads back.
class Routes {
  @Public()
  publicRoute(): void {}

  privateRoute(): void {}

  @RequirePermission('org:billing:manage')
  billingRoute(): void {}
}
const routes = new Routes();

// ── AtlasGuard ───────────────────────────────────────────────────────────────

describe('AtlasGuard', () => {
  const reflector = new Reflector();

  it('allows a valid Bearer token and populates request.atlas', async () => {
    const result = session();
    const guard = new AtlasGuard(reflector, verifier('good', result));
    const req = request({ authorization: 'Bearer good' });

    await expect(guard.canActivate(context(req, routes.privateRoute, Routes))).resolves.toBe(true);
    expect(req.atlas).toBe(result);
    expect(req.atlas?.claims.sub).toBe('user_1');
  });

  it('allows a valid token carried in the __session cookie', async () => {
    const result = session();
    const guard = new AtlasGuard(reflector, verifier('good', result));
    const req = request({ cookie: '__session=good' });

    await expect(guard.canActivate(context(req, routes.privateRoute, Routes))).resolves.toBe(true);
    expect(req.atlas).toBe(result);
  });

  it('throws 401 UnauthorizedException when no token is present', async () => {
    const guard = new AtlasGuard(reflector, verifier('good', session()));
    const req = request();

    await expect(guard.canActivate(context(req, routes.privateRoute, Routes))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(req.atlas).toBeUndefined();
  });

  it('throws 401 UnauthorizedException when the token is invalid', async () => {
    const guard = new AtlasGuard(reflector, verifier('good', session()));
    const req = request({ authorization: 'Bearer forged' });

    await expect(guard.canActivate(context(req, routes.privateRoute, Routes))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(req.atlas).toBeUndefined();
  });

  it('bypasses verification for a @Public() handler (no token needed)', async () => {
    const guard = new AtlasGuard(reflector, verifier('good', session()));
    const req = request();

    await expect(guard.canActivate(context(req, routes.publicRoute, Routes))).resolves.toBe(true);
    // Public means "not authenticated here", so nothing is attached.
    expect(req.atlas).toBeUndefined();
  });

  it('honours a Reflector stub reporting the route as public', async () => {
    const stub = { getAllAndOverride: () => true } as unknown as Reflector;
    const guard = new AtlasGuard(stub, verifier('good', session()));
    const req = request();

    await expect(guard.canActivate(context(req))).resolves.toBe(true);
  });
});

// ── param decorators ─────────────────────────────────────────────────────────

describe('param decorators', () => {
  it('@CurrentUser() resolves the verified claims', () => {
    const result = session({ org_id: 'org_1' });
    const req = request();
    req.atlas = result;

    const claims = currentUserFactory(undefined, context(req));
    expect(claims?.sub).toBe('user_1');
    expect(claims?.org_id).toBe('org_1');
  });

  it('@CurrentUser() resolves null on an unauthenticated request', () => {
    expect(currentUserFactory(undefined, context(request()))).toBeNull();
  });

  it('@AtlasAuth() resolves the full verified session', () => {
    const result = session();
    const req = request();
    req.atlas = result;

    expect(atlasAuthFactory(undefined, context(req))).toBe(result);
    expect(atlasAuthFactory(undefined, context(request()))).toBeNull();
  });
});

// ── AtlasAuthGuard (permission gate) ─────────────────────────────────────────

describe('AtlasAuthGuard', () => {
  const reflector = new Reflector();

  it('allows a route whose @RequirePermission is held by the claims', async () => {
    const result = session({
      org_id: 'org_1',
      org_role: 'admin',
      org_permissions: ['org:billing:manage'],
    });
    const guard = new AtlasAuthGuard(reflector, verifier('good', result));
    const req = request({ authorization: 'Bearer good' });

    await expect(
      guard.canActivate(context(req, routes.billingRoute, Routes)),
    ).resolves.toBe(true);
    expect(req.atlas).toBe(result);
  });

  it('rejects with 403 ForbiddenException when the permission is absent', async () => {
    const result = session({
      org_id: 'org_1',
      org_role: 'member',
      org_permissions: ['org:profile:read'],
    });
    const guard = new AtlasAuthGuard(reflector, verifier('good', result));
    const req = request({ authorization: 'Bearer good' });

    await expect(
      guard.canActivate(context(req, routes.billingRoute, Routes)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still 401s an invalid token before reaching the permission check', async () => {
    const guard = new AtlasAuthGuard(reflector, verifier('good', session()));
    const req = request({ authorization: 'Bearer forged' });

    await expect(
      guard.canActivate(context(req, routes.billingRoute, Routes)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('behaves like AtlasGuard on a route with no @RequirePermission', async () => {
    const result = session();
    const guard = new AtlasAuthGuard(reflector, verifier('good', result));
    const req = request({ authorization: 'Bearer good' });

    await expect(
      guard.canActivate(context(req, routes.privateRoute, Routes)),
    ).resolves.toBe(true);
  });
});
