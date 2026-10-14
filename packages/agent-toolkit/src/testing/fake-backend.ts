import type { AtlasClient } from '@atlasauth/backend';

/** One recorded call against the fake: the dotted method path and its args. */
export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeBackend {
  /** Cast to `AtlasClient` for `createAtlasToolkit({ backend })`. */
  client: AtlasClient;
  /** Every method invocation the tools made, in order. */
  calls: FakeCall[];
  /** The most recent call, or `undefined`. */
  last(): FakeCall | undefined;
}

/**
 * An in-memory stand-in for `@atlasauth/backend`'s client that implements only
 * the methods the toolkit's tools call, records every invocation, and returns
 * fixtures WITHOUT a network. Several fixtures deliberately carry sensitive
 * fields a real response would too — `private_metadata`, `unsafe_metadata`, and
 * the one-time api-key `secret` — so tests can prove the toolkit strips them.
 */
export function createFakeBackend(): FakeBackend {
  const calls: FakeCall[] = [];
  const rec = <T>(method: string, args: unknown[], result: T): Promise<T> => {
    calls.push({ method, args });
    return Promise.resolve(result);
  };

  const user = (id: string) => ({
    object: 'user',
    id,
    first_name: 'Ada',
    last_name: 'Lovelace',
    public_metadata: { tier: 'pro' },
    // Sensitive bags a real BAPI response omits — present here to test stripping.
    private_metadata: { ssn: 'XXX-XX-1234' },
    unsafe_metadata: { note: 'client-set' },
    banned: false,
  });

  const client = {
    users: {
      get: (id: string) => rec('users.get', [id], user(id)),
      list: (params: unknown) =>
        rec('users.list', [params], {
          data: [user('user_1'), user('user_2')],
          has_more: false,
          next_cursor: null,
        }),
      create: (body: unknown) =>
        rec('users.create', [body], { ...user('user_new'), public_metadata: {} }),
      update: (id: string, body: unknown) => rec('users.update', [id, body], user(id)),
      ban: (id: string) => rec('users.ban', [id], { ...user(id), banned: true }),
      unban: (id: string) => rec('users.unban', [id], { ...user(id), banned: false }),
      delete: (id: string) => rec('users.delete', [id], { object: 'user', id, deleted: true }),
    },
    organizations: {
      get: (id: string) =>
        rec('organizations.get', [id], {
          object: 'organization',
          id,
          name: 'Acme',
          slug: 'acme',
          private_metadata: { secret_plan: 'x' },
        }),
      list: (params: unknown) =>
        rec('organizations.list', [params], {
          data: [{ object: 'organization', id: 'org_1', name: 'Acme', slug: 'acme' }],
          has_more: false,
          next_cursor: null,
        }),
      create: (body: unknown) =>
        rec('organizations.create', [body], { object: 'organization', id: 'org_new', name: 'New' }),
      update: (id: string, body: unknown) =>
        rec('organizations.update', [id, body], { object: 'organization', id, name: 'Renamed' }),
      delete: (id: string) =>
        rec('organizations.delete', [id], { object: 'organization', id, deleted: true }),
      memberships: {
        list: (orgId: string) =>
          rec('organizations.memberships.list', [orgId], {
            data: [
              { object: 'organization_membership', id: 'mem_1', user_id: 'user_1', role: 'admin' },
            ],
            has_more: false,
          }),
        add: (orgId: string, body: unknown) =>
          rec('organizations.memberships.add', [orgId, body], {
            object: 'organization_membership',
            organization_id: orgId,
            user_id: 'user_1',
            role: 'member',
          }),
        remove: (orgId: string, userId: string) =>
          rec('organizations.memberships.remove', [orgId, userId], {
            object: 'organization_membership',
            deleted: true,
          }),
        update: (orgId: string, userId: string, body: unknown) =>
          rec('organizations.memberships.update', [orgId, userId, body], {
            object: 'organization_membership',
            role: 'admin',
            updated: true,
          }),
      },
    },
    invitations: {
      list: (params: unknown) =>
        rec('invitations.list', [params], {
          data: [{ object: 'invitation', id: 'inv_1', email_address: 'a@b.com', status: 'pending' }],
          has_more: false,
          next_cursor: null,
        }),
      create: (body: unknown) =>
        rec('invitations.create', [body], {
          object: 'invitation',
          id: 'inv_new',
          email_address: 'a@b.com',
          status: 'pending',
        }),
      revoke: (id: string) =>
        rec('invitations.revoke', [id], { object: 'invitation', id, status: 'revoked' }),
    },
    sessions: {
      list: (params: unknown) =>
        rec('sessions.list', [params], {
          object: 'list',
          data: [{ object: 'session', id: 'sess_1', user_id: 'user_1', status: 'active' }],
        }),
      revoke: (id: string) =>
        rec('sessions.revoke', [id], { object: 'session', id, status: 'revoked' }),
    },
    apiKeys: {
      list: (query: unknown) =>
        rec('apiKeys.list', [query], {
          object: 'list',
          data: [{ object: 'api_key', id: 'ak_1', prefix: 'ak_live_abc', name: 'ci' }],
        }),
      create: (body: unknown) =>
        rec('apiKeys.create', [body], {
          object: 'api_key',
          id: 'ak_new',
          prefix: 'ak_live_new',
          name: 'minted',
          // The one-time plaintext secret — must never survive sanitization.
          secret: 'ak_live_SUPERSECRETVALUE',
          note: 'store this now',
        }),
      delete: (id: string) =>
        rec('apiKeys.delete', [id], { object: 'api_key', id, revoked: true }),
    },
  };

  return {
    // The fake implements only the methods under test; the cast narrows the
    // huge real surface to what the toolkit touches. `unknown` keeps it honest
    // (no `any`), and a missing method would surface as a runtime error in a
    // test rather than a silent pass.
    client: client as unknown as AtlasClient,
    calls,
    last: () => calls[calls.length - 1],
  };
}
