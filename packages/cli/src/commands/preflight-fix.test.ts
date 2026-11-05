import { describe, expect, it, vi } from 'vitest';
import { AtlasApiError } from '@atlasauth/backend';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';

const SAFE = { severity: 'warning', code: 'SAFE', message: 'm', fix: 'f', safe_to_autofix: true, fix_call: { method: 'PUT', path: '/v1/instance/cookie_consent', body: { host_aliases: ['a.example'] } } };

/** Each write takes the findings it fixes away, so the re-run shows the result. */
function setup(findings: Array<Record<string, unknown>>, failing?: string) {
  const state = { findings: [...findings], writes: [] as Array<{ method: string; path: string; body: unknown }> };
  const write = (method: string) => async (path: string, body?: unknown) => {
    state.writes.push({ method, path, body });
    if (failing === path) throw new AtlasApiError(422, [{ code: 'BAD', message: 'refused' }]);
    state.findings = state.findings.filter((f) => (f.fix_call as { path?: string } | undefined)?.path !== path);
    return {} as never;
  };
  const http: ConfigHttp = {
    get: (async () => ({ ok: true, findings: state.findings })) as ConfigHttp['get'],
    post: write('POST') as ConfigHttp['post'],
    put: write('PUT') as ConfigHttp['put'],
    patch: write('PATCH') as ConfigHttp['patch'],
    delete: write('DELETE') as unknown as ConfigHttp['delete'],
  };
  const ctx = (io: CaptureIO, over: Partial<RunContext> = {}): RunContext => ({
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => 'y', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: () => '',
    tty: { stdin: true, stdout: true },
    ...over,
  });
  return { state, ctx };
}

describe('atlas preflight', () => {
  it('normal output prints the exact call', async () => {
    const { ctx } = setup([SAFE]);
    const io = captureIO();
    expect(await run(['preflight'], ctx(io))).toBe(0);
    expect(io.stdout()).toContain('call: PUT /v1/instance/cookie_consent {"host_aliases":["a.example"]}');
  });

  it('--json masks a secret in a finding', async () => {
    const { ctx } = setup([{ ...SAFE, fix_call: { method: 'PUT', path: '/v1/x', body: { api_key: 'hunter2-long' } } }]);
    const io = captureIO();
    await run(['preflight', '--json'], ctx(io));
    expect(io.stdout()).not.toContain('hunter2-long');
  });
});

describe('atlas preflight --fix', () => {
  it('refuses without a terminal unless --yes', async () => {
    const { state, ctx } = setup([SAFE]);
    for (const tty of [{ stdin: false, stdout: true }, { stdin: true, stdout: false }]) {
      const io = captureIO();
      expect(await run(['preflight', '--fix'], ctx(io, { tty }))).toBe(1);
      expect(io.stderr()).toContain('--yes');
    }
    expect(state.writes).toEqual([]);
    expect(await run(['preflight', '--fix', '--yes'], ctx(captureIO(), { tty: { stdin: false, stdout: false } }))).toBe(0);
    expect(state.writes).toHaveLength(1);
  });

  it('asks per item, applies what is confirmed, and prints the re-run', async () => {
    const other = { ...SAFE, code: 'OTHER', fix_call: { method: 'POST', path: '/v1/other' } };
    const { state, ctx } = setup([SAFE, other]);
    const text = vi.fn(async (q: string) => (q.includes('SAFE') ? 'y' : 'n'));
    const io = captureIO();
    expect(await run(['preflight', '--fix'], ctx(io, { prompt: { text, secret: async () => '' } }))).toBe(0);
    expect(text).toHaveBeenCalledTimes(2);
    expect(state.writes).toEqual([{ method: 'PUT', path: '/v1/instance/cookie_consent', body: SAFE.fix_call.body }]);
    expect(io.stdout()).toContain('Fixed SAFE.');
    expect(io.stdout()).toContain('OTHER');
  });

  it('never calls a finding not marked safe, without a call, or off /v1/', async () => {
    const { state, ctx } = setup([
      { ...SAFE, code: 'A', safe_to_autofix: false },
      { ...SAFE, code: 'B', fix_call: undefined },
      { ...SAFE, code: 'C', fix_call: { method: 'POST', path: 'https://evil.example/v1/x' } },
      { ...SAFE, code: 'D', fix_call: { method: 'POST', path: '/oauth2/token' } },
      { ...SAFE, code: 'E', fix_call: { method: 'POST', path: '/v1/../admin' } },
      { ...SAFE, code: 'F', fix_call: { method: 'GET', path: '/v1/x' } },
      { ...SAFE, code: 'G', acknowledged: { reason: 'known' } },
    ]);
    const io = captureIO();
    expect(await run(['preflight', '--fix', '--yes'], ctx(io))).toBe(0);
    expect(state.writes).toEqual([]);
    expect(io.stdout()).toContain('Nothing here can be fixed automatically.');
  });

  it('a refused call is reported and the rest still run', async () => {
    const other = { ...SAFE, code: 'OTHER', fix_call: { method: 'DELETE', path: '/v1/other' } };
    const { state, ctx } = setup([SAFE, other], SAFE.fix_call.path);
    const io = captureIO();
    await run(['preflight', '--fix', '--yes'], ctx(io));
    expect(io.stdout()).toContain('Could not fix SAFE: refused');
    expect(state.writes.map((w) => w.method)).toEqual(['PUT', 'DELETE']);
    expect(io.stdout()).toContain('Fixed OTHER.');
  });
});
