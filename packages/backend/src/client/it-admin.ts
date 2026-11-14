import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** The organization IT-admin view: live health, the inbound SCIM request log, directory sync runs, sign-in history and the SSO connection test. */

export type OrganizationItHealthStatus = 'not_configured' | 'healthy' | 'attention' | 'critical';

export interface OrganizationItHealthIssue {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  /** The connection, token, source or domain the issue is about. */
  subject: string | null;
}

export interface SsoConnectionHealth {
  object: 'sso_connection_health';
  id: string;
  type: string;
  status: string;
  last_successful_login_at: number | null;
  last_failed_login_at: number | null;
  last_failure_code: string | null;
  last_test_at: number | null;
  successes_24h: number;
  failures_24h: number;
  certificate: { status: 'none' | 'ok' | 'expiring' | 'expired'; expires_at: number | null; days_left: number | null };
}

export interface DirectorySyncHealth {
  object: 'directory_sync_health';
  kind: 'ldap' | 'pull';
  id: string;
  name: string | null;
  status: string;
  last_run: {
    id: string;
    status: string;
    error: string | null;
    trigger: string;
    created_at: number;
    finished_at: number | null;
    stats: Record<string, number>;
  } | null;
  last_success_at: number | null;
}

export interface OrganizationItHealth {
  object: 'organization_it_health';
  organization_id: string;
  status: OrganizationItHealthStatus;
  checked_at: number;
  sso: { connections: SsoConnectionHealth[] };
  scim: {
    active_tokens: number;
    last_request_at: number | null;
    last_error_at: number | null;
    last_error: { status: number; detail: string | null; method: string; path: string } | null;
    requests_24h: number;
    errors_24h: number;
    ip_restricted_tokens: number;
    profile_lock: boolean;
  };
  directory_sync: DirectorySyncHealth[];
  domains: Array<{ id: string; domain: string; status: string; verification_method: string | null; verified_at: number | null; last_checked_at: number | null }>;
  recent_alerts: Array<{ id: string; kind: string | null; title: string | null; created_at: number }>;
  issues: OrganizationItHealthIssue[];
}

export interface ScimRequest {
  object: 'scim_request';
  id: string;
  organization_id: string;
  token_id: string | null;
  method: string;
  path: string;
  resource: string | null;
  status: number;
  /** Why a failed request failed; never the request body. */
  error_detail: string | null;
  ip: string | null;
  user_agent: string | null;
  duration_ms: number | null;
  created_at: number;
}

export interface ListScimRequestsQuery {
  /** 1 to 100 (default 25). */
  limit?: number;
  /** The id of the last request of the previous page. */
  starting_after?: string;
  /** ok = answered below 400; error = answered 400 or above. */
  status?: 'ok' | 'error';
  token_id?: string;
  /** Users, Groups, ... */
  resource?: string;
  /** Epoch milliseconds or ISO 8601: only requests after it. */
  since?: number | string;
}

export interface DirectorySyncRun {
  object: 'directory_sync_run';
  id: string;
  kind: 'ldap' | 'pull';
  source_id: string;
  organization_id: string;
  trigger: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  stats: Record<string, number>;
  error: string | null;
  /** The failed run this one retries. */
  retry_of: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface SsoLoginAttempt {
  object: 'sso_login_attempt';
  id: string;
  connection_id: string;
  organization_id: string | null;
  outcome: 'success' | 'failure' | 'test';
  failure_code: string | null;
  user_id: string | null;
  method: string | null;
  ip: string | null;
  created_at: number;
}

export interface SsoLoginHistory extends ListPage<SsoLoginAttempt> {
  summary: { last_successful_login_at: number | null; last_failed_login_at: number | null; successes_24h: number; failures_24h: number };
}

export interface SsoConnectionTest {
  object: 'sso_connection_test';
  id: string;
  /** false when the configuration is incomplete or the issuer cannot be discovered; message says why. */
  ok: boolean;
  message: string;
  endpoints: { authorization_endpoint: string; token_endpoint: string } | null;
  checked: string[];
  not_checked: string[];
}

export function organizationItAdminResource(request: RequestFn) {
  return {
    /** Live health of an organization's single sign-on, directory sync and domains, with the issues that need attention. */
    getItHealth(id: string): Promise<OrganizationItHealth> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/it_health` });
    },
    /** The requests the organization's directory sent to the SCIM endpoint, newest first (30 days). */
    listScimRequests(id: string, query?: ListScimRequestsQuery): Promise<ListPage<ScimRequest>> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/scim/requests`, query: { ...query } });
    },
    /** Directory sync runs (LDAP and HR/directory pull) of one organization, newest first. */
    listDirectorySyncRuns(id: string, query?: { limit?: number; status?: DirectorySyncRun['status'] }): Promise<ListPage<DirectorySyncRun>> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/directory_sync_runs`, query: { ...query } });
    },
    /** Queue a new run for the source of a failed one. 409 while a run for that source is already queued or running. */
    retryDirectorySyncRun(id: string, runId: string): Promise<DirectorySyncRun> {
      return request({ method: 'POST', path: `/v1/organizations/${enc(id)}/directory_sync_runs/${enc(runId)}/retry` });
    },
  };
}

export function ssoConnectionItAdminResource(request: RequestFn) {
  return {
    /** Successful, failed and test sign-ins through one connection, newest first (90 days). */
    loginHistory(id: string, query?: { limit?: number; starting_after?: string; outcome?: SsoLoginAttempt['outcome'] }): Promise<SsoLoginHistory> {
      return request({ method: 'GET', path: `/v1/sso_connections/${enc(id)}/login_history`, query: { ...query } });
    },
    /** Check the connection's configuration (SAML: complete and well-formed; OIDC: the issuer is reachable). A failed check is `ok: false`, not an error. */
    test(id: string, body: { oidc_issuer?: string } = {}): Promise<SsoConnectionTest> {
      return request({ method: 'POST', path: `/v1/sso_connections/${enc(id)}/test`, body });
    },
    /** Begin an interactive OIDC test sign-in: open authorization_url in a browser; no session is issued. */
    testLogin(id: string): Promise<{ object: 'sso_connection_test_login'; authorization_url: string }> {
      return request({ method: 'POST', path: `/v1/sso_connections/${enc(id)}/test_login` });
    },
  };
}
