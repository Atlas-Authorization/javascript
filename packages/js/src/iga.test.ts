import { describe, expect, it, vi } from 'vitest';
import type { FapiClient } from './fapi';
import { cancelAccessRequest, decideAccessReview, decideAccessRequest, endDelegation, listAccessCatalog, listPendingApprovals, requestAccess } from './iga';

function stub(ok: boolean, data: unknown) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const respond = (method: string) => async (path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return { ok, status: ok ? 200 : 409, data: ok ? data : null, errors: ok ? [] : [{ code: 'CONFLICT', message: 'Separation of duties' }] };
  };
  const client = {
    get: vi.fn(respond('GET')),
    post: vi.fn(respond('POST')),
    request: vi.fn((path: string, init?: RequestInit) => respond(init?.method ?? 'GET')(path)),
  } as unknown as FapiClient;
  return { client, calls };
}

describe('identity governance (client)', () => {
  it('lists the catalog', async () => {
    const { client, calls } = stub(true, { object: 'list', data: [{ key: 'wiki' }] });
    expect(await listAccessCatalog(client)).toEqual({ ok: true, data: [{ key: 'wiki' }] });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v1/client/me/iga/catalog' });
  });

  it('files, cancels and decides through the right endpoints', async () => {
    const { client, calls } = stub(true, { id: 'igr_1', status: 'pending' });
    await requestAccess(client, { entitlement: 'wiki', justification: 'need it', durationSeconds: 3600 });
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/v1/client/me/iga/requests', body: { entitlement: 'wiki', justification: 'need it', duration_seconds: 3600 } });
    await cancelAccessRequest(client, 'igr_1');
    expect(calls.at(-1)!.path).toBe('/v1/client/me/iga/requests/igr_1/cancel');
    await decideAccessRequest(client, 'igr_1', 'approve', 'fine');
    expect(calls.at(-1)).toMatchObject({ path: '/v1/client/me/iga/requests/igr_1/decide', body: { decision: 'approve', comment: 'fine' } });
    await decideAccessReview(client, 'igi_1', 'revoke');
    expect(calls.at(-1)!.path).toBe('/v1/client/me/iga/reviews/igi_1/decide');
    await endDelegation(client, 'igd_1');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/client/me/iga/delegations/igd_1' });
  });

  it('surfaces a refusal with its reason', async () => {
    const { client } = stub(false, null);
    expect(await requestAccess(client, { entitlement: 'payer' })).toMatchObject({ ok: false, errors: [{ message: 'Separation of duties' }] });
    expect((await listPendingApprovals(client)).ok).toBe(false);
  });
});
