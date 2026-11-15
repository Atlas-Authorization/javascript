import { enc, type RequestFn } from './request';

type Page<T> = { object: 'list'; data: T[]; has_more: boolean; next_cursor?: string | null };
type Cursor = { limit?: number; starting_after?: string };
const rec = (o: Record<string, unknown>) => ({ ...o });

// --- age assurance ----------------------------------------------------------------------------
export type AgeMethod = 'self_declared' | 'id_document' | 'payment_card' | 'estimation' | 'credential' | 'third_party' | 'admin';
export type AssuranceLevel = 'low' | 'medium' | 'high';
export interface AgeAssurance {
  object: 'age_assurance';
  id: string;
  user_id: string;
  method: AgeMethod;
  level: AssuranceLevel;
  /** The user is at least this many years old. */
  over_age: number;
  provider: string | null;
  reference: string | null;
  verification_id: string | null;
  status: 'valid' | 'revoked' | 'expired';
  /** Whether `compliance.minors.trustedAgeMethods` lets this method replace the date of birth. */
  trusted: boolean;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  created_at: number;
}
export interface RecordAgeAssuranceBody {
  method: AgeMethod;
  over_age: number;
  /** `third_party` only. */
  assurance_level?: AssuranceLevel;
  provider?: string | null;
  /** An opaque reference to the evidence you keep, never the evidence. */
  reference?: string | null;
  /** `id_document` only: the user's approved identity verification. */
  verification_id?: string;
  expires_at?: number | null;
}

// --- compliance ------------------------------------------------------------------------------
export interface ComplianceControl { id: string; title: string; status: 'configured' | 'not_configured'; detail: string }
export interface CompliancePosture {
  object: 'compliance_posture';
  instance_id: string;
  generated_at: string;
  controls: ComplianceControl[];
  summary: { configured: number; total: number };
  data_rights: Record<string, number>;
  downstream_erasure: Array<{ key: string; name: string; mode: string }>;
}
export interface RecordOfProcessing {
  object: 'record_of_processing';
  instance_id: string;
  generated_at: string;
  controller: { name: string | null; contactEmail: string | null; dpoEmail: string | null };
  processor: { name: string; role: string };
  data_region: string | null;
  activities: Array<Record<string, unknown>>;
  retention: Record<string, unknown>;
  atlas_sub_processors: Array<{ name: string; purpose: string; location: string | null }>;
  findings: Array<{ code: string; message: string; activity?: string }>;
}
export interface ComplianceReport {
  object: 'compliance_report';
  id: string;
  kind: 'posture' | 'ropa';
  generated_at: number;
  generated_by: string | null;
  /** The report itself: what the signature covers. */
  claims: Record<string, unknown>;
  /** The signed report (compact JWS); verify it with the keys at `jwks_uri`. Absent in lists. */
  report?: string;
  kid?: string;
  jwks_uri?: string;
}
export interface InactiveUsersPreview {
  object: 'inactive_users_preview';
  enabled: boolean;
  action: 'notify' | 'ban' | 'schedule_deletion';
  after_days: number;
  warn_days: number;
  would_act: Array<{ user_id: string; last_active_at: number }>;
  would_warn: Array<{ user_id: string; last_active_at: number }>;
  truncated: boolean;
}

// --- data rights console ---------------------------------------------------------------------
export interface DsrConsoleSummary {
  object: 'dsr_console_summary';
  open: number;
  overdue: number;
  due_soon: number;
  unassigned: number;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  by_assignee: Record<string, number>;
  oldest_open_at: number | null;
}
export interface DsrConsoleFilter extends Cursor {
  status?: string;
  type?: string;
  assignee?: string;
  unassigned?: boolean;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  label?: string;
  overdue?: boolean;
  due_within_days?: number;
}
export interface DsrNote { object: 'dsr_note'; id: string; request_id: string; author: string | null; body: string; created_at: number }
export interface DownstreamErasure {
  object: 'downstream_erasure';
  request_id: string;
  /** No enabled connector is still pending. */
  complete: boolean;
  pending: number;
  /** Automatic connectors whose last run failed (retry with `downstream.run`). */
  failed: number;
  connectors: Array<{ connector_id: string; key: string; name: string; mode: 'ack' | 'manual' | 'api'; status: 'pending' | 'done' | 'not_applicable' | 'failed'; by: 'operator' | 'acknowledgement' | 'automatic' | null; note: string | null; error: string | null; attempts: number; completed_at: number | null }>;
}
export interface ErasureConnector {
  object: 'erasure_connector';
  id: string;
  key: string;
  catalog_id: string | null;
  name: string;
  /** `ack`: the system confirms through POST /v1/users/{id}/erasure_acks under `ack_source`. `manual`: an operator marks it done per request. `api`: Atlas calls the vendor's deletion API with your own key when an erasure request runs. */
  mode: 'ack' | 'manual' | 'api';
  ack_source: string | null;
  enabled: boolean;
  notes: string | null;
  vendor: ErasureVendorId | null;
  config: Record<string, string>;
  /** Whether a vendor key is saved. The key is never returned. */
  has_credential: boolean;
  created_at: number;
  updated_at: number;
}
export type ErasureVendorId = 'stripe' | 'hubspot' | 'mailchimp' | 'segment' | 'intercom' | 'zendesk' | 'brevo' | 'customerio';
export interface ErasureConnectorRun {
  object: 'erasure_connector_run';
  dry_run: boolean;
  results: Array<{ connector_id: string; key: string; vendor: string; status: 'done' | 'failed' | 'dry_run'; note: string | null; error: string | null }>;
  downstream: DownstreamErasure;
}
export interface ErasureConnectorBody {
  key?: string;
  /** An entry of the catalog: fills `key` and `name`. */
  catalog_id?: string | null;
  name?: string;
  mode?: 'ack' | 'manual' | 'api';
  ack_source?: string | null;
  enabled?: boolean;
  notes?: string | null;
  /** mode api: the vendor to call; defaults to `catalog_id` when that is one of the supported vendors. */
  vendor?: ErasureVendorId | null;
  /** mode api: the vendor's non-secret settings (see `api_vendor.settings` in the catalog). */
  config?: Record<string, string> | null;
  /** mode api: your own vendor key. Sealed at rest, never returned; send it again to replace it. */
  credential?: string;
}
export interface ErasureCatalogEntry {
  object: 'erasure_catalog_entry';
  id: string;
  name: string;
  category: string;
  method: 'api' | 'dashboard' | 'support_request';
  identifier: 'email' | 'user_id' | 'device_id';
  instructions: string;
  holds: string[];
  /** Set when Atlas can call this system's deletion API (mode `api`). */
  api_vendor: { settings: Array<{ key: string; required: boolean; description: string }>; credential_help: string } | null;
}

// --- cookie consent store --------------------------------------------------------------------
export interface CookieConsentEntry {
  object: 'cookie_consent_record';
  id: string;
  subject?: string;
  user_id: string | null;
  categories: Record<string, boolean>;
  policy_version: string | null;
  source: 'banner' | 'api' | 'signal';
  gpc: boolean;
  dnt: boolean;
  signal_applied: 'gpc' | 'dnt' | null;
  region: string | null;
  locale: string | null;
  created_at: number;
}
export interface CookieConsentSummary {
  object: 'cookie_consent_summary';
  enabled: boolean;
  days: number;
  policy_version: string | null;
  choices_recorded: number;
  visitors: number;
  global_privacy_control: number;
  opted_in: Record<string, number>;
}

// --- policies, translation review ------------------------------------------------------------
export interface PolicyAudience { object: 'policy_audience'; policy: string; policy_id: string; audience: 'everyone' | 'orgs'; organization_ids: string[] }
export interface PolicyTranslation {
  object: 'policy_translation';
  id: string;
  policy: string;
  version_id: string;
  version: string;
  locale: string;
  title: string | null;
  content_markdown: string | null;
  content_html: string;
  content_sha256: string;
  created_at: number;
  updated_at: number;
}
export type ReviewStatus = 'draft' | 'in_review' | 'changes_requested' | 'approved';
export interface ReviewedLocalization {
  object: 'localization';
  id: string;
  resource_type: string;
  resource_name: string;
  locale: string;
  content: Record<string, unknown>;
  enabled: boolean;
  review_status: ReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_hint: string | null;
  changed_since_approval: boolean;
  created_at: string;
  updated_at: string;
}
export interface LocalizationCheckResult {
  object: 'localization_check';
  ok: boolean;
  checked: number;
  failed: number;
  results: Array<{ index: number; ok: boolean; problems: Array<{ code: string; message: string }> }>;
}

/**
 * Age assurance, compliance as code (signed reports, the data rights console, downstream erasure),
 * the cookie consent store (operator side), policy audience and translations, and translation review.
 */
export function complianceDepthResource(request: RequestFn) {
  return {
    ageAssurance: {
      /** `GET /v1/users/:id/age_assurance` */
      list(userId: string): Promise<Page<AgeAssurance>> {
        return request({ method: 'GET', path: `/v1/users/${enc(userId)}/age_assurance` });
      },
      /** `POST /v1/users/:id/age_assurance` — record that a method established the user is at least `over_age`. */
      record(userId: string, body: RecordAgeAssuranceBody, idempotencyKey?: string): Promise<AgeAssurance> {
        return request({ method: 'POST', path: `/v1/users/${enc(userId)}/age_assurance`, body: rec({ ...body }), idempotencyKey });
      },
      revoke(userId: string, id: string, body: { reason?: string | null } = {}, idempotencyKey?: string): Promise<AgeAssurance> {
        return request({ method: 'POST', path: `/v1/users/${enc(userId)}/age_assurance/${enc(id)}/revoke`, body, idempotencyKey });
      },
    },
    compliance: {
      /** `GET /v1/compliance/posture` — the live posture: controls and data rights counts. */
      posture(): Promise<CompliancePosture> {
        return request({ method: 'GET', path: '/v1/compliance/posture' });
      },
      /** `GET /v1/compliance/ropa` — the live record of processing built from `compliance.dataPolicy`. */
      recordOfProcessing(): Promise<RecordOfProcessing> {
        return request({ method: 'GET', path: '/v1/compliance/ropa' });
      },
      reports: {
        /** `POST /v1/compliance/reports` — generate, sign with the instance key and keep a report. */
        create(kind: 'posture' | 'ropa', idempotencyKey?: string): Promise<ComplianceReport> {
          return request({ method: 'POST', path: '/v1/compliance/reports', body: { kind }, idempotencyKey });
        },
        list(params: Cursor & { kind?: 'posture' | 'ropa' } = {}): Promise<Page<ComplianceReport>> {
          return request({ method: 'GET', path: '/v1/compliance/reports', query: { ...params } });
        },
        /** One report with its signed form (`report`), key id and `jwks_uri`. */
        get(id: string): Promise<ComplianceReport> {
          return request({ method: 'GET', path: `/v1/compliance/reports/${enc(id)}` });
        },
      },
      /** `GET /v1/compliance/inactive_users/preview` — who the inactive-user policy would act on now. */
      inactiveUsersPreview(params: { limit?: number } = {}): Promise<InactiveUsersPreview> {
        return request({ method: 'GET', path: '/v1/compliance/inactive_users/preview', query: { ...params } });
      },
    },
    dsrConsole: {
      summary(): Promise<DsrConsoleSummary> {
        return request({ method: 'GET', path: '/v1/dsr_console/summary' });
      },
      /** Requests with triage filters (each is a data subject request with `assignee`, `priority` and `labels`). */
      requests(params: DsrConsoleFilter = {}): Promise<Page<Record<string, unknown>>> {
        return request({ method: 'GET', path: '/v1/dsr_console/requests', query: { ...params } });
      },
      triage(id: string, body: { assignee?: string | null; priority?: 'low' | 'normal' | 'high' | 'urgent'; labels?: string[] }): Promise<Record<string, unknown>> {
        return request({ method: 'PATCH', path: `/v1/data_subject_requests/${enc(id)}/triage`, body: rec({ ...body }) });
      },
      notes: {
        list(id: string): Promise<Page<DsrNote>> {
          return request({ method: 'GET', path: `/v1/data_subject_requests/${enc(id)}/notes` });
        },
        add(id: string, body: string, idempotencyKey?: string): Promise<DsrNote> {
          return request({ method: 'POST', path: `/v1/data_subject_requests/${enc(id)}/notes`, body: { body }, idempotencyKey });
        },
      },
      downstream: {
        get(id: string): Promise<DownstreamErasure> {
          return request({ method: 'GET', path: `/v1/data_subject_requests/${enc(id)}/downstream` });
        },
        /** Mark a manual connector done (or not applicable) for the request. */
        mark(id: string, connectorId: string, body: { status?: 'done' | 'not_applicable'; note?: string } = {}, idempotencyKey?: string): Promise<DownstreamErasure> {
          return request({ method: 'POST', path: `/v1/data_subject_requests/${enc(id)}/downstream/${enc(connectorId)}`, body, idempotencyKey });
        },
        /** Run (or retry) an automatic connector for the request; `dry_run` only proves the key works and deletes nothing. */
        run(id: string, connectorId: string, body: { dry_run?: boolean } = {}, idempotencyKey?: string): Promise<ErasureConnectorRun> {
          return request({ method: 'POST', path: `/v1/data_subject_requests/${enc(id)}/downstream/${enc(connectorId)}/run`, body, idempotencyKey });
        },
      },
    },
    erasureConnectors: {
      /** `GET /v1/erasure_connector_catalog` — known downstream systems and how a copy in each is erased. */
      catalog(): Promise<Page<ErasureCatalogEntry>> {
        return request({ method: 'GET', path: '/v1/erasure_connector_catalog' });
      },
      list(): Promise<Page<ErasureConnector>> {
        return request({ method: 'GET', path: '/v1/erasure_connectors' });
      },
      create(body: ErasureConnectorBody, idempotencyKey?: string): Promise<ErasureConnector> {
        return request({ method: 'POST', path: '/v1/erasure_connectors', body: rec({ ...body }), idempotencyKey });
      },
      get(id: string): Promise<ErasureConnector> {
        return request({ method: 'GET', path: `/v1/erasure_connectors/${enc(id)}` });
      },
      update(id: string, body: Omit<ErasureConnectorBody, 'key' | 'catalog_id'>): Promise<ErasureConnector> {
        return request({ method: 'PATCH', path: `/v1/erasure_connectors/${enc(id)}`, body: rec({ ...body }) });
      },
      delete(id: string): Promise<void> {
        return request({ method: 'DELETE', path: `/v1/erasure_connectors/${enc(id)}` });
      },
      /** A read-only call that proves the connector's saved vendor key works. */
      probe(id: string): Promise<{ object: 'erasure_connector_probe'; connector_id: string; vendor: string; ok: boolean; error: string | null }> {
        return request({ method: 'POST', path: `/v1/erasure_connectors/${enc(id)}/probe` });
      },
    },
    cookieConsents: {
      /** `GET /v1/cookie_consents` — the ledger, newest first. */
      list(params: Cursor & { user_id?: string; subject?: string } = {}): Promise<Page<CookieConsentEntry>> {
        return request({ method: 'GET', path: '/v1/cookie_consents', query: { ...params } });
      },
      summary(params: { days?: number } = {}): Promise<CookieConsentSummary> {
        return request({ method: 'GET', path: '/v1/cookie_consents/summary', query: { ...params } });
      },
      /** One visitor's current choice and history. */
      subject(subject: string): Promise<{ object: 'cookie_consent_subject'; subject: string; current: CookieConsentEntry; history: CookieConsentEntry[] }> {
        return request({ method: 'GET', path: `/v1/cookie_consents/subjects/${enc(subject)}` });
      },
      /** Erase one visitor's records. */
      eraseSubject(subject: string): Promise<{ object: 'cookie_consent_erasure'; removed: number }> {
        return request({ method: 'DELETE', path: `/v1/cookie_consents/subjects/${enc(subject)}` });
      },
      /** Erase the records linked to a user. */
      eraseUser(userId: string): Promise<{ object: 'cookie_consent_erasure'; removed: number }> {
        return request({ method: 'DELETE', path: `/v1/users/${enc(userId)}/cookie_consents` });
      },
    },
    policyDepth: {
      /** `GET /v1/policies/:id/audience` */
      audience(policy: string): Promise<PolicyAudience> {
        return request({ method: 'GET', path: `/v1/policies/${enc(policy)}/audience` });
      },
      /** `PUT /v1/policies/:id/audience` — everyone, or only the members of the listed organizations. */
      setAudience(policy: string, body: { audience: 'everyone' | 'orgs'; organization_ids?: string[] }): Promise<PolicyAudience> {
        return request({ method: 'PUT', path: `/v1/policies/${enc(policy)}/audience`, body: rec({ ...body }) });
      },
      translations: {
        list(policy: string, versionId: string): Promise<Page<PolicyTranslation>> {
          return request({ method: 'GET', path: `/v1/policies/${enc(policy)}/versions/${enc(versionId)}/translations` });
        },
        /** Add or replace one language of a version (a published version can gain languages, not change one). */
        put(policy: string, versionId: string, locale: string, body: { title?: string | null; content_markdown?: string; content_html?: string }): Promise<PolicyTranslation> {
          return request({ method: 'PUT', path: `/v1/policies/${enc(policy)}/versions/${enc(versionId)}/translations/${enc(locale)}`, body: rec({ ...body }) });
        },
        delete(policy: string, versionId: string, locale: string): Promise<{ object: 'policy_translation'; version_id: string; locale: string; deleted: true }> {
          return request({ method: 'DELETE', path: `/v1/policies/${enc(policy)}/versions/${enc(versionId)}/translations/${enc(locale)}` });
        },
      },
    },
    localizationReview: {
      /** `POST /v1/localizations/:id/review` */
      decide(id: string, body: { action: 'submit' | 'approve' | 'request_changes' | 'reopen'; note?: string | null; reviewer_hint?: string | null }): Promise<ReviewedLocalization> {
        return request({ method: 'POST', path: `/v1/localizations/${enc(id)}/review`, body: rec({ ...body }) });
      },
      history(id: string): Promise<Page<{ object: 'localization_review'; id: string; localization_id: string; action: string; from_status: ReviewStatus; to_status: ReviewStatus; actor: string | null; note: string | null; content_hash: string | null; created_at: string }>> {
        return request({ method: 'GET', path: `/v1/localizations/${enc(id)}/reviews` });
      },
      summary(): Promise<{ object: 'localization_review_summary'; counts: Record<ReviewStatus, number>; queue: ReviewedLocalization[]; changed_since_approval: ReviewedLocalization[] }> {
        return request({ method: 'GET', path: '/v1/localizations/review_summary' });
      },
      /** `POST /v1/localizations/check` — validate translations without saving (a CI step). */
      check(items: Array<{ resource_type: string; resource_name: string; locale: string; content: Record<string, unknown> }>, opts: { require_approved?: boolean } = {}): Promise<LocalizationCheckResult> {
        return request({ method: 'POST', path: '/v1/localizations/check', body: { items, ...opts } });
      },
    },
  };
}
