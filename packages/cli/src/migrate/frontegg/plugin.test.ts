import { describe, expect, it } from 'vitest';
import type { MigrationBundleWriter } from '@atlasauth/migrate';
import { fakeVendor } from '../export/fake-vendor.test-helper';
import type { CredentialSpec, PluginContext } from '../framework/plugin';
import { fronteggPlugin } from './plugin';

/** A plugin context with credentials from a map (flag name without `--`). */
function context(creds: Record<string, string>, fetchImpl: typeof fetch, env: Record<string, string> = {}): PluginContext {
  const p = {
    ctx: { env },
    args: { values: {} },
    project: '.',
    credential(spec: CredentialSpec) {
      const v = creds[spec.flag.replace(/^--/, '')];
      if (v === undefined && spec.required) throw new Error(`missing ${spec.flag}`);
      return v;
    },
    fetch: fetchImpl,
    say: () => undefined,
    dryRun: false,
  };
  return p as unknown as PluginContext;
}

const API = 'https://api.frontegg.com';
const CREDS = { 'frontegg-client-id': 'cid', 'frontegg-api-key': 'secret' };

describe('frontegg plugin', () => {
  it('registers as the frontegg source with its bridge preset, lazy preset and codemod', () => {
    expect(fronteggPlugin).toMatchObject({ vendor: 'frontegg', source: 'frontegg', codemod: 'frontegg', bridge: { preset: 'frontegg' }, lazy: { preset: 'frontegg' } });
  });

  it('exports users through the bundle writer', async () => {
    const api = fakeVendor(API, {
      'POST /auth/vendor': { token: 't', expiresIn: 3600 },
      'GET /identity/resources/users/v3': { items: [{ id: 'u1', email: 'a@b.example', verified: true, tenants: [] }], _metadata: { totalPages: 1 } },
    });
    const records: Array<{ model: string; data: unknown }> = [];
    const writer = {
      describe: () => undefined,
      warn: () => undefined,
      omit: () => undefined,
      add: async (model: string, data: unknown) => {
        records.push({ model, data });
        return [];
      },
    } as unknown as MigrationBundleWriter;
    await fronteggPlugin.export!.run(context(CREDS, api.fetchImpl), writer, { cursor: null, checkpoint: () => undefined });
    expect(records.map((r) => r.model)).toEqual(['user']);
    expect(records[0]!.data).toMatchObject({ id: 'u1', emails: [{ email: 'a@b.example', verified: true }] });
  });

  it('translates the config and hands the domain to the bridge step', async () => {
    const api = fakeVendor(API, {
      'POST /auth/vendor': { token: 't', expiresIn: 3600 },
      'GET /identity/resources/configurations/v1': { authStrategy: 'EmailAndPassword' },
    });
    const p = context({ ...CREDS, 'frontegg-domain': 'https://app-demo.frontegg.com/' }, api.fetchImpl);
    const t = await fronteggPlugin.config!.translate(p);
    expect(t.bridge).toEqual({ preset: 'frontegg', vars: { base_url: 'https://app-demo.frontegg.com' } });
    expect(fronteggPlugin.bridge!.vars(p, t)).toEqual({ base_url: 'https://app-demo.frontegg.com' });
  });

  it('builds the lazy config from the translation and the region flag', () => {
    const p = context({ ...CREDS, 'frontegg-region': 'US' }, fakeVendor(API, {}).fetchImpl);
    expect(fronteggPlugin.lazy!.config(p)).toEqual({ client_id: 'cid', region: 'us' });
    expect(fronteggPlugin.lazy!.secret).toMatchObject({ env: 'FRONTEGG_API_KEY', secret: true });
  });

  it('turns a refused login into a CLI error naming Frontegg', async () => {
    const api = fakeVendor(API, { 'POST /auth/vendor': { status: 401, body: { message: 'bad secret' } } });
    const writer = { describe: () => undefined, warn: () => undefined, omit: () => undefined, add: async () => [] } as unknown as MigrationBundleWriter;
    await expect(fronteggPlugin.export!.run(context(CREDS, api.fetchImpl), writer, { cursor: null, checkpoint: () => undefined })).rejects.toThrow(/Frontegg: Frontegg refused the environment credentials \(401\)/);
  });
});
