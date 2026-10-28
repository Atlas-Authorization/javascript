import { afterEach, describe, expect, it } from 'vitest';
import { publishActiveAtlas, type ActiveAtlas } from './active-atlas';
import { descopeClaimsFrom, descopeUserFrom, getDescopeSessionTokenCompat } from './compat-descope';
import type { AtlasOrganizationMembership, AtlasUser, SessionClaims } from './types';

const user: AtlasUser = {
  id: 'user_1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  username: 'ada',
  image_url: 'https://img.test/ada.png',
  public_metadata: { plan: 'pro' },
  unsafe_metadata: { theme: 'dark' },
  mfa_enabled: false,
  has_password: true,
  email_addresses: [
    { id: 'idn_2', email_address: 'old@ada.test', verified: false, primary: false },
    { id: 'idn_1', email_address: 'ada@ada.test', verified: true, primary: true },
  ],
  phone_numbers: [{ id: 'idn_3', phone_number: '+15550100', verified: true, primary: true }],
};
const memberships: AtlasOrganizationMembership[] = [
  { role: 'org:admin', organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null } },
];
const claims: SessionClaims = {
  sub: 'user_1',
  sid: 'sess_1',
  exp: 2_000_000_000,
  app_roles: ['admin', 7],
  app_permissions: ['reports:read'],
  org_id: 'org_1',
  org_role: 'org:admin',
  org_permissions: ['org:billing:manage'],
};

function provider(over: Partial<ActiveAtlas> = {}): ActiveAtlas {
  return {
    status: 'signed_in',
    user,
    claims,
    getToken: async () => 'jwt.token.value',
    signOut: async () => ({ revoked: true }),
    reload: async () => true,
    ...over,
  };
}

afterEach(() => {
  publishActiveAtlas(null);
});

describe('descope compat: user', () => {
  it('projects the user onto the Descope user shape', () => {
    expect(descopeUserFrom(user, memberships, claims)).toEqual({
      userId: 'user_1',
      loginIds: ['ada@ada.test', '+15550100', 'ada'],
      email: 'ada@ada.test',
      verifiedEmail: true,
      phone: '+15550100',
      verifiedPhone: true,
      name: 'Ada Lovelace',
      givenName: 'Ada',
      familyName: 'Lovelace',
      picture: 'https://img.test/ada.png',
      roleNames: ['admin'],
      userTenants: [{ tenantId: 'org_1', tenantName: 'Acme', roleNames: ['org:admin'] }],
      customAttributes: { plan: 'pro' },
    });
    expect(descopeUserFrom(null)).toBeUndefined();
  });

  it('omits what the user does not have', () => {
    const bare: AtlasUser = {
      ...user,
      first_name: null,
      last_name: null,
      username: null,
      image_url: null,
      public_metadata: {},
      email_addresses: [],
      phone_numbers: [],
    };
    expect(descopeUserFrom(bare)).toEqual({
      userId: 'user_1',
      loginIds: [],
      verifiedEmail: false,
      verifiedPhone: false,
      roleNames: [],
      userTenants: [],
      customAttributes: {},
    });
  });
});

describe('descope compat: claims', () => {
  it('adds the app roles as roles / permissions and the active organization as a tenant', () => {
    const out = descopeClaimsFrom(claims)!;
    expect(out.sub).toBe('user_1');
    expect(out.exp).toBe(2_000_000_000);
    expect(out.roles).toEqual(['admin']);
    expect(out.permissions).toEqual(['reports:read']);
    expect(out.tenants).toEqual({ org_1: { roles: ['org:admin'], permissions: ['org:billing:manage'] } });
  });

  it('has empty lists without app roles or an organization', () => {
    expect(descopeClaimsFrom({ sub: 'user_1', sid: 'sess_1', exp: 1 })).toMatchObject({ roles: [], permissions: [], tenants: {} });
    expect(descopeClaimsFrom(null)).toBeUndefined();
  });
});

describe('descope compat: getSessionToken', () => {
  it('resolves the Atlas session token from the mounted provider', async () => {
    publishActiveAtlas(provider());
    expect(await getDescopeSessionTokenCompat()).toBe('jwt.token.value');
  });

  it('resolves an empty string when signed out or with no provider, like Descope', async () => {
    expect(await getDescopeSessionTokenCompat()).toBe('');
    publishActiveAtlas(provider({ status: 'signed_out', user: null, claims: null }));
    expect(await getDescopeSessionTokenCompat()).toBe('');
  });
});
