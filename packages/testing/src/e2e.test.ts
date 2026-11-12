import { describe, expect, it, vi } from 'vitest';
import { addVirtualAuthenticator, atlasFixtures, createTestUser, deleteTestUser, signInViaPage, totpCode, type E2ePage } from './e2e';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('totpCode', () => {
  it('matches the RFC 6238 SHA-1 vector', async () => {
    // "12345678901234567890" in base32; T=59s -> 94287082 (8 digits), so 6 digits is 287082.
    expect(await totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
  });
});

describe('createTestUser / deleteTestUser', () => {
  it('creates a verified user with a known TOTP secret', async () => {
    const fetchImpl = vi.fn(async () => reply({ id: 'user_1' }, 201)) as unknown as typeof fetch;
    const u = await createTestUser({ secretKey: 'sk_test_1', apiUrl: 'https://api.test', fetchImpl }, { mfa: 'totp' });
    expect(u.id).toBe('user_1');
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/users');
    const body = JSON.parse(init.body as string);
    expect(body.mfa.totp.secret_base32).toBe(u.totpSecret);
    expect(body.email_verified).toBe(true);
  });

  it('refuses a production key before any request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(createTestUser({ secretKey: 'sk_live_1', fetchImpl })).rejects.toMatchObject({ code: 'production_refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('delete never throws', async () => {
    const fetchImpl = vi.fn(async () => reply({ errors: [{ code: 'x' }] }, 500)) as unknown as typeof fetch;
    expect(await deleteTestUser({ secretKey: 'sk_test_1', fetchImpl }, 'user_1')).toBe(false);
  });
});

describe('signInViaPage', () => {
  it('fills the form and the TOTP code', async () => {
    const filled: string[] = [];
    const page = {
      goto: vi.fn(async () => undefined),
      getByLabel: () => ({ fill: async (v: string) => { filled.push(v); } }),
      getByRole: () => ({ click: async () => undefined }),
    } as unknown as E2ePage;
    await signInViaPage(page, { url: 'http://localhost/sign-in', user: { id: 'u', email: 'a@b.c', password: 'pw', totpSecret: 'GEZDGNBVGY3TQOJQ' } });
    expect(filled.slice(0, 2)).toEqual(['a@b.c', 'pw']);
    expect(filled[2]).toMatch(/^\d{6}$/);
  });
});

describe('addVirtualAuthenticator', () => {
  it('enables WebAuthn and removes the device on teardown', async () => {
    const send = vi.fn(async (m: string) => (m === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'a1' } : {}));
    const page = { context: () => ({ newCDPSession: async () => ({ send }) }) } as unknown as E2ePage;
    const remove = await addVirtualAuthenticator(page);
    await remove();
    expect(send.mock.calls.map((c) => c[0])).toEqual(['WebAuthn.enable', 'WebAuthn.addVirtualAuthenticator', 'WebAuthn.removeVirtualAuthenticator', 'WebAuthn.disable']);
  });
});

describe('atlasFixtures', () => {
  it('deletes created users in teardown', async () => {
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => (init.method === 'POST' ? reply({ id: 'user_9' }, 201) : reply({}, 200))) as unknown as typeof fetch;
    const fixtures = atlasFixtures({ secretKey: 'sk_test_1', apiUrl: 'https://api.test', fetchImpl });
    await fixtures.newUser({}, async (make: () => Promise<unknown>) => { await make(); });
    const methods = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as RequestInit).method);
    expect(methods).toEqual(['POST', 'DELETE']);
  });
});
