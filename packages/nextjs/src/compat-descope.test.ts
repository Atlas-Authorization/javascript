import { beforeEach, describe, expect, it, vi } from 'vitest';
import { descopeServerClaimsFrom, descopeSessionCompat } from './compat-descope';

/**
 * `descopeSessionCompat()` is a projection over `auth()` plus the raw token from
 * `next/headers`; both need a Next request scope, so the test swaps them for
 * fakes and checks the Descope-shaped result.
 */
const { state, request } = vi.hoisted(() => ({
  state: {
    userId: 'user_1' as string | null,
    sessionId: 'sess_1' as string | null,
    orgId: 'org_1' as string | null,
    orgRole: 'org:admin' as string | null,
    claims: {
      sub: 'user_1',
      sid: 'sess_1',
      exp: 2_000_000_000,
      app_roles: ['admin'],
      app_permissions: ['reports:read'],
      org_id: 'org_1',
      org_role: 'org:admin',
      org_permissions: ['org:billing:manage'],
    } as Record<string, unknown> | null,
  },
  request: {
    authorization: null as string | null,
    cookies: { __session: 'cookie.jwt.value' } as Record<string, string>,
  },
}));

vi.mock('./server', () => ({
  auth: async () => ({ ...state, has: () => true, protect: () => undefined }),
}));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'authorization' ? request.authorization : null) }),
  cookies: async () => ({
    get: (name: string) => (request.cookies[name] === undefined ? undefined : { name, value: request.cookies[name] }),
    getAll: () => Object.entries(request.cookies).map(([name, value]) => ({ name, value })),
  }),
}));

beforeEach(() => {
  state.userId = 'user_1';
  request.authorization = null;
});

describe('Descope compat (server)', () => {
  it('session() resolves { jwt, token } with Descope claim names', async () => {
    const session = await descopeSessionCompat();
    expect(session?.jwt).toBe('cookie.jwt.value');
    expect(session?.token).toMatchObject({
      sub: 'user_1',
      exp: 2_000_000_000,
      roles: ['admin'],
      permissions: ['reports:read'],
      tenants: { org_1: { roles: ['org:admin'], permissions: ['org:billing:manage'] } },
    });
  });

  it('prefers the bearer token when the request carries one', async () => {
    request.authorization = 'Bearer header.jwt.value';
    expect((await descopeSessionCompat({ projectId: 'ignored' }))?.jwt).toBe('header.jwt.value');
  });

  it('resolves undefined when signed out, like Descope', async () => {
    state.userId = null;
    expect(await descopeSessionCompat()).toBeUndefined();
  });

  it('has empty role lists and no tenant without app roles or an organization', () => {
    expect(descopeServerClaimsFrom({ iss: 'https://fapi.test', sub: 'user_1', sid: 'sess_1', exp: 1 })).toMatchObject({
      roles: [],
      permissions: [],
      tenants: {},
    });
  });
});
