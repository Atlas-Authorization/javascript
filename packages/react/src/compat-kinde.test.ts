import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  kindeSessionFrom,
  kindeUserFrom,
  useKindeAuthCompat,
  useKindeBrowserClientCompat,
} from './compat-kinde';
import type { AtlasOrganizationMembership, AtlasUser, SessionClaims } from './types';

const user: AtlasUser = {
  id: 'user_1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  username: 'ada',
  image_url: 'https://img.test/ada.png',
  public_metadata: {},
  unsafe_metadata: {},
  mfa_enabled: false,
  has_password: true,
  email_addresses: [
    { id: 'idn_2', email_address: 'old@ada.test', verified: false, primary: false },
    { id: 'idn_1', email_address: 'ada@ada.test', verified: true, primary: true },
  ],
  phone_numbers: [{ id: 'idn_3', phone_number: '+15550100', verified: true, primary: true }],
};
const claims: SessionClaims = {
  sub: 'user_1',
  sid: 'sess_1',
  exp: 2_000_000_000,
  org_id: 'org_1',
  org_permissions: ['org:billing:manage'],
  app_permissions: ['reports:read', 'org:billing:manage'],
};
const memberships: AtlasOrganizationMembership[] = [
  { role: 'admin', organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null } },
  { role: 'member', organization: { id: 'org_2', name: 'Globex', slug: 'globex', image_url: null } },
];

/** The `useAtlas()` value the hooks read; swapped per test. */
const { ctx } = vi.hoisted(() => ({
  ctx: { value: {} as Record<string, unknown> },
}));
vi.mock('./AtlasProvider', () => ({ useAtlas: () => ctx.value }));

const assign = vi.fn();
function stubWindow() {
  vi.stubGlobal('window', { location: { assign, replace: assign, href: 'https://app.test/now' } });
}

function signedIn(over: Record<string, unknown> = {}) {
  const signOut = vi.fn(async () => ({ revoked: true }));
  ctx.value = {
    status: 'signed_in',
    user,
    claims,
    memberships,
    getToken: async () => 'jwt.token.value',
    signOut,
    reload: async () => true,
    ...over,
  };
  return { signOut };
}

afterEach(() => {
  assign.mockReset();
  vi.unstubAllGlobals();
});

describe('kinde compat projections', () => {
  it('maps the user onto the Kinde user shape', () => {
    expect(kindeUserFrom(user)).toEqual({
      id: 'user_1',
      email: 'ada@ada.test',
      given_name: 'Ada',
      family_name: 'Lovelace',
      picture: 'https://img.test/ada.png',
      username: 'ada',
      phone_number: '+15550100',
    });
    expect(kindeUserFrom(null)).toBeNull();
    const bare = { ...user, first_name: null, image_url: null, email_addresses: [], phone_numbers: [] };
    expect(kindeUserFrom(bare)).toMatchObject({ email: null, given_name: null, picture: null, phone_number: null });
  });

  it('projects permissions, the organization and organizations', () => {
    const s = kindeSessionFrom({ status: 'signed_in', user, claims, memberships });
    expect(s.isAuthenticated).toBe(true);
    expect(s.isLoading).toBe(false);
    expect(s.permissions).toEqual({ permissions: ['org:billing:manage', 'reports:read'], orgCode: 'org_1' });
    expect(s.getPermission('reports:read')).toEqual({ isGranted: true, orgCode: 'org_1' });
    expect(s.getPermission('users:delete')).toEqual({ isGranted: false, orgCode: 'org_1' });
    expect(s.getOrganization()).toEqual({ orgCode: 'org_1', orgName: 'Acme' });
    expect(s.getUserOrganizations()).toEqual({
      orgCodes: ['org_1', 'org_2'],
      orgs: [
        { code: 'org_1', name: 'Acme' },
        { code: 'org_2', name: 'Globex' },
      ],
    });
    expect(s.getClaim('sid')).toEqual({ name: 'sid', value: 'sess_1' });
    expect(s.getClaim('missing')).toEqual({ name: 'missing', value: null });
    expect(s.getAccessToken()).toBe(claims);
  });

  it('flags always return the default they are given', () => {
    const s = kindeSessionFrom({ status: 'signed_in', user, claims });
    expect(s.getBooleanFlag('beta', true)).toBe(true);
    expect(s.getStringFlag('theme', 'dark')).toBe('dark');
    expect(s.getIntegerFlag('limit', 5)).toBe(5);
    expect(s.getFlag('beta', false)).toEqual({ code: 'beta', type: 'boolean', value: false, is_default: true, defaultValue: false });
  });

  it('is empty while loading and when signed out', () => {
    const loading = kindeSessionFrom({ status: 'loading', user: null, claims: null });
    expect(loading.isLoading).toBe(true);
    expect(loading.isAuthenticated).toBe(false);
    const out = kindeSessionFrom({ status: 'signed_out', user, claims, memberships });
    expect(out.user).toBeNull();
    expect(out.organization).toBeNull();
    expect(out.userOrganizations).toBeNull();
    expect(out.getPermission('reports:read')).toEqual({ isGranted: false, orgCode: null });
    expect(out.getClaim('sub')).toBeNull();
  });
});

describe('useKindeAuthCompat', () => {
  it('login / register open the Atlas pages with the return path', async () => {
    stubWindow();
    signedIn();
    const kinde = useKindeAuthCompat();
    await kinde.login({ app_state: { redirectTo: '/dashboard' } });
    expect(assign).toHaveBeenLastCalledWith('/sign-in?redirect_url=%2Fdashboard');
    await kinde.register();
    expect(assign).toHaveBeenLastCalledWith('/sign-up');
  });

  it('logout signs out, then goes to the given URL (default /)', async () => {
    stubWindow();
    const { signOut } = signedIn();
    const kinde = useKindeAuthCompat();
    await kinde.logout('/bye');
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenLastCalledWith('/bye');
    await kinde.logout();
    expect(assign).toHaveBeenLastCalledWith('/');
  });

  it('getToken resolves the session JWT, or undefined when there is none', async () => {
    signedIn();
    expect(await useKindeAuthCompat().getToken()).toBe('jwt.token.value');
    signedIn({ getToken: async () => null });
    expect(await useKindeAuthCompat().getToken()).toBeUndefined();
  });

  it('getters work with and without await', async () => {
    signedIn();
    const kinde = useKindeAuthCompat();
    expect(kinde.getPermission('reports:read').isGranted).toBe(true);
    expect((await kinde.getPermission('reports:read')).isGranted).toBe(true);
    expect(kinde.user?.given_name).toBe('Ada');
  });
});

describe('useKindeBrowserClientCompat', () => {
  it('renders with the Kinde browser-client shape (raw token null until fetched)', () => {
    signedIn();
    let seen: ReturnType<typeof useKindeBrowserClientCompat> | undefined;
    function Probe() {
      seen = useKindeBrowserClientCompat();
      return null;
    }
    renderToString(createElement(Probe));
    expect(seen?.isAuthenticated).toBe(true);
    expect(seen?.user?.email).toBe('ada@ada.test');
    expect(seen?.organization).toEqual({ orgCode: 'org_1', orgName: 'Acme' });
    expect(seen?.getPermission('org:billing:manage').isGranted).toBe(true);
    expect(seen?.accessTokenRaw).toBeNull();
    expect(seen?.getToken()).toBeNull();
    expect(seen?.error).toBeNull();
  });
});
