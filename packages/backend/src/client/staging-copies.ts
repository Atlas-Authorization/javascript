import { enc, type RequestFn } from './request';

export type StagingSection = 'config' | 'roles' | 'organizations' | 'users' | 'memberships';

export interface StagingCopy {
  object: 'instance_clone';
  id: string;
  kind: 'clone' | 'preview';
  name: string;
  ref: string | null;
  status: 'pending' | 'copying' | 'completed' | 'failed' | 'deleted';
  progress: Record<string, unknown>;
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

/** A new copy also carries its first secret key, shown once. */
export type StagingCopyCreated = StagingCopy & { secret?: string | null; secret_key_scopes?: string[]; replayed?: boolean; note?: string };

export interface StagingCopyInput {
  mode?: 'clone' | 'preview';
  name?: string;
  ref?: string;
  include?: StagingSection[];
  mask_emails?: boolean;
  ttl_hours?: number;
  allowed_origins?: Array<string | { origin: string; integration?: string }>;
  refresh?: boolean;
}

export interface StagingRefreshInput {
  include?: StagingSection[];
  /** Seeded test users: the same seed and count always give the same users. */
  synthetic_users?: { count: number; seed: string };
  /** A preview only. */
  ttl_hours?: number;
}

/** A development-mode copy of this instance (config, optionally data) for release testing, refreshed in place on demand. */
export function stagingCopiesResource(request: RequestFn) {
  return {
    create(body: StagingCopyInput = {}, idempotencyKey?: string): Promise<StagingCopyCreated> {
      return request({ method: 'POST', path: '/v1/instance/staging_copies', body, idempotencyKey });
    },
    list(params: { limit?: number; starting_after?: string; kind?: 'clone' | 'preview' } = {}): Promise<{ object: 'list'; data: StagingCopy[]; has_more: boolean; next_cursor: string | null }> {
      return request({ method: 'GET', path: '/v1/instance/staging_copies', query: { ...params } });
    },
    get(id: string): Promise<StagingCopy> {
      return request({ method: 'GET', path: `/v1/instance/staging_copies/${enc(id)}` });
    },
    /** Bring a completed copy up to date in place: same instance and keys. */
    refresh(id: string, body: StagingRefreshInput = {}, idempotencyKey?: string): Promise<StagingCopy> {
      return request({ method: 'POST', path: `/v1/instance/staging_copies/${enc(id)}/refresh`, body, idempotencyKey });
    },
    delete(id: string): Promise<StagingCopy> {
      return request({ method: 'DELETE', path: `/v1/instance/staging_copies/${enc(id)}` });
    },
  };
}
