import { describe, expect, it } from 'vitest';
import {
  createOrganizationAuditLog,
  describeAuditAction,
  organizationAuditLogPath,
  type OrganizationAuditLogEntry,
} from './organization-audit-log';

const entry = (id: string, action = 'organization_membership.created'): OrganizationAuditLogEntry => ({
  object: 'audit_log',
  id,
  action,
  actor: { type: 'user', id: 'user_1' },
  target: { type: 'organization_membership', id: 'orgmem_1' },
  organization_id: 'org_1',
  ip: null,
  user_agent: null,
  metadata: {},
  created_at: 1_700_000_000_000,
});

type Reply = { ok: boolean; status: number; data: unknown };
function fakeClient(reply: (path: string) => Reply | Promise<Reply>) {
  const paths: string[] = [];
  return {
    paths,
    client: {
      get: async <T>(path: string) => {
        paths.push(path);
        const r = await reply(path);
        return { ...r, data: r.data as T | null, errors: [] };
      },
    },
  };
}

describe('organizationAuditLogPath / describeAuditAction', () => {
  it('builds the page URL with the cursor and the action filter', () => {
    expect(organizationAuditLogPath('org 1', { pageSize: 5, startingAfter: 'aud_9', action: 'organization.' })).toBe(
      '/v1/client/organizations/org%201/audit_logs?limit=5&starting_after=aud_9&action=organization.',
    );
    expect(organizationAuditLogPath('org_1')).toBe('/v1/client/organizations/org_1/audit_logs?limit=20');
  });
  it('turns an action into a sentence', () => {
    expect(describeAuditAction('organization_invitation.created')).toBe('Organization invitation created');
  });
});

describe('createOrganizationAuditLog', () => {
  it('loads the first page, then appends the next with the cursor', async () => {
    const { client, paths } = fakeClient((path) =>
      path.includes('starting_after')
        ? { ok: true, status: 200, data: { data: [entry('a3')], has_more: false, next_cursor: null } }
        : { ok: true, status: 200, data: { data: [entry('a1'), entry('a2')], has_more: true, next_cursor: 'a2' } },
    );
    const log = createOrganizationAuditLog(client, { pageSize: 2 });
    const seen: number[] = [];
    log.subscribe((s) => seen.push(s.entries.length));
    await log.load('org_1');
    expect(log.getState()).toMatchObject({ hasMore: true, loading: false, forbidden: false });
    await log.loadMore();
    expect(log.getState().entries.map((e) => e.id)).toEqual(['a1', 'a2', 'a3']);
    expect(log.getState().hasMore).toBe(false);
    expect(paths[1]).toContain('starting_after=a2');
    expect(seen.at(-1)).toBe(3);
  });

  it('a member who may not read it is told so (403 / 404)', async () => {
    const { client } = fakeClient(() => ({ ok: false, status: 403, data: null }));
    const log = createOrganizationAuditLog(client);
    await log.load('org_1');
    expect(log.getState()).toMatchObject({ forbidden: true, entries: [], loading: false });
  });

  it('drops a page that arrives after the organization changed', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { client } = fakeClient(async (path) => {
      if (path.includes('org_old')) await slow;
      return { ok: true, status: 200, data: { data: [entry(path.includes('org_old') ? 'old' : 'new')], has_more: false, next_cursor: null } };
    });
    const log = createOrganizationAuditLog(client);
    const first = log.load('org_old');
    await log.load('org_new');
    release();
    await first;
    expect(log.getState().entries.map((e) => e.id)).toEqual(['new']);
  });

  it('no organization: nothing is fetched', async () => {
    const { client, paths } = fakeClient(() => ({ ok: true, status: 200, data: null }));
    const log = createOrganizationAuditLog(client);
    await log.load(null);
    expect(paths).toEqual([]);
    expect(log.getState().entries).toEqual([]);
  });
});
