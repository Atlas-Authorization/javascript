import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { createMachineEnrolmentCode } from './machine-enrolment';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function clientWith(answer: () => Response) {
  const calls: { path: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ path: String(input).replace('https://fapi.example', ''), body: init.body ? JSON.parse(String(init.body)) : undefined });
    return answer();
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl, referral: false, exposeSession: false }), calls };
}

describe('createMachineEnrolmentCode', () => {
  it('returns the code and expiry, sending the lifetime only when given', async () => {
    const { client, calls } = clientWith(() => json(201, { object: 'machine_enrolment_code', id: 'met_1', user_code: 'BCDF-GHJK', expires_at: 5000, expires_in: 600 }));
    expect(await createMachineEnrolmentCode(client)).toEqual({ ok: true, code: 'BCDF-GHJK', id: 'met_1', expiresAt: 5000, expiresIn: 600 });
    await createMachineEnrolmentCode(client, { expiresInSeconds: 300 });
    expect(calls[0]).toMatchObject({ path: '/v1/client/me/machine_enrolment_codes', body: {} });
    expect(calls[1]!.body).toEqual({ expires_in_seconds: 300 });
  });

  it('reports errors and a step-up requirement', async () => {
    const { client } = clientWith(() => json(429, { errors: [{ code: 'RATE_LIMITED', message: 'Too many.' }] }));
    expect(await createMachineEnrolmentCode(client)).toMatchObject({ ok: false, status: 429, stepUpRequired: false });
  });
});
