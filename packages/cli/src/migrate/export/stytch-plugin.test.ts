import { describe, expect, it } from 'vitest';
import type { MigrationBundleWriter } from '@atlasauth/migrate';
import type { CredentialSpec, PluginContext } from '../framework/plugin';
import { stytchPlugin } from '../stytch/plugin';
import { fakeVendor } from './fake-vendor.test-helper';

const LIVE = 'project-live-11111111-2222-3333-4444-555555555555';
const TEST = 'project-test-11111111-2222-3333-4444-555555555555';
const ORIGIN = 'https://api.stytch.com';

/** A plugin context with credentials from a map (flag name without `--`), files from another. */
function context(creds: Record<string, string>, fetchImpl: typeof fetch, files: Record<string, string> = {}): PluginContext {
  const p = {
    ctx: { env: {}, readFile: (path: string) => files[path.split('/').pop()!] ?? '' },
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

describe('stytch plugin', () => {
  it('registers as the stytch source with its bridge, lazy preset and codemod', () => {
    expect(stytchPlugin).toMatchObject({ vendor: 'stytch', source: 'stytch', codemod: 'stytch', bridge: { preset: 'stytch' }, lazy: { preset: 'stytch' } });
  });

  it('exports consumer users through the bundle writer', async () => {
    const api = fakeVendor(ORIGIN, {
      'POST /v1/users/search': { results: [{ user_id: 'user-live-1', emails: [{ email: 'A@B.example', verified: true }] }], results_metadata: { next_cursor: null } },
    });
    const { out, writer } = recorder();
    const p = context({ 'stytch-project-id': LIVE, 'stytch-secret': 's', 'stytch-product': 'consumer' }, api.fetchImpl);
    await stytchPlugin.export!.run(p, writer, resume);
    expect(out.records.map((r) => r.model)).toEqual(['user']);
    expect(out.records[0]!.data).toMatchObject({ id: 'user-live-1', emails: [{ email: 'a@b.example', verified: true }] });
    expect(out.manifest).toMatchObject({ origin: LIVE });
    expect(out.warnings.some((w) => w.startsWith('No password hashes'))).toBe(true);
  });

  it('asks for the project id and rejects an unknown product', async () => {
    const api = fakeVendor(ORIGIN, {});
    await expect(stytchPlugin.export!.run(context({}, api.fetchImpl), recorder().writer, resume)).rejects.toThrow(/stytch-project-id/);
    await expect(stytchPlugin.export!.run(context({ 'stytch-project-id': LIVE, 'stytch-secret': 's', 'stytch-product': 'x' }, api.fetchImpl), recorder().writer, resume)).rejects.toThrow(/consumer/);
  });

  it('translates RBAC and carries the project to the bridge and lazy presets', async () => {
    const api = fakeVendor(ORIGIN, {
      'GET /v1/rbac/policy': {
        policy: {
          roles: [
            { role_id: 'editor', description: 'Edits', permissions: [{ resource_id: 'docs', actions: ['read', 'write'] }] },
            { role_id: 'stytch_admin', permissions: [] },
          ],
          resources: [{ resource_id: 'docs', actions: ['read', 'write', 'delete'] }],
        },
      },
    });
    const p = context({ 'stytch-project-id': LIVE, 'stytch-secret': 's', 'stytch-product': 'consumer' }, api.fetchImpl);
    const tr = await stytchPlugin.config!.translate(p);
    expect(tr.documents.roles).toEqual([{ key: 'editor', name: 'editor', description: 'Edits', permissions: ['docs:read', 'docs:write'] }]);
    expect((tr.documents.permissions as Array<{ key: string }>).map((x) => x.key).sort()).toEqual(['docs:delete', 'docs:read', 'docs:write']);
    expect(tr.bridge).toEqual({ preset: 'stytch', vars: { project_id: LIVE } });
    expect(tr.lazy).toEqual({ preset: 'stytch', config: { project_id: LIVE, product: 'consumer' } });
    expect(stytchPlugin.bridge!.vars(p, tr)).toEqual({ project_id: LIVE });
    expect(stytchPlugin.lazy!.config(p, tr)).toEqual({ project_id: LIVE, product: 'consumer' });
  });

  it('points a B2B test project at the test host and b2b JWKS', () => {
    const p = context({ 'stytch-project-id': TEST, 'stytch-product': 'b2b' }, fakeVendor(ORIGIN, {}).fetchImpl);
    expect(stytchPlugin.bridge!.vars(p)).toEqual({ project_id: TEST, api_host: 'test.stytch.com', jwks_path: 'b2b/sessions' });
    expect(stytchPlugin.lazy!.config(p)).toEqual({ project_id: TEST, product: 'b2b' });
  });
});
