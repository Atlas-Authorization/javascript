import { describe, expect, it } from 'vitest';
import { FapiClient } from './fapi';
import { getProfileSchema, updateProfile } from './profile';

function scripted(status: number, body: unknown) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      path: new URL(String(input)).pathname,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://f.example', fetchImpl }), calls };
}

describe('updateProfile', () => {
  it('PATCHes snake_case fields, traits included', async () => {
    const { client, calls } = scripted(200, { id: 'user_1', public_metadata: { age: 40 } });
    const out = await updateProfile(client, { firstName: 'Ada', traits: { age: '40' } });
    expect(out).toEqual({ ok: true, user: { id: 'user_1', public_metadata: { age: 40 } } });
    expect(calls[0]).toEqual({ path: '/v1/client/me', method: 'PATCH', body: { first_name: 'Ada', traits: { age: '40' } } });
  });

  it('returns the field errors on a refusal', async () => {
    const { client } = scripted(403, { errors: [{ code: 'FORBIDDEN', message: 'no', param: 'traits.plan' }] });
    const out = await updateProfile(client, { traits: { plan: 'pro' } });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.errors[0]?.param).toBe('traits.plan');
  });
});

describe('getProfileSchema', () => {
  it('GETs the schema, with the locale when given', async () => {
    const schema = { object: 'profile_schema', groups: [], fields: [], values: {} };
    const { client, calls } = scripted(200, schema);
    const out = await getProfileSchema(client, { locale: 'de-DE' });
    expect(out).toEqual({ ok: true, schema });
    expect(calls[0]).toEqual({ path: '/v1/client/profile_schema', method: 'GET', body: null });
  });

  it('returns the errors when it cannot be read', async () => {
    const { client } = scripted(401, { errors: [{ code: 'UNAUTHENTICATED', message: 'no' }] });
    const out = await getProfileSchema(client);
    expect(out.ok).toBe(false);
  });
});
