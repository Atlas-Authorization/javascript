import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { createAtlasToolkit, allTools, selectTools, scopeGrants } from './index';
import { createFakeBackend } from './testing/fake-backend';

/** A valid, representative argument object for every tool in the catalogue. */
const REPRESENTATIVE_INPUT: Record<string, Record<string, unknown>> = {
  get_user: { user_id: 'user_1' },
  list_users: { limit: 10 },
  create_user: { email_address: 'ada@example.com', first_name: 'Ada' },
  update_user: { user_id: 'user_1', first_name: 'Ada' },
  ban_user: { user_id: 'user_1' },
  unban_user: { user_id: 'user_1' },
  delete_user: { user_id: 'user_1' },
  get_organization: { organization_id: 'org_1' },
  list_organizations: {},
  get_organization_members: { organization_id: 'org_1' },
  create_organization: { name: 'Acme', slug: 'acme', created_by: 'user_1' },
  update_organization: { organization_id: 'org_1', name: 'Acme Inc' },
  delete_organization: { organization_id: 'org_1' },
  add_organization_member: { organization_id: 'org_1', user_id: 'user_1', role: 'admin' },
  remove_organization_member: { organization_id: 'org_1', user_id: 'user_1' },
  update_organization_member_role: { organization_id: 'org_1', user_id: 'user_1', role: 'member' },
  list_invitations: {},
  create_invitation: { email_address: 'ada@example.com' },
  revoke_invitation: { invitation_id: 'inv_1' },
  list_user_sessions: { user_id: 'user_1' },
  revoke_session: { session_id: 'sess_1' },
  list_api_keys: { subject_type: 'user', subject_id: 'user_1' },
  create_api_key: { subject_type: 'user', subject_id: 'user_1', name: 'ci' },
  revoke_api_key: { api_key_id: 'ak_1' },
};

const WRITE_OR_DELETE = allTools().filter((t) => !t.readOnly).map((t) => t.name);
const READS = allTools().filter((t) => t.readOnly).map((t) => t.name);

describe('catalogue', () => {
  it('has a representative input fixture for every tool (keeps this test honest)', () => {
    for (const tool of allTools()) {
      expect(REPRESENTATIVE_INPUT, `missing fixture for ${tool.name}`).toHaveProperty(tool.name);
    }
  });

  it("every tool's schema parses its representative input", () => {
    for (const tool of allTools()) {
      const result = (tool.schema as z.ZodTypeAny).safeParse(REPRESENTATIVE_INPUT[tool.name]);
      expect(result.success, `${tool.name} failed to parse`).toBe(true);
    }
  });

  it('schemas reject malformed input', () => {
    const getUser = allTools().find((t) => t.name === 'get_user')!;
    expect(getUser.schema.safeParse({}).success).toBe(false); // user_id required
    const createUser = allTools().find((t) => t.name === 'create_user')!;
    expect(createUser.schema.safeParse({ email_address: 'not-an-email' }).success).toBe(false);
  });
});

describe('scoping: safe by default', () => {
  it('exposes ONLY read tools when no allowlist/scopes are given', () => {
    const { client } = createFakeBackend();
    const toolkit = createAtlasToolkit({ backend: client });
    expect(toolkit.names().sort()).toEqual([...READS].sort());
    for (const write of WRITE_OR_DELETE) {
      expect(toolkit.has(write), `${write} must be hidden by default`).toBe(false);
    }
    // The dangerous ones specifically:
    expect(toolkit.has('delete_user')).toBe(false);
    expect(toolkit.has('create_user')).toBe(false);
    expect(toolkit.has('revoke_session')).toBe(false);
  });

  it('a write tool is ABSENT unless allow-listed and PRESENT when allow-listed', () => {
    const { client } = createFakeBackend();
    const without = createAtlasToolkit({ backend: client });
    expect(without.has('delete_user')).toBe(false);

    const withIt = createAtlasToolkit({ backend: client, allowedTools: ['delete_user'] });
    expect(withIt.has('delete_user')).toBe(true);
    // allowedTools is authoritative: a read NOT listed is now hidden too.
    expect(withIt.has('get_user')).toBe(false);
    expect(withIt.names()).toEqual(['delete_user']);
  });

  it('scopes grant by resource:verb, with write⇒read but never write⇒delete', () => {
    const { client } = createFakeBackend();
    const toolkit = createAtlasToolkit({ backend: client, scopes: ['users:write'] });
    expect(toolkit.has('get_user')).toBe(true); // write implies read
    expect(toolkit.has('create_user')).toBe(true);
    expect(toolkit.has('ban_user')).toBe(true);
    expect(toolkit.has('delete_user')).toBe(false); // delete NOT implied by write
    // Untouched resources stay hidden entirely.
    expect(toolkit.has('get_organization')).toBe(false);
  });

  it('an explicit :delete (or :*) scope is required to delete', () => {
    const { client } = createFakeBackend();
    expect(createAtlasToolkit({ backend: client, scopes: ['users:delete'] }).has('delete_user')).toBe(
      true,
    );
    expect(createAtlasToolkit({ backend: client, scopes: ['users:*'] }).has('delete_user')).toBe(true);
  });

  it('wildcards: *:read exposes every read and no write', () => {
    const { client } = createFakeBackend();
    const toolkit = createAtlasToolkit({ backend: client, scopes: ['*:read'] });
    expect(toolkit.names().sort()).toEqual([...READS].sort());
  });

  it('scopeGrants wildcard matrix', () => {
    expect(scopeGrants(['*:*'], 'users', 'delete')).toBe(true);
    expect(scopeGrants(['organizations:write'], 'organizations', 'read')).toBe(true);
    expect(scopeGrants(['organizations:write'], 'organizations', 'delete')).toBe(false);
    expect(scopeGrants(['users:read'], 'organizations', 'read')).toBe(false);
    expect(scopeGrants(['malformed'], 'users', 'read')).toBe(false);
  });

  it('selectTools default returns reads only', () => {
    expect(selectTools().every((t) => t.readOnly)).toBe(true);
  });
});

describe('construction', () => {
  it('throws without a backend or secretKey', () => {
    expect(() => createAtlasToolkit({})).toThrow(/backend.*or.*secretKey/i);
  });

  it('builds a client from a secretKey', () => {
    const toolkit = createAtlasToolkit({ secretKey: 'sk_test_x', fetch: (async () => new Response()) as typeof fetch });
    expect(toolkit.backend.users).toBeDefined();
  });

  it('group accessors hold the exposed tools for that resource', () => {
    const { client } = createFakeBackend();
    const toolkit = createAtlasToolkit({ backend: client, scopes: ['*:*'] });
    expect(Object.keys(toolkit.users)).toContain('delete_user');
    expect(Object.keys(toolkit.organizations)).toContain('add_organization_member');
    expect(Object.keys(toolkit.apiKeys)).toContain('create_api_key');
    expect(Object.keys(toolkit.sessions)).toContain('revoke_session');
  });
});

describe('execute: maps to the right backend method', () => {
  function toolkit() {
    const fake = createFakeBackend();
    return { toolkit: createAtlasToolkit({ backend: fake.client, scopes: ['*:*'] }), fake };
  }

  it('get_user → users.get(id)', async () => {
    const { toolkit: t, fake } = toolkit();
    await t.get('get_user')!.execute({ user_id: 'user_42' });
    expect(fake.last()).toEqual({ method: 'users.get', args: ['user_42'] });
  });

  it('update_user → users.update(id, body) with id split off', async () => {
    const { toolkit: t, fake } = toolkit();
    await t.get('update_user')!.execute({ user_id: 'user_1', first_name: 'Grace' });
    expect(fake.last()).toEqual({ method: 'users.update', args: ['user_1', { first_name: 'Grace' }] });
  });

  it('add_organization_member → organizations.memberships.add', async () => {
    const { toolkit: t, fake } = toolkit();
    await t.get('add_organization_member')!.execute({
      organization_id: 'org_1',
      user_id: 'user_1',
      role: 'admin',
    });
    expect(fake.last()).toEqual({
      method: 'organizations.memberships.add',
      args: ['org_1', { user_id: 'user_1', role: 'admin' }],
    });
  });

  it('list_user_sessions → sessions.list({ user_id })', async () => {
    const { toolkit: t, fake } = toolkit();
    await t.get('list_user_sessions')!.execute({ user_id: 'user_7' });
    expect(fake.last()).toEqual({ method: 'sessions.list', args: [{ user_id: 'user_7' }] });
  });

  it('revoke_api_key → apiKeys.delete(id)', async () => {
    const { toolkit: t, fake } = toolkit();
    await t.get('revoke_api_key')!.execute({ api_key_id: 'ak_9' });
    expect(fake.last()).toEqual({ method: 'apiKeys.delete', args: ['ak_9'] });
  });

  it('returns the mapped result', async () => {
    const { toolkit: t } = toolkit();
    const result = (await t.get('get_user')!.execute({ user_id: 'user_1' })) as Record<string, unknown>;
    expect(result.object).toBe('user');
    expect(result.id).toBe('user_1');
    expect(result.public_metadata).toEqual({ tier: 'pro' });
  });
});

describe('secrets and private metadata never appear in a result', () => {
  function run(name: string, args: Record<string, unknown>) {
    const fake = createFakeBackend();
    const toolkit = createAtlasToolkit({ backend: fake.client, scopes: ['*:*'] });
    return toolkit.get(name)!.execute(args);
  }

  it('strips private_metadata/unsafe_metadata from a user read', async () => {
    const result = (await run('get_user', { user_id: 'user_1' })) as Record<string, unknown>;
    expect(result).not.toHaveProperty('private_metadata');
    expect(result).not.toHaveProperty('unsafe_metadata');
    expect(JSON.stringify(result)).not.toContain('XXX-XX-1234');
  });

  it('strips the one-time secret from a minted api key', async () => {
    const result = (await run('create_api_key', {
      subject_type: 'user',
      subject_id: 'user_1',
      name: 'ci',
    })) as Record<string, unknown>;
    expect(result).not.toHaveProperty('secret');
    expect(result.prefix).toBe('ak_live_new'); // the non-sensitive prefix survives
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET');
  });

  it('strips nested sensitive bags inside list results', async () => {
    const result = (await run('list_users', { limit: 2 })) as { data: Record<string, unknown>[] };
    for (const u of result.data) {
      expect(u).not.toHaveProperty('private_metadata');
      expect(u).not.toHaveProperty('unsafe_metadata');
    }
  });
});
