import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

type Schema = { properties?: Record<string, Schema> };
const schema = JSON.parse(readFileSync(join(__dirname, '../../../../apps/api/src/openapi/auth-config-schema.json'), 'utf8')) as Schema;

/** A document holding every field the server's auth-config schema names, and the dotted path of each. */
function fill(s: Schema, prefix: string, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, sub] of Object.entries(s.properties ?? {})) {
    paths.push(prefix + k);
    out[k] = sub.properties ? fill(sub, `${prefix}${k}.`, paths) : true;
  }
  return out;
}

const has = (doc: unknown, path: string): boolean =>
  path.split('.').every((k) => (doc = doc !== null && typeof doc === 'object' ? (doc as Record<string, unknown>)[k] : undefined) !== undefined);

describe('atlas apply accepts every auth_config field the server schema has', () => {
  it('sends every top-level and nested field (passwordImport, browserHandoff included) and refuses none', async () => {
    const paths: string[] = [];
    const authConfig = fill(schema, '', paths);
    expect(paths).toEqual(expect.arrayContaining(['accountUx.passwordImport', 'session.browserHandoff']));

    const sent: unknown[] = [];
    const reject = async () => {
      throw new Error('unexpected call');
    };
    const api: ConfigHttp = {
      get: (async (p: string) => (p === '/v1/instance' || p === '/v1/branding' ? {} : { data: [] })) as ConfigHttp['get'],
      post: reject as never,
      put: reject as never,
      patch: (async (p: string, body: unknown) => {
        if (!p.includes('dry_run=true')) sent.push(body);
        return {};
      }) as ConfigHttp['patch'],
      delete: reject as never,
    };
    const dir = mkdtempSync(join(tmpdir(), 'atlas-authschema-'));
    try {
      const path = join(dir, 'atlas.json');
      writeFileSync(path, JSON.stringify({ instance: { auth_config: authConfig } }));
      const io = captureIO();
      const ctx: RunContext = {
        io,
        env: {},
        config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
        prompt: { text: async () => '', secret: async () => '' },
        readFile: (p) => readFileSync(p, 'utf8'),
        makeClient: () => ({}) as unknown as ManagementClient,
        makeHttp: () => api,
      };
      expect(await run(['apply', path, '--yes'], ctx), io.stderr() + io.stdout()).toBe(0);
      const body = (sent[0] as { auth_config?: unknown } | undefined)?.auth_config;
      expect(paths.filter((p) => !has(body, p))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
