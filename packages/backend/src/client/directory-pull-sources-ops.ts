import { enc, type RequestFn } from './request';



export interface DirectoryPullSourcesListQuery {
  /** Only the sources of this organization. */
  organization_id?: string;
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type DirectoryPullSourcesListResult = {
  object?: 'list';
  data?: ({
    object?: 'directory_pull_source';
    id?: string;
    organization_id?: string;
    name?: string;
    provider?: 'entra' | 'google_workspace' | 'bamboohr' | 'hibob' | 'personio' | 'workday' | 'successfactors' | 'gusto' | 'csv' | 'rest_json';
    status?: 'active' | 'paused';
    config?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    default_role_id?: string | null;
    has_credentials?: boolean;
    has_uploaded_csv?: boolean;
    next_sync_at?: number | null;
    created_at?: number;
    updated_at?: number;
  })[];
  has_more?: boolean;
};

export type DirectoryPullSourcesCreateBody = {
  organization_id: string;
  name: string;
  provider: 'entra' | 'google_workspace' | 'bamboohr' | 'hibob' | 'personio' | 'workday' | 'successfactors' | 'gusto' | 'csv' | 'rest_json';
  status?: 'active' | 'paused';
  config?: Record<string, unknown>;
  /** Write-only. */
  credentials?: Record<string, unknown>;
  default_role_id?: string | null;
  /** Schedule, role mappings and disable-on-removal. */
  settings?: Record<string, unknown>;
};

export type DirectoryPullSourcesCreateResult = {
  object?: 'directory_pull_source';
  id?: string;
  organization_id?: string;
  name?: string;
  provider?: 'entra' | 'google_workspace' | 'bamboohr' | 'hibob' | 'personio' | 'workday' | 'successfactors' | 'gusto' | 'csv' | 'rest_json';
  status?: 'active' | 'paused';
  config?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  default_role_id?: string | null;
  has_credentials?: boolean;
  has_uploaded_csv?: boolean;
  next_sync_at?: number | null;
  created_at?: number;
  updated_at?: number;
};

export type DirectoryPullSourcesGetResult = {
  object?: 'directory_pull_source';
  id?: string;
  organization_id?: string;
  name?: string;
  provider?: 'entra' | 'google_workspace' | 'bamboohr' | 'hibob' | 'personio' | 'workday' | 'successfactors' | 'gusto' | 'csv' | 'rest_json';
  status?: 'active' | 'paused';
  config?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  default_role_id?: string | null;
  has_credentials?: boolean;
  has_uploaded_csv?: boolean;
  next_sync_at?: number | null;
  created_at?: number;
  updated_at?: number;
};

export type DirectoryPullSourcesUpdateBody = {
  organization_id?: string;
  name?: string;
  provider?: 'entra' | 'google_workspace' | 'bamboohr' | 'hibob' | 'personio' | 'workday' | 'successfactors' | 'gusto' | 'csv' | 'rest_json';
  status?: 'active' | 'paused';
  config?: Record<string, unknown>;
  /** Write-only. */
  credentials?: Record<string, unknown>;
  default_role_id?: string | null;
  /** Schedule, role mappings and disable-on-removal. */
  settings?: Record<string, unknown>;
};

export type DirectoryPullSourcesUpdateResult = {
  object?: 'directory_pull_source';
  id?: string;
  organization_id?: string;
  name?: string;
  provider?: 'entra' | 'google_workspace' | 'bamboohr' | 'hibob' | 'personio' | 'workday' | 'successfactors' | 'gusto' | 'csv' | 'rest_json';
  status?: 'active' | 'paused';
  config?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  default_role_id?: string | null;
  has_credentials?: boolean;
  has_uploaded_csv?: boolean;
  next_sync_at?: number | null;
  created_at?: number;
  updated_at?: number;
};

export type DirectoryPullSourcesSetCsvBody = {
  csv?: string;
};

export type DirectoryPullSourcesStartSyncRunResult = {
  object?: 'directory_pull_run';
  id?: string;
  source_id?: string;
  organization_id?: string;
  trigger?: string;
  status?: string;
  stats?: Record<string, unknown>;
  error?: string | null;
  created_at?: number;
  started_at?: number | null;
  finished_at?: number | null;
};

export interface DirectoryPullSourcesListSyncRunsQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type DirectoryPullSourcesListSyncRunsResult = {
  object?: 'list';
  data?: ({
    object?: 'directory_pull_run';
    id?: string;
    source_id?: string;
    organization_id?: string;
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

export type DirectoryPullSourcesGetSyncRunResult = {
  object?: 'directory_pull_run';
  id?: string;
  source_id?: string;
  organization_id?: string;
  trigger?: string;
  status?: string;
  stats?: Record<string, unknown>;
  error?: string | null;
  created_at?: number;
  started_at?: number | null;
  finished_at?: number | null;
};

/** Operations on `/v1/directory_pull_sources` (9). */
export function directoryPullSourcesOpsResource(request: RequestFn) {
  return {
    /** List HR / directory pull sources, optionally for one organization (organization_id). Credentials are never returned. */
    list(query?: DirectoryPullSourcesListQuery): Promise<DirectoryPullSourcesListResult> {
      return request({ method: 'GET', path: '/v1/directory_pull_sources', query: { ...query } });
    },
    /** Create a pull source for an organization: provider (entra, google_workspace, bamboohr, hibob, personio, workday, successfactors, gusto, csv, rest_json), config, write-only credentials and settings (schedule, role mappings, disable on removal). */
    create(body?: DirectoryPullSourcesCreateBody, idempotencyKey?: string): Promise<DirectoryPullSourcesCreateResult> {
      return request({ method: 'POST', path: '/v1/directory_pull_sources', body, idempotencyKey });
    },
    /** Read one pull source. */
    get(id: string): Promise<DirectoryPullSourcesGetResult> {
      return request({ method: 'GET', path: `/v1/directory_pull_sources/${enc(id)}` });
    },
    /** Change the source name, status (active or paused), config, credentials, default role or settings. Settings are merged. */
    update(id: string, body?: DirectoryPullSourcesUpdateBody): Promise<DirectoryPullSourcesUpdateResult> {
      return request({ method: 'PATCH', path: `/v1/directory_pull_sources/${enc(id)}`, body });
    },
    /** Delete a pull source and its run log. Users it created are kept. */
    delete(id: string): Promise<void> {
      return request({ method: 'DELETE', path: `/v1/directory_pull_sources/${enc(id)}` });
    },
    /** Upload the CSV a csv source without a URL reads on its next run (up to 5 MiB). */
    setCsv(id: string, body?: DirectoryPullSourcesSetCsvBody): Promise<void> {
      return request({ method: 'PUT', path: `/v1/directory_pull_sources/${enc(id)}/csv`, body });
    },
    /** Queue a pull now. One run at a time per source (409 otherwise); the worker executes it. */
    startSyncRun(id: string): Promise<DirectoryPullSourcesStartSyncRunResult> {
      return request({ method: 'POST', path: `/v1/directory_pull_sources/${enc(id)}/sync_runs` });
    },
    /** List the runs of a source with counts of people seen, created, re-roled, disabled and re-enabled. */
    listSyncRuns(id: string, query?: DirectoryPullSourcesListSyncRunsQuery): Promise<DirectoryPullSourcesListSyncRunsResult> {
      return request({ method: 'GET', path: `/v1/directory_pull_sources/${enc(id)}/sync_runs`, query: { ...query } });
    },
    /** Read one directory pull run with its counts and error. */
    getSyncRun(id: string, runId: string): Promise<DirectoryPullSourcesGetSyncRunResult> {
      return request({ method: 'GET', path: `/v1/directory_pull_sources/${enc(id)}/sync_runs/${enc(runId)}` });
    },
  };
}
