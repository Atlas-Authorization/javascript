import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';
import { inputFromConfig, readLive } from './types';
import { emptyInput, renderTypes, schemaToTs } from './types-emit';

const ROUTES: Record<string, unknown> = {
  '/v1/permissions': { data: [{ key: 'org:billing:manage' }, { key: 'org:docs:read' }] },
  '/v1/roles': { data: [{ key: 'org:admin', permissions: ['org:billing:manage'] }, { key: 'org:editor', permissions: ['org:docs:read'] }] },
  '/v1/app_roles': { data: [{ key: 'support', permissions: ['tickets:write'] }] },
  '/v1/billing/plans': { data: [{ slug: 'pro', features: ['seats', 'sso'] }, { slug: 'free', features: [] }] },
  '/v1/instance/scopes': { data: [{ name: 'reports:read' }] },
  '/v1/jwt_templates': { data: [{ name: 'hasura', claims: { 'https://hasura.io/x': 'a', role: 'b' } }] },
  '/v1/instance/user_traits_schema': {
    schemas: {
      public_metadata: {
        type: 'object',
        properties: { plan: { type: 'string', enum: ['free', 'pro'] }, seats: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['plan'],
        additionalProperties: false,
      },
    },
  },
  '/v1/webhook_event_schemas': { data: [{ type: 'user.created' }, { type: 'user.deleted' }] },
  '/v1/app_event_types': { data: [{ type: 'invoice.paid' }] },
  '/v1/audit_event_schemas': { data: [{ action: 'invoice.exported' }] },
  '/v1/fga/stores': { data: [{ id: 'st_1' }] },
  '/v1/fga/stores/st_1/authorization-models': { data: [{ id: 'm_old', created_at: 1 }, { id: 'm_new', created_at: 2 }] },
  '/v1/fga/stores/st_1/authorization-models/m_new': { model: { type_definitions: [{ type: 'user' }, { type: 'doc', relations: { viewer: {}, editor: {} } }] } },
};

function http(routes: Record<string, unknown> = ROUTES, seen: string[] = []): ConfigHttp {
  return {
    get: async (p: string) => {
      seen.push(p);
      if (!(p in routes)) throw new Error(`no route ${p}`);
      return routes[p] as never;
    },
    post: async () => ({}) as never,
    put: async () => ({}) as never,
    patch: async () => ({}) as never,
    delete: async () => undefined,
  };
}

describe('readLive', () => {
  it('reads every source and keeps only the newest authorization model', async () => {
    const seen: string[] = [];
    const { input, failed } = await readLive(http(ROUTES, seen));
    expect(failed).toEqual([]);
    expect(input.orgRoles).toEqual(['org:admin', 'org:editor']);
    expect(input.plans).toEqual(['pro', 'free']);
    expect(input.features).toEqual(['seats', 'sso']);
    expect(input.fgaTypes).toEqual(['user', 'doc']);
    expect(input.fgaRelations).toEqual(['viewer', 'editor']);
    expect(input.jwtTemplates[0]).toEqual({ name: 'hasura', claims: ['https://hasura.io/x', 'role'] });
    expect(seen).not.toContain('/v1/fga/stores/st_1/authorization-models/m_old');
  });

  it('names a source that failed and leaves it empty', async () => {
    const { [`/v1/app_roles`]: _drop, ...rest } = ROUTES;
    const { input, failed } = await readLive(http(rest));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('app roles');
    expect(input.appRoles).toEqual([]);
  });

  it('refuses a truncated list rather than narrowing to half the keys', async () => {
    const { failed } = await readLive(http({ ...ROUTES, '/v1/permissions': { data: [{ key: 'org:a:b' }], has_more: true } }));
    expect(failed.some((f) => f.startsWith('permissions'))).toBe(true);
  });
});

describe('renderTypes', () => {
  it('emits unions, metadata, claims and the Register augmentation', async () => {
    const { input } = await readLive(http());
    const text = renderTypes(input, 'live instance');
    expect(text).toContain('export type AtlasPermission = "org:billing:manage" | "org:docs:read";');
    expect(text).toContain('export type AtlasPlan = "free" | "pro";');
    expect(text).toContain('export type AtlasScope = "email" | "offline_access" | "openid" | "profile" | "reports:read";');
    expect(text).toContain('plan: "free" | "pro";');
    expect(text).toContain('seats?: number;');
    expect(text).toContain('tags?: Array<string>;');
    expect(text).not.toContain('[key: string]: unknown;'); // additionalProperties: false closes the bag
    expect(text).toContain('"https://hasura.io/x"?: unknown;');
    expect(text).toContain("declare module '@atlasauth/types' {");
    expect(text).toContain('    permission: AtlasPermission;');
    expect(text).toContain('    publicMetadata: AtlasUserPublicMetadata;');
    expect(text).toContain('    fgaRelation: AtlasFgaRelation;');
    expect(text).toContain('  pla?: AtlasPlan | null;');
  });

  it('is deterministic: input order does not change the output', async () => {
    const { input } = await readLive(http());
    const shuffled = { ...input, permissions: [...input.permissions].reverse(), orgRoles: [...input.orgRoles].reverse() };
    expect(renderTypes(shuffled, 'live instance')).toBe(renderTypes(input, 'live instance'));
  });

  it('keeps an undefined set as string and does not register it', () => {
    const text = renderTypes(emptyInput(), 'x');
    expect(text).toContain('export type AtlasPermission = string;');
    expect(text).not.toContain('permission: AtlasPermission;');
    expect(text).toContain('    sessionClaims: AtlasSessionClaims;');
  });

  it('cannot be broken out of by a hostile description or key', () => {
    const ts = schemaToTs({ type: 'object', properties: { 'a-b': { type: 'string', description: 'x */ y\nz' } } });
    expect(ts).toContain('"a-b"?: string;');
    expect(ts).not.toContain('x */');
  });
});

describe('inputFromConfig', () => {
  it('reads roles, plans, scopes, templates and the schema; system roles are always present', () => {
    const input = inputFromConfig({
      permissions: [{ key: 'org:docs:read' }],
      roles: [{ key: 'org:editor', permissions: ['org:sys_memberships:read'] }],
      billing_plans: [{ slug: 'pro', features: ['sso'] }],
      scopes: { scopes: [{ name: 'reports:read' }] },
      jwt_templates: [{ name: 't', claims: { a: 'x' } }],
      user_traits_schema: { schemas: { unsafe_metadata: { type: 'object', properties: {} } } },
    });
    expect(input.orgRoles).toEqual(['org:admin', 'org:member', 'org:editor']);
    expect(input.permissions).toEqual(['org:docs:read', 'org:sys_memberships:read']);
    expect(input.plans).toEqual(['pro']);
    expect(input.scopes).toContain('reports:read');
    expect(Object.keys(input.traits)).toEqual(['unsafe_metadata']);
  });
});

describe('atlas types generate', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  const ctx = (io = captureIO()): RunContext => ({
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http(),
    readFile: (p) => readFileSync(p, 'utf8'),
  });

  it('writes the file, then --check passes; a stale file fails --check', async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-types-'));
    const out = join(dir, 'atlas-types.d.ts');
    expect(await run(['types', 'generate', '--out', out], ctx())).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('AtlasPermission');
    expect(await run(['types', 'generate', '--out', out, '--check'], ctx())).toBe(0);
    writeFileSync(out, '// stale\n');
    const io = captureIO();
    expect(await run(['types', 'generate', '--out', out, '--check'], ctx(io))).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe('// stale\n'); // --check never writes
  });

  it('--check fails when the file is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-types-'));
    expect(await run(['types', 'generate', '--out', join(dir, 'nope.d.ts'), '--check'], ctx())).toBe(1);
  });

  it('refuses a language other than ts', async () => {
    const io = captureIO();
    expect(await run(['types', 'generate', '--lang', 'python'], ctx(io))).toBe(1);
  });

  it('--from-config needs no login or network', async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-types-'));
    const cfg = join(dir, 'atlas.json');
    writeFileSync(cfg, JSON.stringify({ roles: [{ key: 'org:editor', permissions: ['org:docs:read'] }] }));
    const out = join(dir, 'out.d.ts');
    const offline: RunContext = { ...ctx(), config: new MemoryConfigStore({ active_profile: 'default', profiles: {} }), makeHttp: () => { throw new Error('network'); } };
    expect(await run(['types', 'generate', '--from-config', cfg, '--out', out], offline)).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('"org:docs:read"');
  });
});
