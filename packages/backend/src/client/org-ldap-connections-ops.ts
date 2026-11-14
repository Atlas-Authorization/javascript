import { enc, type RequestFn } from './request';



export type OrgLdapConnectionsGetSyncResult = {
  object?: 'ldap_sync_settings';
  [key: string]: unknown;
};

export type OrgLdapConnectionsSetSyncBody = {
  enabled?: boolean;
  intervalMinutes?: number;
  pageSize?: number;
  idAttribute?: string;
  userFilter?: string | null;
  groupBaseDN?: string | null;
  groupFilter?: string;
  groupMemberAttribute?: string;
  groupNameAttribute?: string;
  syncGroups?: boolean;
  roleMappings?: {
    group: string;
    role: string;
  }[];
  disableOnRemoval?: boolean;
  deltaAttribute?: string;
};

export type OrgLdapConnectionsStartSyncRunBody = {
  kind?: string;
};

export interface OrgLdapConnectionsListSyncRunsQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OrgLdapConnectionsListSyncRunsResult = {
  object?: 'list';
  data?: ({
    object?: 'ldap_sync_run';
    id?: string;
    connection_id?: string;
    organization_id?: string;
    kind?: string;
    trigger?: string;
    status?: string;
    stats?: Record<string, unknown>;
    error?: string | null;
    created_at?: number;
    started_at?: number | null;
    finished_at?: number | null;
  })[];
  has_more?: boolean;
};

export type OrgLdapConnectionsGetSyncRunResult = {
  object?: 'ldap_sync_run';
  id?: string;
  connection_id?: string;
  organization_id?: string;
  kind?: string;
  trigger?: string;
  status?: string;
  stats?: Record<string, unknown>;
  error?: string | null;
  created_at?: number;
  started_at?: number | null;
  finished_at?: number | null;
};

export type OrgLdapConnectionsGetRelayResult = {
  object?: 'ldap_relay';
  agent_id?: string | null;
};

export type OrgLdapConnectionsSetRelayBody = {
  agent_id?: string | null;
};

/** Operations on `/v1/org_ldap_connections` (7). */
export function orgLdapConnectionsOpsResource(request: RequestFn) {
  return {
    /** Read the directory-sync settings of an organization LDAP / Active Directory connection (schedule, filters, group-to-role mapping, disable-on-removal). */
    getSync(id: string): Promise<OrgLdapConnectionsGetSyncResult> {
      return request({ method: 'GET', path: `/v1/org_ldap_connections/${enc(id)}/sync` });
    },
    /** Set the directory-sync settings. Fields you omit keep their value. Enabling requires an active connection and schedules the first run immediately; disabling clears the schedule. Role mappings are matched in order, by group DN. */
    setSync(id: string, body?: OrgLdapConnectionsSetSyncBody): Promise<void> {
      return request({ method: 'PUT', path: `/v1/org_ldap_connections/${enc(id)}/sync`, body });
    },
    /** Queue a sync run now (202). `full` (default) lists the whole directory and, when disable-on-removal is on, bans users that left it; `delta` only reads entries changed since the last successful run. Refused with 409 while another run is queued or running. */
    startSyncRun(id: string, body?: OrgLdapConnectionsStartSyncRunBody, idempotencyKey?: string): Promise<void> {
      return request({ method: 'POST', path: `/v1/org_ldap_connections/${enc(id)}/sync_runs`, body, idempotencyKey });
    },
    /** The sync run log, newest first, with per-run counts (seen, created, updated, skipped, disabled, role changes, groups, errors) and any failure message. */
    listSyncRuns(id: string, query?: OrgLdapConnectionsListSyncRunsQuery): Promise<OrgLdapConnectionsListSyncRunsResult> {
      return request({ method: 'GET', path: `/v1/org_ldap_connections/${enc(id)}/sync_runs`, query: { ...query } });
    },
    /** Read one LDAP directory sync run with its counts and error. */
    getSyncRun(id: string, runId: string): Promise<OrgLdapConnectionsGetSyncRunResult> {
      return request({ method: 'GET', path: `/v1/org_ldap_connections/${enc(id)}/sync_runs/${enc(runId)}` });
    },
    /** Which relay agent an organization LDAP connection reaches its directory through, if any. */
    getRelay(id: string): Promise<OrgLdapConnectionsGetRelayResult> {
      return request({ method: 'GET', path: `/v1/org_ldap_connections/${enc(id)}/relay` });
    },
    /** Route an LDAP connection through a relay agent (agent_id), or back to a direct connection (null). The agent must be active and allow the LDAP server. */
    setRelay(id: string, body?: OrgLdapConnectionsSetRelayBody): Promise<void> {
      return request({ method: 'PUT', path: `/v1/org_ldap_connections/${enc(id)}/relay`, body });
    },
  };
}
