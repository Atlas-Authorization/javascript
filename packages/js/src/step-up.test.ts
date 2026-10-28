import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { authenticatedWithin, sendStepUpEmailCode, stepUp } from './step-up';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(handler: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler();
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl, referral: false }), calls };
}

describe('step-up', () => {
  it('posts the credential and returns the fresh token and auth context', async () => {
    const body = { object: 'client', stepped_up: true, auth_time: 1_800_000_000, amr: ['pwd'], acr: 'urn:atlas:acr:step_up', jwt: 'eyJ', expires_in_seconds: 60 };
    const { client, calls } = clientWith(() => json(200, body));
    const res = await stepUp(client, { strategy: 'password', password: 'hunter2' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(body);
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/step_up');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ strategy: 'password', password: 'hunter2' });
  });

  it('a wrong credential comes back as the server error, not a throw', async () => {
    const { client } = clientWith(() => json(401, { errors: [{ code: 'UNAUTHENTICATED', message: 'Step-up re-authentication failed.' }] }));
    const res = await stepUp(client, { strategy: 'totp', code: '000000' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.errors[0]!.code).toBe('UNAUTHENTICATED');
  });

  it('sends the email code to the step-up endpoint', async () => {
    const { client, calls } = clientWith(() => json(201, { object: 'step_up_email_code' }));
    await sendStepUpEmailCode(client);
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/step_up/email_code');
  });

  it('authenticatedWithin compares auth_time with the window', () => {
    const now = 1_800_000_300_000;
    expect(authenticatedWithin({ auth_time: 1_800_000_000 }, 300, now)).toBe(true);
    expect(authenticatedWithin({ auth_time: 1_799_999_999 }, 300, now)).toBe(false);
    expect(authenticatedWithin({}, 300, now)).toBe(false);
    expect(authenticatedWithin({ auth_time: '1800000000' }, 300, now)).toBe(false);
  });
});
