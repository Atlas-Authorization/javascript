import { describe, expect, it, vi } from 'vitest';
import type { FapiClient } from './fapi';
import { getIdentityVerification, startIdentityVerification } from './identity-verification';

function stub(ok: boolean, data: unknown) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const respond = async (path: string, body?: unknown) => {
    calls.push({ path, body });
    return { ok, status: ok ? 200 : 409, data: ok ? data : null, errors: ok ? [] : [{ code: 'CONFLICT', message: 'off' }] };
  };
  const client = { request: vi.fn((path: string) => respond(path)), post: vi.fn((path: string, body?: unknown) => respond(path, body)) } as unknown as FapiClient;
  return { client, calls };
}

describe('identity verification', () => {
  it('starts a check, passing the return url', async () => {
    const { client, calls } = stub(true, { object: 'identity_verification', status: 'pending', url: 'https://v.example/x' });
    const res = await startIdentityVerification(client, 'https://app.example/done');
    expect(res).toMatchObject({ ok: true, data: { status: 'pending', url: 'https://v.example/x' } });
    expect(calls[0]).toEqual({ path: '/v1/client/me/identity_verification', body: { redirect_url: 'https://app.example/done' } });
  });

  it('reads the latest outcome and surfaces errors', async () => {
    const good = stub(true, { object: 'identity_verification', status: 'approved' });
    expect(await getIdentityVerification(good.client)).toMatchObject({ ok: true, data: { status: 'approved' } });
    expect(good.calls[0]!.path).toBe('/v1/client/me/identity_verification');
    const bad = stub(false, null);
    expect(await startIdentityVerification(bad.client)).toMatchObject({ ok: false, errors: [{ code: 'CONFLICT' }] });
  });
});
