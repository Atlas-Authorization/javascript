import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileConfigStore } from './config';
import type { ManagementClient, RunContext } from './context';
import { captureIO, type CaptureIO } from './io';
import type { Prompter } from './prompt';
import { run } from './run';

/**
 * A fake Backend client: every method is a vi.fn() the test pre-programs. Typed
 * through `ManagementClient` so a drift in the real namespaces (a renamed
 * method) fails this file at compile time.
 */
function fakeClient(overrides: Record<string, unknown> = {}): {
  client: ManagementClient;
  calls: Record<string, ReturnType<typeof vi.fn>>;
} {
  const calls = {
    usersList: vi.fn(async () => ({ data: [], has_more: false, next_cursor: null })),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>;

  const client = {
    users: { list: calls.usersList },
  } as unknown as ManagementClient;

  return { client, calls };
}

/** A scripted prompter: hands back queued answers in order. */
function scriptedPrompter(answers: string[]): Prompter {
  const queue = [...answers];
  return {
    text: async () => queue.shift() ?? '',
    secret: async () => queue.shift() ?? '',
  };
}

let dir: string;
function ctxWith(opts: {
  io: CaptureIO;
  client?: ManagementClient;
  env?: NodeJS.ProcessEnv;
  prompt?: Prompter;
  makeClient?: RunContext['makeClient'];
}): RunContext {
  return {
    io: opts.io,
    env: opts.env ?? {},
    config: new FileConfigStore(join(dir, 'config.json')),
    prompt: opts.prompt ?? scriptedPrompter([]),
    makeClient: opts.makeClient ?? (() => opts.client ?? fakeClient().client),
    readFile: () => '',
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cli-run-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('top-level dispatch', () => {
  it('--version prints the version and exits 0', async () => {
    const io = captureIO();
    const code = await run(['--version'], ctxWith({ io }));
    expect(code).toBe(0);
    expect(io.stdout()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('--help (and bare invocation) print usage on stdout, exit 0', async () => {
    const io = captureIO();
    expect(await run(['--help'], ctxWith({ io }))).toBe(0);
    expect(io.stdout()).toContain('Usage: atlas');

    const bare = captureIO();
    expect(await run([], ctxWith({ io: bare }))).toBe(0);
    expect(bare.stdout()).toContain('Commands:');
  });

  it('an unknown command exits non-zero with a helpful message, not a stack', async () => {
    const io = captureIO();
    const code = await run(['frobnicate'], ctxWith({ io }));
    expect(code).toBe(1);
    expect(io.stderr()).toContain("Unknown command 'frobnicate'");
    expect(io.stderr()).not.toMatch(/at .*\(/); // no stack frames
  });

  it('an unknown flag exits non-zero with a clean message', async () => {
    const io = captureIO();
    const code = await run(['users', 'list', '--frob'], ctxWith({ io }));
    expect(code).toBe(1);
    expect(io.stderr()).toContain('atlas:');
    expect(io.stderr().toLowerCase()).toContain('frob');
  });

  it('per-command --help prints that command usage', async () => {
    const io = captureIO();
    expect(await run(['users', '--help'], ctxWith({ io }))).toBe(0);
    expect(io.stdout()).toContain('atlas users create --email');
  });
});

describe('auth resolution', () => {
  it('a command with no stored key and no env var exits non-zero', async () => {
    const io = captureIO();
    const code = await run(['users', 'list'], ctxWith({ io }));
    expect(code).toBe(1);
    expect(io.stderr()).toContain('Not logged in');
  });

  it('ATLAS_SECRET_KEY lets a command run with no login', async () => {
    const io = captureIO();
    const { client, calls } = fakeClient();
    const makeClient = vi.fn(() => client);
    const code = await run(
      ['users', 'list'],
      ctxWith({ io, env: { ATLAS_SECRET_KEY: 'sk_env', ATLAS_API_URL: 'https://env.test' }, makeClient }),
    );
    expect(code).toBe(0);
    expect(makeClient).toHaveBeenCalledWith({ secretKey: 'sk_env', apiUrl: 'https://env.test' });
    expect(calls.usersList).toHaveBeenCalledOnce();
  });
});

describe('login / whoami / logout', () => {
  it('login validates the key, then writes the config; whoami reads it back', async () => {
    const io = captureIO();
    const { client, calls } = fakeClient();
    const makeClient = vi.fn(() => client);
    const prompt = scriptedPrompter(['https://api.test', 'sk_secret_value_1234']);

    const ctx = ctxWith({ io, makeClient, prompt });
    const code = await run(['login'], ctx);

    expect(code).toBe(0);
    // Validation happened before any save.
    expect(calls.usersList).toHaveBeenCalledWith({ limit: 1 });
    // Config persisted the profile.
    expect(ctx.config.load()).toEqual({
      active_profile: 'default',
      profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_secret_value_1234' } },
    });

    // whoami reads the SAME config file (fresh ctx, same temp dir) and masks the key.
    const io3 = captureIO();
    const whoamiCtx = ctxWith({ io: io3, makeClient });
    expect(await run(['whoami', '--json'], whoamiCtx)).toBe(0);
    const parsed = JSON.parse(io3.stdout());
    expect(parsed.profile).toBe('default');
    expect(parsed.api_url).toBe('https://api.test');
    expect(parsed.secret_key).not.toContain('secret_value');
    expect(parsed.secret_key).toContain('…');
  });

  it('login rejects a bad key WITHOUT writing config', async () => {
    const io = captureIO();
    const makeClient = vi.fn(() => ({
      users: { list: vi.fn(async () => { throw new AtlasApiError(401, [{ code: 'UNAUTHORIZED', message: 'bad key' }]); }) },
    }) as unknown as ManagementClient);
    const prompt = scriptedPrompter(['https://api.test', 'sk_bad']);
    const ctx = ctxWith({ io, makeClient, prompt });

    const code = await run(['login'], ctx);
    expect(code).toBe(1);
    expect(io.stderr()).toContain('rejected');
    expect(ctx.config.load()).toEqual({ profiles: {} }); // nothing saved
  });

  it('logout forgets the stored profile', async () => {
    const io = captureIO();
    const { client } = fakeClient();
    const makeClient = vi.fn(() => client);
    const ctx = ctxWith({ io, makeClient, prompt: scriptedPrompter(['https://api.test', 'sk_1234567890ab']) });
    await run(['login'], ctx);
    expect(ctx.config.load().profiles.default).toBeDefined();

    const outCtx = ctxWith({ io: captureIO(), makeClient });
    expect(await run(['logout'], outCtx)).toBe(0);
    expect(outCtx.config.load().profiles.default).toBeUndefined();
  });
});
