import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from '@atlasauth/js';
import { createCacheFetch } from './cache-fetch';
import { createExpoStepUp } from './step-up';
import { createInMemoryTokenCache } from './token-cache';

vi.mock('./policies', () => ({ useExpoFapiClient: () => null }));

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createExpoStepUp', () => {
  it('re-verifies with the stored bearer token and keeps the re-minted token', async () => {
    const cache = createInMemoryTokenCache();
    await cache.saveToken('k', 'old.jwt');
    const seen: Array<{ url: string; auth: string | null }> = [];
    let enrolls = 0;
    const raw = (async (u: string, init: RequestInit) => {
      const url = String(u).replace('https://fapi.test', '');
      seen.push({ url, auth: new Headers(init.headers).get('authorization') });
      if (url === '/v1/client/me') return reply({ has_password: true });
      if (url === '/v1/client/me/mfa') return reply({ data: [], backup_codes_remaining: 0 });
      if (url === '/v1/client/me/passkeys') return reply({ data: [] });
      if (url === '/v1/client/me/step_up') return reply({ object: 'client', stepped_up: true, auth_time: 1, amr: ['pwd'], acr: 'a', jwt: 'new.jwt', expires_in_seconds: 60 });
      if (url === '/v1/client/me/mfa/totp') return enrolls++ === 0 ? reply({ errors: [{ code: 'STEP_UP_REQUIRED', message: 'old', meta: { accepted_factors: ['password', 'email_code'] } }] }, 403) : reply({ id: 'f1' }, 201);
      return reply({}, 404);
    }) as unknown as typeof fetch;
    const client = new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.test', fetchImpl: createCacheFetch({ cache, key: 'k', fetchImpl: raw }), referral: false, exposeSession: false });
    const choose = vi.fn(() => ({ strategy: 'password' as const, password: 'pw' }));
    const { withStepUp } = createExpoStepUp(client, { choose });

    const res = await withStepUp(() => client.post('/v1/client/me/mfa/totp', {}));

    expect(res.ok).toBe(true);
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ factors: ['password', 'email_code'] }));
    expect(seen.every((s) => s.auth?.includes('jwt'))).toBe(true);
    expect(seen.filter((s) => s.url === '/v1/client/me/mfa/totp')).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(await cache.getToken('k')).toBe('new.jwt');
  });
});
