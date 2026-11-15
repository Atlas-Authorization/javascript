import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

function ctx(io: ReturnType<typeof captureIO>, get: (path: string) => unknown): RunContext {
  const http = { get: async (p: string) => get(p) } as unknown as ConfigHttp;
  return {
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: () => '',
    sleep: async () => undefined,
  };
}

describe('atlas changes tail', () => {
  it('prints one line per change from --after and pages through has_more', async () => {
    const paths: string[] = [];
    const pages = [
      { data: [{ seq: 1, resource_type: 'user', resource_id: 'u1', op: 'create', occurred_at: 0 }], has_more: true, next_after: 1, head_seq: 2 },
      { data: [{ seq: 2, resource_type: 'user', resource_id: 'u1', op: 'delete', occurred_at: 0 }], has_more: false, next_after: 2, head_seq: 2 },
    ];
    const io = captureIO();
    const code = await run(['changes', 'tail', '--after', '0', '--types', 'user', '--once'], ctx(io, (p) => (paths.push(p), pages.shift())));
    expect(code).toBe(0);
    expect(paths).toEqual(['/v1/changes?after=0&limit=200&types=user', '/v1/changes?after=1&limit=200&types=user']);
    expect(io.stdout()).toContain('1\t1970-01-01T00:00:00.000Z\tcreate\tuser\tu1');
    expect(io.stdout()).toContain('delete');
  });

  it('without --after it starts at the head', async () => {
    const paths: string[] = [];
    const io = captureIO();
    await run(['changes', 'tail', '--once'], ctx(io, (p) => (paths.push(p), { data: [], has_more: false, next_after: 9, head_seq: 9 })));
    expect(paths).toEqual(['/v1/changes?after=0&limit=1', '/v1/changes?after=9&limit=200']);
  });

  it('rejects an unknown type and a bad --after', async () => {
    const io = captureIO();
    expect(await run(['changes', 'tail', '--types', 'nope'], ctx(io, () => ({})))).toBe(1);
    expect(io.stderr()).toContain('Unknown resource type');
    const io2 = captureIO();
    expect(await run(['changes', 'tail', '--after', '-3'], ctx(io2, () => ({})))).toBe(1);
  });
});

describe('atlas mirror init', () => {
  it('requires an adapter', async () => {
    const io = captureIO();
    expect(await run(['mirror', 'init'], ctx(io, () => ({})))).toBe(1);
    expect(io.stderr()).toContain('--adapter');
  });

  it('prints drizzle and prisma starters for the chosen types', async () => {
    const d = captureIO();
    expect(await run(['mirror', 'init', '--adapter', 'drizzle', '--types', 'user,api_key'], ctx(d, () => ({})))).toBe(0);
    expect(d.stdout()).toContain("pgTable('atlas_api_keys'");
    expect(d.stdout()).toContain("@atlasauth/backend/mirror/drizzle");
    const p = captureIO();
    expect(await run(['mirror', 'init', '--adapter', 'prisma'], ctx(p, () => ({})))).toBe(0);
    expect(p.stdout()).toContain('model AtlasOrganization');
    expect(p.stdout()).toContain("@atlasauth/backend/mirror/prisma");
  });
});

describe('atlas changes consumers', () => {
  it('reads the consumers route and prints one line each', async () => {
    const io = captureIO();
    const paths: string[] = [];
    const code = await run(['changes', 'consumers'], ctx(io, (p) => (paths.push(p), { data: [{ object: 'change_consumer', name: 'mirror', lag: 3 }] })));
    expect(code).toBe(0);
    expect(paths).toEqual(['/v1/changes/consumers']);
    expect(io.stdout()).toContain('name=mirror\tlag=3');
  });
});
