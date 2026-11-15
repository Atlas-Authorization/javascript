import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** Cursor paging shared by the list calls below. */
export interface GapPageParams {
  limit?: number;
  starting_after?: string;
}

// ---- migrations: dual-run verify + status ----------------------------------

export interface MigrationVerifyResult {
  object?: string;
  source?: string;
  valid?: boolean;
  /** `invalid`, `expired` or `unavailable`. */
  reason?: 'invalid' | 'expired' | 'unavailable' | null;
  subject?: string | null;
  /** The mapped Atlas user when the user was imported. */
  user_id?: string | null;
  /** End of the dual-run window (epoch ms). */
  dual_run_until?: number;
}

/** Where a migration stands; `safe_to_delete_old_auth` lists its blockers. */
export interface MigrationStatus {
  object?: string;
  safe_to_delete_old_auth?: boolean;
  blockers?: string[];
  [key: string]: unknown;
}

// ---- instance policies ------------------------------------------------------

export interface ScopeDefinition {
  name: string;
  /** Consent-screen text per locale, e.g. `{ en: '...', es: '...' }`. */
  label?: Record<string, string>;
  description?: Record<string, string>;
  sensitive?: boolean;
  /** Refused at /oauth2/authorize unless the app is approved or the scope is in its `approved_scopes`. */
  requires_verified_client?: boolean;
}

export interface ImpersonationPolicy {
  object?: string;
  require_reason: boolean;
  reason_codes: string[];
  max_duration_seconds: number;
  require_approval: boolean;
  read_only_default: boolean;
  notify_user: boolean;
}

export type OrgDepartureTransfer = 'oldest_admin' | 'user' | 'none';

export interface OrgDeparturePolicy {
  object?: string;
  transfer_to: OrgDepartureTransfer;
  user_id?: string;
}

/** The event types third-party apps can subscribe to. */
export interface InstanceAppEventType {
  object?: string;
  id: string;
  type: string;
  description: string | null;
  schema: Record<string, unknown> | null;
  deprecated: boolean;
  required_scope?: string | null;
  created_at: number;
  updated_at: number;
}

export interface InstanceAppEventTypeInput {
  /** Lowercase dotted, not an Atlas event name. */
  type: string;
  description?: string | null;
  schema?: Record<string, unknown> | null;
  /** Must exist in the scope catalogue. */
  required_scope: string;
}

// ---- users, orgs, sessions ---------------------------------------------------

export interface ExternalAccount {
  object?: string;
  id: string;
  provider: string;
  provider_user_id: string;
  provider_email: string | null;
  email_verified: boolean;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
  connected_at: number;
}

export interface AttachExternalAccountBody {
  /** Namespaced, e.g. `telegram:bot`. */
  provider?: string;
  provider_user_id?: string;
  /** Must be false or omitted. */
  sign_in?: boolean;
  email_address?: string;
}

export interface OrganizationAuditLogEntry {
  object?: string;
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  organization_id: string;
  metadata: Record<string, unknown> | null;
  created_at: number;
}

export interface OrganizationAuditLogParams extends GapPageParams {
  /** Exact action, or a prefix ending in ".". */
  action?: string;
  /** ISO dates. */
  from?: string;
  to?: string;
}

export interface SessionRisk {
  object?: string;
  session_id: string;
  user_id: string;
  /** 0 to 100; null when never assessed (unknown, not safe). */
  score: number | null;
  level: 'low' | 'medium' | 'high' | null;
  reasons: string[];
  computed_at?: number | null;
}

// ---- OAuth clients + grants --------------------------------------------------

export interface OAuthClientUsage {
  object?: string;
  client_id?: string;
  rate_limit_per_minute?: number | null;
  since?: string;
  until?: string;
  totals?: { calls?: number; token_issuances?: number; errors?: number; rate_limited?: number };
  data?: Array<{ day?: string; calls?: number; token_issuances?: number; active_users?: number; errors?: number; rate_limited?: number }>;
}

export type OAuthClientWebhookEvent =
  | 'user.updated'
  | 'user.deleted'
  | 'grant.revoked'
  | 'user.deletion_scheduled'
  | 'user.deletion_canceled'
  | 'signing_key.staged'
  | 'signing_key.activated';

export interface OAuthClientWebhook {
  object?: string;
  id?: string;
  url?: string;
  enabled_events?: string[];
  active?: boolean;
  available_events?: string[];
  /** Shown once, on create. */
  webhook_secret?: string;
  note?: string;
}

export interface PutOAuthClientWebhookBody {
  url: string;
  /** May also name types declared with `instance.putAppEventTypes`. */
  enabled_events?: Array<OAuthClientWebhookEvent | (string & {})>;
}

export interface OAuthGrantImportRow {
  user_id: string;
  client_id: string;
  scopes: string[];
  /** Hashes only (bcrypt or sha256), never the tokens. */
  refresh_tokens?: Array<Record<string, unknown>>;
}

export interface OAuthGrantImportResult {
  object?: string;
  dry_run?: boolean;
  imported?: number;
  failed?: number;
  refresh_tokens?: number;
  results?: Array<{ index?: number; status?: 'imported' | 'failed'; client_id?: string | null; user_id?: string | null; refresh_tokens?: number; message?: string }>;
  errors?: Array<{ index?: number; message?: string }>;
  note?: string;
}

// ---- passkey campaigns -------------------------------------------------------

export interface PasskeyCampaignSegment {
  created_before?: number;
  created_after?: number;
  last_sign_in_after?: number;
  has_password?: boolean;
  email_domain?: string;
  org_ids?: string[];
}

export interface PasskeyCampaign {
  object?: string;
  id?: string;
  name?: string;
  segment?: PasskeyCampaignSegment;
  /** A user is prompted at most once per this many days. */
  frequency_cap_days?: number;
  starts_at?: number;
  ends_at?: number | null;
  status?: 'active' | 'ended';
  created_at?: number;
  metrics?: { eligible?: number; prompted?: number; enrolled?: number };
}

export interface CreatePasskeyCampaignBody {
  name: string;
  segment?: PasskeyCampaignSegment;
  frequency_cap_days?: number;
  starts_at?: number;
  ends_at?: number;
}

// ---- diagnostics, advisories, connections, dev inbox, integrations -----------

export interface DiagnosticTrace {
  object?: string;
  id: string;
  user_id: string | null;
  method: string;
  path: string;
  status: number;
  code: string;
  reason: string | null;
  /** captcha, policy, risk, rate_limit, scope, step_up, access_policy, verification or validation. */
  decided_by: string | null;
  /** A plain-language explanation of the refusal. */
  explanation: string;
  chain: Array<{ step: string; outcome: string; detail?: Record<string, unknown> }>;
  created_at: number;
}

export interface DiagnosticTraceParams extends GapPageParams {
  user_id?: string;
  /** Epoch ms or ISO 8601. */
  since?: string;
  until?: string;
  code?: string;
}

export interface SecurityAdvisoryDetail {
  object: 'security_advisory';
  id: string;
  published?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  summary?: string;
  affects?: string[];
  fixed_on?: string;
  action?: string;
  docs_url?: string;
  applies?: boolean;
  detail?: string | null;
  count?: number | null;
  first_seen_at?: number | null;
  emailed_at?: number | null;
  acknowledged_at?: number | null;
  subjects?: Array<{ user_id: string; email_address_id: string; email_address: string; reported_verified_at?: number | null }>;
  /** True when more than 100 subjects apply; `count` stays the full number. */
  subjects_truncated?: boolean;
}

export interface ConnectionSignBody {
  method?: string;
  url: string;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: string;
}

export interface ConnectionSignResult {
  object?: string;
  connection_id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
}

export interface DevEmail {
  object?: string;
  id: string;
  to: string;
  template: string;
  subject: string;
  text: string;
  html?: string | null;
  variables: Record<string, unknown>;
  created_at: number;
}

export interface IntegrationTestResult {
  object: 'webhook_delivery' | 'webhook_test_result';
  status?: 'success' | 'failed';
  http_status?: number | null;
  latency_ms?: number;
  response_snippet?: string | null;
  error_kind?: string | null;
  signature_header_sent?: boolean;
  [key: string]: unknown;
}

export interface PrivacyCasesDismissResult {
  object?: string;
  reason_code: string;
  dismissed: number;
}

/** Operations the other client files did not cover; each is merged into its natural namespace. */
export function gapOpsResources(request: RequestFn) {
  return {
    migrations: {
      /** Dual-run check: is this old token valid? Answers only while `dual_run_until` is open (403 after). */
      verifyDualRun(source: string, body: { token: string }): Promise<MigrationVerifyResult> {
        return request({ method: 'POST', path: `/v1/migrations/${enc(source)}/verify`, body });
      },
      status(params: { quiet_days?: number } = {}): Promise<MigrationStatus> {
        return request({ method: 'GET', path: '/v1/migrations/status', query: { ...params } });
      },
    },
    instance: {
      listScopes(params: GapPageParams = {}): Promise<{ object?: string; data: ScopeDefinition[] }> {
        return request({ method: 'GET', path: '/v1/instance/scopes', query: { ...params } });
      },
      /** Replaces the whole scope catalogue. */
      putScopes(body: { scopes: ScopeDefinition[] }): Promise<{ object?: string; data: ScopeDefinition[] }> {
        return request({ method: 'PUT', path: '/v1/instance/scopes', body });
      },
      getImpersonationPolicy(): Promise<ImpersonationPolicy> {
        return request({ method: 'GET', path: '/v1/instance/impersonation_policy' });
      },
      /** Send only the fields to change. */
      putImpersonationPolicy(body: Partial<Omit<ImpersonationPolicy, 'object'>>): Promise<ImpersonationPolicy> {
        return request({ method: 'PUT', path: '/v1/instance/impersonation_policy', body });
      },
      /** Organization role key to the feature keys a seat in that role grants. */
      getOrgRoleEntitlements(): Promise<{ object?: string; roles: Record<string, string[]> }> {
        return request({ method: 'GET', path: '/v1/instance/org_role_entitlements' });
      },
      putOrgRoleEntitlements(body: { roles: Record<string, string[]> }): Promise<{ object?: string; roles: Record<string, string[]> }> {
        return request({ method: 'PUT', path: '/v1/instance/org_role_entitlements', body });
      },
      getOrgDeparturePolicy(): Promise<OrgDeparturePolicy> {
        return request({ method: 'GET', path: '/v1/instance/org_departure_policy' });
      },
      putOrgDeparturePolicy(body: { transfer_to: OrgDepartureTransfer; user_id?: string }): Promise<OrgDeparturePolicy> {
        return request({ method: 'PUT', path: '/v1/instance/org_departure_policy', body });
      },
      listAppEventTypes(params: GapPageParams = {}): Promise<ListPage<InstanceAppEventType>> {
        return request({ method: 'GET', path: '/v1/instance/app_event_types', query: { ...params } });
      },
      /** Replaces the event types third-party apps can subscribe to. */
      putAppEventTypes(body: InstanceAppEventTypeInput[]): Promise<ListPage<InstanceAppEventType>> {
        return request({ method: 'PUT', path: '/v1/instance/app_event_types', body });
      },
      /** Dismiss every open privacy case held back because the primary email is unverified. */
      dismissPrivacyOrchestratorCases(body: { reason_code: 'email_unverified'; reason?: string }): Promise<PrivacyCasesDismissResult> {
        return request({ method: 'POST', path: '/v1/instance/privacy_orchestrator/cases/dismiss', body });
      },
    },
    users: {
      /** Attach a non-sign-in identity (a chat id, a marketplace username) to a user. */
      addExternalAccount(userId: string, body: AttachExternalAccountBody, idempotencyKey?: string): Promise<ExternalAccount> {
        return request({ method: 'POST', path: `/v1/users/${enc(userId)}/external_accounts`, body, idempotencyKey });
      },
      removeExternalAccount(userId: string, accountId: string): Promise<{ object?: string; id: string; removed: boolean }> {
        return request({ method: 'DELETE', path: `/v1/users/${enc(userId)}/external_accounts/${enc(accountId)}` });
      },
    },
    organizations: {
      /** A page of the organization's audit trail, newest first. */
      listAuditLogs(id: string, params: OrganizationAuditLogParams = {}): Promise<ListPage<OrganizationAuditLogEntry>> {
        return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/audit_logs`, query: { ...params } });
      },
    },
    sessions: {
      /** Advisory risk of a session; null fields mean never assessed. */
      getRisk(id: string): Promise<SessionRisk> {
        return request({ method: 'GET', path: `/v1/sessions/${enc(id)}/risk` });
      },
    },
    oauthClients: {
      getUsage(id: string, params: GapPageParams & { days?: number } = {}): Promise<OAuthClientUsage> {
        return request({ method: 'GET', path: `/v1/oauth_clients/${enc(id)}/usage`, query: { ...params } });
      },
      getWebhook(id: string): Promise<OAuthClientWebhook> {
        return request({ method: 'GET', path: `/v1/oauth_clients/${enc(id)}/webhook` });
      },
      /** The signing secret is returned once, on create. */
      putWebhook(id: string, body: PutOAuthClientWebhookBody): Promise<OAuthClientWebhook> {
        return request({ method: 'PUT', path: `/v1/oauth_clients/${enc(id)}/webhook`, body });
      },
      deleteWebhook(id: string): Promise<void> {
        return request({ method: 'DELETE', path: `/v1/oauth_clients/${enc(id)}/webhook` });
      },
    },
    oauthGrants: {
      /** Carry over consent and refresh-token hashes from a previous provider. Per-row results; `?dry_run=true` via withOptions. */
      import(body: { grants: OAuthGrantImportRow[] }, idempotencyKey?: string): Promise<OAuthGrantImportResult> {
        return request({ method: 'POST', path: '/v1/oauth_grants/import', body, idempotencyKey });
      },
    },
    passkeyCampaigns: {
      create(body: CreatePasskeyCampaignBody, idempotencyKey?: string): Promise<PasskeyCampaign> {
        return request({ method: 'POST', path: '/v1/passkey_campaigns', body, idempotencyKey });
      },
      list(params: GapPageParams = {}): Promise<ListPage<PasskeyCampaign>> {
        return request({ method: 'GET', path: '/v1/passkey_campaigns', query: { ...params } });
      },
      get(id: string): Promise<PasskeyCampaign> {
        return request({ method: 'GET', path: `/v1/passkey_campaigns/${enc(id)}` });
      },
      /** Ends the campaign now; it stays readable. */
      end(id: string): Promise<PasskeyCampaign> {
        return request({ method: 'DELETE', path: `/v1/passkey_campaigns/${enc(id)}` });
      },
    },
    diagnostics: {
      /** Explain a refusal from the `trace_id` on an error response. */
      getTrace(id: string): Promise<DiagnosticTrace> {
        return request({ method: 'GET', path: `/v1/diagnostics/traces/${enc(id)}` });
      },
      listTraces(params: DiagnosticTraceParams = {}): Promise<{ object?: string; data: DiagnosticTrace[] }> {
        return request({ method: 'GET', path: '/v1/diagnostics/traces', query: { ...params } });
      },
    },
    securityAdvisories: {
      get(id: string): Promise<SecurityAdvisoryDetail> {
        return request({ method: 'GET', path: `/v1/security_advisories/${enc(id)}` });
      },
    },
    connections: {
      /** Sign a request you send yourself with the connection's signing preset; the secret never leaves Atlas. */
      sign(id: string, body: ConnectionSignBody): Promise<ConnectionSignResult> {
        return request({ method: 'POST', path: `/v1/connections/${enc(id)}/sign`, body });
      },
    },
    dev: {
      /** Development instances only: the mail the instance would have sent. */
      listEmails(params: GapPageParams & { to?: string } = {}): Promise<{ object?: string; data: DevEmail[] }> {
        return request({ method: 'GET', path: '/v1/dev/emails', query: { ...params } });
      },
      clearEmails(): Promise<{ object?: string; deleted: number }> {
        return request({ method: 'DELETE', path: '/v1/dev/emails' });
      },
    },
    integrations: {
      /** Send a signed webhook.test to the integration's receiver. `wait` such as `10s` makes the attempt now. */
      test(product: string, params: { wait?: string } = {}): Promise<IntegrationTestResult> {
        return request({ method: 'POST', path: `/v1/instance/integrations/${enc(product)}/test`, query: { ...params } });
      },
    },
  };
}
