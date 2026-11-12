import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliLoginRequiredError, createCliLogin } from './cli-login';

const ISSUER = 'https://acme-fapi.atlasauth.net';
const DEVICE = {
  device_code: 'dc_1',
  user_code: 'ABCD-EFGH',
  verification_uri: `${ISSUER}/oauth2/device`,
  verification_uri_complete: `${ISSUER}/oauth2/device?user_code=ABCD-EFGH`,
  expires_in: 600,
  interval: 1,
};

type Call = { url: string; body: URLSearchParams };
function server(answer: (call: Call) => [number, Record<string, unknown>]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { url, body: new URLSearchParams(String(init.body)) };
    calls.push(call);
    const [status, json] = answer(call);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-login-'));
  saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
});
const file = () => join(dir, 'acme', 'atlas-session.json');

function make(fetch: typeof globalThis.fetch, t = { now: 1_000_000 }, extra: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const cli = createCliLogin({ issuer: ISSUER, clientId: 'cli_1', appName: 'acme', fetch, sleep: async () => {}, now: () => t.now, print: (l) => lines.push(l), openBrowser: false, ...extra });
  return { cli, lines, t };
}
const tokens = (n: number) => ({ access_token: `at_${n}`, refresh_token: `rt_${n}`, token_type: 'Bearer', expires_in: 3600, scope: 'openid' });

describe('createCliLogin', () => {
  it('login prints the link, saves a 0600 session and prints no token', async () => {
    const { fetch } = server((c) => (c.url.endsWith('/device_authorization') ? [200, DEVICE] : [200, tokens(1)]));
    const { cli, lines } = make(fetch);
    const s = await cli.login();
    expect(s.access_token).toBe('at_1');
    expect(lines.join('\n')).toContain('ABCD-EFGH');
    expect(lines.join('\n')).not.toContain('at_1');
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file(), 'utf8')).refresh_token).toBe('rt_1');
    expect(await cli.status()).toEqual({ signedIn: true, expiresAt: 1_000_000 + 3_600_000, scope: 'openid' });
  });

  it('refreshes near expiry and keeps the rotated refresh token', async () => {
    const { calls, fetch } = server((c) => (c.url.endsWith('/device_authorization') ? [200, DEVICE] : c.body.get('grant_type') === 'refresh_token' ? [200, tokens(2)] : [200, tokens(1)]));
    const { cli, t } = make(fetch);
    await cli.login();
    expect(await cli.getAccessToken()).toBe('at_1');
    t.now += 3_550_000;
    expect(await cli.getAccessToken()).toBe('at_2');
    const refresh = calls.find((c) => c.body.get('grant_type') === 'refresh_token')!;
    expect(refresh.body.get('refresh_token')).toBe('rt_1');
    expect(JSON.parse(readFileSync(file(), 'utf8')).refresh_token).toBe('rt_2');
  });

  it('a refused refresh throws CliLoginRequiredError and clears the file', async () => {
    const { fetch } = server((c) => (c.url.endsWith('/device_authorization') ? [200, DEVICE] : c.body.get('grant_type') === 'refresh_token' ? [400, { error: 'invalid_grant' }] : [200, tokens(1)]));
    const { cli, t } = make(fetch);
    await cli.login();
    t.now += 3_600_000;
    await expect(cli.getAccessToken()).rejects.toBeInstanceOf(CliLoginRequiredError);
    expect(existsSync(file())).toBe(false);
    await expect(cli.getAccessToken()).rejects.toThrow('Not signed in. Run `acme login`.');
  });

  it('concurrent getAccessToken calls share one refresh', async () => {
    const { calls, fetch } = server((c) => (c.url.endsWith('/device_authorization') ? [200, DEVICE] : c.body.get('grant_type') === 'refresh_token' ? [200, tokens(2)] : [200, tokens(1)]));
    const { cli, t } = make(fetch);
    await cli.login();
    t.now += 3_600_000;
    const all = await Promise.all([cli.getAccessToken(), cli.getAccessToken(), cli.getAccessToken()]);
    expect(all).toEqual(['at_2', 'at_2', 'at_2']);
    expect(calls.filter((c) => c.body.get('grant_type') === 'refresh_token')).toHaveLength(1);
  });

  it('logout revokes the refresh token then the access token and clears the file', async () => {
    const { calls, fetch } = server((c) => (c.url.endsWith('/device_authorization') ? [200, DEVICE] : c.url.endsWith('/revoke') ? [200, {}] : [200, tokens(1)]));
    const { cli } = make(fetch);
    await cli.login();
    await cli.logout();
    const revokes = calls.filter((c) => c.url === `${ISSUER}/oauth2/revoke`);
    expect(revokes.map((r) => r.body.get('token'))).toEqual(['rt_1', 'at_1']);
    expect(existsSync(file())).toBe(false);
    expect((await cli.status()).signedIn).toBe(false);
  });

  it('logout still clears when the network fails', async () => {
    const { fetch } = server((c) => (c.url.endsWith('/device_authorization') ? [200, DEVICE] : [200, tokens(1)]));
    const { cli } = make(fetch);
    await cli.login();
    const down = make((async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch).cli;
    await expect(down.logout()).resolves.toBeUndefined();
    expect(existsSync(file())).toBe(false);
  });

  it('ignores a session saved for another issuer', async () => {
    const { fetch } = server((c) => (c.url.endsWith('/device_authorization') ? [200, DEVICE] : [200, tokens(1)]));
    await make(fetch).cli.login();
    const other = createCliLogin({ issuer: 'https://other-fapi.atlasauth.net', clientId: 'cli_1', appName: 'acme', fetch });
    expect((await other.status()).signedIn).toBe(false);
    await expect(other.getAccessToken()).rejects.toBeInstanceOf(CliLoginRequiredError);
  });

  it('rejects an app name that is not a single safe path segment', () => {
    expect(() => createCliLogin({ issuer: ISSUER, clientId: 'c', appName: '../evil' })).toThrow(/Invalid appName/);
  });
});
