import type { User } from '@atlasauth/backend';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO, type CaptureIO } from '../io';
import { MemoryConfigStore } from '../config';
import { run } from '../run';

const USER: User = {
  object: 'user',
  id: 'user_42',
  username: 'ada',
  first_name: 'Ada',
  last_name: 'Lovelace',
  image_url: null,
  public_metadata: {},
  mfa_enabled: false,
  banned: false,
  locked: false,
  last_sign_in_at: null,
  created_at: 0,
  updated_at: 0,
};

/** A context pre-authenticated via a stored profile, with an injected fake client. */
function ctx(io: CaptureIO, usersList: ReturnType<typeof vi.fn>): RunContext {
  const client = { users: { list: usersList } } as unknown as ManagementClient;
  return {
    io,
    env: {},
    config: new MemoryConfigStore({
      active_profile: 'default',
      profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } },
    }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => client,
    readFile: () => '',
  };
}

describe('users list', () => {
  it('renders a human table of rows by default', async () => {
    const io = captureIO();
    const usersList = vi.fn(async () => ({ data: [USER], has_more: false, next_cursor: null }));
    const code = await run(['users', 'list'], ctx(io, usersList));

    expect(code).toBe(0);
    const out = io.stdout();
    expect(out).toContain('ID');
    expect(out).toContain('user_42');
    expect(out).toContain('Ada Lovelace');
    // A table, not JSON.
    expect(out).not.toContain('"object"');
  });

  it('emits the raw page as JSON under --json', async () => {
    const io = captureIO();
    const page = { data: [USER], has_more: false, next_cursor: null };
    const usersList = vi.fn(async () => page);
    const code = await run(['users', 'list', '--json'], ctx(io, usersList));

    expect(code).toBe(0);
    expect(JSON.parse(io.stdout())).toEqual(page);
  });

  it('passes --limit and --starting-after through to the client', async () => {
    const io = captureIO();
    const usersList = vi.fn(async () => ({ data: [], has_more: false, next_cursor: null }));
    await run(['users', 'list', '--limit', '7', '--starting-after', 'user_9'], ctx(io, usersList));

    expect(usersList).toHaveBeenCalledWith({ limit: 7, starting_after: 'user_9' });
  });

  it('rejects a non-numeric --limit with a clean non-zero exit', async () => {
    const io = captureIO();
    const usersList = vi.fn();
    const code = await run(['users', 'list', '--limit', 'lots'], ctx(io, usersList));

    expect(code).toBe(1);
    expect(io.stderr()).toContain('--limit must be a positive integer');
    expect(usersList).not.toHaveBeenCalled();
  });
});

describe('users subcommands', () => {
  it('an unknown subcommand exits non-zero with a hint', async () => {
    const io = captureIO();
    const code = await run(['users', 'frobnicate'], ctx(io, vi.fn()));
    expect(code).toBe(1);
    expect(io.stderr()).toContain("Unknown subcommand 'users frobnicate'");
  });

  it('clear-password calls the DELETE route', async () => {
    const io = captureIO();
    const del = vi.fn(async () => undefined);
    const http = { delete: del } as unknown as ConfigHttp;
    expect(await run(['users', 'clear-password', 'user_1'], { ...ctx(io, vi.fn()), makeHttp: () => http })).toBe(0);
    expect(del).toHaveBeenCalledWith('/v1/users/user_1/password');
    expect(io.stdout()).toContain('Cleared the password of user user_1');
    const json = captureIO();
    expect(await run(['users', 'clear-password', 'user_1', '--json'], { ...ctx(json, vi.fn()), makeHttp: () => http })).toBe(0);
    expect(JSON.parse(json.stdout())).toEqual({ id: 'user_1', password_enabled: false });
  });

  it('clear-password needs a user id', async () => {
    const io = captureIO();
    expect(await run(['users', 'clear-password'], ctx(io, vi.fn()))).toBe(1);
    expect(io.stderr()).toContain('<user-id>');
  });

  it('create without --email fails cleanly before any client call', async () => {
    const io = captureIO();
    const usersList = vi.fn();
    const code = await run(['users', 'create'], ctx(io, usersList));
    expect(code).toBe(1);
    expect(io.stderr()).toContain('--email');
  });
});

describe('users protect', () => {
  const answering = (protection: string, seen: unknown[]) => ({
    ...ctx(captureIO(), vi.fn()),
    makeHttp: () => ({ post: async (path: string, body: unknown) => (seen.push({ path, body }), { object: 'account_claim', protection }) }) as unknown as ConfigHttp,
  });

  it('posts the policy to the route and says what it did', async () => {
    const io = captureIO();
    const seen: unknown[] = [];
    expect(await run(['users', 'protect', 'user_42'], { ...answering('claim_marker', seen), io })).toBe(0);
    expect(seen).toEqual([{ path: '/v1/users/user_42/account_claim', body: { password_policy: 'until_email_verified' } }]);
    expect(io.stdout()).toContain('user_42');
  });

  it('--json prints the answer, a password says it is on hold, and it needs an id', async () => {
    const io = captureIO();
    expect(await run(['users', 'protect', 'user_42', '--json'], { ...answering('password_hold', []), io })).toBe(0);
    expect(JSON.parse(io.stdout())).toMatchObject({ protection: 'password_hold' });
    const text = captureIO();
    expect(await run(['users', 'protect', 'user_42'], { ...answering('password_hold', []), io: text })).toBe(0);
    expect(text.stdout()).toContain('on hold');
    expect(await run(['users', 'protect'], { ...answering('password_hold', []), io: captureIO() })).toBe(1);
  });
});
