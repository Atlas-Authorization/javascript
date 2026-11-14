import { verifyAtlasWebhook } from '@atlasauth/backend';
import { describe, expect, it } from 'vitest';
import { createTestMembership, createTestOrg, createTestUser, seedScenario, signWebhook, waitForMessage, type AtlasTestTarget } from './emulator';

const fake = (handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  const target: AtlasTestTarget = { baseUrl: 'http://emu.test/', secretKey: 'sk_test_emulator', fetchImpl };
  return { calls, target };
};

describe('fixtures', () => {
  it('createTestUser/Org/Membership call the Backend API with the secret key and unique defaults', async () => {
    const { calls, target } = fake(() => ({ body: { id: 'x' } }));
    await createTestUser(target, { firstName: 'Ada' });
    await createTestOrg(target, { createdBy: 'user_1' });
    await createTestMembership(target, { organizationId: 'org_1', userId: 'user_2' });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(['POST http://emu.test/v1/users', 'POST http://emu.test/v1/organizations', 'POST http://emu.test/v1/organizations/org_1/memberships']);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk_test_emulator');
    expect(JSON.parse(String(calls[0]!.init.body)).email_address).toMatch(/^test-.+@example\.com$/);
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ user_id: 'user_2', role: 'org:member' });
  });

  it('turns an API failure into an error naming the code', async () => {
    const { target } = fake(() => ({ status: 409, body: { errors: [{ code: 'IDENTIFIER_EXISTS', message: 'taken' }] } }));
    await expect(createTestUser(target, { email: 'a@example.com' })).rejects.toThrow(/409: IDENTIFIER_EXISTS taken/);
  });

  it('seedScenario posts to the emulator without an Authorization header and returns the refs', async () => {
    const { calls, target } = fake(() => ({ body: { refs: { ada: { id: 'user_1' } } } }));
    expect(await seedScenario(target, { users: [{ ref: 'ada', email: 'ada@example.com' }] })).toEqual({ ada: { id: 'user_1' } });
    expect(calls[0]!.url).toBe('http://emu.test/__emulator/scenarios');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('waitForMessage long-polls the sink and rejects when nothing arrives', async () => {
    const hit = fake(() => ({ body: { data: [{ id: 1, to: 'a@example.com', channel: 'email', code: '123456' }] } }));
    expect((await waitForMessage(hit.target, { to: 'a@example.com', channel: 'email', timeoutMs: 1000 })).code).toBe('123456');
    expect(hit.calls[0]!.url).toContain('wait=1000');
    const miss = fake(() => ({ body: { data: [] } }));
    await expect(waitForMessage(miss.target, { to: 'b@example.com', timeoutMs: 10 })).rejects.toThrow(/No message/);
  });
});

describe('signWebhook', () => {
  it('produces headers that the Atlas verifier accepts, and only for the right secret and body', async () => {
    const { body, headers } = await signWebhook({ secret: 'whsec_test', body: { type: 'user.created', data: { id: 'user_1' } } });
    expect((await verifyAtlasWebhook({ body, headers, secret: 'whsec_test' })).verified).toBe(true);
    expect((await verifyAtlasWebhook({ body, headers, secret: 'whsec_other' })).verified).toBe(false);
    expect((await verifyAtlasWebhook({ body: `${body} `, headers, secret: 'whsec_test' })).verified).toBe(false);
    const old = await signWebhook({ secret: 'whsec_test', body: '{}', timestamp: Date.now() - 3_600_000 });
    expect((await verifyAtlasWebhook({ body: old.body, headers: old.headers, secret: 'whsec_test' })).reason).toBe('stale_timestamp');
  });
});
