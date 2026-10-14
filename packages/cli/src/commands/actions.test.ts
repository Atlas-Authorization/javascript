import type { Action } from '@atlasauth/backend';
import { describe, expect, it, vi } from 'vitest';
import type { ManagementClient, RunContext } from '../context';
import { MemoryConfigStore } from '../config';
import { captureIO, type CaptureIO } from '../io';
import { run } from '../run';

const ACTION: Action = {
  object: 'action',
  id: 'act_123',
  name: 'require-verified-email',
  trigger: 'post_login',
  code: "if (!event.user.emailVerified) api.access.deny('verify');",
  runtime: 'node',
  enabled: true,
  secret_names: ['CLAIM_NAMESPACE'],
  created_at: 0,
  updated_at: 0,
};

/** An authed context with an injected fake client and in-memory file reader. */
function ctx(
  io: CaptureIO,
  opts: {
    actions?: Partial<Record<'list' | 'create', ReturnType<typeof vi.fn>>>;
    files?: Record<string, string>;
  } = {},
): RunContext {
  const client = { actions: opts.actions ?? {} } as unknown as ManagementClient;
  return {
    io,
    env: {},
    config: new MemoryConfigStore({
      active_profile: 'default',
      profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } },
    }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => client,
    readFile: (path) => {
      const content = opts.files?.[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

describe('actions list', () => {
  it('renders a table of actions by default', async () => {
    const io = captureIO();
    const list = vi.fn(async () => ({ object: 'list', data: [ACTION], has_more: false }));
    const code = await run(['actions', 'list'], ctx(io, { actions: { list } }));
    expect(code).toBe(0);
    expect(io.stdout()).toContain('act_123');
    expect(io.stdout()).toContain('require-verified-email');
    expect(io.stdout()).toContain('post_login');
    expect(io.stdout()).toContain('CLAIM_NAMESPACE');
  });

  it('emits raw JSON under --json', async () => {
    const io = captureIO();
    const page = { object: 'list', data: [ACTION], has_more: false };
    const list = vi.fn(async () => page);
    const code = await run(['actions', 'list', '--json'], ctx(io, { actions: { list } }));
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout())).toEqual(page);
  });
});

describe('actions deploy', () => {
  it('reads the file and creates an action with the given trigger and name', async () => {
    const io = captureIO();
    const create = vi.fn(async () => ACTION);
    const files = { './a.js': "api.idToken.setCustomClaim('x', 1);" };
    const code = await run(
      ['actions', 'deploy', './a.js', '--trigger', 'post_login', '--name', 'require-verified-email'],
      ctx(io, { actions: { create }, files }),
    );
    expect(code).toBe(0);
    expect(create).toHaveBeenCalledWith({
      name: 'require-verified-email',
      trigger: 'post_login',
      code: "api.idToken.setCustomClaim('x', 1);",
    });
    expect(io.stdout()).toContain('Deployed action act_123');
  });

  it('derives the name from the filename when --name is omitted', async () => {
    const io = captureIO();
    const create = vi.fn(async () => ACTION);
    const files = { '/tmp/my-hook.js': 'api.console.log(1);' };
    await run(
      ['actions', 'deploy', '/tmp/my-hook.js', '--trigger', 'pre_user_registration'],
      ctx(io, { actions: { create }, files }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-hook', trigger: 'pre_user_registration' }),
    );
  });

  it('rejects a missing --trigger before any client call', async () => {
    const io = captureIO();
    const create = vi.fn();
    const code = await run(
      ['actions', 'deploy', './a.js'],
      ctx(io, { actions: { create }, files: { './a.js': 'x' } }),
    );
    expect(code).toBe(1);
    expect(io.stderr()).toContain('--trigger is required');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an unknown trigger value', async () => {
    const io = captureIO();
    const code = await run(
      ['actions', 'deploy', './a.js', '--trigger', 'on_banana'],
      ctx(io, { files: { './a.js': 'x' } }),
    );
    expect(code).toBe(1);
    expect(io.stderr()).toContain("Unknown trigger 'on_banana'");
  });
});

describe('actions test (offline harness)', () => {
  it('runs the file through the harness and reports a deny, no client needed', async () => {
    const io = captureIO();
    const files = { './deny.js': "if (!event.user.emailVerified) api.access.deny('verify');" };
    // emailVerified defaults to true in the sample event → NOT denied here.
    const code = await run(['actions', 'test', './deny.js'], ctx(io, { files }));
    expect(code).toBe(0);
    expect(io.stdout()).toContain('Denied:    false');
    expect(io.stdout()).toContain('Trigger:   post_login');
  });

  it('captures claims set by the script and exits 0', async () => {
    const io = captureIO();
    const files = { './claim.js': "api.idToken.setCustomClaim('role', 'admin');" };
    const code = await run(['actions', 'test', './claim.js', '--json'], ctx(io, { files }));
    expect(code).toBe(0);
    const result = JSON.parse(io.stdout());
    expect(result.idTokenClaims).toEqual({ role: 'admin' });
  });

  it('exits non-zero when the action throws', async () => {
    const io = captureIO();
    const files = { './boom.js': "throw new Error('kaboom');" };
    const code = await run(['actions', 'test', './boom.js'], ctx(io, { files }));
    expect(code).toBe(1);
    expect(io.stderr()).toContain('kaboom');
  });
});

describe('actions logs', () => {
  it('explains where execution history lives and exits 0', async () => {
    const io = captureIO();
    const code = await run(['actions', 'logs', 'act_123'], ctx(io));
    expect(code).toBe(0);
    expect(io.stdout()).toContain('act_123');
    expect(io.stdout()).toContain('audit event');
  });
});

describe('actions dispatch', () => {
  it('an unknown subcommand exits non-zero with a hint', async () => {
    const io = captureIO();
    const code = await run(['actions', 'frobnicate'], ctx(io));
    expect(code).toBe(1);
    expect(io.stderr()).toContain("Unknown subcommand 'actions frobnicate'");
  });
});
