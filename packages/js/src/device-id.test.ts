// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_ID_ROUTES, FapiClient } from './fapi';

/**
 * The stable device id rides on every start that can create an account (email
 * sign-up, social, enterprise SSO, native id_token, wallets), so the
 * accounts-per-device abuse limit counts social and SSO sign-ups too.
 */
function recording() {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'sia_1', status: 'needs_oauth_callback' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const client = new FapiClient({ publishableKey: 'pk', baseUrl: 'https://f.example', fetchImpl });
  const bodyFor = (path: string) => calls.filter((c) => c.path === path).at(-1)?.body;
  return { client, bodyFor };
}

describe('device_id on account-creating starts', () => {
  it.each([
    ['/v1/client/sign_ins/oauth', { provider: 'google', redirect_url: 'https://app.example/cb' }],
    ['/v1/client/sign_ins/sso', { email: 'a@corp.example', redirect_url: 'https://app.example/cb' }],
    ['/v1/client/sign_ins/saml', { email: 'a@corp.example', redirect_url: 'https://app.example/cb' }],
    ['/v1/client/sign_ins/wsfed', { email: 'a@corp.example', redirect_url: 'https://app.example/cb' }],
    ['/v1/client/sign_ins/id_token', { provider: 'google', id_token: 'a.b.c' }],
    ['/v1/oauth/siwe/verify', { message: 'm', signature: 's' }],
  ])('%s carries the device id', async (path, body) => {
    const { client, bodyFor } = recording();
    await client.post(path, body);
    expect(bodyFor(path)).toMatchObject({ ...body, device_id: expect.stringMatching(/^d_/) });
  });

  it('the same device id as an email sign-up', async () => {
    const { client, bodyFor } = recording();
    await client.post('/v1/client/sign_ups', { email: 'a@b.co' });
    await client.post('/v1/client/sign_ins/oauth', { provider: 'github', redirect_url: 'https://app.example/cb' });
    expect(bodyFor('/v1/client/sign_ins/oauth')!.device_id).toBe(bodyFor('/v1/client/sign_ups')!.device_id);
  });

  it('a password / passwordless sign-in does not send it, and a caller-set id is kept', async () => {
    const { client, bodyFor } = recording();
    await client.post('/v1/client/sign_ins', { identifier: 'a@b.co' });
    expect(bodyFor('/v1/client/sign_ins')).not.toHaveProperty('device_id');
    await client.post('/v1/client/sign_ins/oauth', { provider: 'google', redirect_url: 'https://x/cb', device_id: 'd_mine123' });
    expect(bodyFor('/v1/client/sign_ins/oauth')!.device_id).toBe('d_mine123');
    expect(DEVICE_ID_ROUTES.has('/v1/client/sign_ins')).toBe(false);
  });
});
