import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';
import { has, hasAppPermission, hasAppRole, type SessionClaims } from '../verify';

const API_URL = 'https://api.example.test';

function mockFetch(body: unknown = {}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const client = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl as unknown as typeof fetch });
  return { client, calls };
}

describe('appRoles resource', () => {
  it('hits the app role and user app role routes', async () => {
    const { client, calls } = mockFetch({ object: 'list', data: [], has_more: false });
    await client.appRoles.list();
    await client.appRoles.create({ key: 'support', name: 'Support', permissions: ['tickets:read'] });
    await client.appRoles.update('support', { name: 'S' });
    await client.appRoles.delete('support');
    await client.appRoles.listUsers('support', { limit: 10 });
    await client.appRoles.getForUser('user_1');
    await client.appRoles.setForUser('user_1', { add: ['support'] });
    await client.appRoles.removeFromUser('user_1', 'support');
    expect(calls.map((c) => `${c.method} ${c.url.replace(API_URL, '')}`)).toEqual([
      'GET /v1/app_roles',
      'POST /v1/app_roles',
      'PATCH /v1/app_roles/support',
      'DELETE /v1/app_roles/support',
      'GET /v1/app_roles/support/users?limit=10',
      'GET /v1/users/user_1/app_roles',
      'POST /v1/users/user_1/app_roles',
      'DELETE /v1/users/user_1/app_roles/support',
    ]);
    expect(JSON.parse(calls[6]!.body!)).toEqual({ add: ['support'] });
  });

  it('apiKeys.verify forwards required_scopes', async () => {
    const { client, calls } = mockFetch({ object: 'api_key_verification', valid: false });
    await client.apiKeys.verify('ak_x', { required_scopes: ['docs:read'] });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ secret: 'ak_x', required_scopes: ['docs:read'] });
  });
});

describe('app-level permission helpers', () => {
  const claims = {
    iss: 'i',
    sub: 'user_1',
    sid: 'sess_1',
    exp: 0,
    app_roles: ['support'],
    app_permissions: ['tickets:read'],
  } as SessionClaims;

  it('read app_roles / app_permissions with no organization', () => {
    expect(hasAppPermission(claims, 'tickets:read')).toBe(true);
    expect(hasAppPermission(claims, 'tickets:write')).toBe(false);
    expect(hasAppRole(claims, 'support')).toBe(true);
    expect(hasAppRole(claims, 'admin')).toBe(false);
    expect(has(claims, { allAppPermissions: ['tickets:read'] })).toBe(true);
  });
});
