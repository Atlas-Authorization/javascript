import { enc, type QueryParams, type RequestFn } from './request';
import type { ListPage } from './types';

/* ------------------------------------------------------- provisioning --- */

/** Provisioning tags on a resource (`?metadata[key]=value` filters lists). */
export type ProvisioningMetadata = Record<string, string | number | boolean>;

/** The provisioning fields every tagged resource carries. */
export interface ProvisioningFields {
  metadata?: Record<string, unknown>;
  /** Your idempotent-create key. */
  external_ref?: string | null;
  /** On a create that sent a ref: true when the existing object was returned (200, no secret). */
  idempotent_replay?: boolean;
}

/** The create-body fields any provisioning create accepts. */
export interface ProvisioningInput {
  metadata?: ProvisioningMetadata;
  /** A stable key of your own: a repeat create with it returns the existing object. */
  external_ref?: string;
}

/** `{ product: 'x' }` → `{ 'metadata[product]': 'x' }` for a list query. */
export function metadataQuery(filter: Record<string, string | number | boolean> | undefined): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(filter ?? {})) out[`metadata[${k}]`] = String(v);
  return out;
}

/* ------------------------------------------------ notices & advisories --- */

export interface InstanceNotice {
  object: 'instance_notice';
  id: string;
  date: string;
  type: 'behavior_change' | 'deprecation' | 'new';
  tags: Array<'breaking' | 'behaviour' | 'security'>;
  title: string;
  summary: string;
  affects: string[];
  docs_url: string;
  changelog_id: string;
  applies: boolean;
  /** One sentence about this instance. */
  detail: string | null;
  count: number | null;
  first_seen_at: number | null;
  emailed_at: number | null;
  acknowledged_at: number | null;
}

export interface SecurityAdvisory {
  object: 'security_advisory';
  id: string;
  published: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  summary: string;
  affects: string[];
  fixed_on: string;
  action: string;
  docs_url: string;
  /** Absent on the public catalog. */
  applies?: boolean;
  detail?: string | null;
  count?: number | null;
  first_seen_at?: number | null;
  emailed_at?: number | null;
  acknowledged_at?: number | null;
}

export function noticesResource(request: RequestFn) {
  return {
    /** Behaviour changes that affect this instance; `all: true` includes ones that do not apply. */
    list(params: { all?: boolean } = {}): Promise<ListPage<InstanceNotice> & { unacknowledged: number; changelog_url: string }> {
      return request({ method: 'GET', path: '/v1/instance/notices', query: params.all ? { all: 'true' } : undefined });
    },
    acknowledge(id: string): Promise<InstanceNotice> {
      return request({ method: 'POST', path: `/v1/instance/notices/${enc(id)}/acknowledge` });
    },
  };
}

export function securityAdvisoriesResource(request: RequestFn) {
  return {
    /** Every advisory, with whether it applies to this instance. */
    list(): Promise<ListPage<SecurityAdvisory> & { applying: number }> {
      return request({ method: 'GET', path: '/v1/security_advisories' });
    },
    acknowledge(id: string): Promise<SecurityAdvisory> {
      return request({ method: 'POST', path: `/v1/security_advisories/${enc(id)}/acknowledge` });
    },
    /** The public catalog (no instance data). */
    catalog(): Promise<ListPage<SecurityAdvisory>> {
      return request({ method: 'GET', path: '/v1/public/security_advisories' });
    },
  };
}

/* ------------------------------------------------------ sub-processors --- */

export interface SubProcessor {
  object: 'sub_processor';
  id: string;
  name: string;
  role: 'atlas_sub_processor' | 'engaged_by_you';
  source:
    | 'atlas'
    | 'integration'
    | 'referral_platform'
    | 'consent_manager'
    | 'email_provider'
    | 'sms_provider'
    | 'log_stream'
    | 'audit_export'
    | 'webhook_endpoint';
  purpose: string;
  data: string[];
  location: string | null;
  enabled_by: string | null;
  url: string | null;
}

export interface SubProcessorList {
  object: 'sub_processor_view';
  instance_id: string;
  roles: Record<string, string>;
  data_region: string | null;
  processor: { name: string; role: string; url: string };
  atlas_sub_processors: SubProcessor[];
  engaged_by_you: SubProcessor[];
  dpa_url: string;
}

export function subProcessorsResource(request: RequestFn) {
  return {
    /** Who processes this instance's end-user data, and in which role. */
    get(): Promise<SubProcessorList> {
      return request({ method: 'GET', path: '/v1/instance/sub_processors' });
    },
  };
}

/* -------------------------------------------------------- audit export --- */

export type AuditExportType = 'webhook' | 's3';

export interface AuditExport {
  object: 'audit_export';
  id: string;
  name: string;
  type: AuditExportType;
  enabled: boolean;
  status: 'active' | 'failing';
  action_filter: string[] | null;
  /** Non-secret fields plus has_* markers. */
  destination: Record<string, string | boolean>;
  cursor: { id: string | null; created_at: number | null };
  consecutive_failures: number;
  last_error: string | null;
  last_delivered_at: number | null;
  exported_count: number;
  mandatory_actions: string[];
  /** Webhook exports, on create and rotateSecret only. */
  secret?: string;
  created_at: number;
  updated_at: number;
}

export type AuditExportDestination =
  | { url: string }
  | { endpoint: string; bucket: string; region?: string; prefix?: string; access_key_id: string; secret_access_key: string };

export interface CreateAuditExportBody {
  name: string;
  type: AuditExportType;
  destination: AuditExportDestination;
  /** Action names or prefixes; key and data-rights events are always exported. null = everything. */
  action_filter?: string[] | null;
  enabled?: boolean;
  /** Also export the last N hours (0–720). */
  backfill_hours?: number;
}

export interface UpdateAuditExportBody {
  name?: string;
  /** Merged; a secret left out is kept. */
  destination?: Partial<Record<string, string>>;
  action_filter?: string[] | null;
  enabled?: boolean;
}

/** An audit entry as the export sends it (CloudEvents 1.0, structured JSON). */
export interface AuditCloudEvent {
  specversion: '1.0';
  id: string;
  source: string;
  /** `net.atlasauth.audit.<action>` */
  type: string;
  subject?: string;
  time: string;
  datacontenttype: 'application/json';
  atlasinstance: string;
  data: {
    actor: { type: string; id: string | null; key_name: string | null; key_prefix: string | null };
    action: string;
    resource: { type: string | null; id: string | null } | null;
    org: { id: string } | null;
    trace: string | null;
    ip: string | null;
    metadata: Record<string, unknown>;
  };
}

export interface AuditExportTestResult {
  object: 'audit_export_test';
  id: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  location: string | null;
  event: AuditCloudEvent;
}

export function auditExportsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<AuditExport> & { mandatory_actions: string[] }> {
      return request({ method: 'GET', path: '/v1/audit_exports' });
    },
    get(id: string): Promise<AuditExport> {
      return request({ method: 'GET', path: `/v1/audit_exports/${enc(id)}` });
    },
    /** A webhook export's signing secret is in this response only. */
    create(body: CreateAuditExportBody, idempotencyKey?: string): Promise<AuditExport> {
      return request({ method: 'POST', path: '/v1/audit_exports', body, idempotencyKey });
    },
    update(id: string, body: UpdateAuditExportBody): Promise<AuditExport> {
      return request({ method: 'PATCH', path: `/v1/audit_exports/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'audit_export'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/audit_exports/${enc(id)}` });
    },
    /** Send one synthetic `audit_export.test` event now. */
    test(id: string): Promise<AuditExportTestResult> {
      return request({ method: 'POST', path: `/v1/audit_exports/${enc(id)}/test` });
    },
    rotateSecret(id: string): Promise<AuditExport> {
      return request({ method: 'POST', path: `/v1/audit_exports/${enc(id)}/rotate_secret` });
    },
  };
}
