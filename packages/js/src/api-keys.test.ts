import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import {
  ApiKeyRequestError,
  createApiKey,
  impliedScopes,
  listApiKeys,
  revokeApiKey,
  scopeGrid,
  updateApiKey,
} from './api-keys';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }), calls };
}

const KEY = {
  object: 'api_key',
  id: 'eak_1',
  subject_type: 'user',
  subject_id: 'user_1',
  name: 'CLI',
  prefix: 'ak_abc',
  claims: {},
  scopes: null,
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  created_at: 1,
};

describe('end-user API key client', () => {
  it('lists keys and maps the create-form settings', async () => {
    const { client, calls } = clientWith(() =>
      json(200, { object: 'list', data: [KEY], allowed_scopes: ['r'], allowed_claims: ['c'], max_active_keys: 5, active_count: 1 }),
    );
    const list = await listApiKeys(client, { organizationId: 'org_1' });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/api_keys?organization_id=org_1');
    expect(calls[0]!.init.credentials).toBe('include');
    expect(list).toEqual({ data: [KEY], allowedScopes: ['r'], allowedClaims: ['c'], scopeImplications: {}, maxActiveKeys: 5, activeCount: 1 });
  });

  it('creates with snake_case fields and returns the one-time secret', async () => {
    const { client, calls } = clientWith(() => json(201, { ...KEY, secret: 'ak_abc_secret' }));
    const created = await createApiKey(client, {
      name: 'CLI',
      expiresInSeconds: 60,
      scopes: ['r'],
      claims: { spend_limit: 5 },
      organizationId: 'org_1',
    });
    expect(created.secret).toBe('ak_abc_secret');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      name: 'CLI',
      expires_in_seconds: 60,
      scopes: ['r'],
      claims: { spend_limit: 5 },
      organization_id: 'org_1',
    });
  });

  it('throws a typed error carrying the server code (step-up)', async () => {
    const { client } = clientWith(() =>
      json(403, { errors: [{ code: 'STEP_UP_REQUIRED', message: 'Re-authenticate.' }] }),
    );
    const err = await createApiKey(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiKeyRequestError);
    expect((err as ApiKeyRequestError).code).toBe('STEP_UP_REQUIRED');
    expect((err as ApiKeyRequestError).status).toBe(403);
    expect((err as ApiKeyRequestError).needsReverification).toBe(true);
  });

  it('renames and revokes by id', async () => {
    const { client, calls } = clientWith((url) =>
      url.endsWith('/revoke') ? json(200, { object: 'api_key', id: 'eak_1', revoked: true }) : json(200, { ...KEY, name: 'New' }),
    );
    expect((await updateApiKey(client, 'eak_1', { name: 'New' })).name).toBe('New');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect((await revokeApiKey(client, 'eak_1')).revoked).toBe(true);
    expect(calls[1]!.url).toBe('https://fapi.example/v1/client/me/api_keys/eak_1/revoke');
  });
});

describe('scope helpers', () => {
  it('impliedScopes follows implications transitively; * is the named vocabulary only', () => {
    const imp = { 'calls:write': ['calls:read'], admin: ['*'], a: ['b'], b: ['a'] };
    expect(impliedScopes(['calls:write'], imp)).toEqual(['calls:read', 'calls:write']);
    expect(impliedScopes(['a'], imp)).toEqual(['a', 'b']);
    expect(impliedScopes(['admin'], imp, ['x:read'])).toEqual(['a', 'admin', 'b', 'calls:read', 'calls:write', 'x:read']);
  });
  it('scopeGrid groups resource:read/write and returns the rest as other', () => {
    expect(scopeGrid(['calls:read', 'calls:write', 'leads:read', 'admin'])).toEqual({
      rows: [
        { resource: 'calls', read: 'calls:read', write: 'calls:write' },
        { resource: 'leads', read: 'leads:read' },
      ],
      other: ['admin'],
    });
    expect(scopeGrid(['admin', 'reports:export'])).toBeNull();
  });
});
