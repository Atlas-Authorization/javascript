import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { MemoryConfigStore } from '../config';
import { captureIO } from '../io';
import { run } from '../run';

type Call = { method: string; path: string; body?: unknown };

function ctx(calls: Call[], answers: Record<string, unknown>): { c: RunContext; io: ReturnType<typeof captureIO> } {
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
      env: {},
      config: new MemoryConfigStore({
        active_profile: 'default',
        profiles: { default: { api_url: 'https://api.atlas.test', secret_key: 'sk_test_123456' } },
      }),
      prompt: { text: async () => '', secret: async () => '' },
      makeClient: () => ({}) as ManagementClient,
      makeHttp: () => http,
      readFile: () => '',
      sleep: async () => undefined,
    },
  };
}

describe('atlas integrations', () => {
  it('set sends the audience, receivers ("none" = null) and dry run, and names getToken({ for })', async () => {
    const calls: Call[] = [];
    const { c, io } = ctx(calls, {
      'PUT /v1/instance/integrations/helpdesk?dry_run=true': { id: 'helpdesk', enabled: true, audience: 'helpdesk:acme', dry_run: true },
    });
    const code = await run(
      ['integrations', 'set', 'helpdesk', '--name', 'Helpdesk', '--audience', 'helpdesk:acme', '--events-url', 'https://h.example.com/e', '--backchannel-logout-url', 'none', '--dry-run'],
      c,
    );
    expect(code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/v1/instance/integrations/helpdesk?dry_run=true',
      body: { audience: 'helpdesk:acme', name: 'Helpdesk', events_url: 'https://h.example.com/e', backchannel_logout_url: null },
    });
    expect(io.stdout()).toContain("Would save helpdesk");
    expect(io.stdout()).toContain("getToken({ for: 'helpdesk' })");
  });

  it('set --oauth-client-id names the first-party client ("none" = null)', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls, {
      'PUT /v1/instance/integrations/referalli': { id: 'referalli', enabled: true, audience: 'referalli:org_1' },
    });
    expect(await run(['integrations', 'set', 'referalli', '--audience', 'referalli:org_1', '--oauth-client-id', 'client_ref'], c)).toBe(0);
    expect(await run(['integrations', 'set', 'referalli', '--audience', 'referalli:org_1', '--oauth-client-id', 'none'], c)).toBe(0);
    expect(calls.map((x) => x.body)).toEqual([
      { audience: 'referalli:org_1', oauth_client_id: 'client_ref' },
      { audience: 'referalli:org_1', oauth_client_id: null },
    ]);
  });

  it('list, deliveries --trace and remove call the generic routes', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls, {
      'GET /v1/instance/integrations': { data: [{ id: 'chatly', connected: false, enabled: false }] },
      'GET /v1/instance/integrations/chatly/deliveries?trace=01J0': { data: [] },
    });
    expect(await run(['integrations', 'list'], c)).toBe(0);
    expect(await run(['integrations', 'deliveries', 'chatly', '--trace', '01J0'], c)).toBe(0);
    expect(await run(['integrations', 'remove', 'chatly'], c)).toBe(0);
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/instance/integrations',
      'GET /v1/instance/integrations/chatly/deliveries?trace=01J0',
      'DELETE /v1/instance/integrations/chatly',
    ]);
  });

  it('refuses a set with nothing to change, and an unknown subcommand', async () => {
    const { c } = ctx([], {});
    expect(await run(['integrations', 'set', 'helpdesk'], c)).not.toBe(0);
    expect(await run(['integrations', 'nope'], c)).not.toBe(0);
  });
});
