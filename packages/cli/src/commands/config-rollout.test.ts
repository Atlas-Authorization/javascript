import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';
import { planConfigImport } from './config';
import { applyRequires, resolveCodeFiles, sortSets, validateAgainstLimits, type ConfigLimits } from './config-rollout';

type Call = { method: string; path: string; body?: unknown };

/** A tiny management API: a few lists, recorded writes, optional failures per write path. */
class Api implements ConfigHttp {
  calls: Call[] = [];
  lists: Record<string, Array<Record<string, unknown>>> = {};
  /** write path (without the query) -> the status to answer; a `?dry_run=true` write fails too when `dry` is set. */
  fail: Record<string, { status: number; message: string; dry?: boolean }> = {};
  limits: ConfigLimits | null = null;
  async get<T>(path: string): Promise<T> {
    if (path === '/v1/config/limits') {
      if (!this.limits) throw new AtlasApiError(404, [{ code: 'NOT_FOUND', message: 'none' }]);
      return { object: 'config_limits', limits: this.limits } as T;
    }
    if (this.lists[path]) return { data: this.lists[path] } as T;
    throw new AtlasApiError(404, [{ code: 'NOT_FOUND', message: `no route ${path}` }]);
  }
  private write(method: string, path: string, body?: unknown): Record<string, never> {
    const [bare, query] = path.split('?');
    const isDry = query?.includes('dry_run=true') === true;
    const rule = this.fail[`${method} ${bare}`];
    if (rule && (!isDry || rule.dry)) throw new AtlasApiError(rule.status, [{ code: 'VALIDATION', message: rule.message }]);
    this.calls.push({ method, path, body });
    return {};
  }
  async post<T>(path: string, body: unknown): Promise<T> { return this.write('POST', path, body) as T; }
  async put<T>(path: string, body: unknown): Promise<T> { return this.write('PUT', path, body) as T; }
  async patch<T>(path: string, body: unknown): Promise<T> { return this.write('PATCH', path, body) as T; }
  async delete(path: string): Promise<void> { this.write('DELETE', path); }
  real() { return this.calls.filter((c) => !c.path.includes('dry_run=true')); }
  dry() { return this.calls.filter((c) => c.path.includes('dry_run=true')); }
}

const ctx = (io: ReturnType<typeof captureIO>, api: ConfigHttp): RunContext => ({
  io,
  env: {},
  config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
  prompt: { text: async () => '', secret: async () => '' },
  readFile: (p) => readFileSync(p, 'utf8'),
  makeClient: () => ({}) as unknown as ManagementClient,
  makeHttp: () => api,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cx-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const perms = (n: number) => Array.from({ length: n }, (_, i) => `org:thing${String(i).padStart(3, '0')}:read`);
const shuffled = <T>(xs: T[]) => [...xs].sort((a, b) => (String(a).split('').reverse().join('') < String(b).split('').reverse().join('') ? -1 : 1));

describe('set-valued fields compare without order', () => {
  it('sortSets sorts only the named keys', () => {
    const keys = new Set(['permissions']);
    expect(sortSets({ permissions: ['b', 'a'], stages: ['b', 'a'] }, keys)).toEqual({ permissions: ['a', 'b'], stages: ['b', 'a'] });
    expect(sortSets({ roles: [{ permissions: ['z', 'y'] }] }, keys)).toEqual({ roles: [{ permissions: ['y', 'z'] }] });
  });

  it('a 99-permission role listed in a shuffled order plans no change', async () => {
    const all = perms(99);
    const api = new Api();
    api.lists['/v1/roles'] = [{ id: 'role_1', key: 'editor', name: 'Editor', permissions: all, is_system: false }];
    const doc = write('roles.json', JSON.stringify([{ key: 'editor', name: 'Editor', permissions: shuffled(all) }]));
    expect(doc).toBeTruthy();
    const plan = await planConfigImport(api, { dir, format: 'json', env: {}, prune: false });
    expect(plan.changes).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('a real change in a set is still a change', async () => {
    const all = perms(99);
    const api = new Api();
    api.lists['/v1/roles'] = [{ id: 'role_1', key: 'editor', name: 'Editor', permissions: all, is_system: false }];
    write('roles.json', JSON.stringify([{ key: 'editor', name: 'Editor', permissions: [...shuffled(all).slice(1), 'org:extra:write'] }]));
    const plan = await planConfigImport(api, { dir, format: 'json', env: {}, prune: false });
    expect(plan.changes.map((c) => c.action)).toEqual(['update']);
  });

  it('scopes, redirect URIs and event lists are sets too', async () => {
    const api = new Api();
    api.lists['/v1/oauth_clients'] = [{ id: 'oc_1', name: 'web', redirect_uris: ['https://b.example/cb', 'https://a.example/cb'], allowed_scopes: ['openid', 'email'] }];
    api.lists['/v1/webhook_endpoints'] = [{ id: 'we_1', url: 'https://hooks.example/a', enabled_events: ['user.created', 'user.deleted'], active: true }];
    write('oauth_clients.json', JSON.stringify([{ name: 'web', redirect_uris: ['https://a.example/cb', 'https://b.example/cb'], allowed_scopes: ['email', 'openid'] }]));
    write('webhook_endpoints.json', JSON.stringify([{ url: 'https://hooks.example/a', enabled_events: ['user.deleted', 'user.created'], active: true }]));
    const plan = await planConfigImport(api, { dir, format: 'json', env: {}, prune: false });
    expect(plan.changes).toEqual([]);
  });
});

describe('requires', () => {
  const keyOf = (e: Record<string, unknown>) => `${String(e.provider)}/${String(e.environment ?? 'production')}`;

  it('drops an entry whose variable is unset and names it', () => {
    const out = applyRequires('connection_oauth_clients', [{ provider: 'ebay', requires: ['EBAY_SECRET'] }, { provider: 'etsy' }], { OTHER: 'x' }, keyOf as never);
    expect(out.doc).toEqual([{ provider: 'etsy' }]);
    expect(out.notes).toEqual(['skipped connection_oauth_clients ebay/production: EBAY_SECRET unset']);
    expect([...out.skippedKeys]).toEqual(['ebay/production']);
  });

  it('keeps an entry whose variables are set, without the requires key; an empty value counts as unset', () => {
    expect(applyRequires('x', [{ provider: 'a', requires: 'A' }], { A: '1' }, keyOf as never).doc).toEqual([{ provider: 'a' }]);
    expect(applyRequires('x', [{ provider: 'a', requires: ['A'] }], { A: '' }, keyOf as never).skippedKeys.size).toBe(1);
  });

  it('skips a whole section: an object section by key, a list section by wrapper', () => {
    const single = applyRequires('hosted_pages', { requires: ['PAGES'], sign_in_url: 'https://a.example' }, {});
    expect(single.skippedSection).toBe(true);
    expect(single.notes).toEqual(['skipped hosted_pages: PAGES unset']);
    const list = applyRequires('connection_oauth_clients', { requires: ['EBAY'], items: [{ provider: 'ebay' }] }, { EBAY: 'on' }, keyOf as never);
    expect(list.skippedSection).toBe(false);
    expect(list.doc).toEqual([{ provider: 'ebay' }]);
    expect(applyRequires('connection_oauth_clients', { requires: ['EBAY'], items: [{ provider: 'ebay' }] }, {}, keyOf as never).skippedSection).toBe(true);
  });

  it('rejects a requires that is not a name or a list of names', () => {
    expect(() => applyRequires('x', [{ provider: 'a', requires: [1] }], {}, keyOf as never)).toThrow(/requires must be/);
  });

  it('a skipped entry is never read as a deletion, even under --prune-type', async () => {
    const api = new Api();
    api.lists['/v1/connections/oauth_clients'] = [
      { id: 'cc_1', provider: 'ebay', environment: 'production', client_id: 'abc', enabled: true },
      { id: 'cc_2', provider: 'gone', environment: 'production', client_id: 'old', enabled: true },
    ];
    write('connection_oauth_clients.json', JSON.stringify([{ provider: 'ebay', client_id: 'abc', client_secret: '${EBAY_SECRET}', requires: ['EBAY_SECRET'] }]));
    const plan = await planConfigImport(api, { dir, format: 'json', env: {}, prune: true, pruneTypes: ['connection_oauth_clients'] });
    expect(plan.warnings).toContain('skipped connection_oauth_clients instance/ebay/production: EBAY_SECRET unset');
    const deletes = plan.changes.filter((c) => c.action === 'delete').map((c) => c.key);
    expect(deletes).toEqual(['instance/gone/production']);
  });

  it('a skipped section is never pruned or changed', async () => {
    const api = new Api();
    api.lists['/v1/connections/oauth_clients'] = [{ id: 'cc_1', provider: 'ebay', environment: 'production', client_id: 'abc', enabled: true }];
    write('connection_oauth_clients.json', JSON.stringify({ requires: ['NOT_SET'], items: [] }));
    const plan = await planConfigImport(api, { dir, format: 'json', env: {}, prune: true, pruneTypes: ['connection_oauth_clients'] });
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual(['skipped connection_oauth_clients: NOT_SET unset']);
  });

  it('connection_oauth_clients applies per entry once its variable is set', async () => {
    const api = new Api();
    api.lists['/v1/connections/oauth_clients'] = [];
    write('connection_oauth_clients.json', JSON.stringify([
      { provider: 'ebay', client_id: 'e', client_secret: '${EBAY_SECRET}', redirect_uri: 'https://app.example.com/cb', requires: ['EBAY_SECRET'] },
      { provider: 'etsy', client_id: 'y', client_secret: '${ETSY_SECRET}', requires: ['ETSY_SECRET'] },
    ]));
    const plan = await planConfigImport(api, { dir, format: 'json', env: { EBAY_SECRET: 's1' }, prune: false });
    expect(plan.changes.map((c) => c.key)).toEqual(['instance/ebay/production']);
    expect(plan.warnings).toEqual(['skipped connection_oauth_clients instance/etsy/production: ETSY_SECRET unset']);
    await plan.changes[0]!.apply();
    expect(api.real()[0]!.body).toMatchObject({ provider: 'ebay', redirect_uri: 'https://app.example.com/cb', client_secret: 's1' });
  });
});

describe('code_file', () => {
  it('reads an action\'s code from a path relative to the config', async () => {
    write('hook.js', 'export default () => ({ allow: true });\n');
    expect(resolveCodeFiles('actions', [{ name: 'a', trigger: 'pre_user_deletion', code_file: 'hook.js' }], dir)).toEqual([
      { name: 'a', trigger: 'pre_user_deletion', code: 'export default () => ({ allow: true });\n' },
    ]);
  });

  it('refuses an absolute path, a missing file, and both code and code_file', () => {
    expect(() => resolveCodeFiles('actions', [{ name: 'a', code_file: '/etc/passwd' }], dir)).toThrow(/relative/);
    expect(() => resolveCodeFiles('actions', [{ name: 'a', code_file: 'nope.js' }], dir)).toThrow(/not found/);
    write('x.js', 'x');
    expect(() => resolveCodeFiles('actions', [{ name: 'a', code: 'y', code_file: 'x.js' }], dir)).toThrow(/not both/);
  });
});

describe('published limits', () => {
  const limits: ConfigLimits = {
    resource_types: { max_roles_per_type: 3, key_pattern: '^[a-z][a-z0-9_.-]{0,62}$', name_max_length: 20 },
    app_roles: { max_permissions_per_role: 2, max_roles_per_instance: 5 },
    permissions: { max_implied_per_permission: 2, key_max_length: 30 },
    scopes: { description_max_length: 500, label_max_length: 200 },
  };

  it('reports roles over the per-type limit, bad keys and unknown includes', () => {
    const errors = validateAgainstLimits(
      [{ type: 'resource_types', doc: [{ key: 'folder', roles: [{ key: 'a', permissions: [] }, { key: 'b', permissions: [], includes: ['zzz'] }, { key: 'a', permissions: [] }, { key: 'Bad', permissions: [] }] }] }],
      limits,
    );
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('4 roles; a resource type may define at most 3'),
      expect.stringContaining('role key "a" appears twice'),
      expect.stringContaining('includes unknown role "zzz"'),
      expect.stringContaining('roles[3].key must match'),
    ]));
  });

  it('reports permissions per app role and implied permissions', () => {
    const errors = validateAgainstLimits(
      [
        { type: 'app_roles', doc: [{ key: 'big', permissions: ['a', 'b', 'c'] }] },
        { type: 'permissions', doc: [{ key: 'org:a:write', implies: ['x', 'y', 'z'] }, { key: 'org:b:write', implies: ['org:b:write'] }] },
      ],
      limits,
    );
    expect(errors).toEqual([
      expect.stringContaining('3 permissions; a role may carry at most 2'),
      expect.stringContaining('implies 3 permissions; the limit is 2'),
      expect.stringContaining('cannot imply itself'),
    ]);
  });

  it('plan exits 1 with the errors and sends nothing', async () => {
    const api = new Api();
    api.limits = limits;
    api.lists['/v1/resource_types'] = [];
    const p = write('atlas.json', JSON.stringify({ resource_types: [{ key: 'folder', roles: [1, 2, 3, 4].map((n) => ({ key: `r${n}`, permissions: [] })) }] }));
    const io = captureIO();
    expect(await run(['plan', p, '--json'], ctx(io, api))).toBe(1);
    const out = JSON.parse(io.stdout()) as { validation: { errors: string[] }; has_errors: boolean };
    expect(out.has_errors).toBe(true);
    expect(out.validation.errors[0]).toContain('4 roles');
    expect(api.real()).toEqual([]);
  });
});

describe('pre-flight and apply reporting', () => {
  const file = () => write('atlas.json', JSON.stringify({
    redirect_urls: [{ url: 'https://a.example.com/cb' }, { url: 'https://b.example.com/cb' }],
    permissions: [{ key: 'org:one:read', name: 'One' }],
  }));

  it('apply dry-runs every change first and, when the server refuses one, writes nothing', async () => {
    const api = new Api();
    api.lists = { '/v1/redirect_urls': [], '/v1/permissions': [] };
    api.fail['POST /v1/permissions'] = { status: 422, message: 'name is too long', dry: true };
    const io = captureIO();
    expect(await run(['apply', file(), '--yes'], ctx(io, api))).toBe(1);
    expect(api.real()).toEqual([]);
    expect(io.stdout()).toContain('permissions org:one:read (create): name is too long');
    expect(io.stdout()).toContain('Nothing applied');
  });

  it('a clean plan applies after validating', async () => {
    const api = new Api();
    api.lists = { '/v1/redirect_urls': [], '/v1/permissions': [] };
    const io = captureIO();
    expect(await run(['apply', file(), '--yes'], ctx(io, api))).toBe(0);
    expect(api.dry().length).toBe(3);
    expect(api.real().length).toBe(3);
  });

  it('config import runs the same pre-flight and writes nothing when the server refuses a change', async () => {
    const api = new Api();
    api.lists = { '/v1/permissions': [] };
    api.fail['POST /v1/permissions'] = { status: 422, message: 'name is too long', dry: true };
    writeFileSync(join(dir, 'permissions.json'), JSON.stringify([{ key: 'org:one:read', name: 'One' }]));
    const io = captureIO();
    expect(await run(['config', 'import', '--dir', dir], ctx(io, api))).toBe(1);
    expect(api.real()).toEqual([]);
    expect(io.stdout()).toContain('permissions org:one:read (create): name is too long');
  });

  it('config import applies a clean plan after dry-running it, and --skip-validate omits the dry run', async () => {
    writeFileSync(join(dir, 'permissions.json'), JSON.stringify([{ key: 'org:one:read', name: 'One' }]));
    const api = new Api();
    api.lists = { '/v1/permissions': [] };
    expect(await run(['config', 'import', '--dir', dir], ctx(captureIO(), api))).toBe(0);
    expect(api.dry().length).toBe(1);
    expect(api.real().length).toBe(1);
    const api2 = new Api();
    api2.lists = { '/v1/permissions': [] };
    expect(await run(['config', 'import', '--dir', dir, '--skip-validate'], ctx(captureIO(), api2))).toBe(0);
    expect(api2.dry()).toEqual([]);
  });

  it('--skip-validate leaves out the dry run', async () => {
    const api = new Api();
    api.lists = { '/v1/redirect_urls': [], '/v1/permissions': [] };
    expect(await run(['apply', file(), '--yes', '--skip-validate'], ctx(captureIO(), api))).toBe(0);
    expect(api.dry()).toEqual([]);
  });

  it('a failure mid-run names what was applied and what was not, in text and in --json', async () => {
    const api = new Api();
    api.lists = { '/v1/redirect_urls': [], '/v1/permissions': [] };
    // The dry run passes; the real second write fails (a concurrent change).
    api.fail['POST /v1/permissions'] = { status: 500, message: 'database is unavailable' };
    const text = captureIO();
    expect(await run(['apply', file(), '--yes', '--skip-validate'], ctx(text, api))).toBe(1);
    expect(text.stdout()).toContain('applied      create redirect_urls https://a.example.com/cb');
    expect(text.stdout()).toContain('FAILED       create permissions org:one:read');
    expect(text.stdout()).toContain('Applied 2 of 3');

    const json = captureIO();
    const api2 = new Api();
    api2.lists = { '/v1/redirect_urls': [], '/v1/permissions': [] };
    api2.fail['POST /v1/permissions'] = { status: 500, message: 'database is unavailable' };
    expect(await run(['apply', file(), '--yes', '--skip-validate', '--json'], ctx(json, api2))).toBe(1);
    const out = JSON.parse(json.stdout()) as { applied: Array<{ type: string }>; failed: { type: string; error: string }; not_applied: unknown[] };
    expect(out.applied.map((a) => a.type)).toEqual(['redirect_urls', 'redirect_urls']);
    expect(out.failed).toMatchObject({ type: 'permissions', error: 'database is unavailable' });
    expect(out.not_applied).toEqual([]);
  });

  it('a 403 on the dry run (a read-only key) is a note, not a failure', async () => {
    const api = new Api();
    api.lists = { '/v1/redirect_urls': [], '/v1/permissions': [] };
    api.fail['POST /v1/redirect_urls'] = { status: 403, message: 'missing scope', dry: true };
    const io = captureIO();
    expect(await run(['plan', file()], ctx(io, api))).toBe(0);
    expect(io.stdout()).toContain('cannot dry-run writes');
  });

  it('a dry-run 404 on a dependency this plan creates is deferred, not an error', async () => {
    const api = new Api();
    api.lists = { '/v1/redirect_urls': [], '/v1/permissions': [] };
    api.fail['POST /v1/permissions'] = { status: 404, message: 'unknown thing', dry: true };
    const io = captureIO();
    expect(await run(['plan', file(), '--json'], ctx(io, api))).toBe(0);
    const out = JSON.parse(io.stdout()) as { validation: { deferred: unknown[]; errors: string[] } };
    expect(out.validation.errors).toEqual([]);
    expect(out.validation.deferred).toHaveLength(1);
  });
});

describe('resource_types and implied permissions in config', () => {
  it('creates a resource type and a permission with implies', async () => {
    const api = new Api();
    api.lists = { '/v1/resource_types': [], '/v1/permissions': [] };
    write('atlas.json', JSON.stringify({
      permissions: [{ key: 'org:inv:manage', name: 'Manage', implies: ['org:inv:read'] }],
      resource_types: [{ key: 'folder', name: 'Folder', parent_type: null, roles: [{ key: 'viewer', permissions: ['read'] }] }],
    }));
    expect(await run(['apply', join(dir, 'atlas.json'), '--yes', '--skip-validate'], ctx(captureIO(), api))).toBe(0);
    const writes = api.real();
    expect(writes.find((w) => w.path === '/v1/permissions')!.body).toMatchObject({ key: 'org:inv:manage', implies: ['org:inv:read'] });
    expect(writes.find((w) => w.path === '/v1/resource_types')!.body).toMatchObject({ key: 'folder', roles: [{ key: 'viewer', permissions: ['read'] }] });
  });

  it('a re-plan after apply is clean when the role order differs', async () => {
    const api = new Api();
    api.lists = {
      '/v1/permissions': [],
      '/v1/resource_types': [{ key: 'folder', name: 'Folder', inherit: true, roles: [{ key: 'b', permissions: ['y', 'x'] }, { key: 'a', permissions: ['x'] }] }],
    };
    const p = write('atlas.json', JSON.stringify({ resource_types: [{ key: 'folder', name: 'Folder', roles: [{ key: 'a', permissions: ['x'] }, { key: 'b', permissions: ['x', 'y'] }] }] }));
    expect(await run(['plan', p, '--check', '--skip-validate'], ctx(captureIO(), api))).toBe(0);
  });
});
