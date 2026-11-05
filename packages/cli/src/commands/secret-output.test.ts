import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import { createConfigHttp, type ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { isSecretKey, redactDeep, scrubText } from '../redact';
import { run } from '../run';

/** Secrets must never reach stdout or stderr, whichever form the output takes. */

const SENTINEL = 'sentinel-provider-secret-8f3a91c2';

class Api implements ConfigHttp {
  writes: Array<{ method: string; path: string; body: unknown }> = [];
  providers: Array<Record<string, unknown>> = [];
  webhooks: Array<Record<string, unknown>> = [];
  custom: Array<Record<string, unknown>> = [];
  storedWebhookSecret = '';
  failWrites: string | null = null;
  dryRunUnavailable = false;

  async get<T>(path: string): Promise<T> {
    if (path === '/v1/oauth_providers') return { data: this.providers } as T;
    if (path === '/v1/webhook_endpoints') return { data: this.webhooks } as T;
    if (path === '/v1/custom_oauth_providers') return { data: this.custom } as T;
    if (path === '/v1/instance') return { allowed_origins: [], auth_config: {} } as T;
    if (path.startsWith('/v1/')) return { data: [] } as T;
    throw new AtlasApiError(404, [{ code: 'NOT_FOUND', message: path }]);
  }
  private note(method: string, path: string, body: unknown): void {
    this.writes.push({ method, path, body });
    if (this.failWrites) throw new AtlasApiError(422, [{ code: 'VALIDATION_FAILED', message: this.failWrites }]);
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (path.includes('/rotate_secret')) {
      if (path.includes('dry_run=true') && this.dryRunUnavailable) throw new AtlasApiError(403, [{ code: 'FORBIDDEN', message: 'no' }]);
      if (b.secret === this.storedWebhookSecret) throw new AtlasApiError(422, [{ code: 'VALIDATION_FAILED', message: 'secret must differ from the current signing secret.', param: 'secret' }]);
      if (path.includes('dry_run=true')) return {} as T;
      this.note('POST', path, body);
      this.storedWebhookSecret = String(b.secret);
      return {} as T;
    }
    this.note('POST', path, body);
    if (path === '/v1/webhook_endpoints') {
      this.storedWebhookSecret = String(b.secret ?? '');
      this.webhooks.push({ id: 'we_1', url: b.url, enabled_events: b.enabled_events, active: b.active ?? true });
      return { id: 'we_1', secret: b.secret } as T;
    }
    return {} as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    this.note('PUT', path, body);
    const m = /^\/v1\/oauth_providers\/(.+)$/.exec(path);
    if (m) {
      const b = body as { values?: Record<string, string>; mode?: string };
      const existing = this.providers.find((p) => p.provider === m[1]);
      const row = existing ?? { provider: m[1], configured: true, mode: 'native', has_secret: false, setting_values: {} };
      if (b.mode) row.mode = b.mode;
      if (b.values?.client_id) row.client_id = b.values.client_id;
      if (b.values?.client_secret) row.has_secret = true;
      if (!existing) this.providers.push(row);
    }
    return {} as T;
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    this.note('PATCH', path, body);
    return {} as T;
  }
  async delete(path: string): Promise<void> {
    this.note('DELETE', path, undefined);
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cli-secret-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (io: CaptureIO, api: ConfigHttp, over: Partial<RunContext> = {}): RunContext => ({
  io,
  env: {},
  config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
  prompt: { text: async () => 'y', secret: async () => '' },
  makeClient: () => ({}) as ManagementClient,
  makeHttp: () => api,
  readFile: (p) => readFileSync(p, 'utf8'),
  tty: { stdin: false, stdout: false },
  ...over,
});

const file = (doc: unknown) => {
  const p = join(dir, 'atlas.json');
  writeFileSync(p, JSON.stringify(doc));
  return p;
};
const secrets = (extra = '') => {
  const p = join(dir, 'secrets.env');
  writeFileSync(p, `GOOGLE_SECRET=${SENTINEL}\n${extra}`);
  chmodSync(p, 0o600);
  return p;
};
const clean = (io: CaptureIO) => {
  expect(io.stdout()).not.toContain(SENTINEL);
  expect(io.stderr()).not.toContain(SENTINEL);
};
const google = (over: Record<string, unknown> = {}) => ({ oauth_providers: [{ provider: 'google', client_id: 'cid', client_secret: '${GOOGLE_SECRET}', mode: 'redirect', ...over }] });

describe('isSecretKey', () => {
  it.each(['client_secret', 'secret', 'api_key', 'apiKey', 'password', 'password_digest', 'signing_secret', 'token', 'verify_token', 'private_key', 'oidc_client_secret', 'clientSecret'])('%s is a secret', (k) => {
    expect(isSecretKey(k)).toBe(true);
  });
  it.each(['token_endpoint', 'tokenEndpoint', 'token_endpoint_auth_method', 'password_policy', 'passwordPolicy', 'secret_key_prefix', 'token_url', 'jwks_uri', 'token_ttl_seconds', 'access_token_format', 'token_lifetimes', 'token_params', 'secret_prefix', 'has_secret', 'signing_secret_set', 'url', 'name', 'client_id'])('%s is not', (k) => {
    expect(isSecretKey(k)).toBe(false);
  });
});

describe('redactDeep and scrubText', () => {
  it('masks by name at any depth, and keeps look-alike fields', () => {
    expect(redactDeep({ a: { client_secret: 'x', token_endpoint: 'https://i/t' }, list: [{ api_key: 'y' }], n: 3 })).toEqual({
      a: { client_secret: '<redacted>', token_endpoint: 'https://i/t' },
      list: [{ api_key: '<redacted>' }],
      n: 3,
    });
  });
  it('keeps an unresolved placeholder and masks key shapes under any name', () => {
    expect(redactDeep({ client_secret: '${X}', note: 'used atlas_live_sk_abc123 here' })).toEqual({ client_secret: '${X}', note: 'used <redacted> here' });
  });
  it('masks secret pairs in text and leaves prose', () => {
    expect(scrubText('bad client_secret=abc&x=1')).toBe('bad client_secret=<redacted>&x=1');
    expect(scrubText('{"api_key":"hunter2"}')).toBe('{"api_key":"<redacted>"}');
    expect(scrubText('client_secret: missing')).toBe('client_secret: missing');
    expect(scrubText('token_endpoint=https://i/t')).toBe('token_endpoint=https://i/t');
    expect(scrubText('Authorization: Bearer abcdefgh1234')).toContain('Bearer <redacted>');
  });
});

describe('a sentinel secret through every output', () => {
  it('plan, plan --json, apply and a re-plan never print it', async () => {
    const api = new Api();
    for (const argv of [['plan', file(google()), '--secrets-file', secrets()], ['plan', file(google()), '--json', '--secrets-file', secrets()], ['apply', file(google()), '--yes', '--secrets-file', secrets()], ['plan', file(google()), '--secrets-file', secrets()]]) {
      const io = captureIO();
      expect(await run(argv, ctx(io, api))).toBe(0);
      clean(io);
    }
    // ... and it did go to the API.
    expect(JSON.stringify(api.writes)).toContain(SENTINEL);
  });

  it('under a key nobody thought of, it is scrubbed by value', async () => {
    const api = new Api();
    api.providers = [{ provider: 'google', configured: true, client_id: 'old', mode: 'native', setting_values: {} }];
    const io = captureIO();
    expect(await run(['plan', file(google({ client_id: '${GOOGLE_SECRET}x', scopes: ['${GOOGLE_SECRET}'] })), '--secrets-file', secrets()], ctx(io, api))).toBe(0);
    clean(io);
  });

  it('a failing API response that echoes it stays masked, in plain and --json runs', async () => {
    const api = new Api();
    api.failWrites = `client_secret ${SENTINEL} was refused`;
    const io = captureIO();
    expect(await run(['apply', file(google()), '--yes', '--secrets-file', secrets()], ctx(io, api))).toBe(1);
    expect(io.stderr()).toContain('API error');
    clean(io);
  });

  it('the real HTTP client masks a key-shaped value in an error body', async () => {
    const http = createConfigHttp({
      secretKey: 'k',
      apiUrl: 'https://api.test',
      fetch: (async () => new Response(JSON.stringify({ errors: [{ code: 'BAD', message: 'rejected whsec_abcdef1234 and client_secret=zzz' }] }), { status: 422 })) as unknown as typeof fetch,
    });
    const err = (await http.post('/v1/x', {}).catch((e: unknown) => e)) as AtlasApiError;
    expect(err.message).toBe('rejected <redacted> and client_secret=<redacted>');
  });
});

describe('a strict 422', () => {
  it('keeps the nearest field in the message', async () => {
    const http = createConfigHttp({
      secretKey: 'k',
      apiUrl: 'https://api.test',
      fetch: (async () => new Response(JSON.stringify({ errors: [{ code: 'UNKNOWN_FIELD', message: 'Unknown field "nam": this endpoint does not accept it. Did you mean "name"?', param: 'nam', meta: { did_you_mean: 'name' } }] }), { status: 422 })) as unknown as typeof fetch,
    });
    const err = (await http.post('/v1/x', {}).catch((e: unknown) => e)) as AtlasApiError;
    expect(err.message).toBe('Unknown field "nam": this endpoint does not accept it. Did you mean "name"?');
  });
});

describe('drift on a secret', () => {
  it('prints <redacted> (changed) when the API says none is set', async () => {
    const api = new Api();
    api.providers = [{ provider: 'google', configured: true, client_id: 'cid', mode: 'redirect', has_secret: false, setting_values: {} }];
    const io = captureIO();
    expect(await run(['plan', file(google()), '--check', '--secrets-file', secrets()], ctx(io, api))).toBe(2);
    expect(io.stdout()).toContain('client_secret: <redacted> (changed)');
    clean(io);
    const j = captureIO();
    await run(['plan', file(google()), '--json', '--secrets-file', secrets()], ctx(j, api));
    expect(JSON.parse(j.stdout()).changes[0].fields).toEqual([{ path: 'client_secret', redacted: true, changed: true }]);
  });

  it('is equal to the live marker, and says the API cannot tell', async () => {
    const api = new Api();
    api.providers = [{ provider: 'google', configured: true, client_id: 'cid', mode: 'redirect', has_secret: true, setting_values: {} }];
    const io = captureIO();
    expect(await run(['plan', file(google()), '--check', '--secrets-file', secrets()], ctx(io, api))).toBe(0);
    expect(io.stdout()).toContain('oauth_providers google client_secret: Atlas does not return this value');
    expect(io.stdout()).toContain('--rotate-secret');
    const j = captureIO();
    await run(['plan', file(google()), '--json', '--secrets-file', secrets()], ctx(j, api));
    expect(JSON.parse(j.stdout()).unverifiable_secrets).toEqual([{ type: 'oauth_providers', key: 'google', path: 'client_secret' }]);
  });

  it('--rotate-secret sends it again', async () => {
    const api = new Api();
    api.providers = [{ provider: 'google', configured: true, client_id: 'cid', mode: 'redirect', has_secret: true, setting_values: {} }];
    const io = captureIO();
    expect(await run(['apply', file(google()), '--yes', '--rotate-secret', '--secrets-file', secrets()], ctx(io, api))).toBe(0);
    expect(io.stdout()).toContain('client_secret: <redacted> (changed)');
    expect(JSON.stringify(api.writes)).toContain(SENTINEL);
    clean(io);
  });

  it('look-alike string fields still display and diff', async () => {
    const api = new Api();
    api.custom = [{ id: 'c1', provider_key: 'kc', token_endpoint: 'https://old.example/t', has_secret: true }];
    const io = captureIO();
    expect(await run(['plan', file({ custom_oauth_providers: [{ provider_key: 'kc', token_endpoint: 'https://new.example/t' }] })], ctx(io, api))).toBe(0);
    expect(io.stdout()).toContain('token_endpoint: "https://old.example/t" -> "https://new.example/t"');
  });

  it('--prune does not plan the removal of a secret or a defaulted mode the file leaves out', async () => {
    const api = new Api();
    api.providers = [{ provider: 'google', configured: true, client_id: 'cid', mode: 'native', has_secret: true, setting_values: {} }];
    const io = captureIO();
    expect(await run(['plan', file({ oauth_providers: [{ provider: 'google', client_id: 'cid' }] }), '--check', '--prune'], ctx(io, api))).toBe(0);
  });
});

describe('--show-secrets', () => {
  const withDrift = () => {
    const api = new Api();
    api.providers = [{ provider: 'google', configured: true, client_id: 'cid', mode: 'redirect', has_secret: false, setting_values: {} }];
    return api;
  };
  it('is refused when stdout is not a terminal', async () => {
    const io = captureIO();
    expect(await run(['plan', file(google()), '--show-secrets', '--secrets-file', secrets()], ctx(io, withDrift()))).toBe(1);
    expect(io.stderr()).toContain('--show-secrets');
    clean(io);
  });
  it('is refused under CI even on a terminal', async () => {
    const io = captureIO();
    expect(await run(['plan', file(google()), '--show-secrets', '--secrets-file', secrets()], ctx(io, withDrift(), { tty: { stdin: true, stdout: true }, env: { CI: 'true' } }))).toBe(1);
    clean(io);
  });
  it('prints the value on a terminal', async () => {
    const io = captureIO();
    expect(await run(['plan', file(google()), '--show-secrets', '--secrets-file', secrets()], ctx(io, withDrift(), { tty: { stdin: true, stdout: true } }))).toBe(0);
    expect(io.stdout()).toContain(SENTINEL);
  });
});

describe('provider mode', () => {
  it('is sent, and a plan after apply is clean', async () => {
    const api = new Api();
    const doc = { oauth_providers: [{ provider: 'google', client_id: 'cid', mode: 'native' }] };
    expect(await run(['apply', file(doc), '--yes'], ctx(captureIO(), api))).toBe(0);
    expect(api.writes.find((w) => w.method === 'PUT')?.body).toMatchObject({ mode: 'native' });
    expect(await run(['plan', file(doc), '--check'], ctx(captureIO(), api))).toBe(0);
  });
  it('left out of the file, the default shows no drift', async () => {
    const api = new Api();
    api.providers = [{ provider: 'google', configured: true, client_id: 'cid', mode: 'native', has_secret: false, setting_values: {} }];
    expect(await run(['plan', file({ oauth_providers: [{ provider: 'google', client_id: 'cid' }] }), '--check'], ctx(captureIO(), api))).toBe(0);
  });
  it('warns on redirect with no secret anywhere, not when the instance has one', async () => {
    const doc = { oauth_providers: [{ provider: 'github', client_id: 'cid', mode: 'redirect' }] };
    const io = captureIO();
    await run(['plan', file(doc)], ctx(io, new Api()));
    expect(io.stdout()).toContain('mode redirect needs a client_secret');

    const api = new Api();
    api.providers = [{ provider: 'github', configured: true, client_id: 'cid', mode: 'redirect', has_secret: true, setting_values: {} }];
    const quiet = captureIO();
    await run(['plan', file(doc)], ctx(quiet, api));
    expect(quiet.stdout()).not.toContain('mode redirect needs');
  });
  it('warns on a secret in native mode, in text and --json', async () => {
    const doc = google({ mode: 'native' });
    const io = captureIO();
    await run(['plan', file(doc), '--secrets-file', secrets()], ctx(io, new Api()));
    expect(io.stdout()).toContain('secret unused in native mode');
    const j = captureIO();
    await run(['plan', file(doc), '--json', '--secrets-file', secrets()], ctx(j, new Api()));
    expect(JSON.parse(j.stdout()).warnings[0]).toContain('secret unused in native mode');
  });
});

describe('unknown keys', () => {
  it('are an error with a suggestion, before anything is read or written', async () => {
    const api = new Api();
    const io = captureIO();
    const doc = { oauth_providers: [{ provider: 'google', clent_secret: 'x' }], webhook_endpoints: [{ url: 'https://a.example/h', enabled_event: [] }], hooks: { before_user_create: { urll: 'x' } } };
    expect(await run(['apply', file(doc), '--yes'], ctx(io, api))).toBe(1);
    expect(io.stderr()).toContain('oauth_providers google: clent_secret (did you mean client_secret?)');
    expect(io.stderr()).toContain('enabled_event (did you mean enabled_events?)');
    expect(io.stderr()).toContain('hooks.before_user_create: urll (did you mean url?)');
    expect(api.writes).toEqual([]);
  });
  it('a key that is nothing like a real one gets no suggestion', async () => {
    const io = captureIO();
    expect(await run(['plan', file({ redirect_urls: [{ url: 'https://a.example', zzzzzzzzzzzz: 1 }] })], ctx(io, new Api()))).toBe(1);
    expect(io.stderr()).toContain('zzzzzzzzzzzz');
    expect(io.stderr()).not.toContain('did you mean');
  });
  it('keys that only go in are accepted', async () => {
    const doc = { webhook_endpoints: [{ url: 'https://a.example/h', secret: 'whsec_abc', active: false }], sso_connections: [{ type: 'oidc', oidc_issuer: 'https://i', oidc_client_secret: 'x', saml_idp_certificate: 'c' }], oauth_clients: [{ name: 'n', client_secret: 's' }] };
    const io = captureIO();
    await run(['plan', file(doc)], ctx(io, new Api()));
    expect(io.stderr()).not.toContain('Unknown key');
  });
  it('an export re-imports clean, every key it can write included', async () => {
    const api = new Api();
    api.providers = [{ provider: 'google', configured: true, client_id: 'cid', mode: 'native', enabled: true, allow_sign_in: true, allow_sign_up: true, scopes: ['openid'], has_secret: true, setting_values: { domain: 'd' } }];
    api.webhooks = [{ id: 'we_1', url: 'https://a.example/h', enabled_events: ['*'], active: false }];
    api.custom = [{ id: 'c1', provider_key: 'kc', token_endpoint: 'https://i/t', token_endpoint_auth_method: 'client_secret_basic', has_secret: true }];
    const out = join(dir, 'exported');
    expect(await run(['config', 'export', '--dir', out], ctx(captureIO(), api))).toBe(0);
    const everything = readdirSync(out).map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
    expect(everything).not.toContain('secret set');
    const io = captureIO();
    expect(await run(['plan', out, '--check'], ctx(io, api))).toBe(0);
    expect(io.stderr()).not.toContain('Unknown key');
  });
});

describe('Atlas-Unknown-Fields', () => {
  const withFetch = (io: CaptureIO, fetchImpl: typeof fetch) =>
    ctx(io, new Api(), { makeHttp: (o) => createConfigHttp({ ...o, fetch: fetchImpl }) });

  it('apply prints the header and its suggestions as a warning', async () => {
    const io = captureIO();
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Response(init.method === 'GET' ? '{"data":[]}' : '{}', {
        status: 200,
        headers: init.method === 'GET' ? {} : { 'Atlas-Unknown-Fields': 'nope', 'Atlas-Unknown-Fields-Suggestions': 'nope=note' },
      })) as unknown as typeof fetch;
    expect(await run(['apply', file({ redirect_urls: [{ url: 'https://a.example' }] }), '--yes'], withFetch(io, fetchImpl))).toBe(0);
    expect(io.stderr()).toContain('warning: POST /v1/redirect_urls ignored field(s) nope (did you mean: nope=note)');
  });
  it('says nothing without the header', async () => {
    const io = captureIO();
    const fetchImpl = (async (_url: string, init: RequestInit) => new Response(init.method === 'GET' ? '{"data":[]}' : '{}', { status: 200 })) as unknown as typeof fetch;
    expect(await run(['apply', file({ redirect_urls: [{ url: 'https://a.example' }] }), '--yes'], withFetch(io, fetchImpl))).toBe(0);
    expect(io.stderr()).not.toContain('ignored field');
  });
});

describe('webhook_endpoints with a secret', () => {
  const doc = () => ({ webhook_endpoints: [{ url: 'https://a.example/h', enabled_events: ['*'], secret: '${GOOGLE_SECRET}', active: false }] });

  it('create sends the chosen secret and active:false, and saves no file for it', async () => {
    const api = new Api();
    const out = join(dir, 'kept');
    const io = captureIO();
    expect(await run(['apply', file(doc()), '--yes', '--out', out, '--secrets-file', secrets()], ctx(io, api))).toBe(0);
    expect(api.writes[0]).toMatchObject({ path: '/v1/webhook_endpoints', body: { secret: SENTINEL, active: false } });
    expect(io.stdout()).not.toContain('A new secret was written');
    clean(io);
  });

  it('the same secret plans clean', async () => {
    const api = new Api();
    await run(['apply', file(doc()), '--yes', '--secrets-file', secrets()], ctx(captureIO(), api));
    const io = captureIO();
    expect(await run(['plan', file(doc()), '--check', '--secrets-file', secrets()], ctx(io, api))).toBe(0);
    expect(io.stdout()).not.toContain('does not return');
  });

  it('a changed secret plans as changed and apply rotates it, never in a PATCH', async () => {
    const api = new Api();
    await run(['apply', file(doc()), '--yes', '--secrets-file', secrets()], ctx(captureIO(), api));
    api.storedWebhookSecret = 'an-older-secret-value';
    api.writes = [];
    const io = captureIO();
    expect(await run(['apply', file(doc()), '--yes', '--secrets-file', secrets()], ctx(io, api))).toBe(0);
    expect(io.stdout()).toContain('secret: <redacted> (changed)');
    clean(io);
    expect(api.writes.find((w) => w.path === '/v1/webhook_endpoints/we_1/rotate_secret')?.body).toEqual({ secret: SENTINEL });
    expect(JSON.stringify(api.writes.find((w) => w.method === 'PATCH')?.body)).not.toContain(SENTINEL);
    expect(api.storedWebhookSecret).toBe(SENTINEL);
  });

  it('when the API cannot say, the plan says so', async () => {
    const api = new Api();
    await run(['apply', file(doc()), '--yes', '--secrets-file', secrets()], ctx(captureIO(), api));
    api.dryRunUnavailable = true;
    const io = captureIO();
    expect(await run(['plan', file(doc()), '--check', '--secrets-file', secrets()], ctx(io, api))).toBe(0);
    expect(io.stdout()).toContain('webhook_endpoints https://a.example/h secret: Atlas does not return this value');
  });
});
