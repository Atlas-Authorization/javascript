import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';

const CHANGES = [
  { object: 'instance', id: 'ins_1', field: 'allowed_origins', before: ['https://old.example.com'], after: ['https://new.example.com'] },
  { object: 'oauth_client', id: 'oac_1', field: 'redirect_uris', before: ['https://old.example.com/cb'], after: ['https://new.example.com/cb'] },
  { object: 'webhook_endpoint', id: 'wh_1', field: 'url', before: 'https://old.example.com/h', after: 'https://new.example.com/h' },
];

function setup(opts: { problems?: unknown[]; testStatus?: number; answer?: string; changes?: unknown[] } = {}) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const http: ConfigHttp = {
    get: async () => ({}) as never,
    put: async () => ({}) as never,
    patch: async () => ({}) as never,
    delete: async () => undefined,
    post: async (path: string, body: unknown) => {
      posts.push({ path, body });
      if (path === '/v1/instance/move_origin') {
        const b = body as { dry_run?: boolean };
        const changes = opts.changes ?? CHANGES;
        return { object: 'origin_move', from: 'https://old.example.com', to: 'https://new.example.com', dry_run: b.dry_run === true, applied: !b.dry_run && changes.length > 0, changes, problems: opts.problems ?? [] } as never;
      }
      return { status: 'delivered', http_status: opts.testStatus ?? 200, error: null } as never;
    },
  };
  const make = (io: CaptureIO): RunContext => ({
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => opts.answer ?? 'y', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: () => '',
  });
  return { posts, make };
}

const ARGS = ['move-origin', '--from', 'https://old.example.com', '--to', 'https://new.example.com'];

describe('atlas move-origin', () => {
  it('--dry-run prints the diff and only ever sends dry_run:true', async () => {
    const { posts, make } = setup();
    const io = captureIO();
    expect(await run([...ARGS, '--dry-run'], make(io))).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ from: 'https://old.example.com', to: 'https://new.example.com', dry_run: true });
    expect(io.stdout()).toContain('3 field(s) would change');
    expect(io.stdout()).toContain('redirect_uris');
    expect(io.stdout()).toContain('Dry run: nothing was written');
  });

  it('applies after confirmation, then tests each moved webhook endpoint', async () => {
    const { posts, make } = setup();
    const io = captureIO();
    expect(await run(ARGS, make(io))).toBe(0);
    expect(posts.map((p) => p.path)).toEqual(['/v1/instance/move_origin', '/v1/instance/move_origin', '/v1/webhook_endpoints/wh_1/test?wait=10s']);
    expect(posts[1]!.body).toEqual({ from: 'https://old.example.com', to: 'https://new.example.com' });
    expect(io.stdout()).toContain('Moved 3 field(s)');
    expect(io.stdout()).toContain('webhook wh_1: test delivery answered 200');
  });

  it('exits 1 when a moved webhook does not answer 2xx', async () => {
    const { make } = setup({ testStatus: 502 });
    const io = captureIO();
    expect(await run([...ARGS, '--yes'], make(io))).toBe(1);
    expect(io.stdout()).toContain('did not get a 2xx (502)');
  });

  it('writes nothing when the answer is no', async () => {
    const { posts, make } = setup({ answer: 'n' });
    const io = captureIO();
    expect(await run(ARGS, make(io))).toBe(1);
    expect(posts).toHaveLength(1);
    expect(io.stdout()).toContain('Cancelled');
  });

  it('refuses to write when a rewritten value would be refused', async () => {
    const { posts, make } = setup({ problems: [{ object: 'webhook_endpoint', id: 'wh_1', field: 'url', url: 'http://localhost/h', message: 'Not a usable webhook target.' }] });
    const io = captureIO();
    expect(await run([...ARGS, '--yes'], make(io))).toBe(1);
    expect(posts).toHaveLength(1);
    expect(io.stdout()).toContain('Not a usable webhook target');
    expect(io.stderr()).toContain('Nothing was written');
  });

  it('an empty diff is a no-op', async () => {
    const { posts, make } = setup({ changes: [] });
    const io = captureIO();
    expect(await run([...ARGS, '--yes'], make(io))).toBe(0);
    expect(posts).toHaveLength(1);
    expect(io.stdout()).toContain('Nothing on');
  });

  it('--json needs --yes to apply, and emits the move plus webhook tests', async () => {
    const { make } = setup();
    expect(await run([...ARGS, '--json'], make(captureIO()))).toBe(1);
    const io = captureIO();
    expect(await run([...ARGS, '--json', '--yes'], make(io))).toBe(0);
    const out = JSON.parse(io.stdout());
    expect(out.applied).toBe(true);
    expect(out.webhook_tests).toEqual([{ endpoint: 'wh_1', ok: true, http_status: 200, error: null }]);
  });

  it('needs --from and --to', async () => {
    const { make } = setup();
    const io = captureIO();
    expect(await run(['move-origin', '--from', 'https://a.example'], make(io))).toBe(1);
    expect(io.stderr()).toContain('--from');
  });
});
