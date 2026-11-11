import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../config-http';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { MemoryConfigStore } from '../config';
import { captureIO } from '../io';
import { connectCookieMunchSide, connectPartners, parsePartners, readConnectFields, readKeysFile } from './golive-connect';
import { staleSecretKeys } from './golive';
import { planConfigImport } from './config';

const ctx = (): RunContext =>
  ({ io: captureIO(), env: {}, config: new MemoryConfigStore({ active_profile: 'default', profiles: {} }), readFile: (p: string) => readFileSync(p, 'utf8') }) as unknown as RunContext;

const keysFile = (body: string, mode: number) => {
  const f = join(mkdtempSync(join(tmpdir(), 'atlas-keys-')), 'keys.env');
  writeFileSync(f, body);
  chmodSync(f, mode);
  return f;
};

describe('golive --connect', () => {
  it('accepts any subset and refuses an unknown partner', () => {
    expect(parsePartners('chatly, forumulate')).toEqual(['chatly', 'forumulate']);
    expect(() => parsePartners('chatly,nope')).toThrow(CliError);
  });

  it('refuses a keys file readable by group or others, reads a 0600 one', () => {
    expect(() => readKeysFile(ctx(), keysFile('FORUMULATE_API_KEY=k\n', 0o640))).toThrow(/readable by others/);
    expect(readKeysFile(ctx(), keysFile('FORUMULATE_API_KEY=k\n', 0o600))).toEqual({ FORUMULATE_API_KEY: 'k' });
  });

  it('connects with the integration PUT and prints the read-back', async () => {
    const calls: Array<{ m: string; p: string; b?: unknown }> = [];
    const http = {
      get: async (p: string) =>
        p === '/v1/instance/integrations'
          ? { data: [{ id: 'forumulate', connected: true, enabled: true, health: { last_minted_at: 1700000000000, events: { state: 'healthy' } }, spaces: [{ redeem_url: 'https://read.example.com/x' }] }] }
          : { id: 'forumulate', audience: 'forumulate:acme' },
      put: async (p: string, b: unknown) => (calls.push({ m: 'PUT', p, b }), {}),
      patch: async (p: string, b: unknown) => (calls.push({ m: 'PATCH', p, b }), {}),
    } as unknown as ConfigHttp;
    const { table, failures } = await connectPartners(http, ['forumulate'], { FORUMULATE_API_KEY: 'fk_1' }, (x) => x, () => undefined);
    expect(failures).toEqual([]);
    expect(calls).toEqual([{ m: 'PUT', p: '/v1/instance/integrations/forumulate', b: { enabled: true, audience: 'forumulate:acme', forumulate_api_key: 'fk_1' } }]);
    expect(table).toContain('read.example.com');
    expect(table).toContain('ok');
  });

  it('reports a missing key instead of calling', async () => {
    const http = { get: async () => ({ data: [] }), put: async () => ({}) } as unknown as ConfigHttp;
    const { failures } = await connectPartners(http, ['forumulate'], {}, (x) => x, () => undefined);
    expect(failures[0]).toContain('FORUMULATE_API_KEY');
  });
});

describe('golive --connect with --config and the Cookie Munch handshake', () => {
  const recorder = () => {
    const calls: Array<{ m: string; p: string; b?: unknown }> = [];
    const http = {
      get: async (p: string) => (p === '/v1/instance/integrations' ? { data: [] } : {}),
      put: async (p: string, b: unknown) => (calls.push({ m: 'PUT', p, b }), {}),
      patch: async (p: string, b: unknown) => (calls.push({ m: 'PATCH', p, b }), {}),
    } as unknown as ConfigHttp;
    return { calls, http };
  };

  it('sends forumulate org_id and spaces, and referalli program settings, from the file', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'atlas-cfg-')), 'atlas.yaml');
    writeFileSync(f, 'integrations:\n  forumulate:\n    org_id: org_1\n    spaces: [s1]\nreferrals:\n  program_id: prog_1\n  auto_enroll_users: true\n');
    const fields = readConnectFields(ctx(), f);
    const { calls, http } = recorder();
    const { failures } = await connectPartners(http, ['forumulate', 'referalli'], { FORUMULATE_API_KEY: 'fk', REFERALLI_API_KEY: 'rk', REFERALLI_AUDIENCE: 'referalli:prog_1' }, (x) => x, () => undefined, fields);
    expect(failures).toEqual([]);
    expect(calls[0]).toEqual({ m: 'PUT', p: '/v1/instance/integrations/forumulate', b: { enabled: true, org_id: 'org_1', spaces: ['s1'], forumulate_api_key: 'fk' } });
    expect(calls.find((c) => c.m === 'PATCH')!.b).toEqual({ provider: 'referalli', enabled: true, program_id: 'prog_1', auto_enroll_users: true, api_key: 'rk' });
  });

  it('connects the executor and the rights identity once, then changes nothing', async () => {
    const writes: string[] = [];
    let connected = false;
    let identity: Record<string, unknown> = {};
    const fetchFake = (async (url: string, init: RequestInit) => {
      const m = init.method ?? 'GET';
      const path = new URL(url).pathname;
      if (m !== 'GET') writes.push(`${m} ${path}`);
      if (m === 'POST') connected = true;
      if (m === 'PUT') identity = JSON.parse(String(init.body));
      const body = path === '/v1/dsar/executors' ? { data: connected ? [{ system: 'identity', preset: 'atlas' }] : [] } : identity;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const o = { fetch: fetchFake, key: 'cm_k', cbid: 'dv-1', issuer: 'https://auth.example.com', origin: 'https://app.example.com', dry: false };
    await connectCookieMunchSide(o);
    expect(writes).toEqual(['POST /v1/dsar/executors', 'PUT /v1/sites/dv-1/rights-identity']);
    expect(identity).toEqual({ type: 'atlas', issuer: 'https://auth.example.com', authorizedParties: ['https://app.example.com'] });
    writes.length = 0;
    await connectCookieMunchSide(o);
    expect(writes).toEqual([]);
  });

  it('lists only platform-owned keys unused for 14 days', async () => {
    const day = 86_400_000;
    const now = 100 * day;
    const api = {
      get: async () => ({
        data: [
          { id: 'a', owner: 'platform', last_used_at: now - 20 * day },
          { id: 'b', owner: 'platform', last_used_at: now - day },
          { id: 'c', owner: 'person', last_used_at: null, created_at: 0 },
          { id: 'd', owner: 'platform', last_used_at: null, created_at: now - 30 * day },
          { id: 'e', owner: 'platform', last_used_at: null, created_at: now - day },
          { id: 'f', last_used_at: null },
        ],
      }),
    } as unknown as ConfigHttp;
    expect((await staleSecretKeys(api, now)).map((k) => k.id)).toEqual(['a', 'd']);
  });
});

describe('config types: domains, integrations, referrals, proxy_secret', () => {
  it('plans a missing domain, a switched-off integration and drifted referrals; domains are never pruned without --prune', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cfg-'));
    writeFileSync(join(dir, 'domains.yaml'), '- host: app.example.com\n  method: path\n  base_path: /atlas\n');
    writeFileSync(join(dir, 'integrations.yaml'), '- id: chatly\n  enabled: true\n  audience: chatly:abc\n');
    writeFileSync(join(dir, 'referrals.yaml'), 'enabled: true\napi_key: ${REF_KEY}\n');
    writeFileSync(join(dir, 'proxy_secret.yaml'), 'set: true\n');
    const http = {
      get: async (p: string) => {
        if (p === '/v1/domains') return { data: [{ id: 'dom_x', host: 'other.example.com', method: 'cname', role: 'fapi' }] };
        if (p === '/v1/instance/integrations') return { data: [{ id: 'chatly', connected: true, enabled: false, audience: 'chatly:abc' }] };
        if (p === '/v1/instance/referrals') return { object: 'referral_settings', enabled: false, provider: 'webhook', api_key_set: false };
        if (p === '/v1/instance/proxy_secret') return { set: true };
        return { data: [] };
      },
    } as unknown as ConfigHttp;
    const plan = await planConfigImport(http, { dir, format: 'yaml', env: { REF_KEY: 'k'.repeat(20) }, prune: false });
    const got = plan.changes.map((c) => `${c.action} ${c.type} ${c.key}`.trim()).sort();
    expect(got).toEqual(['create domains app.example.com/atlas', 'update integrations chatly', 'update referrals']);
    expect(plan.skippedDeletes.map((c) => c.type)).toEqual(['domains']);
  });
});
