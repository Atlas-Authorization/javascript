import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';
import { loadSuite } from './fga';

const SUITE = `
name: docs
model: |
  model
    schema 1.1
  type user
  type doc
    relations
      define viewer: [user]
tuples:
  - { user: "user:anne", relation: viewer, object: "doc:1" }
tests:
  - name: anne views
    check:
      - { user: "user:anne", object: "doc:1", assertions: { viewer: true } }
`;

function ctx(files: Record<string, string>, calls: Array<{ path: string; body: unknown }> = [], passed = true): RunContext {
  const http: ConfigHttp = {
    get: async () => ({}) as never,
    post: async (path: string, body?: unknown) => {
      calls.push({ path, body });
      if (path === '/v1/fga/models/transform') return { valid: true, dsl: 'model\n  schema 1.1\ntype user', model: { type_definitions: [] } } as never;
      return { passed, total: 1, failed: passed ? 0 : 1, coverage: { relations: 1, covered: 1, uncovered: [] }, results: [{ name: 'anne views', passed, checks: 1, failures: passed ? [] : [{ kind: 'check', query: 'q', expected: true, actual: false }] }] } as never;
    },
    put: async () => ({}) as never,
    patch: async () => ({}) as never,
    delete: async () => undefined,
  };
  return {
    io: captureIO(),
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: (p: string) => {
      const f = files[p] ?? Object.entries(files).find(([k]) => p.endsWith(`/${k}`))?.[1] ?? files[p.split('/').pop()!];
      if (f === undefined) throw new Error(`no file ${p}`);
      return f;
    },
  };
}

describe('atlas fga test', () => {
  it('posts the suite to the store-less runner and exits 0 when everything passes', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const c = ctx({ 'suite.fga.yaml': SUITE }, calls);
    expect(await run(['fga', 'test', 'suite.fga.yaml'], c)).toBe(0);
    expect(calls[0]!.path).toBe('/v1/fga/tests');
    expect((calls[0]!.body as { tuples: unknown[] }).tuples).toHaveLength(1);
    expect((c.io as ReturnType<typeof captureIO>).stdout()).toContain('PASS  anne views');
  });

  it('exits 1 on a failure and prints it; --store targets the store route', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const c = ctx({ 'suite.fga.yaml': SUITE }, calls, false);
    expect(await run(['fga', 'test', 'suite.fga.yaml', '--store', 'fgas_1'], c)).toBe(1);
    expect(calls[0]!.path).toBe('/v1/fga/stores/fgas_1/tests');
    expect((c.io as ReturnType<typeof captureIO>).stdout()).toContain('FAIL');
  });

  it('reads model_file and tuple_file relative to the suite', () => {
    const c = ctx({ 'dir/m.fga': 'model\n  schema 1.1\ntype user', 'dir/t.yaml': '- { user: "user:a", relation: r, object: "doc:1" }', 'dir/s.yaml': 'model_file: m.fga\ntuple_file: t.yaml\ntests:\n  - name: t\n    check: []\n' });
    const s = loadSuite(c, 'dir/s.yaml');
    expect(s.dsl).toContain('schema 1.1');
    expect(s.tuples).toHaveLength(1);
  });

  it('rejects a suite with no model or no tests', async () => {
    expect(await run(['fga', 'test', 'a.yaml'], ctx({ 'a.yaml': 'tests: [{ name: x }]' }))).toBe(1);
    expect(await run(['fga', 'test', 'a.yaml'], ctx({ 'a.yaml': 'model: "m"\ntests: []' }))).toBe(1);
  });
});

describe('atlas fga validate and transform', () => {
  it('validates and converts', async () => {
    const c = ctx({ 'm.fga': 'model\n  schema 1.1\ntype user' });
    expect(await run(['fga', 'validate', 'm.fga'], c)).toBe(0);
    const c2 = ctx({ 'm.fga': 'x' });
    expect(await run(['fga', 'transform', 'm.fga', '--to', 'json'], c2)).toBe(0);
    expect((c2.io as ReturnType<typeof captureIO>).stdout()).toContain('type_definitions');
    expect(await run(['fga', 'transform', 'm.fga', '--to', 'xml'], ctx({ 'm.fga': 'x' }))).toBe(1);
  });
});
