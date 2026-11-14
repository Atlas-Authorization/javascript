/**
 * A local mirror of resource-scoped role assignments, so `can(user, permission,
 * resource)` is answered with no network call and the SAME inheritance rules as
 * `POST /v1/resource_checks`.
 *
 * What it keeps: the resource types (roles, `includes`, `inherit`), the resource
 * tree (type, external id, parent) and the role assignments. `sync()` pulls the
 * types and the tree, then consumes `GET /v1/resource_role_assignments/changes`
 * from the stored cursor (created, updated and deleted assignments, including those
 * that ended with their resource or type). `applyWebhook()` applies the
 * `resource_role_assignment.created` / `.deleted` events between syncs.
 *
 * One difference from the server: Atlas adds the user's organizations and groups to
 * the subject itself. Offline you pass them: `can(user, perm, res, { orgs, groups })`.
 *
 * The evaluation below is a line-for-line port of the server resolver (`rolePermissions`
 * and `resolveResourceGrants`); the server repository's tests run both against the same
 * trees and compare the answers.
 */
import type { ListPage } from './client/types';
import type { Resource, ResourceRoleAssignmentChange, ResourceRoleDef, ResourceType } from './client/resources';

export type MirrorSubject = { type: 'user' | 'group' | 'org'; id: string };
/** A resource reference: Atlas `id`, or your own `type` + `external_id`. */
export type MirrorResourceRef = { id: string } | { type: string; external_id: string };

export interface MirroredResourceType {
  key: string;
  inherit: boolean;
  roles: ResourceRoleDef[];
}

export interface MirroredResource {
  id: string;
  type: string;
  external_id: string;
  parent_id: string | null;
}

export interface MirroredAssignment {
  id: string;
  resource_id: string;
  /** `user:usr_1`, `group:eng`, `org:org_1`. */
  subject: string;
  role: string;
  inherit: boolean;
}

export interface ResourceRoleMirrorStore {
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
  getType(key: string): Promise<MirroredResourceType | null>;
  getResource(ref: MirrorResourceRef): Promise<MirroredResource | null>;
  /** Every assignment sitting on any of these resources. */
  assignmentsOn(resourceIds: string[]): Promise<MirroredAssignment[]>;
  /** Replace the whole type registry. */
  replaceTypes(types: MirroredResourceType[]): Promise<void>;
  /** Replace the whole resource tree. */
  replaceResources(resources: MirroredResource[]): Promise<void>;
  /** `created` upserts by assignment id; `deleted` removes it. */
  applyChanges(changes: Array<{ change: 'created' | 'deleted'; assignment: MirroredAssignment }>): Promise<void>;
  /** Epoch ms of the last completed `sync()` (null = never). Optional: without it the mirror keeps it in memory. */
  getLastSyncAt?(): Promise<number | null>;
  setLastSyncAt?(at: number): Promise<void>;
}

/** An in-memory store, for tests and single-process apps. */
export function memoryResourceRoleMirrorStore(): ResourceRoleMirrorStore & {
  assignments: Map<string, MirroredAssignment>;
  resources: Map<string, MirroredResource>;
  types: Map<string, MirroredResourceType>;
} {
  const assignments = new Map<string, MirroredAssignment>();
  let resources = new Map<string, MirroredResource>();
  let types = new Map<string, MirroredResourceType>();
  let cursor: string | null = null;
  let lastSyncAt: number | null = null;
  return {
    assignments,
    get resources() {
      return resources;
    },
    get types() {
      return types;
    },
    async getCursor() {
      return cursor;
    },
    async setCursor(c) {
      cursor = c;
    },
    async getType(key) {
      return types.get(key) ?? null;
    },
    async getResource(ref) {
      if ('id' in ref) return resources.get(ref.id) ?? null;
      for (const r of resources.values()) if (r.type === ref.type && r.external_id === ref.external_id) return r;
      return null;
    },
    async assignmentsOn(ids) {
      const want = new Set(ids);
      return [...assignments.values()].filter((a) => want.has(a.resource_id));
    },
    async replaceTypes(next) {
      types = new Map(next.map((t) => [t.key, t]));
    },
    async replaceResources(next) {
      resources = new Map(next.map((r) => [r.id, r]));
    },
    async applyChanges(changes) {
      for (const c of changes) {
        if (c.change === 'deleted') assignments.delete(c.assignment.id);
        else assignments.set(c.assignment.id, c.assignment);
      }
    },
    async getLastSyncAt() {
      return lastSyncAt;
    },
    async setLastSyncAt(at) {
      lastSyncAt = at;
    },
  };
}

type Api = {
  types: { list(): Promise<ListPage<ResourceType>> };
  list(query?: { limit?: number; starting_after?: string }): Promise<ListPage<Resource> & { next_cursor?: string | null }>;
  assignments: { changes(query?: { after?: string; limit?: number }): Promise<ListPage<ResourceRoleAssignmentChange> & { next_cursor: string }> };
};

export interface ResourceRoleMirrorOptions {
  store: ResourceRoleMirrorStore;
  /** `createAtlasClient(...).resources`. */
  resources: Api;
  /**
   * When set, `check` / `can` answer "not allowed" (`code: 'stale'`) if the mirror has
   * never completed a `sync()` or the last one finished longer ago than this, because a
   * revoked assignment may not have reached it. Unset turns the check off (webhook-only mirrors).
   */
  maxStalenessMs?: number;
  /**
   * Keep answering from the last synced data for this many extra milliseconds after `maxStalenessMs` has passed, instead
   * of refusing with `code: 'stale'` at once. An answer inside the grace carries `stale: true` and fires
   * `onServeStale`. A role revoked at Atlas during the grace is not seen until the next `sync()`. Default 0: refuse
   * as soon as the mirror is stale. Needs `maxStalenessMs`.
   */
  serveStaleForMs?: number;
  /** Called (not awaited) each time an answer is served inside the `serveStaleForMs` grace. */
  onServeStale?: (info: { lastSyncAt: number | null; staleForMs: number }) => void;
  /** Re-pull the types and the resource tree on a `sync()` only when this long has passed since the last pull (default 0 = every sync). */
  treeRefreshMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface ResourceRoleCheckOptions {
  /** Organization ids the user belongs to (the server adds these itself). */
  orgs?: string[];
  /** Group ids / slugs the subject belongs to (the server adds the instance groups itself). */
  groups?: string[];
}

export interface ResourceRoleMirrorCheck {
  allowed: boolean;
  resource_id: string | null;
  grants: Array<{ resource_id: string; role: string; subject: string; inherited: boolean }>;
  /** `unknown_resource`: the mirror does not hold that resource. `stale`: see `maxStalenessMs`. */
  code?: 'unknown_resource' | 'stale';
  /** True when the mirror was past `maxStalenessMs` and this answer came from its last synced data (see `serveStaleForMs`). */
  stale?: true;
}

// Same cap as the server's ancestor walk.
const MAX_DEPTH = 16;

/** All permissions a role grants, following `includes` (cycle-safe). `*` means every permission. */
function rolePermissions(type: MirroredResourceType, roleKey: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(roleKey)) return out;
  seen.add(roleKey);
  const role = type.roles.find((r) => r.key === roleKey);
  if (!role) return out;
  for (const p of role.permissions) out.add(p);
  for (const inc of role.includes ?? []) for (const p of rolePermissions(type, inc, seen)) out.add(p);
  return out;
}

/** The server's `resolveResourceGrants`, over a chain of (resource, type, assignments), resource first. */
export function resolveMirrorGrants(
  chain: Array<{ resourceId: string; type: MirroredResourceType; assignments: Array<{ subject: string; roleKey: string; inherit: boolean }> }>,
  subjects: Iterable<string>,
  permission: string,
): Array<{ resourceId: string; role: string; subject: string; inherited: boolean }> {
  const held = new Set(subjects);
  const grants: Array<{ resourceId: string; role: string; subject: string; inherited: boolean }> = [];
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i]!;
    for (const a of link.assignments) {
      if (!held.has(a.subject) || (i > 0 && !a.inherit)) continue;
      const perms = rolePermissions(link.type, a.roleKey);
      if (perms.has(permission) || perms.has('*')) grants.push({ resourceId: link.resourceId, role: a.roleKey, subject: a.subject, inherited: i > 0 });
    }
    // The next link up is only reachable when this resource's type inherits.
    if (!link.type.inherit) break;
  }
  return grants;
}

const toAssignment = (c: ResourceRoleAssignmentChange): MirroredAssignment => ({
  id: c.assignment_id,
  resource_id: c.resource_id,
  subject: `${c.subject.type}:${c.subject.id}`,
  role: c.role,
  inherit: c.inherit,
});

export function createResourceRoleMirror(options: ResourceRoleMirrorOptions) {
  const { store, resources: api } = options;
  const now = options.now ?? Date.now;
  let memorySyncAt: number | null = null;
  let treeAt: number | null = null;
  const readSyncAt = async () => (store.getLastSyncAt ? await store.getLastSyncAt() : memorySyncAt);

  async function chainOf(resource: MirroredResource) {
    // The resource, then its ancestors (cycle-safe, depth-capped), exactly like the server.
    // Same walk as the server's ancestorsOf: the ancestors dedupe among themselves only,
    // so a cycle yields the start resource once more, exactly as the server's chain does.
    const ancestors: MirroredResource[] = [];
    let id = resource.parent_id;
    for (let i = 0; i < MAX_DEPTH && id; i++) {
      const row = await store.getResource({ id });
      if (!row || ancestors.some((r) => r.id === row.id)) break;
      ancestors.push(row);
      id = row.parent_id;
    }
    const rows = [resource, ...ancestors];
    const assignments = await store.assignmentsOn(rows.map((r) => r.id));
    return Promise.all(
      rows.map(async (r) => {
        const t = await store.getType(r.type);
        return {
          resourceId: r.id,
          type: { key: r.type, inherit: t?.inherit ?? true, roles: t?.roles ?? [] },
          assignments: assignments.filter((a) => a.resource_id === r.id).map((a) => ({ subject: a.subject, roleKey: a.role, inherit: a.inherit })),
        };
      }),
    );
  }

  async function check(subject: MirrorSubject, permission: string, resource: MirrorResourceRef, opts: ResourceRoleCheckOptions = {}): Promise<ResourceRoleMirrorCheck> {
    let servedStale = false;
    if (options.maxStalenessMs !== undefined) {
      const at = await readSyncAt();
      const behind = at === null ? Infinity : now() - at - options.maxStalenessMs;
      if (behind > 0) {
        if (at === null || behind > (options.serveStaleForMs ?? 0)) return { allowed: false, resource_id: null, grants: [], code: 'stale' };
        servedStale = true;
        options.onServeStale?.({ lastSyncAt: at, staleForMs: behind });
      }
    }
    const row = await store.getResource(resource);
    if (!row || typeof permission !== 'string' || !permission) return { allowed: false, resource_id: row?.id ?? null, grants: [], code: row ? undefined : 'unknown_resource' };
    const subjects = new Set([`${subject.type}:${subject.id}`]);
    for (const g of opts.groups ?? []) subjects.add(`group:${g}`);
    for (const o of opts.orgs ?? []) subjects.add(`org:${o}`);
    const grants = resolveMirrorGrants(await chainOf(row), subjects, permission);
    return {
      allowed: grants.length > 0,
      resource_id: row.id,
      grants: grants.map((g) => ({ resource_id: g.resourceId, role: g.role, subject: g.subject, inherited: g.inherited })),
      ...(servedStale ? { stale: true as const } : {}),
    };
  }

  return {
    /** The verdict and the grants behind it, in the shape of `POST /v1/resource_checks`. */
    check,

    /** May `subject` hold `permission` on `resource`? Answered locally. */
    async can(subject: MirrorSubject, permission: string, resource: MirrorResourceRef, opts?: ResourceRoleCheckOptions): Promise<boolean> {
      return (await check(subject, permission, resource, opts)).allowed;
    },

    /** Epoch ms of the last completed `sync()`; null = never. */
    lastSyncAt: readSyncAt,

    /**
     * Pull the types and the resource tree (when `treeRefreshMs` has passed), then
     * consume the assignment change feed from the stored cursor. Call it on a timer
     * (every few seconds to a minute) and at startup. Returns how many changes it applied.
     */
    async sync(): Promise<{ applied: number }> {
      if (treeAt === null || now() - treeAt >= (options.treeRefreshMs ?? 0)) {
        // Tree first: an assignment the feed then delivers never names a resource this mirror lacks.
        const types = (await api.types.list()).data.map((t) => ({ key: t.key, inherit: t.inherit, roles: t.roles }));
        const tree: MirroredResource[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await api.list({ limit: 1000, ...(cursor ? { starting_after: cursor } : {}) });
          for (const r of page.data) tree.push({ id: r.id, type: r.type, external_id: r.external_id, parent_id: r.parent_id });
          if (!page.has_more || !page.next_cursor) break;
          cursor = page.next_cursor;
        }
        await store.replaceTypes(types);
        await store.replaceResources(tree);
        treeAt = now();
      }
      let after = (await store.getCursor()) ?? undefined;
      let applied = 0;
      for (;;) {
        const page = await api.assignments.changes({ ...(after ? { after } : {}), limit: 500 });
        await store.applyChanges(page.data.map((c) => ({ change: c.change, assignment: toAssignment(c) })));
        applied += page.data.length;
        if (page.next_cursor) {
          after = page.next_cursor;
          await store.setCursor(after);
        }
        if (!page.has_more) {
          memorySyncAt = now();
          await store.setLastSyncAt?.(memorySyncAt);
          return { applied };
        }
      }
    },

    /**
     * Apply a VERIFIED `resource_role_assignment.created` / `.deleted` webhook (check the
     * signature first, e.g. with `verifyWebhook`). Returns whether the event changed the mirror.
     */
    async applyWebhook(event: { type: string; data: unknown }): Promise<boolean> {
      if (!event || (event.type !== 'resource_role_assignment.created' && event.type !== 'resource_role_assignment.deleted')) return false;
      const d = event.data as {
        id?: unknown;
        resource_id?: unknown;
        subject?: { type?: unknown; id?: unknown };
        role?: unknown;
        inherit?: unknown;
      } | null;
      if (!d || typeof d.id !== 'string' || typeof d.resource_id !== 'string' || typeof d.role !== 'string' || typeof d.subject?.type !== 'string' || typeof d.subject.id !== 'string') return false;
      await store.applyChanges([
        {
          change: event.type === 'resource_role_assignment.created' ? 'created' : 'deleted',
          assignment: { id: d.id, resource_id: d.resource_id, subject: `${d.subject.type}:${d.subject.id}`, role: d.role, inherit: d.inherit !== false },
        },
      ]);
      return true;
    },
  };
}

export type ResourceRoleMirror = ReturnType<typeof createResourceRoleMirror>;
