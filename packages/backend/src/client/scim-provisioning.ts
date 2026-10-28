import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * An OUTBOUND SCIM provisioning target — a downstream SCIM 2.0 endpoint Atlas
 * pushes its users/groups OUT to (Clerk/Auth0 "directory provisioning" parity,
 * the reverse of the inbound SCIM server). The `bearer_token` is write-only:
 * stored encrypted and never returned, so a read reports only `has_bearer_token`.
 */
export interface ScimProvisioningTarget {
  object: 'scim_provisioning_target';
  id: string;
  name: string;
  kind: ProvisioningKind;
  /** The kind's non-secret settings. */
  connector_config: Record<string, unknown>;
  /** Whether write-only credentials are stored (non-SCIM kinds) — never the values. */
  has_credentials: boolean;
  base_url: string;
  /** Whether a bearer is set — never the value. */
  has_bearer_token: boolean;
  enabled: boolean;
  attribute_mapping: Record<string, unknown>;
  deprovision_action: string;
  status: string;
  cursor: string | null;
  consecutive_failures: number;
  last_error: string | null;
  last_synced_at: number | null;
  created_at: number;
  updated_at: number;
}

export type ProvisioningKind = 'scim' | 'google_workspace' | 'microsoft_graph' | 'rest' | 'ad_writeback' | 'sql';

export interface CreateScimProvisioningTargetBody {
  name: string;
  /** Default scim. GET /v1/provisioning_connectors lists what each kind needs. */
  kind?: ProvisioningKind;
  connector_config?: Record<string, unknown>;
  /** Write-only secrets for a non-SCIM kind. */
  credentials?: Record<string, unknown>;
  /** scim and rest only. Must be an https:// URL so the bearer never travels in cleartext. */
  base_url?: string;
  /** Required for scim. Write-only; stored encrypted, never returned. */
  bearer_token?: string;
  preset?: string;
  preset_params?: Record<string, string>;
  attribute_mapping?: Record<string, unknown>;
  deprovision_action?: 'deactivate' | 'delete';
  enabled?: boolean;
}

export interface UpdateScimProvisioningTargetBody {
  name?: string;
  connector_config?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  base_url?: string;
  /** Write-only; omit to leave the stored bearer unchanged. */
  bearer_token?: string;
  attribute_mapping?: Record<string, unknown>;
  deprovision_action?: 'deactivate' | 'delete';
  enabled?: boolean;
  status?: 'active' | 'paused';
}

/** The connectivity/auth probe's outcome (GET ServiceProviderConfig; writes nothing). */
export interface ScimProvisioningTestResult {
  object: 'scim_provisioning_test_result';
  id: string;
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** The result of forcing one user's sync now. */
export interface ScimProvisioningSyncResult {
  object: 'scim_provisioning_sync_result';
  id: string;
  user_id: string;
  action: string;
  ok: boolean;
  status: number | null;
  remote_id: string | null;
  error: string | null;
}

/** The result of forcing one org's (group) sync now. */
export interface ScimProvisioningGroupSyncResult {
  object: 'scim_provisioning_group_sync_result';
  id: string;
  organization_id: string;
  action: string;
  ok: boolean;
  status: number | null;
  remote_id: string | null;
  member_count: number;
  error: string | null;
}

export interface ProvisioningPreview {
  object: 'provisioning_preview';
  user_id: string;
  attributes: Array<{ attribute: string; source: string; expression: boolean; ok: boolean; value: unknown; error: string | null }>;
  payload: Record<string, unknown>;
}
export interface ProvisioningLogEntry {
  object: 'provisioning_log_entry';
  id: string;
  resource_type: 'user' | 'group';
  resource_id: string;
  operation: string;
  ok: boolean;
  status: number | null;
  remote_id: string | null;
  error: string | null;
  created_at: number;
}
export interface ProvisioningFailure {
  object: 'provisioning_failure';
  resource_type: 'user' | 'group';
  resource_id: string;
  remote_id: string | null;
  error: string | null;
  attempts: number;
  last_attempt_at: number;
}

export function scimProvisioningResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<ScimProvisioningTarget>> {
      return request({ method: 'GET', path: '/v1/scim_provisioning_targets' });
    },
    get(id: string): Promise<ScimProvisioningTarget> {
      return request({ method: 'GET', path: `/v1/scim_provisioning_targets/${enc(id)}` });
    },
    create(
      body: CreateScimProvisioningTargetBody,
      idempotencyKey?: string,
    ): Promise<ScimProvisioningTarget> {
      return request({
        method: 'POST',
        path: '/v1/scim_provisioning_targets',
        body,
        idempotencyKey,
      });
    },
    update(
      id: string,
      body: UpdateScimProvisioningTargetBody,
    ): Promise<ScimProvisioningTarget> {
      return request({ method: 'PATCH', path: `/v1/scim_provisioning_targets/${enc(id)}`, body });
    },
    delete(
      id: string,
    ): Promise<{ object: 'scim_provisioning_target'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/scim_provisioning_targets/${enc(id)}` });
    },
    /** Probe connectivity + auth to the downstream with the real bearer. Writes nothing. */
    test(id: string): Promise<ScimProvisioningTestResult> {
      return request({ method: 'POST', path: `/v1/scim_provisioning_targets/${enc(id)}/test` });
    },
    /** Force one user's sync now (backfill / re-push), out of band from the worker. */
    syncUser(id: string, userId: string): Promise<ScimProvisioningSyncResult> {
      return request({
        method: 'POST',
        path: `/v1/scim_provisioning_targets/${enc(id)}/sync_user`,
        body: { user_id: userId },
      });
    },
    /** Force one org's (group) sync now; only already-provisioned members are sent. */
    syncGroup(id: string, organizationId: string): Promise<ScimProvisioningGroupSyncResult> {
      return request({
        method: 'POST',
        path: `/v1/scim_provisioning_targets/${enc(id)}/sync_group`,
        body: { organization_id: organizationId },
      });
    },
     /** The connector kinds, what each needs, and the expression functions. */
    connectors(): Promise<{ object: 'list'; data: Array<{ kind: ProvisioningKind; name: string; needs_relay_agent: boolean; credentials: string[]; config: string[]; hint: string }>; expression_functions: string[] }> {
      return request({ method: 'GET', path: '/v1/provisioning_connectors' });
    },
    /** Evaluate a mapping for one user without sending anything. */
    preview(body: { attribute_mapping?: Record<string, string>; lookups?: Record<string, unknown>; target_id?: string; user_id?: string; user?: Record<string, unknown> }): Promise<ProvisioningPreview> {
      return request({ method: 'POST', path: '/v1/provisioning/preview', body });
    },
    /** The target's provisioning log, newest first. */
    logs(id: string, query: { limit?: number; starting_after?: string; failures?: boolean; resource_id?: string } = {}): Promise<ListPage<ProvisioningLogEntry> & { next_cursor: string | null }> {
      const q = new URLSearchParams();
      if (query.limit) q.set('limit', String(query.limit));
      if (query.starting_after) q.set('starting_after', query.starting_after);
      if (query.failures) q.set('failures', 'true');
      if (query.resource_id) q.set('resource_id', query.resource_id);
      const qs = q.toString();
      return request({ method: 'GET', path: `/v1/scim_provisioning_targets/${enc(id)}/logs${qs ? `?${qs}` : ''}` });
    },
    /** Users and organizations whose last push failed. */
    failures(id: string): Promise<ListPage<ProvisioningFailure>> {
      return request({ method: 'GET', path: `/v1/scim_provisioning_targets/${enc(id)}/failures` });
    },
    /** Retry failed users and groups now (all, or one with resource_type + resource_id). */
    retryFailed(id: string, body: { resource_type?: 'user' | 'group'; resource_id?: string } = {}): Promise<{ object: 'provisioning_retry_result'; retried: number; succeeded: number; results: Array<{ resource_type: string; resource_id: string; ok: boolean; error: string | null }> }> {
      return request({ method: 'POST', path: `/v1/scim_provisioning_targets/${enc(id)}/retry_failed`, body });
    },
  };
}
