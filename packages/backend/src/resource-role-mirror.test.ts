import { describe, expect, it, vi } from 'vitest';
import { createResourceRoleMirror, memoryResourceRoleMirrorStore } from './resource-role-mirror';
import type { ResourceRoleAssignmentChange } from './client/resources';

const ROLES = [
  { key: 'viewer', permissions: ['read'] },
  { key: 'editor', permissions: ['write'], includes: ['viewer'] },
  { key: 'owner', permissions: ['*'] },
];

const change = (seq: number, kind: 'created' | 'deleted', id: string, resource: { id: string; type: string; ext: string }, subject: string, role: string, inherit = true): ResourceRoleAssignmentChange => ({
  object: 'resource_role_assignment_change',
  seq,
  change: kind,
  assignment_id: id,
  resource_id: resource.id,
  resource_type: resource.type,
  resource_external_id: resource.ext,
  subject: { type: subject.split(':')[0] as 'user', id: subject.split(':')[1]! },
  role,
  inherit,
  created_at: 1,
});

const F1 = { id: 'res_f1', type: 'folder', ext: 'f1' };
const D1 = { id: 'res_d1', type: 'doc', ext: 'd1' };

function fakeAtlas(feed: ResourceRoleAssignmentChange[]) {
  return {
    types: {
      list: vi.fn(async () => ({
        object: 'list' as const,
        data: [
          { object: 'resource_type' as const, key: 'folder', name: 'f', description: null, parent_type: null, inherit: true, roles: ROLES, created_at: 1, updated_at: 1 },
          { object: 'resource_type' as const, key: 'doc', name: 'd', description: null, parent_type: 'folder', inherit: true, roles: ROLES, created_at: 1, updated_at: 1 },
        ],
      })),
    },
    list: vi.fn(async (q: { starting_after?: string } = {}) => {
      const all = [
        { object: 'resource' as const, id: F1.id, type: 'folder', external_id: 'f1', name: null, parent_id: null, metadata: {}, created_at: 1, updated_at: 1 },
        { object: 'resource' as const, id: D1.id, type: 'doc', external_id: 'd1', name: null, parent_id: F1.id, metadata: {}, created_at: 1, updated_at: 1 },
      ];
      // Two pages of one, to exercise the cursor.
      return q.starting_after ? { object: 'list' as const, data: all.slice(1), has_more: false, next_cursor: null } : { object: 'list' as const, data: all.slice(0, 1), has_more: true, next_cursor: 'c1' };
    }),
    assignments: {
      changes: vi.fn(async (q: { after?: string; limit?: number } = {}) => {
        const from = q.after ? Number(q.after) : 0;
        const page = feed.filter((c) => c.seq > from).slice(0, 2);
        const last = page[page.length - 1];
        return { object: 'list' as const, data: page, has_more: feed.filter((c) => c.seq > from).length > 2, next_cursor: String(last?.seq ?? from) };
      }),
    },
  };
}

describe('createResourceRoleMirror', () => {
  it('syncs types, the tree and the feed, then answers can() locally with inheritance', async () => {
    const api = fakeAtlas([
      change(1, 'created', 'a1', F1, 'user:alice', 'editor'),
      change(2, 'created', 'a2', F1, 'group:eng', 'viewer', false),
      change(3, 'created', 'a3', D1, 'user:bob', 'owner'),
    ]);
    const mirror = createResourceRoleMirror({ store: memoryResourceRoleMirrorStore(), resources: api });
    expect(await mirror.sync()).toEqual({ applied: 3 });

    const alice = { type: 'user' as const, id: 'alice' };
    // Inherited from the folder through the doc's parent.
    expect(await mirror.can(alice, 'read', { type: 'doc', external_id: 'd1' })).toBe(true);
    expect(await mirror.can(alice, 'delete', { type: 'doc', external_id: 'd1' })).toBe(false);
    const checked = await mirror.check(alice, 'write', { id: D1.id });
    expect(checked.grants).toEqual([{ resource_id: F1.id, role: 'editor', subject: 'user:alice', inherited: true }]);
    // An assignment that does not inherit stays on its own resource.
    expect(await mirror.can({ type: 'user', id: 'carol' }, 'read', { id: D1.id }, { groups: ['eng'] })).toBe(false);
    expect(await mirror.can({ type: 'user', id: 'carol' }, 'read', { id: F1.id }, { groups: ['eng'] })).toBe(true);
    // The org the server would add itself is passed offline.
    expect(await mirror.can({ type: 'user', id: 'dave' }, 'read', { id: F1.id }, { orgs: ['o1'] })).toBe(false);
    expect(await mirror.can({ type: 'user', id: 'bob' }, 'anything', { id: D1.id })).toBe(true);
    // An unknown resource fails closed.
    expect(await mirror.check(alice, 'read', { type: 'doc', external_id: 'nope' })).toMatchObject({ allowed: false, code: 'unknown_resource' });
  });

  it('applies deletions from the feed and from webhooks, and resumes from the stored cursor', async () => {
    const feed = [change(1, 'created', 'a1', F1, 'user:alice', 'viewer')];
    const api = fakeAtlas(feed);
    const store = memoryResourceRoleMirrorStore();
    const mirror = createResourceRoleMirror({ store, resources: api });
    await mirror.sync();
    expect(await mirror.can({ type: 'user', id: 'alice' }, 'read', { id: F1.id })).toBe(true);

    feed.push(change(2, 'deleted', 'a1', F1, 'user:alice', 'viewer'));
    expect(await mirror.sync()).toEqual({ applied: 1 });
    expect(api.assignments.changes).toHaveBeenLastCalledWith({ after: '1', limit: 500 });
    expect(await mirror.can({ type: 'user', id: 'alice' }, 'read', { id: F1.id })).toBe(false);

    expect(
      await mirror.applyWebhook({
        type: 'resource_role_assignment.created',
        data: { id: 'a9', resource_id: F1.id, subject: { type: 'user', id: 'erin' }, role: 'owner', inherit: true },
      }),
    ).toBe(true);
    expect(await mirror.can({ type: 'user', id: 'erin' }, 'delete', { id: F1.id })).toBe(true);
    await mirror.applyWebhook({ type: 'resource_role_assignment.deleted', data: { id: 'a9', resource_id: F1.id, subject: { type: 'user', id: 'erin' }, role: 'owner', inherit: true } });
    expect(await mirror.can({ type: 'user', id: 'erin' }, 'delete', { id: F1.id })).toBe(false);
    expect(await mirror.applyWebhook({ type: 'user.created', data: {} })).toBe(false);
  });

  it('answers stale instead of guessing when the last sync is too old', async () => {
    let t = 1_000;
    const mirror = createResourceRoleMirror({ store: memoryResourceRoleMirrorStore(), resources: fakeAtlas([]), maxStalenessMs: 100, now: () => t });
    expect(await mirror.check({ type: 'user', id: 'a' }, 'read', { id: F1.id })).toMatchObject({ allowed: false, code: 'stale' });
    await mirror.sync();
    expect((await mirror.check({ type: 'user', id: 'a' }, 'read', { id: F1.id })).code).toBeUndefined();
    t += 500;
    expect(await mirror.can({ type: 'user', id: 'a' }, 'read', { id: F1.id })).toBe(false);
    expect((await mirror.check({ type: 'user', id: 'a' }, 'read', { id: F1.id })).code).toBe('stale');
  });
});
