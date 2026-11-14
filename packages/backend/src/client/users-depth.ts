import { enc, type RequestFn } from './request';

/** What a bulk user action does. Parameters per action are in `BulkUserActionParams`. */
export type BulkUserAction = 'ban' | 'unban' | 'revoke_sessions' | 'add_to_org' | 'set_metadata' | 'delete' | 'require_action';

export interface BulkUserActionParams {
  /** ban */
  reason?: string;
  note?: string;
  expires_in_seconds?: number;
  expires_at?: number;
  /** add_to_org */
  organization_id?: string;
  role?: string;
  /** set_metadata: keys to set; a null value removes the key. */
  public_metadata?: Record<string, unknown>;
  unsafe_metadata?: Record<string, unknown>;
  private_metadata?: Record<string, unknown>;
  /** require_action */
  action?: string;
  url?: string;
}

/** Who the action applies to: a search (filter / query / segment_id) or a list of ids, never both. */
export interface BulkUserActionBody {
  action: BulkUserAction;
  params?: BulkUserActionParams;
  filter?: Record<string, unknown>;
  query?: string;
  segment_id?: string;
  user_ids?: string[];
  include_deleted?: boolean;
  dry_run?: boolean;
  /** The count a dry run reported; required for `delete`. */
  expected_count?: number;
}

export interface BulkUserActionPreview {
  object: 'bulk_user_action_preview';
  dry_run: true;
  action: BulkUserAction;
  matched: number;
  will_skip_at_most: number;
  skip_reasons: Record<string, number>;
  sample_user_ids: string[];
}

export interface BulkUserActionJob {
  object: 'bulk_user_action';
  id: string;
  action: BulkUserAction;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  progress: number;
  errors: Array<{ user_id: string; code: string; message: string }>;
  cancel_requested: boolean;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface LegalHold {
  object: 'legal_hold';
  id: string;
  user_id: string;
  reason: string;
  case_ref: string | null;
  placed_by: string | null;
  placed_at: number;
  released_at: number | null;
  released_by: string | null;
  release_reason: string | null;
  active: boolean;
}

export interface DeletionReceipt {
  object: 'deletion_receipt';
  id: string;
  request_id: string;
  subject_id: string;
  issued_at: number;
  /** A compact JWS (typ `atlas-deletion-receipt+jwt`). Verify it with the keys at `jwks_uri`. */
  receipt: string;
  claims: Record<string, unknown>;
  kid: string;
  jwks_uri: string;
}

export type InstanceExportSection = 'config' | 'roles' | 'organizations' | 'users' | 'memberships' | 'keys' | 'connections' | 'webhooks';

export interface InstanceExportJob {
  object: 'instance_export';
  id: string;
  kind: 'export' | 'import';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'expired';
  sections: InstanceExportSection[];
  counts: Record<string, unknown>;
  progress: Record<string, unknown>;
  errors: Array<{ section: string; ref: string | null; code: string; message: string }>;
  bundle_sha256: string | null;
  bundle_bytes: number | null;
  signature: string | null;
  signature_kid: string | null;
  downloadable: boolean;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  completed_at: number | null;
}

type Page<T> = { object: 'list'; data: T[]; has_more: boolean; next_cursor?: string | null };

/** Bulk user actions, legal holds, deletion receipts and deadlines, ownership hand-over and tenant export / import. */
export function usersDepthResource(request: RequestFn) {
  return {
    bulkActions: {
      /** `POST /v1/users/bulk_actions` with `dry_run: true`: counts only, nothing changes. */
      preview(body: Omit<BulkUserActionBody, 'dry_run'>): Promise<BulkUserActionPreview> {
        return request({ method: 'POST', path: '/v1/users/bulk_actions', body: { ...body, dry_run: true } });
      },
      /** `POST /v1/users/bulk_actions` — start the job (202). */
      start(body: Omit<BulkUserActionBody, 'dry_run'>, idempotencyKey?: string): Promise<BulkUserActionJob> {
        return request({ method: 'POST', path: '/v1/users/bulk_actions', body, idempotencyKey });
      },
      list(params: { limit?: number; starting_after?: string; status?: BulkUserActionJob['status'] } = {}): Promise<Page<BulkUserActionJob>> {
        return request({ method: 'GET', path: '/v1/users/bulk_actions', query: { ...params } });
      },
      get(id: string): Promise<BulkUserActionJob> {
        return request({ method: 'GET', path: `/v1/users/bulk_actions/${enc(id)}` });
      },
      /** Stop after the chunk in hand. */
      cancel(id: string): Promise<BulkUserActionJob> {
        return request({ method: 'POST', path: `/v1/users/bulk_actions/${enc(id)}/cancel` });
      },
      /** Poll until the job is no longer pending or processing. */
      async wait(id: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<BulkUserActionJob> {
        const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
        for (;;) {
          const job = await request<BulkUserActionJob>({ method: 'GET', path: `/v1/users/bulk_actions/${enc(id)}` });
          if (job.status !== 'pending' && job.status !== 'processing') return job;
          if (Date.now() > deadline) throw new Error(`Bulk action ${id} did not finish in time (status ${job.status}).`);
          await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
        }
      },
    },
    legalHolds: {
      /** `GET /v1/legal_holds` — every active hold. */
      list(params: { limit?: number; starting_after?: string } = {}): Promise<Page<LegalHold>> {
        return request({ method: 'GET', path: '/v1/legal_holds', query: { ...params } });
      },
      /** `GET /v1/users/:id/legal_hold` */
      get(userId: string): Promise<{ object: 'legal_hold_status'; user_id: string; on_hold: boolean; active: LegalHold | null; history: LegalHold[] }> {
        return request({ method: 'GET', path: `/v1/users/${enc(userId)}/legal_hold` });
      },
      /** `POST /v1/users/:id/legal_hold` — no deletion path erases the user until it is released. */
      place(userId: string, body: { reason: string; case_ref?: string | null }, idempotencyKey?: string): Promise<LegalHold> {
        return request({ method: 'POST', path: `/v1/users/${enc(userId)}/legal_hold`, body, idempotencyKey });
      },
      release(userId: string, body: { reason?: string | null } = {}, idempotencyKey?: string): Promise<LegalHold> {
        return request({ method: 'POST', path: `/v1/users/${enc(userId)}/legal_hold/release`, body, idempotencyKey });
      },
    },
    /** `GET /v1/users/:id/owned_organizations` — organizations the user alone administers (what deleting them would orphan). */
    ownedOrganizations(userId: string): Promise<Page<{ object: 'owned_organization'; id: string; name: string; slug: string; other_members: number }>> {
      return request({ method: 'GET', path: `/v1/users/${enc(userId)}/owned_organizations` });
    },
    deletedAddresses: {
      /** `POST /v1/users/deleted_addresses` — remember addresses of accounts deleted elsewhere (up to 5000 per call). */
      import(addresses: string[], idempotencyKey?: string): Promise<{ object: 'deleted_address_import'; received: number; added: number; already_remembered: number; invalid: number; invalid_indexes: number[] }> {
        return request({ method: 'POST', path: '/v1/users/deleted_addresses', body: { addresses }, idempotencyKey });
      },
      check(address: string): Promise<{ object: 'deleted_address_check'; remembered: boolean }> {
        return request({ method: 'POST', path: '/v1/users/deleted_addresses/check', body: { address } });
      },
    },
    instanceExports: {
      /** `POST /v1/instance/exports` — start a whole-instance export (202). */
      create(body: { sections?: InstanceExportSection[]; expires_in_hours?: number } = {}, idempotencyKey?: string): Promise<InstanceExportJob> {
        return request({ method: 'POST', path: '/v1/instance/exports', body, idempotencyKey });
      },
      list(params: { limit?: number; starting_after?: string } = {}): Promise<Page<InstanceExportJob>> {
        return request({ method: 'GET', path: '/v1/instance/exports', query: { ...params } });
      },
      get(id: string): Promise<InstanceExportJob> {
        return request({ method: 'GET', path: `/v1/instance/exports/${enc(id)}` });
      },
      /** `GET /v1/instance/exports/:id/bundle` — the bundle as text (canonical JSON); its SHA-256 is `bundle_sha256`. */
      bundle(id: string): Promise<string> {
        return request({ method: 'GET', path: `/v1/instance/exports/${enc(id)}/bundle`, raw: true });
      },
      /** A signed link to the bundle, good for 15 minutes without a key. */
      downloadUrl(id: string): Promise<{ object: 'instance_export_download'; url: string; expires_at: number }> {
        return request({ method: 'POST', path: `/v1/instance/exports/${enc(id)}/download_url` });
      },
      /** Invalidate every signed link handed out for this export. */
      revokeLinks(id: string): Promise<InstanceExportJob> {
        return request({ method: 'POST', path: `/v1/instance/exports/${enc(id)}/revoke_links` });
      },
    },
    instanceImports: {
      /** `POST /v1/instance/imports` — load a bundle into this instance (202). */
      create(body: { bundle: unknown; sha256?: string; sections?: InstanceExportSection[]; config_mode?: 'merge' | 'skip' }, idempotencyKey?: string): Promise<InstanceExportJob> {
        return request({ method: 'POST', path: '/v1/instance/imports', body, idempotencyKey });
      },
      list(params: { limit?: number; starting_after?: string } = {}): Promise<Page<InstanceExportJob>> {
        return request({ method: 'GET', path: '/v1/instance/imports', query: { ...params } });
      },
      get(id: string): Promise<InstanceExportJob> {
        return request({ method: 'GET', path: `/v1/instance/imports/${enc(id)}` });
      },
    },
  };
}
