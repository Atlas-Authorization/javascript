import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** An action over a connection: a typed provider operation. */
export interface ConnectionAction {
  object: 'connection_action';
  provider: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  method: string;
  mutating: boolean;
  scopes: string[];
  source: 'first_party' | 'custom';
}

export interface ConnectionActionResult {
  object: 'connection_action_result';
  action: string;
  connection_id: string;
  ok: boolean;
  status: number | null;
  data: unknown;
  error: string | null;
  truncated: boolean;
  attempts: number;
  dry_run?: Record<string, unknown>;
}

/** A custom action definition: data only (input schema, request template, response mapping). */
export interface ConnectionActionDefinition {
  description: string;
  input?: Record<string, unknown>;
  request: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; base_url: string; path: string; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> };
  response?: { path?: string; ok_field?: string; error_field?: string };
  scopes?: string[];
  paginate?: Record<string, unknown>;
  mutating?: boolean;
}

export interface ConnectionTrigger {
  object: 'connection_trigger';
  id: string;
  connection_id: string;
  event: string;
  mode: 'webhook' | 'poll';
  filter: Record<string, string>;
  target_url: string | null;
  status: 'active' | 'paused' | 'failed';
  provider_registered: boolean;
  ingress_url: string | null;
  poll: Record<string, unknown> | null;
  next_poll_at: number | null;
  last_error: string | null;
  last_fired_at: number | null;
  fired_count: number;
  /** Shown once on creation of a webhook trigger. */
  forward_secret?: string;
  created_at: number;
}

export interface CreateConnectionTriggerBody {
  event: string;
  mode?: 'webhook' | 'poll';
  filter?: Record<string, string>;
  target_url?: string;
  scheme?: string;
  signing_secret?: string;
  options?: Record<string, string>;
  poll?: { action: string; input?: Record<string, unknown>; items_path?: string; id_field: string; interval_seconds?: number };
}

/** Typed actions over connections, provider event triggers, scoped relay tokens and usage records. */
export function connectionActionsResource(request: RequestFn) {
  return {
    catalog: {
      list(query: { provider?: string } = {}): Promise<ListPage<ConnectionAction>> {
        return request({ method: 'GET', path: '/v1/connection_actions', query: { ...query } });
      },
      get(provider: string, name: string): Promise<ConnectionAction> {
        return request({ method: 'GET', path: `/v1/connection_actions/${enc(provider)}/${enc(name)}` });
      },
      /** Define or replace a custom action (data, never code). */
      define(provider: string, name: string, body: ConnectionActionDefinition): Promise<ConnectionAction> {
        return request({ method: 'PUT', path: `/v1/connection_actions/${enc(provider)}/${enc(name)}`, body });
      },
      delete(provider: string, name: string): Promise<void> {
        return request({ method: 'DELETE', path: `/v1/connection_actions/${enc(provider)}/${enc(name)}` });
      },
    },
    /** The actions available on one connection. */
    list(connectionId: string): Promise<ListPage<ConnectionAction>> {
      return request({ method: 'GET', path: `/v1/connections/${enc(connectionId)}/actions` });
    },
    run(connectionId: string, name: string, body: { input?: Record<string, unknown>; dry_run?: boolean; all_pages?: boolean; redirect_url?: string; connect_user_id?: string } = {}): Promise<ConnectionActionResult> {
      return request({ method: 'POST', path: `/v1/connections/${enc(connectionId)}/actions/${enc(name)}`, body });
    },
    triggers: {
      list(connectionId: string): Promise<ListPage<ConnectionTrigger>> {
        return request({ method: 'GET', path: `/v1/connections/${enc(connectionId)}/triggers` });
      },
      create(connectionId: string, body: CreateConnectionTriggerBody): Promise<ConnectionTrigger> {
        return request({ method: 'POST', path: `/v1/connections/${enc(connectionId)}/triggers`, body });
      },
      get(connectionId: string, triggerId: string): Promise<ConnectionTrigger> {
        return request({ method: 'GET', path: `/v1/connections/${enc(connectionId)}/triggers/${enc(triggerId)}` });
      },
      setStatus(connectionId: string, triggerId: string, status: 'active' | 'paused'): Promise<ConnectionTrigger> {
        return request({ method: 'PATCH', path: `/v1/connections/${enc(connectionId)}/triggers/${enc(triggerId)}`, body: { status } });
      },
      delete(connectionId: string, triggerId: string): Promise<{ object: 'connection_trigger'; id: string; deleted: true; provider_unregistered: boolean | null }> {
        return request({ method: 'DELETE', path: `/v1/connections/${enc(connectionId)}/triggers/${enc(triggerId)}` });
      },
    },
    /** A signed credential for one connection that only works through the relay, for listed methods and URL prefixes. */
    mintScopedToken(connectionId: string, body: { url_prefixes: string[]; methods?: string[]; ttl_seconds?: number }): Promise<{ object: 'connection_scoped_token'; connection_id: string; token: string; expires_at: number; methods: string[]; url_prefixes: string[] }> {
      return request({ method: 'POST', path: `/v1/connections/${enc(connectionId)}/scoped_tokens`, body });
    },
    /** Calls through connections, agent connection use and gateway calls, counted from the audit trail. */
    usage(query: { from?: string | number; to?: string | number; group_by?: 'action' | 'day' | 'agent' | 'connection' } = {}): Promise<{ object: 'list'; from: number; to: number; group_by: string; data: Array<{ object: 'connection_usage'; key: string | null; calls: number }> }> {
      return request({ method: 'GET', path: '/v1/usage/connections', query: { ...query } });
    },
  };
}

export interface AgentLifecycle {
  object: 'agent_lifecycle';
  agent_id: string;
  sponsor_user_id: string | null;
  backup_sponsor_user_id: string | null;
  expires_at: number | null;
  renewed_at: number | null;
  renewal_count: number;
}

export interface AgentAccessReview {
  object: 'agent_access_review';
  id: string;
  name: string;
  status: 'open' | 'closed';
  due_at: number | null;
  created_at: number;
  closed_at: number | null;
  item_count?: number;
}

export interface AgentAccessReviewItem {
  object: 'agent_access_review_item';
  id: string;
  review_id: string;
  agent_id: string;
  kind: string;
  resource: string;
  reviewer_user_id: string | null;
  decision: 'pending' | 'certified' | 'revoked';
  decided_by: string | null;
  decided_at: number | null;
  comment: string | null;
  revoked_applied: boolean;
}

/** Agent governance: sponsors, expiry and renewal, the activity log, and access reviews of agents' grants. */
export function agentGovernanceResource(request: RequestFn) {
  return {
    lifecycle: {
      get(agentId: string): Promise<AgentLifecycle> {
        return request({ method: 'GET', path: `/v1/agents/${enc(agentId)}/lifecycle` });
      },
      set(agentId: string, body: { sponsor_user_id?: string | null; backup_sponsor_user_id?: string | null; expires_at?: number | string | null }): Promise<AgentLifecycle> {
        return request({ method: 'PUT', path: `/v1/agents/${enc(agentId)}/lifecycle`, body });
      },
      renew(agentId: string, extendDays: number): Promise<AgentLifecycle> {
        return request({ method: 'POST', path: `/v1/agents/${enc(agentId)}/renew`, body: { extend_days: extendDays } });
      },
    },
    activity(agentId: string, query: { since?: string | number; before?: string | number; limit?: number } = {}): Promise<ListPage<{ object: 'agent_activity'; id: string; action: string; target_type: string | null; target_id: string | null; metadata: Record<string, unknown>; at: number }>> {
      return request({ method: 'GET', path: `/v1/agents/${enc(agentId)}/activity`, query: { ...query } });
    },
    reviews: {
      list(): Promise<ListPage<AgentAccessReview>> {
        return request({ method: 'GET', path: '/v1/agent_access_reviews' });
      },
      start(body: { name: string; due_at?: number | string | null; tier?: 'trusted' | 'untrusted'; kind?: 'tool' | 'connection' }): Promise<AgentAccessReview> {
        return request({ method: 'POST', path: '/v1/agent_access_reviews', body });
      },
      get(id: string, query: { decision?: 'pending' | 'certified' | 'revoked'; reviewer_user_id?: string } = {}): Promise<AgentAccessReview & { items: AgentAccessReviewItem[] }> {
        return request({ method: 'GET', path: `/v1/agent_access_reviews/${enc(id)}`, query: { ...query } });
      },
      decide(id: string, itemId: string, body: { decision: 'certified' | 'revoked'; comment?: string; decided_by?: string }): Promise<AgentAccessReviewItem> {
        return request({ method: 'POST', path: `/v1/agent_access_reviews/${enc(id)}/items/${enc(itemId)}/decide`, body });
      },
      close(id: string): Promise<AgentAccessReview> {
        return request({ method: 'POST', path: `/v1/agent_access_reviews/${enc(id)}/close` });
      },
    },
  };
}

export interface McpRegistryEntry {
  object: 'mcp_registry_entry';
  id: string;
  name: string;
  url: string;
  description: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requested_by: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
}

/** The registry of approved upstream MCP servers, and write elevations for the admin MCP server. */
export function mcpRegistryResource(request: RequestFn) {
  return {
    list(query: { status?: 'pending' | 'approved' | 'rejected' } = {}): Promise<ListPage<McpRegistryEntry>> {
      return request({ method: 'GET', path: '/v1/mcp_registry', query: { ...query } });
    },
    add(body: { name: string; url: string; description?: string; status?: 'approved' | 'pending' }): Promise<McpRegistryEntry> {
      return request({ method: 'POST', path: '/v1/mcp_registry', body });
    },
    decide(id: string, status: 'approved' | 'rejected'): Promise<McpRegistryEntry> {
      return request({ method: 'POST', path: `/v1/mcp_registry/${enc(id)}/decide`, body: { status } });
    },
    remove(id: string): Promise<{ object: 'mcp_registry_entry'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/mcp_registry/${enc(id)}` });
    },
    /** Grant another API key a short write elevation over the admin MCP server. */
    elevate(body: { api_key_id: string; ttl_seconds?: number; reason?: string }): Promise<{ object: 'mcp_elevation'; api_key_id: string; token: string; expires_at: number; header: string }> {
      return request({ method: 'POST', path: '/v1/mcp/elevations', body });
    },
  };
}

export interface TelemetryExport {
  object: 'telemetry_export';
  enabled: boolean;
  endpoint: string | null;
  /** Headers are write-only. */
  has_headers: boolean;
  service_name: string;
  traces: boolean;
  metrics: boolean;
}

/** OTLP/HTTP export of gateway and relay calls (spans and metrics) to your collector. */
export function telemetryExportResource(request: RequestFn) {
  return {
    get(): Promise<TelemetryExport> {
      return request({ method: 'GET', path: '/v1/telemetry_export' });
    },
    update(body: { enabled?: boolean; endpoint?: string; headers?: Record<string, string> | null; service_name?: string; traces?: boolean; metrics?: boolean }): Promise<TelemetryExport> {
      return request({ method: 'PUT', path: '/v1/telemetry_export', body });
    },
    /** Send one test span now. */
    test(): Promise<{ object: 'telemetry_export_test'; ok: boolean; error: string | null }> {
      return request({ method: 'POST', path: '/v1/telemetry_export/test' });
    },
  };
}
