import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AtlasApiError } from '@atlasauth/backend';
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
      return new Response(JSON.stringify({ issuer: discoveryIssuer }), { status: 200, headers: { 'content-type': 'application/json' } });
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
      'POST /v1/domains/dom_1/verify?dry_run=true',
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

  it('prints a warning mark, never a tick, for what doctor counts as a warning', async () => {
    const { make } = setup(
      mockApi({
        'GET /v1/secret_keys': { data: [{ id: 'key_1', scopes: ['*'], last_used_at: 5 }] },
      }),
    );
    const io = captureIO();
    expect(await run(['golive', '--origin', 'https://app.example.com'], make(io))).toBe(0);
    const out = io.stdout();
    expect(out).toContain('⚠ preflight/W1');
    expect(out).toContain('⚠ unscoped_keys — 1 in-use key(s) hold every scope (*): key_1.');
    expect(out).not.toContain('✓ unscoped_keys');
    expect(out).toContain('Rotating ends anything derived from the old secret');
    expect(out).toContain('ATLAS_SECRET_KEY: atlas keys rotate key_1 --preset app-runtime --overlap 72h --out ./atlas-app-runtime.env');
    expect(out).toContain('--preset provisioning');
    expect(out).toContain('--preset integrations');
  });

  it('--json marks a warning step with severity', async () => {
    const { make } = setup(mockApi({ 'GET /v1/secret_keys': { data: [{ id: 'key_1', scopes: ['*'], last_used_at: 5 }] } }));
    const io = captureIO();
    expect(await run(['golive', '--origin', 'https://app.example.com', '--json'], make(io))).toBe(0);
    const body = JSON.parse(io.stdout()) as { steps: Array<{ id: string; ok: boolean; severity?: string }> };
    expect(body.steps.find((x) => x.id === 'unscoped_keys')).toMatchObject({ ok: true, severity: 'warning' });
  });

  it('warns when a consent platform is connected but the hosted pages load no consent manager', async () => {
    const { make } = setup(
      mockApi({
        'GET /v1/instance/integrations': { data: [{ id: 'cookiemunch', connected: true, enabled: true }] },
        'GET /v1/instance/cookie_consent': { enabled: false, declared_cookies: [{ name: '__session' }, { name: '__client' }] },
      }),
    );
    const io = captureIO();
    expect(await run(['golive', '--origin', 'https://app.example.com'], make(io))).toBe(0);
    expect(io.stdout()).toContain('⚠ cookie_consent — a consent platform is connected');
    expect(io.stdout()).toContain('PUT /v1/instance/cookie_consent {"enabled": true');
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

  describe('a verify that moves the issuer', () => {
    const OLD = 'https://old.atlas.test';
    const moved = () =>
      mockApi({ 'POST /v1/domains/dom_1/verify?dry_run=true': { issuer_before: OLD, issuer_after: ISSUER, previous_issuers_kept_until: 1_900_000_000 } });

    it('prints both issuers and the value to copy, and stops without --yes', async () => {
      const { calls, make } = setup(moved());
      const io = captureIO();
      expect(await run(['golive', '--origin', 'https://app.example.com'], make(io))).toBe(1);
      expect(writes(calls)).toEqual(['POST /v1/domains/dom_1/verify?dry_run=true']);
      expect(io.stdout()).toContain(`issuer moves from ${OLD} to ${ISSUER}`);
      expect(io.stdout()).toContain(`previousIssuers: ["${OLD}"]`);
      expect(io.stdout()).toContain(`kept until ${new Date(1_900_000_000 * 1000).toISOString()}`);
      expect(io.stdout()).toContain('--yes');
    });

    it('goes on with --yes', async () => {
      const { calls, make } = setup(moved());
      const io = captureIO();
      expect(await run(['golive', '--origin', 'https://app.example.com', '--yes'], make(io))).toBe(0);
      expect(writes(calls)).toContain('POST /v1/domains/dom_1/verify');
      expect(io.stdout()).toContain(`✓ issuer_move — issuer moves from ${OLD}`);
    });

    it('warns that copied env values are stale and names the command to re-run', async () => {
      const { make } = setup(moved());
      const io = captureIO();
      expect(await run(['golive', '--origin', 'https://app.example.com', '--yes'], make(io))).toBe(0);
      expect(io.stdout()).toContain('⚠ env_values_stale');
      expect(io.stdout()).toContain('atlas env --product <product> --format dotenv');
    });

    it('--dry-run prints the pair and writes nothing, without --yes', async () => {
      const { calls, make } = setup(moved());
      const io = captureIO();
      expect(await run(['golive', '--origin', 'https://app.example.com', '--dry-run'], make(io))).toBe(0);
      expect(writes(calls).every((p) => p.endsWith('dry_run=true'))).toBe(true);
      expect(io.stdout()).toContain(`issuer moves from ${OLD}`);
    });

    it('stays quiet when the issuer does not change', async () => {
      const { make } = setup(mockApi({ 'POST /v1/domains/dom_1/verify?dry_run=true': { issuer_before: ISSUER, issuer_after: ISSUER, previous_issuers_kept_until: null } }));
      const io = captureIO();
      expect(await run(['golive', '--origin', 'https://app.example.com'], make(io))).toBe(0);
      expect(io.stdout()).not.toContain('issuer moves');
    });
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

describe('golive --connect with an integrations key', () => {
  const keysFile = (body: string) => {
    const f = join(mkdtempSync(join(tmpdir(), 'atlas-keys-')), 'partner-keys.env');
    writeFileSync(f, body, { mode: 0o600 });
    return f;
  };
  const withKeys = (answers: Record<string, unknown>) => {
    const { make } = setup(answers);
    const used: Array<{ key: string; path: string }> = [];
    return {
      used,
      ctx: (io: CaptureIO): RunContext => {
        const base = make(io);
        const mk = base.makeHttp!;
        return {
          ...base,
          readFile: (path: string) => readFileSync(path, 'utf8'),
          makeHttp: (o) => {
            const h = mk(o);
            return { ...h, get: (p) => (used.push({ key: o.secretKey, path: p }), h.get(p)) } as ConfigHttp;
          },
        };
      },
    };
  };
  const ANSWERS = () => mockApi({ 'GET /v1/instance/integrations/chatly': { id: 'chatly', audience: 'chatly:x' }, 'GET /v1/instance/integrations': { data: [] } });

  it('uses ATLAS_INTEGRATIONS_KEY for integration calls only; other steps keep the main key', async () => {
    const { ctx, used } = withKeys(ANSWERS());
    const f = keysFile('ATLAS_INTEGRATIONS_KEY=sk_test_integrations_key\nCHATLY_API_KEY=chk\n');
    const io = captureIO();
    expect(await run(['golive', '--origin', 'https://app.example.com', '--connect', 'chatly', '--keys-file', f], ctx(io))).toBe(0);
    const integ = used.filter((u) => u.path.startsWith('/v1/instance/integrations'));
    expect(integ.length).toBeGreaterThan(0);
    expect(integ.every((u) => u.key === 'sk_test_integrations_key')).toBe(true);
    expect(used.filter((u) => u.path === '/v1/domains').every((u) => u.key === 'sk_test_123456')).toBe(true);
    expect(io.stdout()).not.toContain('sk_test_integrations_key');
  });

  it('a 403 with missing scopes and no integrations key prints the integrations-key hint', async () => {
    const answers = ANSWERS();
    const { make } = setup(answers);
    const io = captureIO();
    const base = make(io);
    const denied = () => {
      throw new AtlasApiError(403, [{ code: 'SCOPE_MISSING', message: 'missing', meta: { missing_scopes: ['privacy:execute'] } }]);
    };
    const ctx: RunContext = { ...base, makeHttp: (o) => ({ ...base.makeHttp!(o), put: async () => denied() }) as ConfigHttp };
    const f = keysFile('CHATLY_API_KEY=chk\n');
    expect(await run(['golive', '--origin', 'https://app.example.com', '--connect', 'chatly', '--keys-file', f], ctx)).toBe(1);
    expect(io.stdout()).toContain('this step needs an integrations key: atlas keys create --preset integrations');
    expect(io.stdout()).toContain('privacy:execute');
  });
});

describe('login readiness detail', () => {
  it('names the failing hop with the API detail', async () => {
    const { loginReadinessCheck } = await import('./golive');
    const api = { get: async () => ({ ready: false, checks: [{ name: 'token_signing', pass: false, detail: 'signing key sk_1 has no public half in the JWKS' }] }) } as unknown as ConfigHttp;
    const r = await loginReadinessCheck(api, 'https://app.example.com');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('token_signing: signing key sk_1 has no public half in the JWKS');
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
    expect(out).toContain('mount_jwks');
    expect(out).toContain('1 failing, 0 warning, 5 passing');
  });

  it('flags an HTML answer and a cached answer on the mount', async () => {
    const { mountAliveCheck } = await import('./golive');
    const html = (async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const [a] = await mountAliveCheck(new URL('https://app.example.com'), '/auth', html);
    expect(a!.ok).toBe(false);
    expect(a!.detail).toContain('HTML');
    expect(a!.detail).toContain('https://app.example.com/auth/.well-known/jwks.json?_atlas_probe=');
    const cached = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', age: '120' } })) as unknown as typeof fetch;
    const [b] = await mountAliveCheck(new URL('https://app.example.com'), null, cached);
    expect(b!.ok).toBe(false);
    expect(b!.detail).toContain('cache');
  });
});

describe('unscopedKeysInUse', () => {
  it('lists used, live keys that hold the * scope', async () => {
    const { unscopedKeysInUse } = await import('./golive');
    const api = { get: async () => ({ data: [
      { id: 'a', scopes: ['*'], last_used_at: 1 },
      { id: 'b', scopes: ['*'], last_used_at: null },
      { id: 'c', scopes: ['users:read'], last_used_at: 1 },
      { id: 'd', scopes: ['*'], last_used_at: 1, revoked_at: 2 },
    ] }) } as never;
    expect((await unscopedKeysInUse(api)).map((k) => k.id)).toEqual(['a']);
  });
});
