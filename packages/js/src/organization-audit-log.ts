import type { FapiClient } from './fapi';

/**
 * An organization's audit trail, for its admins — the framework-agnostic state
 * behind `<OrganizationAuditLog/>` in every framework SDK, so React, Vue,
 * Svelte, Solid and Angular page through `GET /v1/client/organizations/:id/
 * audit_logs` the same way.
 */

/** One entry of an organization's audit trail, as the Frontend API returns it. */
export interface OrganizationAuditLogEntry {
  object: 'audit_log';
  id: string;
  action: string;
  actor: { type: string; id: string | null };
  target: { type: string | null; id: string | null };
  organization_id: string;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
}

export interface OrganizationAuditLogOptions {
  /** Entries per page (the server caps it). Default 20. */
  pageSize?: number;
  /** Narrow to one action, or a prefix ending in `.` (`organization_membership.`). */
  action?: string;
}

export interface OrganizationAuditLogState {
  entries: OrganizationAuditLogEntry[];
  loading: boolean;
  /** The signed-in member may not read this organization's log: hide the surface. */
  forbidden: boolean;
  hasMore: boolean;
}

export interface OrganizationAuditLogController {
  getState(): OrganizationAuditLogState;
  /** Called with the new state on every change; returns the unsubscribe. */
  subscribe(listener: (state: OrganizationAuditLogState) => void): () => void;
  /** Show `organizationId`'s log from its newest entry (null clears it). */
  load(organizationId: string | null): Promise<void>;
  /** Append the next page, when there is one. */
  loadMore(): Promise<void>;
  /** Re-read the current organization's log from its newest entry. */
  reload(): Promise<void>;
}

export const EMPTY_ORGANIZATION_AUDIT_LOG: OrganizationAuditLogState = Object.freeze({
  entries: [],
  loading: false,
  forbidden: false,
  hasMore: false,
}) as OrganizationAuditLogState;

/** The Frontend API path for one page of an organization's audit log. */
export function organizationAuditLogPath(
  organizationId: string,
  options: OrganizationAuditLogOptions & { startingAfter?: string | null } = {},
): string {
  const params = new URLSearchParams({ limit: String(options.pageSize ?? 20) });
  if (options.startingAfter) params.set('starting_after', options.startingAfter);
  if (options.action) params.set('action', options.action);
  return `/v1/client/organizations/${encodeURIComponent(organizationId)}/audit_logs?${params.toString()}`;
}

/** `organization_invitation.created` → `Organization invitation created`. */
export function describeAuditAction(action: string): string {
  const text = action.replace(/[._]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Page through an organization's audit log. A response for an organization
 * that is no longer the one shown (the user switched while it was in flight)
 * is dropped, so a slow page never lands in the wrong organization's list.
 */
export function createOrganizationAuditLog(
  client: Pick<FapiClient, 'get'>,
  options: OrganizationAuditLogOptions = {},
): OrganizationAuditLogController {
  let state: OrganizationAuditLogState = EMPTY_ORGANIZATION_AUDIT_LOG;
  let organizationId: string | null = null;
  let cursor: string | null = null;
  let generation = 0;
  const listeners = new Set<(state: OrganizationAuditLogState) => void>();

  const set = (patch: Partial<OrganizationAuditLogState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };

  const fetchPage = async (after: string | null) => {
    const orgId = organizationId;
    if (!orgId) return;
    const mine = generation;
    set({ loading: true });
    try {
      const res = await client.get<{
        data: OrganizationAuditLogEntry[];
        has_more: boolean;
        next_cursor: string | null;
      }>(organizationAuditLogPath(orgId, { ...options, startingAfter: after }));
      if (mine !== generation) return;
      if (!res.ok || !res.data) {
        set({ forbidden: res.status === 403 || res.status === 404 });
        return;
      }
      const page = res.data;
      cursor = page.next_cursor;
      set({
        forbidden: false,
        entries: after ? [...state.entries, ...page.data] : page.data,
        hasMore: page.has_more,
      });
    } finally {
      if (mine === generation) set({ loading: false });
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load(next) {
      generation += 1;
      organizationId = next;
      cursor = null;
      set({ ...EMPTY_ORGANIZATION_AUDIT_LOG });
      await fetchPage(null);
    },
    async loadMore() {
      if (cursor && !state.loading) await fetchPage(cursor);
    },
    async reload() {
      generation += 1;
      cursor = null;
      await fetchPage(null);
    },
  };
}
