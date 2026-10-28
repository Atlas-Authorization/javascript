import { type RequestFn } from './request';
import type { CursorPage, CursorParams } from './types';

/**
 * Your OWN audit events — actions in your product you want on an audit trail
 * (e.g. `invoice.sent`). Org-scoped events are streamed to that organization's
 * audit streams. Separate from `auditLogs`, which records what happened in Atlas.
 */
export interface CustomAuditEvent {
  object: 'audit_event';
  id: string;
  /** The org this event is scoped to, if any. */
  organization_id?: string | null;
  /** Your own actor vocabulary, e.g. `user`, `service`. */
  actor: { type?: string; id?: string | null };
  /** Your own action string, e.g. `invoice.sent`. */
  action: string;
  target: { type?: string | null; id?: string | null; name?: string | null };
  /** When it happened in your system (epoch ms). */
  occurred_at: number;
  metadata: unknown;
  /** The registered schema version this event satisfied; null when its action has no schema. */
  schema_version?: number | null;
  /** When Atlas received it (epoch ms). */
  created_at: number;
}

export interface CreateCustomAuditEventBody {
  actor: { type: string; id?: string };
  action: string;
  target?: { type?: string; id?: string; name?: string };
  /** Scope to an org (and stream to its SIEM). An unknown org id is a 404. */
  organization_id?: string;
  /** Epoch ms NUMBER; defaults to now. */
  occurred_at?: number;
  /** Non-secret structured context. */
  metadata?: Record<string, unknown>;
  /** Pin to a registered schema version; default the latest active one for the action. */
  schema_version?: number;
}

/** Shared filters of the list and export endpoints. */
export interface CustomAuditEventFilters {
  /** Omit to query across all organizations (a blank value is a 400). */
  organization_id?: string;
  /** One id, or a comma-separated list (matches any). */
  actor_id?: string;
  /** One action, or a comma-separated list. */
  action?: string;
  /** One type, or a comma-separated list. */
  target_type?: string;
  /** One id, or a comma-separated list. */
  target_id?: string;
  /** Inclusive lower bound of occurred_at (epoch ms). */
  from?: number;
  /** Upper bound of occurred_at (epoch ms). */
  to?: number;
  /** OR the actor_id / target_type / target_id filters instead of AND. */
  any_of?: boolean;
  /** Give together with `metadata_value`: match events whose metadata[key] equals the value. */
  metadata_key?: string;
  metadata_value?: string;
}

export interface ListCustomAuditEventsParams extends CustomAuditEventFilters, CursorParams {}

export interface ExportCustomAuditEventsParams extends CustomAuditEventFilters {
  /** `jsonl` (default) or `csv`. */
  format?: 'jsonl' | 'csv';
  starting_after?: string;
}

export function auditEventsResource(request: RequestFn) {
  return {
    create(body: CreateCustomAuditEventBody, idempotencyKey?: string): Promise<CustomAuditEvent> {
      return request({ method: 'POST', path: '/v1/audit_events', body, idempotencyKey });
    },
    /** Up to 100 events, stored atomically (one bad org id fails the whole batch). */
    createBatch(
      events: CreateCustomAuditEventBody[],
      idempotencyKey?: string,
    ): Promise<{ object: 'list'; data: CustomAuditEvent[] }> {
      return request({
        method: 'POST',
        path: '/v1/audit_events/batch',
        body: { events },
        idempotencyKey,
      });
    },
    /** Newest first, cursor-paginated. */
    list(params: ListCustomAuditEventsParams = {}): Promise<CursorPage<CustomAuditEvent>> {
      return request({ method: 'GET', path: '/v1/audit_events', query: { ...params } });
    },
    /**
     * Every matching event in one response, as text: JSONL (one event per line;
     * a capped export ends with a `{"truncated":true,…}` line) or CSV.
     */
    export(params: ExportCustomAuditEventsParams = {}): Promise<string> {
      return request({
        method: 'GET',
        path: '/v1/audit_events/export',
        query: { ...params },
        raw: true,
      });
    },
    /**
     * Test-mode reset: delete the custom audit events of a DEVELOPMENT instance,
     * optionally only one org's and/or one action's. A production instance is a 403.
     */
    deleteAll(
      params: { organization_id?: string; action?: string } = {},
    ): Promise<{ object: 'audit_events.bulk_delete'; deleted: number }> {
      return request({ method: 'DELETE', path: '/v1/audit_events', query: { ...params } });
    },
  };
}

/** A registered audit event schema: what an action's events must look like. */
export interface AuditEventSchema {
  object: 'audit_event_schema';
  id: string;
  action: string;
  version: number;
  description: string | null;
  /** Allowed `target.type` values (empty = any). */
  target_types: string[];
  /** Allowed `actor.type` values (empty = any). */
  actor_types: string[];
  /** A JSON Schema the event's metadata must satisfy. */
  metadata_schema: Record<string, unknown>;
  status: 'active' | 'deprecated';
  created_at: number;
}

export interface RegisterAuditEventSchemaBody {
  action: string;
  /** Defaults to the next version for the action; a version is immutable. */
  version?: number;
  description?: string;
  target_types?: string[];
  actor_types?: string[];
  metadata_schema?: Record<string, unknown>;
}

export function auditEventSchemasResource(request: RequestFn) {
  return {
    list(): Promise<{ object: 'list'; data: AuditEventSchema[]; has_more: false }> {
      return request({ method: 'GET', path: '/v1/audit_event_schemas' });
    },
    get(id: string): Promise<AuditEventSchema> {
      return request({ method: 'GET', path: `/v1/audit_event_schemas/${encodeURIComponent(id)}` });
    },
    /** Events with this action are validated against it from now on. Change a schema by registering a new version. */
    register(body: RegisterAuditEventSchemaBody): Promise<AuditEventSchema> {
      return request({ method: 'POST', path: '/v1/audit_event_schemas', body });
    },
    update(id: string, body: { description?: string | null; status?: 'active' | 'deprecated' }): Promise<AuditEventSchema> {
      return request({ method: 'PATCH', path: `/v1/audit_event_schemas/${encodeURIComponent(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'audit_event_schema'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/audit_event_schemas/${encodeURIComponent(id)}` });
    },
    /** Blank fields of one event (`actor_id`, `target_id`, `target_name`, `metadata.<path>`); logged, never deleted. */
    redact(eventId: string, body: { fields: string[]; reason: string }): Promise<{ object: 'audit_event_redaction'; event_id: string; redacted: string[]; unchanged: string[]; reason: string }> {
      return request({ method: 'POST', path: `/v1/audit_events/${encodeURIComponent(eventId)}/redact`, body });
    },
    redactions(eventId: string): Promise<{ object: 'list'; data: Array<{ id: string; event_id: string; fields: string[]; reason: string; redacted_by: string | null; created_at: number }>; has_more: false }> {
      return request({ method: 'GET', path: `/v1/audit_events/${encodeURIComponent(eventId)}/redactions` });
    },
  };
}
