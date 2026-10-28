import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as compat from './compat';

/**
 * The compat layer is a projection over `auth()` / `currentUser()` / `atlasClient()`;
 * those need a Next request scope, so the test swaps them (and the two lazily
 * loaded Next modules) for fakes and checks the vendor-shaped results.
 */
const { state, profile, revoke, redirect, middlewareCalls } = vi.hoisted(() => ({
  state: {
    userId: 'user_1' as string | null,
    sessionId: 'sess_1' as string | null,
    orgId: 'org_1' as string | null,
    orgRole: 'admin' as string | null,
    claims: { sub: 'user_1', sid: 'sess_1', exp: 2_000_000_000, email_verified: true } as Record<string, unknown> | null,
  },
  profile: {
    id: 'user_1',
    orgId: 'org_1',
    orgRole: 'admin',
    email: 'ada@ada.test',
    name: null as string | null,
    firstName: 'Ada',
    lastName: 'Lovelace',
  },
  revoke: vi.fn(async (_id: string) => ({ object: 'session', id: 'sess_1', status: 'revoked' })),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  middlewareCalls: [] as unknown[],
}));

vi.mock('./server', () => ({
  auth: async () => ({ ...state, has: () => true, protect: () => undefined }),
  currentUser: async () => (state.userId ? profile : null),
  atlasClient: () => ({ sessions: { revoke } }),
  configFromEnv: () => ({ jwksUrl: 'https://fapi.test/jwks', issuer: 'https://fapi.test' }),
}));
vi.mock('./middleware', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    atlasMiddleware: (options: unknown) => async (request: unknown) => {
      middlewareCalls.push({ options, request });
      return 'next-response';
    },
  };
});
vi.mock('next/server', () => ({ NextResponse: {} }));
vi.mock('next/navigation', () => ({ redirect }));


beforeEach(() => {
  state.userId = 'user_1';
  state.sessionId = 'sess_1';
  revoke.mockClear();
  redirect.mockClear();
  middlewareCalls.length = 0;
});

function signOut() {
  state.userId = null;
  state.sessionId = null;
}

describe('Auth.js compat', () => {
  it('getServerSession resolves the next-auth session shape', async () => {
    expect(await compat.getServerSessionCompat({ providers: [] })).toEqual({
      user: { id: 'user_1', name: 'Ada Lovelace', email: 'ada@ada.test', image: null },
      expires: new Date(2_000_000_000_000).toISOString(),
    });
    signOut();
    expect(await compat.getServerSessionCompat()).toBeNull();
  });

  it('server signIn redirects to the sign-in page with the return path', async () => {
    await expect(compat.nextAuthServerSignIn('github', { redirectTo: '/app' })).rejects.toThrow(
      'NEXT_REDIRECT /sign-in?redirect_url=%2Fapp',
    );
  });

  it('server signOut revokes the session then redirects', async () => {
    await expect(compat.nextAuthServerSignOut({ redirectTo: '/bye' })).rejects.toThrow('NEXT_REDIRECT /bye');
    expect(revoke).toHaveBeenCalledWith('sess_1');
    revoke.mockClear();
    await compat.nextAuthServerSignOut({ redirect: false });
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('the old /api/auth route answers 404 with a migration message', async () => {
    const res = await compat.nextAuthHandlersCompat.GET();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('MIGRATED_TO_ATLAS');
  });
});

describe('NextAuth() compat', () => {
  it('destructures into the v5 members and doubles as the v4 route handler', async () => {
    const { handlers, auth, signIn, signOut } = compat.nextAuthCompat({ providers: [] });
    expect(handlers).toBe(compat.nextAuthHandlersCompat);
    expect((await auth())?.user.id).toBe('user_1');
    expect(signIn).toBe(compat.nextAuthServerSignIn);
    expect(signOut).toBe(compat.nextAuthServerSignOut);
    const handler = compat.nextAuthCompat({});
    expect((await handler()).status).toBe(404);
  });
});

describe('middleware', () => {
  it('builds the Atlas middleware once, from env, with the Atlas pages public', async () => {
    const mw = compat.createAtlasMiddleware({ publicRoutes: ['/'] });
    expect(await mw({ headers: { get: () => null }, nextUrl: { pathname: '/x' } } as never)).toBe('next-response');
    await mw({ headers: { get: () => null }, nextUrl: { pathname: '/y' } } as never);
    expect(middlewareCalls).toHaveLength(2);
    const { options } = middlewareCalls[0] as { options: { publicRoutes: string[]; issuer: string } };
    expect(options.issuer).toBe('https://fapi.test');
    expect(options.publicRoutes).toEqual(['/sign-in(.*)', '/sign-up(.*)', '/']);
  });
});

describe('Auth0 compat', () => {
  it('getSession resolves { user } with the OIDC profile', async () => {
    expect(await compat.getAuth0SessionCompat()).toEqual({
      user: { sub: 'user_1', email: 'ada@ada.test', name: 'Ada Lovelace', given_name: 'Ada', family_name: 'Lovelace', org_id: 'org_1' },
      expiresAt: 2_000_000_000,
    });
  });

  it('withApiAuthRequired passes signed-in requests and 401s others (App Router)', async () => {
    const handler = compat.withApiAuthRequiredCompat(async () => new Response('ok'));
    expect(await ((await handler()) as Response).text()).toBe('ok');
    signOut();
    expect(((await handler()) as Response).status).toBe(401);
  });

  it('withApiAuthRequired answers through res on a Pages API route', async () => {
    signOut();
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    const handler = compat.withApiAuthRequiredCompat(async (_req: unknown, _res: unknown) => 'never');
    expect(await handler({}, res)).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'not_authenticated' }));
  });

  it('withPageAuthRequired renders for a user and redirects otherwise', async () => {
    const page = compat.withPageAuthRequiredCompat(async () => 'page', { returnTo: '/profile' });
    expect(await page({})).toBe('page');
    signOut();
    await expect(page({})).rejects.toThrow('NEXT_REDIRECT /sign-in?redirect_url=%2Fprofile');
  });

  it('Auth0ClientCompat exposes getSession and middleware', async () => {
    const client = new compat.Auth0ClientCompat({ domain: 'ignored' });
    expect((await client.getSession())?.user.sub).toBe('user_1');
    expect(await client.middleware({ headers: { get: () => null }, nextUrl: { pathname: '/' } } as never)).toBe('next-response');
    await expect(client.getAccessToken()).rejects.toThrow(/no server-side access-token/);
  });
});

describe('Supabase compat', () => {
  it('getUser / getSession / signOut resolve { data, error }', async () => {
    const { data, error } = await compat.getSupabaseUserCompat();
    expect(error).toBeNull();
    expect(data.user).toEqual({
      id: 'user_1',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'ada@ada.test',
      user_metadata: { full_name: 'Ada Lovelace', name: 'Ada Lovelace' },
      app_metadata: { org_id: 'org_1', org_role: 'admin' },
    });
    expect((await compat.getSupabaseSessionCompat()).data.session?.expires_at).toBe(2_000_000_000);
    expect(await compat.supabaseSignOutCompat()).toEqual({ error: null });
    expect(revoke).toHaveBeenCalledWith('sess_1');
    signOut();
    expect((await compat.getSupabaseUserCompat()).data.user).toBeNull();
  });
});

describe('Better Auth compat', () => {
  it('auth.api.getSession resolves the { user, session } pair', async () => {
    const auth = compat.createBetterAuthServerCompat({ database: 'ignored' });
    const session = await auth.api.getSession({ headers: {} });
    expect(session?.user).toEqual({ id: 'user_1', email: 'ada@ada.test', name: 'Ada Lovelace', image: null, emailVerified: true });
    expect(session?.session).toMatchObject({ id: 'sess_1', userId: 'user_1', activeOrganizationId: 'org_1' });
    expect(await auth.api.signOut()).toEqual({ success: true });
    expect((await auth.handler()).status).toBe(404);
    expect((await compat.toNextJsHandlerCompat(auth).POST()).status).toBe(404);
  });

  it('getSessionCookie reports the Atlas signed-in hint', () => {
    const req = (cookie: string | null) => ({ headers: { get: (n: string) => (n === 'cookie' ? cookie : null) }, nextUrl: { pathname: '/' } });
    expect(compat.getSessionCookieCompat(req('__atlas_uat=1700000000') as never)).toBe('atlas');
    expect(compat.getSessionCookieCompat(req(null) as never)).toBeNull();
  });
});
