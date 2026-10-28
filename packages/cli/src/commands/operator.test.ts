import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../run';
import { defaultContext } from '../context';
import { FileConfigStore } from '../config';
import { sealBox } from '@atlasauth/backend';

function memIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('atlas login --device / atlas token', () => {
  it('runs the device flow, exchanges for a bound token and stores only short-lived tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'));
    const config = new FileConfigStore(join(dir, 'config.json'));
    let polls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/operator')) {
        return json({
          issuer: 'https://atlasauth.test',
          device_authorization_endpoint: 'https://atlasauth.test/oauth2/device_authorization',
          token_endpoint: 'https://atlasauth.test/oauth2/token',
          client_id: 'atlas-cli',
          scope: 'openid atlas:operator',
          token_exchange_endpoint: 'https://api.test/v1/oauth/token',
          token_exchange_audience: 'atlas',
          root_action_max_mfa_age_seconds: 300,
        });
      }
      if (url.endsWith('/oauth2/device_authorization')) {
        return json({ device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://atlasauth.test/oauth2/device', verification_uri_complete: 'https://atlasauth.test/oauth2/device?user_code=ABCD-EFGH', expires_in: 600, interval: 1 });
      }
      if (url.endsWith('/oauth2/token')) {
        polls += 1;
        return polls < 2 ? json({ error: 'authorization_pending' }, 400) : json({ access_token: 'op-token', token_type: 'Bearer', expires_in: 3600 });
      }
      if (url.endsWith('/v1/oauth/token')) {
        const p = new URLSearchParams(String(init?.body));
        expect(p.get('subject_token')).toBe('op-token');
        expect(p.get('resource')).toBe('ins_1');
        return json({ access_token: 'atlas_live_at_bound', token_type: 'Bearer', expires_in: 3600, scope: 'read_only', resource: 'ins_1' });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;
    const m = memIO();
    const ctx = defaultContext({ io: m.io, config, fetch: fetchImpl, sleep: async () => undefined, env: {} });
    const code = await run(['login', '--device', '--url', 'https://api.test', '--resource', 'ins_1'], ctx);
    expect(m.err).toEqual([]);
    expect(code).toBe(0);
    expect(m.out.join('\n')).toContain('ABCD-EFGH');
    const stored = config.load().profiles.default!;
    expect(stored.secret_key).toBe('atlas_live_at_bound');
    expect(stored.operator?.access_token).toBe('op-token');
    expect(stored.expires_at).toBeGreaterThan(Date.now());
    // POSIX permission bits only (Windows has no 0600).
    if (process.platform !== 'win32') expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);

    const t = memIO();
    expect(await run(['token', '--resource', 'ins_1', '--scope', 'read'], { ...ctx, io: t.io })).toBe(0);
    expect(t.out).toEqual(['atlas_live_at_bound']);
  });
});

describe('atlas login --device --audience', () => {
  it('asks for an operator token FOR that product (resource=<audience>), prints it and stores nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'));
    const config = new FileConfigStore(join(dir, 'config.json'));
    let resource: string | null = 'unset';
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/operator')) {
        return json({
          issuer: 'https://atlasauth.test',
          device_authorization_endpoint: 'https://atlasauth.test/oauth2/device_authorization',
          token_endpoint: 'https://atlasauth.test/oauth2/token',
          client_id: 'atlas-cli',
          scope: 'openid email atlas:operator',
          token_exchange_endpoint: 'https://api.test/v1/oauth/token',
          token_exchange_audience: 'atlas',
          root_action_max_mfa_age_seconds: 300,
          audiences: ['partner-console'],
        });
      }
      if (url.endsWith('/oauth2/device_authorization')) {
        resource = new URLSearchParams(String(init?.body)).get('resource');
        return json({ device_code: 'dc', user_code: 'WXYZ-ABCD', verification_uri: 'https://atlasauth.test/oauth2/device', verification_uri_complete: 'https://atlasauth.test/oauth2/device?user_code=WXYZ-ABCD', expires_in: 600, interval: 1 });
      }
      if (url.endsWith('/oauth2/token')) return json({ access_token: 'partner-op-token', token_type: 'Bearer', expires_in: 600 });
      throw new Error(`unexpected call ${url}`);
    }) as unknown as typeof fetch;
    const m = memIO();
    const ctx = defaultContext({ io: m.io, config, fetch: fetchImpl, sleep: async () => undefined, env: {} });
    expect(await run(['login', '--device', '--url', 'https://api.test', '--audience', 'partner-console'], ctx)).toBe(0);
    expect(resource).toBe('partner-console');
    expect(m.out.at(-1)).toBe('partner-op-token');
    expect(m.err.join('\n')).toContain('not stored');
    expect(config.load().profiles.default?.operator).toBeUndefined();
  });
});

describe('API base from the environment (operator commands)', () => {
  it('ATLAS_API_BASE is used, and wins over ATLAS_API_URL; the URL name still works alone', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return json({ results: [{ outcome: 'not_found' }] });
    }) as unknown as typeof fetch;
    const run1 = async (env: Record<string, string>) => {
      const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'));
      const m = memIO();
      const ctx = defaultContext({ io: m.io, config: new FileConfigStore(join(dir, 'c.json')), fetch: fetchImpl, env });
      await run(['keys', 'revoke-leaked', 'sk_live_leaked'], ctx);
    };
    await run1({ ATLAS_API_BASE: 'https://base.test', ATLAS_API_URL: 'https://url.test' });
    await run1({ ATLAS_API_URL: 'https://url.test' });
    expect(seen[0]).toMatch(/^https:\/\/base\.test\//);
    expect(seen[1]).toMatch(/^https:\/\/url\.test\//);
  });
});

describe('atlas keys create', () => {
  it('asks for the secret sealed, opens it locally and writes a 0600 file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'));
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const recipient = headers['x-secret-recipient']!;
      expect(recipient).toMatch(/^x25519:/);
      const pk = Uint8Array.from(atob(recipient.slice(7)), (c) => c.charCodeAt(0));
      const sealed = btoa(String.fromCharCode(...sealBox('atlas_live_sk_secretvalue', pk)));
      expect(url).toBe('https://api.test/v1/secret_keys');
      return json({ object: 'secret_key', id: 'key_1', prefix: 'atlas_live_sk_abcd', scopes: ['read_only'], sealed_secret: sealed }, 201);
    }) as unknown as typeof fetch;
    const m = memIO();
    const out = join(dir, 'k.env');
    const ctx = defaultContext({ io: m.io, config: new FileConfigStore(join(dir, 'c.json')), fetch: fetchImpl, env: { ATLAS_SECRET_KEY: 'sk_live_x', ATLAS_API_URL: 'https://api.test' } });
    expect(await run(['keys', 'create', '--scopes', 'read_only', '--out', out], ctx)).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('ATLAS_SECRET_KEY=atlas_live_sk_secretvalue\n');
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(m.out.join('\n')).not.toContain('secretvalue');
  });
});
