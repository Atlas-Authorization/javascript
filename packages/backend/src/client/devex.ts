import { enc, type RequestFn } from './request';

type Page<T> = { object: 'list'; data: T[]; has_more: boolean; next_cursor?: string | null };

export type ConfigSnapshotSource = 'manual' | 'auto' | 'pre_restore' | 'cli' | 'clone';

/** A saved copy of the instance's configuration. Secrets are never in it. */
export interface ConfigSnapshot {
  object: 'config_snapshot';
  id: string;
  /** 1, 2, 3 ... per instance. */
  version: number;
  label: string | null;
  source: ConfigSnapshotSource;
  /** Two snapshots with the same digest are identical. */
  sha256: string;
  /** Where a secret was removed. */
  redacted_paths: string[];
  created_by: string | null;
  created_at: number;
  /** Only on `configSnapshots.get`. */
  auth_config?: Record<string, unknown>;
  /** Only on `configSnapshots.get`. */
  allowed_origins?: string[];
}

export interface ConfigChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface ConfigSnapshotDiff {
  object: 'config_snapshot_diff';
  from: string;
  to: string;
  changes: ConfigChange[];
  allowed_origins: { before: string[]; after: string[] } | null;
  unchanged: boolean;
}

export interface ConfigSnapshotRestore {
  object: 'config_snapshot_restore';
  snapshot_id: string;
  version: number;
  dry_run: boolean;
  applied: boolean;
  /** Send back as `expected_sha256` to apply exactly what a dry run showed. */
  current_sha256: string;
  changes: ConfigChange[];
  allowed_origins_changed: boolean;
}

export type CloneSection = 'config' | 'roles' | 'organizations' | 'users' | 'memberships';

export interface CreateInstanceCloneBody {
  mode: 'clone' | 'preview';
  /** mode `clone` only: the new environment's name. */
  name?: string;
  /** A stable handle (a pull request number). Required for a preview; one live clone per ref. */
  ref?: string;
  /** Default `['config', 'roles']`. `memberships` needs `users` and `organizations`. */
  include?: CloneSection[];
  /** Default true: replace user emails with unreachable ones, drop phones and linked identities. */
  mask_emails?: boolean;
  /** mode `preview` only: hours until it is deleted (default 72, at most 720). */
  ttl_hours?: number;
  /** The origins the new instance accepts, e.g. the preview URL. */
  allowed_origins?: string[];
  /** With an existing ref: re-apply the source's configuration and restart a preview's clock. */
  refresh?: boolean;
  secret_key_preset?: 'app-runtime' | 'full';
}

export interface InstanceClone {
  object: 'instance_clone';
  id: string;
  kind: 'clone' | 'preview';
  name: string;
  ref: string | null;
  status: 'pending' | 'completed' | 'failed' | 'deleted';
  source_instance_id: string;
  /** The new instance. */
  instance_id: string | null;
  environment: 'development';
  publishable_key: string | null;
  frontend_api_host: string | null;
  allowed_origins: string[];
  include: string[];
  mask_emails: boolean;
  counts: Record<string, unknown>;
  errors: Array<Record<string, unknown>>;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  completed_at: number | null;
  deleted_at: number | null;
}

/** A new clone also carries the new instance's first secret key, shown once. */
export interface InstanceCloneCreated extends InstanceClone {
  secret: string | null;
  secret_key_scopes?: string[];
  replayed?: boolean;
  note?: string;
}

/** Config time travel on the instance client: save, list, diff and restore configuration snapshots. */
export function configSnapshotsResource(request: RequestFn) {
  return {
    /** `POST /v1/instance/config_snapshots` — save the configuration as it is now. */
    create(body: { label?: string } = {}, idempotencyKey?: string): Promise<ConfigSnapshot> {
      return request({ method: 'POST', path: '/v1/instance/config_snapshots', body, idempotencyKey });
    },
    list(params: { limit?: number; starting_after?: string; source?: ConfigSnapshotSource } = {}): Promise<Page<ConfigSnapshot>> {
      return request({ method: 'GET', path: '/v1/instance/config_snapshots', query: { ...params } });
    },
    /** One snapshot with its configuration. */
    get(id: string): Promise<ConfigSnapshot> {
      return request({ method: 'GET', path: `/v1/instance/config_snapshots/${enc(id)}` });
    },
    /** What changed from `from` to `to` (snapshot ids, or `current` for the live configuration; `to` defaults to current). */
    diff(params: { from: string; to?: string }): Promise<ConfigSnapshotDiff> {
      return request({ method: 'GET', path: '/v1/instance/config_snapshots/diff', query: { ...params } });
    },
    /** Put a snapshot back. `dry_run: true` previews. The replaced state is saved first as a `pre_restore` snapshot. */
    restore(id: string, body: { dry_run?: boolean; include_allowed_origins?: boolean; expected_sha256?: string } = {}, idempotencyKey?: string): Promise<ConfigSnapshotRestore> {
      return request({ method: 'POST', path: `/v1/instance/config_snapshots/${enc(id)}/restore`, body, idempotencyKey });
    },
    delete(id: string): Promise<{ object: 'config_snapshot'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/instance/config_snapshots/${enc(id)}` });
    },
  };
}

/** Environment clones and per-PR previews on the platform client (`apps.instances.clones`). */
export function instanceClonesResource(request: RequestFn) {
  const base = (appId: string, instanceId: string) => `/v1/platform/apps/${enc(appId)}/instances/${enc(instanceId)}/clones`;
  return {
    /** Clone an instance into a new development-mode instance, or open a preview for a ref. The secret is shown once. */
    create(appId: string, instanceId: string, body: CreateInstanceCloneBody, idempotencyKey?: string): Promise<InstanceCloneCreated> {
      return request({ method: 'POST', path: base(appId, instanceId), body, idempotencyKey });
    },
    list(appId: string, instanceId: string, params: { limit?: number; starting_after?: string; kind?: 'clone' | 'preview' } = {}): Promise<Page<InstanceClone>> {
      return request({ method: 'GET', path: base(appId, instanceId), query: { ...params } });
    },
    get(appId: string, instanceId: string, cloneId: string): Promise<InstanceClone> {
      return request({ method: 'GET', path: `${base(appId, instanceId)}/${enc(cloneId)}` });
    },
    /** Delete a clone or preview together with its instance. */
    delete(appId: string, instanceId: string, cloneId: string): Promise<InstanceClone> {
      return request({ method: 'DELETE', path: `${base(appId, instanceId)}/${enc(cloneId)}` });
    },
  };
}
