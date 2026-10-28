import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { MemoryConfigStore } from '../config';
import { captureIO } from '../io';
import { run } from '../run';

type Call = { method: string; path: string; body?: unknown };

function ctx(calls: Call[], answers: Record<string, unknown>, files: Record<string, string> = {}, env: Record<string, string> = {}): { c: RunContext; io: ReturnType<typeof captureIO> } {
  const io = captureIO();
  const send = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return (answers[`${method} ${path}`] ?? {}) as never;
  };
  const http: ConfigHttp = {
    get: (p) => send('GET', p),
    post: (p, b) => send('POST', p, b),
    put: (p, b) => send('PUT', p, b),
    patch: (p, b) => send('PATCH', p, b),
    delete: async (p) => {
      await send('DELETE', p);
    },
  };
  return {
    io,
    c: {
      io,
      env,
      config: new MemoryConfigStore({
        active_profile: 'default',
        profiles: { default: { api_url: 'https://api.atlas.test', secret_key: 'sk_test_123456' } },
      }),
      prompt: { text: async () => '', secret: async () => '' },
      makeClient: () => ({}) as ManagementClient,
      makeHttp: () => http,
      readFile: (p: string) => files[p] ?? '',
      sleep: async () => undefined,
    },
  };
}

describe('atlas partner-platforms', () => {
  it('set sends the preset overrides and allowed sources', async () => {
    const calls: Call[] = [];
    const { c, io } = ctx(calls, {
      'PUT /v1/partner_platforms/cookiemunch': { partner: 'cookiemunch', enabled: true, receiver_url: 'https://api.atlas.test/v1/partner_deliveries/cookiemunch/ins_1' },
    });
    expect(await run(['partner-platforms', 'set', 'cookiemunch', '--allowed-source', 'dv-1', '--allowed-source', 'dv-2'], c)).toBe(0);
    expect(calls[0]).toEqual({ method: 'PUT', path: '/v1/partner_platforms/cookiemunch', body: { allowed_sources: ['dv-1', 'dv-2'] } });
    expect(io.stdout()).toContain('partner-platforms registration cookiemunch');
  });

  it('registration prints what to send the partner', async () => {
    const calls: Call[] = [];
    const { c, io } = ctx(calls, {
      'GET /v1/partner_platforms/cookiemunch/registration': {
        partner: 'cookiemunch',
        platform_id: 'atlas',
        receiver_url: 'https://api.atlas.test/v1/partner_deliveries/cookiemunch/ins_1',
        receiver_url_is_template: false,
        events: ['consent.recorded', 'consent.withdrawn'],
        signature: { header: 'CookieMunch-Partner-Signature', format: 't=,kid=,ed25519=', jwks_url: 'https://api.cookiemunch.net/v1/partner/jwks.json', tolerance_seconds: 300 },
        send_to: { contact: 'support@cookiemunch.net', docs: 'https://cookiemunch.net/docs/provisioning-and-health' },
      },
    });
    expect(await run(['partner-platforms', 'registration', 'cookiemunch'], c)).toBe(0);
    expect(io.stdout()).toContain('support@cookiemunch.net');
    expect(io.stdout()).toContain('/v1/partner_deliveries/cookiemunch/ins_1');
  });

  it('token reads the token from a file, sends it once, and never prints it', async () => {
    const calls: Call[] = [];
    const { c, io } = ctx(
      calls,
      { 'POST /v1/partner_platforms/cookiemunch/token': { partner: 'cookiemunch', name: 'Cookie Munch', token_set: true } },
      { '/tmp/tok': 'CM_TOKEN=cmpt_abcdefghijklmnop\n' },
    );
    expect(await run(['partner-platforms', 'token', 'cookiemunch', '--token-file', '/tmp/tok', '--rotate'], c)).toBe(0);
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/partner_platforms/cookiemunch/token', body: { token: 'cmpt_abcdefghijklmnop', rotate: true } });
    expect(io.stdout()).not.toContain('cmpt_');
  });

  it('token falls back to ATLAS_PARTNER_TOKEN and refuses with neither', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls, {}, {}, { ATLAS_PARTNER_TOKEN: 'cmpt_fromenv_0123456' });
    expect(await run(['partner-platforms', 'token', 'cookiemunch'], c)).toBe(0);
    expect(calls[0]?.body).toEqual({ token: 'cmpt_fromenv_0123456' });
    const none = ctx([], {});
    expect(await run(['partner-platforms', 'token', 'cookiemunch'], none.c)).not.toBe(0);
    expect(none.io.stderr()).toContain('--token-file');
  });

  it('deliveries and list render tables', async () => {
    const calls: Call[] = [];
    const { c, io } = ctx(calls, {
      'GET /v1/partner_platforms/cookiemunch/deliveries?limit=5': { data: [{ received_at: 0, event_type: 'consent.recorded', outcome: 'no_subject', user_id: null }] },
      'GET /v1/partner_platforms': { data: [{ partner: 'cookiemunch', enabled: true, token_set: false, receiver_url: 'https://x' }] },
    });
    expect(await run(['partner-platforms', 'deliveries', 'cookiemunch', '--limit', '5'], c)).toBe(0);
    expect(await run(['partner-platforms', 'list'], c)).toBe(0);
    expect(io.stdout()).toContain('no_subject');
    expect(io.stdout()).toContain('not stored');
  });
});
