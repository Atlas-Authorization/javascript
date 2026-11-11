import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../config-http';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { MemoryConfigStore } from '../config';
import { captureIO } from '../io';
import { connectPartners, parsePartners, readKeysFile } from './golive-connect';
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
