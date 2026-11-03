import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';

/** `atlas golive` and `atlas doctor --origin`, driven through `run()` with an in-memory API. */

type Call = { method: string; path: string; body?: unknown };
const ISSUER = 'https://auth.example.com';

/** The Atlas API of an instance that is one verify + one webhook activation away from live. */
function mockApi(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'GET /v1/domains': { data: [{ id: 'dom_1', role: 'fapi', host: 'auth.example.com', status: 'pending', method: 'cname' }], required: true },
    'POST /v1/domains/dom_1/verify': { id: 'dom_1', role: 'fapi', host: 'auth.example.com', status: 'active', verified: true },
    'GET /v1/instance': { id: 'ins_1', issuer: ISSUER },
    'GET /v1/instance/sign_in_with_atlas': { enabled: false, connection_id: null, candidates: [], turned_off_by_you: false },
    'GET /v1/webhook_endpoints': { data: [{ id: 'we_1', url: 'https://app.example.com/hook', active: false }] },
    'POST /v1/webhook_endpoints/we_1/test?wait=10s': { status: 'success', http_status: 200 },
    'GET /v1/instance/hooks/before_user_create': { enabled: false, url: null, signing_secret_set: false },
    'GET /v1/instance/preflight': { ok: true, findings: [{ severity: 'warning', code: 'W1', message: 'meh', fix: 'x' }] },
    'GET /v1/diagnostics/login_readiness?origin=https%3A%2F%2Fapp.example.com&live=true': { ready: true, checks: [] },
    'GET /v1/instance/referrals': { endpoint_url: null, connection_id: null, signing_secret_set: false },
    'GET /v1/instance/privacy_integrations': { preset: null, connected: false },
    'GET /v1/instance/integrations': { data: [{ id: 'chatly', connected: true, enabled: true }, { id: 'forumulate', connected: false, enabled: false }] },
    'GET /v1/integration-health': { ok: true, checks: [], summary: { failing: 0, passing: 0, unknown: 0 } },
    'GET /v1/instance/cookie_consent': { declared_cookies: [{ name: '__session' }, { name: '__client' }, { name: null }] },
    ...over,
  };
}

function setup(answers: Record<string, unknown>, discoveryIssuer = ISSUER) {
  const calls: Call[] = [];
  const fetched: string[] = [];
  const send = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const a = answers[`${method} ${path}`];
    return (a ?? {}) as never;
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
  const make = (io: CaptureIO): RunContext => ({
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: () => '',
    fetch: (async (url: string | URL) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ issuer: discoveryIssuer }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { calls, fetched, make };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

describe('atlas golive', () => {
  it('happy path: verifies the domain, tests then activates the webhook, and exits 0', async () => {
    const { calls, fetched, make } = setup(mockApi());
    const io = captureIO();
    expect(await run(['golive', '--origin', 'https://app.example.com'], make(io))).toBe(0);
    expect(writes(calls)).toEqual([
      'POST /v1/domains/dom_1/verify',
      'POST /v1/webhook_endpoints/we_1/test?wait=10s',
      'PATCH /v1/webhook_endpoints/we_1',
    ]);
    expect(fetched).toEqual(['https://auth.example.com/.well-known/openid-configuration']);
    const out = io.stdout();
    expect(out).toContain('✓ domains — auth.example.com verified');
    expect(out).toContain(`✓ issuer — ${ISSUER}`);
    expect(out).toContain('✓ webhooks — https://app.example.com/hook tested and activated');
    expect(out).toContain('✓ login_readiness');
    expect(out).toContain('✓ integrations/chatly — on');
    expect(out).not.toContain('forumulate');
  });

  it('wrong issuer: stops at the issuer step with a fix and exits 1', async () => {
    const { calls, make } = setup(mockApi(), 'https://someone-else.example.net');
    const io = captureIO();
    expect(await run(['golive', '--origin', 'https://app.example.com'], make(io))).toBe(1);
    expect(io.stdout()).toContain('✗ issuer — https://auth.example.com/.well-known/openid-configuration serves issuer https://someone-else.example.net, expected https://auth.example.com');
    expect(io.stdout()).toContain('  fix: ');
    // Nothing after the failing step ran.
    expect(calls.some((c) => c.path.startsWith('/v1/webhook_endpoints'))).toBe(false);
  });

  it('a failing webhook test leaves the endpoint inactive', async () => {
    const { calls, make } = setup(mockApi({ 'POST /v1/webhook_endpoints/we_1/test?wait=10s': { status: 'failed', http_status: 502 } }));
    const io = captureIO();
    expect(await run(['golive', '--origin', 'https://app.example.com'], make(io))).toBe(1);
    expect(writes(calls)).not.toContain('PATCH /v1/webhook_endpoints/we_1');
    expect(io.stdout()).toContain('✗ webhooks — test delivery to https://app.example.com/hook failed (502)');
  });

  it('preflight errors fail the run', async () => {
    const { make } = setup(mockApi({ 'GET /v1/instance/preflight': { findings: [{ severity: 'error', code: 'E1', message: 'broken', fix: 'mend it' }] } }));
    const io = captureIO();
    expect(await run(['golive', '--origin', 'https://app.example.com'], make(io))).toBe(1);
    expect(io.stdout()).toContain('✗ preflight — E1: broken\n  fix: E1: mend it');
  });

  it('--dry-run sends every write with ?dry_run=true', async () => {
    const { calls, make } = setup(mockApi({ 'POST /v1/domains/dom_1/verify?dry_run=true': { object: 'dry_run' } }));
    const io = captureIO();
    expect(await run(['golive', '--origin', 'https://app.example.com', '--dry-run'], make(io))).toBe(0);
    const w = writes(calls);
    expect(w.length).toBeGreaterThan(0);
    expect(w.every((p) => p.endsWith('dry_run=true'))).toBe(true);
    expect(io.stdout()).toContain('Dry run: nothing was written.');
  });

  it('--json prints the steps', async () => {
    const { make } = setup(mockApi());
    const io = captureIO();
    expect(await run(['golive', '--origin', 'https://app.example.com', '--json'], make(io))).toBe(0);
    const body = JSON.parse(io.stdout()) as { ok: boolean; steps: Array<{ id: string }> };
    expect(body.ok).toBe(true);
    expect(body.steps[0]!.id).toBe('domains');
  });

  it('needs --origin', async () => {
    const { make } = setup(mockApi());
    const io = captureIO();
    expect(await run(['golive'], make(io))).toBe(1);
    expect(io.stderr()).toContain('golive needs --origin');
  });
});

describe('atlas doctor --origin', () => {
  it('adds preflight, login readiness, path mount and declared cookies to one report', async () => {
    const { make } = setup(mockApi());
    const io = captureIO();
    expect(await run(['doctor', '--origin', 'https://app.example.com'], make(io))).toBe(1);
    const out = io.stdout();
    expect(out).toContain('preflight');
    expect(out).toContain('login_readiness');
    expect(out).toContain('path_mount');
    expect(out).toContain('declared_cookies: Re-import the storage declaration');
    expect(out).toContain('1 failing, 3 passing');
  });
});
