import { describe, expect, it } from 'vitest';
import { FapiClient } from './fapi';
import { approveSignIn, denySignIn, getAppApproval, prepareAppApproval } from './app-approval';

function setup(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }), calls };
}

describe('app approval', () => {
  it('prepareAppApproval keeps the poll secret and the number to show', async () => {
    const { client, calls } = setup({ poll_secret: 'ps', match_code: '42' });
    const state = await prepareAppApproval(client, { attempt: { id: 'si_1' } as never, errors: [], busy: true, pollSecret: null, ticket: null });
    expect(state).toMatchObject({ pollSecret: 'ps', matchCode: '42', prepared: 'app_approval', busy: false });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/sign_ins/si_1/prepare_first_factor');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ strategy: 'app_approval' });
  });

  it('the approving app reads the choices and answers with the tapped number or a denial', async () => {
    const read = setup({ id: 'a1', purpose: 'first_factor', status: 'pending', choices: ['11', '42', '77'], requested_from: { ip: '203.0.113.9' }, expires_at: 5 });
    expect(await getAppApproval(read.client, 'a1')).toMatchObject({ choices: ['11', '42', '77'], requestedFrom: { ip: '203.0.113.9', userAgent: null } });
    const yes = setup({ status: 'approved' });
    await approveSignIn(yes.client, { id: 'a1', number: '42' });
    expect(JSON.parse(String(yes.calls[0]!.init?.body))).toEqual({ action: 'approve', selected_number: '42' });
    const no = setup({ status: 'denied' });
    await denySignIn(no.client, 'a1');
    expect(JSON.parse(String(no.calls[0]!.init?.body))).toEqual({ action: 'deny' });
  });
});
