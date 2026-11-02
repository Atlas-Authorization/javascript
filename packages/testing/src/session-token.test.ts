import { describe, expect, it, vi } from 'vitest';
import { AtlasSignInError } from './sign-in-as';
import { getSessionToken } from './session-token';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('getSessionToken', () => {
  it('mints for a user id', async () => {
    const fetchImpl = vi.fn(async () => reply({ id: 'sess_1', jwt: 'jwt.a.b' })) as unknown as typeof fetch;
    expect(await getSessionToken({ secretKey: 'sk_test_1', userId: 'user_1', apiUrl: 'https://api.test', fetchImpl })).toEqual({ jwt: 'jwt.a.b', sessionId: 'sess_1' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/sessions');
    expect(JSON.parse(init.body as string)).toEqual({ user_id: 'user_1' });
  });

  it('resolves an email to exactly one user first', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.includes('/v1/users') ? reply({ data: [{ id: 'user_7' }] }) : reply({ id: 's', jwt: 'j.j.j' }))) as unknown as typeof fetch;
    const out = await getSessionToken({ secretKey: 'sk_test_1', email: 'a@example.com', apiUrl: 'https://api.test', fetchImpl });
    expect(out.sessionId).toBe('s');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1].body).toContain('user_7');
  });

  it('refuses no match or several matches', async () => {
    const none = vi.fn(async () => reply({ data: [] })) as unknown as typeof fetch;
    await expect(getSessionToken({ secretKey: 'sk_test_1', email: 'x@example.com', fetchImpl: none })).rejects.toMatchObject({ code: 'user_not_found' });
    const two = vi.fn(async () => reply({ data: [{ id: 'a' }, { id: 'b' }] })) as unknown as typeof fetch;
    await expect(getSessionToken({ secretKey: 'sk_test_1', email: 'x@example.com', fetchImpl: two })).rejects.toBeInstanceOf(AtlasSignInError);
  });

  it('refuses a production key without calling the API', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(getSessionToken({ secretKey: 'sk_live_1', userId: 'u', fetchImpl })).rejects.toMatchObject({ code: 'production_refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws the API error', async () => {
    const fetchImpl = vi.fn(async () => reply({ errors: [{ code: 'forbidden', message: 'nope' }] }, 403)) as unknown as typeof fetch;
    await expect(getSessionToken({ secretKey: 'sk_test_1', userId: 'u', fetchImpl })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('requires a user', async () => {
    await expect(getSessionToken({ secretKey: 'sk_test_1' })).rejects.toBeInstanceOf(AtlasSignInError);
  });
});
