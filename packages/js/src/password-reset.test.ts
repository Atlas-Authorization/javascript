import { describe, expect, it } from 'vitest';
import { FapiClient } from './fapi';
import {
  startPasswordReset,
  advancePasswordReset,
  resetStep,
  initialResetFlow,
  type ResetFlowState,
} from './password-reset';

// A FapiClient wired to a scripted fetch that records the calls it receives.
function clientFor(
  routes: Record<string, { status?: number; body: unknown }>,
): { client: FapiClient; calls: { path: string; body: unknown }[] } {
  const calls: { path: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path: url.pathname, body });
    const r = routes[url.pathname] ?? { status: 404, body: { errors: [{ code: 'NO_ROUTE', message: 'x' }] } };
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test', baseUrl: 'https://api.test', fetchImpl }), calls };
}

describe('password-reset flow', () => {
  it('resetStep maps statuses to steps', () => {
    expect(resetStep(initialResetFlow)).toBe('request');
    const at = (status: string): ResetFlowState => ({ attempt: { id: 'pr', status }, errors: [], busy: false, ticket: null });
    expect(resetStep(at('needs_email_verification'))).toBe('collect_email_code');
    expect(resetStep(at('needs_second_factor'))).toBe('collect_second_factor');
    expect(resetStep(at('needs_new_password'))).toBe('collect_new_password');
    expect(resetStep(at('complete'))).toBe('done');
  });

  it('startPasswordReset POSTs the email and parks at needs_email_verification', async () => {
    const { client, calls } = clientFor({
      '/v1/client/password_resets': { status: 201, body: { id: 'pr_1', status: 'needs_email_verification' } },
    });
    const state = await startPasswordReset(client, 'ada@example.com');
    expect(state.attempt).toEqual({ id: 'pr_1', status: 'needs_email_verification' });
    expect(resetStep(state)).toBe('collect_email_code');
    expect(calls[0]!.path).toBe('/v1/client/password_resets');
    expect((calls[0]!.body as { email_address: string }).email_address).toBe('ada@example.com');
  });

  it('routes each step to its endpoint and carries the completion ticket', async () => {
    const { client, calls } = clientFor({
      '/v1/client/password_resets/pr_1/attempt_verification': { body: { id: 'pr_1', status: 'needs_new_password' } },
      '/v1/client/password_resets/pr_1/set_new_password': { body: { id: 'pr_1', status: 'complete', ticket: 'tk' } },
    });

    let state: ResetFlowState = { attempt: { id: 'pr_1', status: 'needs_email_verification' }, errors: [], busy: false, ticket: null };
    state = await advancePasswordReset(client, state, { code: '123456' });
    expect(calls[0]!.path).toBe('/v1/client/password_resets/pr_1/attempt_verification');
    expect(resetStep(state)).toBe('collect_new_password');

    state = await advancePasswordReset(client, state, { password: 'new-pass' });
    expect(calls[1]!.path).toBe('/v1/client/password_resets/pr_1/set_new_password');
    expect(state.attempt!.status).toBe('complete');
    expect(state.ticket).toBe('tk');
  });

  it('keeps the attempt and surfaces errors on a wrong code', async () => {
    const { client } = clientFor({
      '/v1/client/password_resets/pr_1/attempt_verification': {
        status: 400,
        body: { errors: [{ code: 'verification_failed', message: 'That code is incorrect.' }] },
      },
    });
    const state: ResetFlowState = { attempt: { id: 'pr_1', status: 'needs_email_verification' }, errors: [], busy: false, ticket: null };
    const after = await advancePasswordReset(client, state, { code: '000000' });
    // Attempt preserved (so the user can retry), error surfaced.
    expect(after.attempt).toEqual(state.attempt);
    expect(after.errors[0]!.code).toBe('verification_failed');
  });
});
