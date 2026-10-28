import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

type Call = { method: string; path: string; body?: unknown };

function ctx(calls: Call[], answers: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const send = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return (answers[`${method} ${path}`] ?? {}) as never;
  };
  const http: ConfigHttp = {
    get: (p) => send('GET', p),
    post: (p, b) => send('POST', p, b),
    put: (p, b) => send('PUT', p, b),
    patch: (p, b) => send('PATCH', p, b),
    delete: async (p, b) => {
      await send('DELETE', p, b);
    },
  };
  const io = captureIO();
  const c: RunContext = {
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: (p) => files[p] ?? '',
  };
  return { c, io };
}

describe('resource commands', () => {
  it('invokes a workflow with a JSON body and encodes ids', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    expect(await run(['workflows', 'run', 'wf/1', '--data', '{"input":{"a":1}}'], c)).toBe(0);
    expect(calls).toEqual([{ method: 'POST', path: '/v1/workflows/wf%2F1/invoke', body: { input: { a: 1 } } }]);
  });

  it('resumes a run using two ids', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    await run(['workflows', 'resume', 'wf_1', 'run_2'], c);
    expect(calls[0]!.path).toBe('/v1/workflows/wf_1/runs/run_2/resume');
  });

  it('refuses a missing id and a non-object body', async () => {
    const calls: Call[] = [];
    const a = ctx(calls);
    expect(await run(['workflows', 'resume', 'wf_1'], a.c)).toBe(1);
    expect(a.io.stderr()).toContain('needs 2 id');
    const b = ctx(calls);
    expect(await run(['workflows', 'run', 'wf_1', '--data', '[1]'], b.c)).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('fails closed on destructive ops without --yes', async () => {
    const calls: Call[] = [];
    const a = ctx(calls);
    expect(await run(['device-sso', 'revoke', 'dsr_1'], a.c)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(await run(['device-sso', 'revoke', 'dsr_1', '--yes'], a.c)).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/device_sso/registrations/dsr_1/revoke' });
  });

  it('prints a launch URL only when it is https', async () => {
    const calls: Call[] = [];
    const ok = ctx(calls, { 'GET /v1/cloud_access/targets/t1': { launch_url: 'https://idp.test/launch/t1' } });
    expect(await run(['cloud', 'login', 't1'], ok.c)).toBe(0);
    expect(ok.io.stdout()).toContain('https://idp.test/launch/t1');
    const bad = ctx(calls, { 'GET /v1/cloud_access/targets/t1': { launch_url: 'javascript:alert(1)' } });
    expect(await run(['cloud', 'login', 't1'], bad.c)).toBe(1);
  });

  it('renders a list as a table', async () => {
    const { c, io } = ctx([], { 'GET /v1/mcp_gateways': { data: [{ id: 'gw_1', name: 'Main' }] } });
    await run(['mcp', 'gateways'], c);
    expect(io.stdout()).toContain('gw_1');
  });

  it('routes keys data / keys op and users merge', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    await run(['keys', 'data', 'status'], c);
    await run(['keys', 'op', 'rotate', '--data', '{"alg":"ES384"}', '--yes'], c);
    await run(['users', 'merge', 'user_a', 'user_b', '--dry-run'], c);
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/instance/data_key_provider',
      'POST /v1/instance/op_keys/rotate',
      'POST /v1/users/user_b/merge',
    ]);
    expect(calls[2]!.body).toEqual({ source_user_id: 'user_a', dry_run: true });
  });

  it('refuses a real merge without --yes', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    expect(await run(['users', 'merge', 'a', 'b'], c)).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('maps the SAML, provisioning and catalog commands to their routes', async () => {
    const calls: Call[] = [];
    const a = ctx(calls);
    expect(await run(['saml-idp', 'import-metadata', '--data', '{"url":"https://idp.test/m"}'], a.c)).toBe(1);
    expect(await run(['saml-idp', 'import-metadata', '--data', '{"url":"https://idp.test/m"}', '--yes'], a.c)).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/saml_idp/service_providers/import_metadata' });
    expect(await run(['provisioning', 'failures', 'tgt_1'], a.c)).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/v1/scim_provisioning_targets/tgt_1/failures' });
    expect(await run(['provisioning', 'retry', 'tgt_1'], a.c)).toBe(1);
    expect(await run(['catalog', 'vote', 'req_1'], a.c)).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/app_catalog/requests/req_1/vote' });
    expect(await run(['catalog', 'requests'], a.c)).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/v1/app_catalog/requests' });
  });

  it('shreds the data key only when the typed instance id matches', async () => {
    const calls: Call[] = [];
    const a = ctx(calls, { 'GET /v1/instance': { id: 'ins_1' } });
    expect(await run(['keys', 'data', 'shred', '--confirm', 'ins_2'], a.c)).toBe(1);
    expect(await run(['keys', 'data', 'shred'], a.c)).toBe(1);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(await run(['keys', 'data', 'shred', '--confirm', 'ins_1'], a.c)).toBe(0);
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/v1/instance/data_key_provider', body: { confirm: 'shred' } });
  });
});
