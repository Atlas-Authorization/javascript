import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as kinde from './compat-kinde';

/**
 * The Kinde compat layer is a projection over `auth()` / `currentUser()` /
 * `atlasClient()` and the Atlas route decider; those need a Next request scope, so
 * the test swaps them (and the lazily loaded Next modules) for fakes and checks
 * the Kinde-shaped results.
 */
const { state, profile, memberships, decision, deciderOptions, cookieJar, headerJar } = vi.hoisted(() => ({
  state: {
    userId: 'user_1' as string | null,
    sessionId: 'sess_1' as string | null,
    orgId: 'org_1' as string | null,
    orgRole: 'admin' as string | null,
    claims: {
      sub: 'user_1',
      sid: 'sess_1',
      exp: 2_000_000_000,
      org_id: 'org_1',
      org_name: 'Acme',
      picture: 'https://img.test/ada.png',
      org_permissions: ['org:billing:manage'],
      app_permissions: ['reports:read'],
    } as Record<string, unknown> | null,
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
  memberships: vi.fn(async (_id: string, _params: unknown) => ({
    data: [{ organization_id: 'org_1' }, { organization_id: 'org_2' }],
    has_more: false,
    next_cursor: null,
  })),
  decision: { value: { kind: 'continue' } as Record<string, unknown> },
  deciderOptions: [] as unknown[],
  cookieJar: new Map<string, string>(),
  headerJar: new Map<string, string>(),
}));

vi.mock('./server', () => ({
  auth: async () => ({ ...state, has: () => true, protect: () => undefined }),
  currentUser: async () => (state.userId ? profile : null),
  atlasClient: () => ({ users: { listOrganizationMemberships: memberships } }),
  configFromEnv: () => ({ jwksUrl: 'https://fapi.test/jwks', issuer: 'https://fapi.test' }),
}));
vi.mock('./middleware', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    createAtlasDecider: (options: unknown) => {
      deciderOptions.push(options);
      return async () => decision.value;
    },
  };
});
vi.mock('next/server', () => ({
  NextResponse: {
    next: () => 'next',
    json: (body: unknown, init?: { status?: number }) => ({ json: body, status: init?.status }),
    redirect: (url: string) => ({ redirect: url, cookies: { set: () => undefined } }),
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined), getAll: () => [] }),
  headers: async () => ({ get: (name: string) => headerJar.get(name) ?? null }),
}));

const signedInAuth = () => ({ userId: 'user_1', sessionId: 'sess_1', orgId: 'org_1', orgRole: 'admin', claims: state.claims });

beforeEach(() => {
  state.userId = 'user_1';
  state.orgId = 'org_1';
  decision.value = { kind: 'continue', auth: signedInAuth() };
  deciderOptions.length = 0;
  cookieJar.clear();
  headerJar.clear();
  memberships.mockClear();
});

function signOut() {
  state.userId = null;
}

const request = (pathname = '/dashboard') => ({
  nextUrl: { pathname, search: '' },
  headers: { get: () => null },
  url: `https://app.test${pathname}`,
});

describe('getKindeServerSessionCompat', () => {
  it('resolves the Kinde user and authentication state', async () => {
    const session = kinde.getKindeServerSessionCompat();
    expect(await session.isAuthenticated()).toBe(true);
    expect(await session.getUser()).toEqual({
      id: 'user_1',
      email: 'ada@ada.test',
      given_name: 'Ada',
      family_name: 'Lovelace',
      picture: 'https://img.test/ada.png',
      username: null,
      phone_number: null,
    });
    signOut();
    expect(await session.isAuthenticated()).toBe(false);
    expect(await session.getUser()).toBeNull();
  });

  it('maps permissions, the organization and roles', async () => {
    const session = kinde.getKindeServerSessionCompat();
    expect(await session.getPermission('reports:read')).toEqual({ isGranted: true, orgCode: 'org_1' });
    expect(await session.getPermission('users:delete')).toEqual({ isGranted: false, orgCode: 'org_1' });
    expect(await session.getPermissions()).toEqual({ permissions: ['org:billing:manage', 'reports:read'], orgCode: 'org_1' });
    expect(await session.getOrganization()).toEqual({ orgCode: 'org_1', orgName: 'Acme' });
    expect(await session.getRoles()).toEqual([{ id: 'admin', key: 'admin', name: 'admin' }]);
    signOut();
    expect(await session.getPermission('reports:read')).toEqual({ isGranted: false, orgCode: null });
    expect(await session.getOrganization()).toBeNull();
  });

  it('lists the user organizations through the Backend API', async () => {
    const session = kinde.getKindeServerSessionCompat();
    expect(await session.getUserOrganizations()).toEqual({
      orgCodes: ['org_1', 'org_2'],
      orgs: [
        { code: 'org_1', name: null },
        { code: 'org_2', name: null },
      ],
    });
    expect(memberships).toHaveBeenCalledWith('user_1', { limit: 100 });
  });

  it('tokens are the Atlas session: decoded claims and the raw JWT', async () => {
    const session = kinde.getKindeServerSessionCompat();
    expect(await session.getAccessToken()).toBe(state.claims);
    expect(await session.getClaim('sid')).toEqual({ name: 'sid', value: 'sess_1' });
    cookieJar.set('__session', 'cookie.jwt');
    expect(await session.getAccessTokenRaw()).toBe('cookie.jwt');
    headerJar.set('authorization', 'Bearer header.jwt');
    expect(await session.getIdTokenRaw()).toBe('header.jwt');
    signOut();
    expect(await session.getAccessTokenRaw()).toBeNull();
    expect(await session.getClaim('sid')).toBeNull();
  });

  it('flags return the default they are given; refreshTokens is a no-op', async () => {
    const session = kinde.getKindeServerSessionCompat();
    expect(await session.getBooleanFlag('beta', false)).toBe(false);
    expect(await session.getStringFlag('theme', 'dark')).toBe('dark');
    expect(await session.getFlag('limit', 3)).toEqual({ code: 'limit', type: 'integer', value: 3, is_default: true, defaultValue: 3 });
    await expect(session.refreshTokens()).resolves.toBeUndefined();
  });
});

describe('kindeWithAuthCompat', () => {
  it('withAuth(req) runs the Atlas middleware with the Atlas pages public', async () => {
    expect(await kinde.kindeWithAuthCompat(request() as never)).toBe('next');
    const options = deciderOptions[0] as { publicRoutes: string[]; signInUrl: string; issuer: string };
    expect(options.publicRoutes).toEqual(['/sign-in(.*)', '/sign-up(.*)']);
    expect(options.signInUrl).toBe('/sign-in');
    expect(options.issuer).toBe('https://fapi.test');
  });

  it('passes on the redirect and 401 decisions', async () => {
    const mw = kinde.kindeWithAuthCompat();
    decision.value = { kind: 'redirect', location: 'https://app.test/sign-in?redirect_url=%2Fdashboard', cookies: [], auth: {} };
    expect(await mw(request() as never)).toMatchObject({ redirect: 'https://app.test/sign-in?redirect_url=%2Fdashboard' });
    decision.value = { kind: 'unauthorized', auth: {} };
    expect(await mw(request() as never)).toMatchObject({ status: 401 });
  });

  it('maps publicPaths and loginPage, and runs the handler for signed-in users', async () => {
    const seen: unknown[] = [];
    const mw = kinde.kindeWithAuthCompat(
      async (req) => {
        seen.push(req.kindeAuth);
      },
      { publicPaths: ['/', '/pricing'], loginPage: '/login' },
    );
    expect(await mw(request() as never)).toBe('next');
    const options = deciderOptions[0] as { publicRoutes: string[]; signInUrl: string };
    expect(options.publicRoutes).toEqual(['/sign-in(.*)', '/sign-up(.*)', '/', '/pricing(.*)']);
    expect(options.signInUrl).toBe('/login');
    expect(seen[0]).toMatchObject({ user: { id: 'user_1' }, token: { org_code: 'org_1', permissions: ['org:billing:manage', 'reports:read'] } });
  });

  it('isAuthorized gets Kinde-style permissions and sends a refused user to sign-in', async () => {
    const mw = kinde.kindeWithAuthCompat({
      isAuthorized: ({ token }) => (token.permissions as string[]).includes('reports:read'),
    });
    expect(await mw(request() as never)).toBe('next');
    const strict = kinde.kindeWithAuthCompat({
      isAuthorized: ({ token }) => (token.permissions as string[]).includes('users:delete'),
    });
    expect(await strict(request('/admin') as never)).toEqual({
      redirect: 'https://app.test/sign-in?redirect_url=%2Fadmin',
      cookies: expect.anything(),
    });
    const throwing = kinde.kindeWithAuthCompat({
      isAuthorized: () => {
        throw new Error('boom');
      },
    });
    expect(await throwing(request() as never)).toMatchObject({ redirect: expect.stringContaining('/sign-in') });
  });

  it('skips the handler on a public route (no verified user)', async () => {
    const handler = vi.fn();
    decision.value = { kind: 'continue', auth: { userId: null, orgId: null, claims: null } };
    expect(await kinde.kindeWithAuthCompat(handler)(request('/pricing') as never)).toBe('next');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('handleKindeAuthCompat', () => {
  it('the old /api/auth/[kindeAuth] route answers 404 with a migration message', async () => {
    const res = await kinde.handleKindeAuthCompat()();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('MIGRATED_TO_ATLAS');
  });
});
