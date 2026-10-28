import { describe, expect, it } from 'vitest';
import type { MigrationBundleWriter } from '@atlasauth/migrate';
import { corbadoPlugin } from '../corbado/plugin';
import type { CredentialSpec, PluginContext } from '../framework/plugin';
import { magicPlugin } from '../magic/plugin';
import { fakeVendor } from './fake-vendor.test-helper';

/** A plugin context with credentials from a map (flag name without `--`), files from another. */
function context(creds: Record<string, string>, fetchImpl: typeof fetch, files: Record<string, string> = {}, env: Record<string, string> = {}): PluginContext {
  const said: string[] = [];
  const p = {
    ctx: { env, readFile: (path: string) => files[path.split('/').pop()!] ?? '' },
    args: { values: {} },
    project: '.',
    credential(spec: CredentialSpec) {
      const v = creds[spec.flag.replace(/^--/, '')];
      if (v === undefined && spec.required) throw new Error(`missing ${spec.flag}`);
      return v;
    },
    fetch: fetchImpl,
    say: (l: string) => said.push(l),
    dryRun: false,
  };
  return p as unknown as PluginContext;
}

function recorder() {
  const out = { records: [] as Array<{ model: string; data: unknown }>, warnings: [] as string[], manifest: undefined as unknown };
  const writer = {
    describe: (m: unknown) => void (out.manifest = m),
    warn: (w: string) => void out.warnings.push(w),
    omit: () => undefined,
    add: async (model: string, data: unknown) => {
      out.records.push({ model, data });
      return [];
    },
  } as unknown as MigrationBundleWriter;
  return { out, writer };
}
const resume = { cursor: null, checkpoint: () => undefined };

describe('corbado plugin', () => {
  const ORIGIN = 'https://backendapi.cloud.corbado.io';
  it('registers as the corbado source with its bridge preset and codemod', () => {
    expect(corbadoPlugin).toMatchObject({ vendor: 'corbado', source: 'corbado', codemod: 'corbado', bridge: { preset: 'corbado' } });
  });

  it('exports users and passkeys through the bundle writer', async () => {
    const api = fakeVendor(ORIGIN, {
      'GET /v2/users': { users: [{ userID: 'usr-1', status: 'active', emailIdentifiers: [{ value: 'a@b.example', status: 'verified' }] }], paging: { page: 1, totalPages: 1, totalItems: 1 } },
      'GET /v2/users/usr-1/fullCredentials': { fullCredentials: [{ credentialID: 'c1', publicKey: 'k1' }] },
    });
    const { out, writer } = recorder();
    const p = context({ 'corbado-project-id': 'pro-42', 'corbado-api-secret': 's', 'corbado-rp-id': 'b.example' }, api.fetchImpl);
    await corbadoPlugin.export!.run(p, writer, resume);
    expect(out.records.map((r) => r.model)).toEqual(['user', 'passkey']);
    expect(out.records[1]!.data).toMatchObject({ user_id: 'usr-1', credential_id: 'c1', public_key: 'k1', rp_id: 'b.example' });
    expect(out.manifest).toMatchObject({ origin: 'pro-42', rpId: 'b.example' });
  });

  it('takes the project id from the public env var and hands it to the bridge', async () => {
    const p = context({ 'corbado-api-secret': 's' }, fakeVendor(ORIGIN, {}).fetchImpl, {}, { NEXT_PUBLIC_CORBADO_PROJECT_ID: 'pro-7' });
    expect(corbadoPlugin.bridge!.vars(p)).toEqual({ project_id: 'pro-7' });
    const tr = await corbadoPlugin.config!.translate(p);
    expect(tr.bridge).toEqual({ preset: 'corbado', vars: { project_id: 'pro-7' } });
  });
});

describe('magic plugin', () => {
  it('registers as the magic source with its bridge preset and codemod', () => {
    expect(magicPlugin).toMatchObject({ vendor: 'magic', source: 'magic', codemod: 'magic', bridge: { preset: 'magic' } });
  });

  it('exports the dashboard file (plus issuers file) through the bundle writer', async () => {
    const issuer = 'did:ethr:0x3333333333333333333333333333333333333333';
    const p = context({ 'magic-users-file': '/x/users.csv', 'magic-issuers-file': '/x/issuers.csv' }, fakeVendor('https://x.example', {}).fetchImpl, {
      'users.csv': 'Email\njane@acme.example\n',
      'issuers.csv': `email,issuer\njane@acme.example,${issuer}\n`,
    });
    const { out, writer } = recorder();
    await magicPlugin.export!.run(p, writer, resume);
    expect(out.records).toEqual([{ model: 'user', data: { id: issuer, emails: [{ email: 'jane@acme.example', verified: true, primary: true }], private_metadata: { magic_issuer: issuer } } }]);
    expect(out.warnings.some((w) => w.includes('wallet keys'))).toBe(true);
  });

  it('asks for the users file when it is missing', async () => {
    const p = context({}, fakeVendor('https://x.example', {}).fetchImpl);
    await expect(magicPlugin.export!.run(p, recorder().writer, resume)).rejects.toThrow(/magic-users-file/);
  });

  it('passes the client id to the bridge from a flag or the translation', async () => {
    const p = context({ 'magic-client-id': 'did:magic:abc' }, fakeVendor('https://x.example', {}).fetchImpl);
    expect(magicPlugin.bridge!.vars(p)).toEqual({ client_id: 'did:magic:abc' });
    const tr = await magicPlugin.config!.translate(p);
    expect(magicPlugin.bridge!.vars(context({}, p.fetch), tr)).toEqual({ client_id: 'did:magic:abc' });
  });
});
