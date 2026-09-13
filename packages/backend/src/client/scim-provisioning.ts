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

export interface CreateScimProvisioningTargetBody {
  name: string;
  /** Must be an https:// URL so the bearer never travels in cleartext. */
  base_url: string;
  /** Write-only; stored encrypted, never returned. */
  bearer_token: string;
  attribute_mapping?: Record<string, unknown>;
  deprovision_action?: 'deactivate' | 'delete';
  enabled?: boolean;
}

export interface UpdateScimProvisioningTargetBody {
  name?: string;
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
  };
}
