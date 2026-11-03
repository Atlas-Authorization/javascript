import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { CibaError, clearCibaPin, decideCibaRequest, getCibaPin, listCibaRequests, setCibaPin } from './ciba';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function clientWith(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }), calls };
}

describe('CIBA self-service client', () => {
  it('lists and decides requests', async () => {
    const { client, calls } = clientWith((url) => (url.endsWith('/r1') ? json(200, { status: 'approved' }) : json(200, { object: 'list', data: [{ id: 'r1', client_name: 'A', scope: ['openid'] }] })));
    expect((await listCibaRequests(client))[0]!.id).toBe('r1');
    expect(await decideCibaRequest(client, 'r1', 'approve')).toBe('approved');
    expect(calls[1]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ decision: 'approve' });
  });

  it('sets, reads and clears the PIN, and surfaces a refusal', async () => {
    const { client, calls } = clientWith((_u, init) => (init.method === 'GET' ? json(200, { set: true, updated_at: 5, available: true }) : json(200, { set: init.method === 'PUT' })));
    await setCibaPin(client, { pin: '482913', currentPassword: 'pw' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ pin: '482913', current_password: 'pw' });
    expect(await getCibaPin(client)).toEqual({ set: true, updated_at: 5, available: true });
    await clearCibaPin(client, { currentPassword: 'pw' });
    expect(calls[2]!.init.method).toBe('DELETE');
    const bad = clientWith(() => json(400, { errors: [{ code: 'VALIDATION', message: 'The PIN must be 6 to 12 digits.' }] }));
    await expect(setCibaPin(bad.client, { pin: 'x' })).rejects.toBeInstanceOf(CibaError);
  });
});
