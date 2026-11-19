import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { MemoryConfigStore } from '../config';
import { captureIO } from '../io';
import { run } from '../run';

type Call = { method: string; path: string; body?: unknown };

function ctx(calls: Call[], answers: Record<string, unknown>, files: Record<string, string> = {}) {
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
  const c: RunContext = {
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.atlas.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: (p) => files[p] ?? '',
    sleep: async () => undefined,
  };
  return { c, io };
}

describe('atlas hooks before-first-session', () => {
  it('set sends url, the secret read from a file, timeout and enabled; never prints the secret', async () => {
    const calls: Call[] = [];
    const { c, io } = ctx(calls, { 'PATCH /v1/instance/hooks/before_first_session': { url: 'https://app.example.com/h', enabled: true, timeout_ms: 2000, signing_secret_set: true } }, { '/tmp/s': 'whsec_abc123\n' });
    expect(await run(['hooks', 'before-first-session', 'set', '--url', 'https://app.example.com/h', '--secret-file', '/tmp/s', '--timeout-ms', '2000', '--enable'], c)).toBe(0);
    expect(calls[0]).toEqual({ method: 'PATCH', path: '/v1/instance/hooks/before_first_session', body: { url: 'https://app.example.com/h', signing_secret: 'whsec_abc123', timeout_ms: 2000, enabled: true } });
    expect(io.stdout()).toContain('signing secret set');
    expect(io.stdout()).not.toContain('whsec_abc123');
  });

  it('show, remove and test call their routes; a failed test exits 1', async () => {
    const calls: Call[] = [];
    const { c, io } = ctx(calls, { 'POST /v1/instance/hooks/before_first_session/test': { ok: false, error: { code: 'timeout', message: 'no answer' }, latency_ms: 5, http_status: null } });
    expect(await run(['hooks', 'before-first-session', 'show'], c)).toBe(0);
    expect(io.stdout()).toContain('not configured');
    expect(await run(['hooks', 'before-first-session', 'remove'], c)).toBe(0);
    expect(await run(['hooks', 'before-first-session', 'test'], c)).toBe(1);
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/instance/hooks/before_first_session',
      'DELETE /v1/instance/hooks/before_first_session',
      'POST /v1/instance/hooks/before_first_session/test',
    ]);
  });
});

describe('atlas issuers', () => {
  it('prints the four fields', async () => {
    const { c, io } = ctx([], { 'GET /v1/instance/issuers': { active: 'https://a.example', planned: 'https://app.example.com/__atlas', previous: ['https://old.example'], jwks_uri: 'https://a.example/.well-known/jwks.json' } });
    expect(await run(['issuers'], c)).toBe(0);
    expect(io.stdout()).toContain('planned   https://app.example.com/__atlas');
    expect(io.stdout()).toContain('previous  https://old.example');
  });
});

describe('atlas integrations health and forwarding', () => {
  it('health lists rows', async () => {
    const { c, io } = ctx([], { 'GET /v1/instance/integrations/health': { data: [{ kind: 'webhook_endpoint', id: 'we_1', name: 'Crossly', managed_by: null, destination: 'lucida', state: 'healthy', last_success_at: null, consecutive_failures: 0 }], unhealthy_count: 0 } });
    expect(await run(['integrations', 'health'], c)).toBe(0);
    expect(io.stdout()).toContain('Crossly');
    expect(io.stdout()).toContain('Nothing failing.');
  });

  it('forwarding set reads the key from a file and removes with DELETE', async () => {
    const calls: Call[] = [];
    const { c, io } = ctx(calls, { 'PUT /v1/instance/integrations/forwarding/lucida': { id: 'we_9', created: true } }, { '/tmp/k': 'LUCIDA_KEY=sk_abc\n' });
    expect(await run(['integrations', 'forwarding', 'set', 'lucida', '--secret-file', '/tmp/k', '--host', 'https://l.example', '--include-pii'], c)).toBe(0);
    expect(calls[0]).toEqual({ method: 'PUT', path: '/v1/instance/integrations/forwarding/lucida', body: { server_key: 'sk_abc', host: 'https://l.example', include_pii: true } });
    expect(io.stdout()).not.toContain('sk_abc');
    expect(await run(['integrations', 'forwarding', 'remove', 'lucida'], c)).toBe(0);
    expect(calls[1]).toEqual({ method: 'DELETE', path: '/v1/instance/integrations/forwarding/lucida' });
  });
});
