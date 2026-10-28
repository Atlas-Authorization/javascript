import { describe, expect, it } from 'vitest';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { oneLoginSubdomain, exportOneLogin } from './onelogin';
import { exportPingOne, pingRegion, ssoConnectionOf } from './pingone';

const ENV = '3f2b8e1a-1111-4222-8333-444455556666';

describe('PingOne export', () => {
  const api = `https://api.pingone.com/v1/environments/${ENV}`;
  const users = [
    { id: 'u1', username: 'ada', email: 'Ada@Example.com', emailVerified: true, name: { given: 'Ada', family: 'Lovelace', formatted: 'Ada Lovelace' }, mobilePhone: '+1 202-555-0100', enabled: true, account: { status: 'OK' }, population: { id: 'pop1' }, mfaEnabled: true, createdAt: '2024-01-01T00:00:00Z', lastSignOn: { at: '2025-01-01T00:00:00Z' } },
    { id: 'u2', username: 'bob', email: 'bob@example.com', enabled: false },
    { id: 'u3', username: 'cy', email: 'cy@example.com', enabled: true, account: { status: 'LOCKED' }, identityProvider: { id: 'idp1', type: 'SAML' } },
    { id: 'u4' },
  ];
  const routes = {
    [`POST /${ENV}/as/token`]: { access_token: 'tok' },
    [`GET /v1/environments/${ENV}/identityProviders`]: { _embedded: { identityProviders: [
      { id: 'idp1', type: 'SAML', name: 'Corp', enabled: true, idpEntityId: 'https://idp.corp/e', ssoEndpoint: 'https://idp.corp/sso', spEntityId: 'p1' },
      { id: 'idp2', type: 'OPENID_CONNECT', name: 'Partner', issuer: 'https://partner.example', clientId: 'c' },
      { id: 'idp3', type: 'GOOGLE', name: 'Google' },
    ] } },
    [`GET /v1/environments/${ENV}/groups`]: { _embedded: { groups: [{ id: 'g1', name: 'Site Admins' }] } },
    [`GET /v1/environments/${ENV}/users?limit=100`]: { _embedded: { users: users.slice(0, 2) }, _links: { next: { href: `${api}/users?limit=100&after=2` } } },
    [`GET /v1/environments/${ENV}/users?limit=100&after=2`]: { _embedded: { users: users.slice(2) } },
    [`GET /v1/environments/${ENV}/users/u1/memberOfGroups`]: { _embedded: { groups: [{ id: 'g1' }] } },
  };

  it('maps users, state, groups, connections and external identities', async () => {
    const v = fakeVendor('https://api.pingone.com', routes as never);
    // the token host differs from the API host
    const f = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://auth.pingone.com/')) return Promise.resolve(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }));
      return v.fetchImpl(input, init);
    }) as typeof fetch;
    const set = await exportPingOne({ environmentId: ENV, clientId: 'cid', clientSecret: 'sec', fetchImpl: f, sleep: noSleep });
    const u = set.list('user');
    expect(u.map((x) => x.id)).toEqual(['u1', 'u2', 'u3']);
    expect(u[0]).toMatchObject({ emails: [{ email: 'ada@example.com', verified: true }], phones: [{ phone: '+12025550100' }], roles: ['site_admins'], first_name: 'Ada' });
    expect(u[1]).toMatchObject({ banned: true });
    expect(u[2]).toMatchObject({ locked: true });
    expect(set.omitted.user).toMatchObject({ count: 1 });
    expect(set.list('sso_connection').map((c) => [c.id, c.protocol])).toEqual([['idp1', 'saml'], ['idp2', 'oidc']]);
    expect(set.list('identity')[0]).toMatchObject({ user_id: 'u3', kind: 'enterprise', sso_connection_id: 'idp1' });
    expect(set.warnings.join(' ')).toMatch(/Google/);
    expect(JSON.stringify(v.calls.map((c) => c.url))).not.toContain('sec');
  });

  it('refuses bad credentials and bad regions', async () => {
    const f = (async () => new Response(JSON.stringify({ error_description: 'bad' }), { status: 401 })) as typeof fetch;
    await expect(exportPingOne({ environmentId: ENV, clientId: 'c', clientSecret: 's', fetchImpl: f })).rejects.toThrow(/refused/);
    expect(() => pingRegion('mars')).toThrow(/Unknown PingOne region/);
    expect(pingRegion('EU')).toBe('eu');
  });

  it('converts SAML and OIDC providers only', () => {
    expect(ssoConnectionOf({ id: 'x', type: 'APPLE' })).toBeNull();
    expect(ssoConnectionOf({ id: 'x', type: 'SAML', idpEntityId: 'e' })?.saml?.idp_entity_id).toBe('e');
  });
});

describe('OneLogin export', () => {
  it('maps users and roles, follows the cursor, and treats status codes', async () => {
    const v = fakeVendor('https://acme.onelogin.com', {
      'POST /auth/oauth2/v2/token': { access_token: 'tok' },
      'GET /api/2/roles?limit=100': [{ id: 7, name: 'Editors' }],
      'GET /api/2/users?limit=100': { status: 200, body: [{ id: 1, username: 'ada', email: 'ada@example.com', firstname: 'Ada', lastname: 'L', phone: '+44 20 7946 0958', status: 1, role_ids: [7], custom_attributes: { team: 'x' } }], headers: { 'after-cursor': 'c2' } },
      'GET /api/2/users?limit=100&cursor=c2': [{ id: 2, username: 'bob', status: 2 }, { id: 3, email: 'cy@example.com', status: 3 }, { id: 4, email: 'new@example.com', status: 0 }, { id: 5 }],
    });
    const set = await exportOneLogin({ subdomain: 'Acme.onelogin.com', clientId: 'id', clientSecret: 'sekret', fetchImpl: v.fetchImpl, sleep: noSleep });
    const u = set.list('user');
    expect(u.map((x) => x.id)).toEqual(['1', '2', '3', '4']);
    expect(u[0]).toMatchObject({ roles: ['editors'], phones: [{ phone: '+442079460958' }], emails: [{ verified: false }] });
    expect(u[1]).toMatchObject({ banned: true });
    expect(u[2]).toMatchObject({ locked: true });
    expect(set.warnings.join(' ')).toMatch(/never activated/);
    expect(v.calls.every((c) => !c.url.includes('sekret'))).toBe(true);
    expect(new Headers(v.calls[0]!.headers).get('authorization')).toBe('client_id:id, client_secret:sekret');
  });

  it('validates the subdomain', () => {
    expect(oneLoginSubdomain('https://Acme.onelogin.com/')).toBe('acme');
    expect(() => oneLoginSubdomain('evil.com/x?')).toThrow();
  });
});
