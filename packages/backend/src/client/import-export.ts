import { enc, type RequestFn } from './request';
import type { CursorPage, CursorParams, ListPage, Metadata } from './types';

/**
 * §9.3 bulk user import/export — the Auth0 `jobs` parity surface. A job runs
 * synchronously for a small batch (201 with the finished job) or is queued for
 * a larger one (202 with a `pending` job the caller polls). An export never
 * carries a password hash or provider secret, by construction.
 */
export interface Job {
  object: 'job';
  id: string;
  type: 'user_import' | 'user_export';
  status: string;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  error_count: number;
  /** Present only on an export job: the serialised user array, or null. */
  result?: ExportedUser[] | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

/** One recorded per-row failure inside a job's `errors` array. */
export interface JobError {
  index: number;
  email: string | null;
  code: string;
  message: string;
}

/** A user as serialised into an export job's `result`. Never a secret. */
export interface ExportedUser {
  object: 'user';
  id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  public_metadata: Metadata;
  private_metadata: Metadata;
  email_addresses: Array<{
    id: string;
    email_address: string;
    verified: boolean;
    primary: boolean;
  }>;
  mfa_enabled: boolean;
  banned: boolean;
  created_at: number;
  updated_at: number;
}

/** One user row accepted by an import. Provide `password` or a `password_hash`. */
export interface ImportUserRow {
  email_address?: string;
  email?: string;
  password?: string;
  password_hash?: string;
  email_verified?: boolean;
  verified?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  public_metadata?: unknown;
  private_metadata?: unknown;
  external_accounts?: Array<{
    provider?: string;
    provider_user_id?: string;
    email?: string;
    email_verified?: boolean;
  }>;
}

export interface ImportUsersBody {
  users: ImportUserRow[];
  /** Update an existing user matched by verified email instead of skipping it. */
  upsert?: boolean;
}

export function importExportResource(request: RequestFn) {
  return {
    /** Import users through the same per-row path sign-up uses. Deduped by verified email. */
    importUsers(body: ImportUsersBody, idempotencyKey?: string): Promise<Job> {
      return request({ method: 'POST', path: '/v1/user_imports', body, idempotencyKey });
    },
    /** Export every non-deleted user in the instance, serialised without secrets. */
    exportUsers(idempotencyKey?: string): Promise<Job> {
      return request({ method: 'POST', path: '/v1/user_exports', idempotencyKey });
    },
    /** Poll the instance's import/export jobs, newest first. */
    listJobs(params: CursorParams = {}): Promise<CursorPage<Job>> {
      return request({ method: 'GET', path: '/v1/jobs', query: { ...params } });
    },
    getJob(id: string): Promise<Job> {
      return request({ method: 'GET', path: `/v1/jobs/${enc(id)}` });
    },
    /** The per-row failures recorded against a job. */
    getJobErrors(id: string): Promise<ListPage<JobError>> {
      return request({ method: 'GET', path: `/v1/jobs/${enc(id)}/errors` });
    },
  };
}
