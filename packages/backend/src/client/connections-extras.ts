import { enc, type RequestFn } from './request';
import { relayAgentsOpsResource } from './relay-agents-ops';
import { connectionsOpsResource, type ConnectionsRelayBody, type ConnectionsRelayResult } from './connections-ops';

/** A page of a cursor list. */
export interface ConnectionsPage<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export type ConnectionActivityKind = 'relay' | 'token_read' | 'token_refresh' | 'token_exchange' | 'status' | 'provider_event' | 'reconnect_email' | 'reconnect_started';

export interface ConnectionActivityEntry {
  object: 'connection_activity';
  id: string;
  connection_id: string;
  kind: ConnectionActivityKind;
  outcome: 'ok' | 'error';
  /** Relay only. */
  method: string | null;
  /** Relay only: the host called. Never the path, query, headers or body. */
  host: string | null;
  http_status: number | null;
  duration_ms: number | null;
  attempts: number | null;
  actor: { type: string; id: string | null } | null;
  code: string | null;
  detail: Record<string, unknown>;
  created_at: number;
}

export interface ConnectionActivityQuery {
  /** 1 to 200 (default 50). */
  limit?: number;
  starting_after?: string;
  kind?: ConnectionActivityKind;
  outcome?: 'ok' | 'error';
  /** Epoch ms or ISO 8601. */
  since?: number | string;
}

export interface ConnectionProviderEvent {
  object: 'connection_provider_event';
  id: string;
  connection_id: string;
  provider: string;
  topic: string;
  kind: 'lifecycle' | 'business';
  code: string | null;
  summary: string | null;
  delivery_id: string | null;
  /** Only on the single-event read. */
  payload?: Record<string, unknown> | null;
  payload_truncated: boolean;
  normalized: Record<string, string> | null;
  received_at: number;
  replay_count: number;
  last_replayed_at: number | null;
}

export interface ConnectionProviderEventQuery {
  limit?: number;
  starting_after?: string;
  topic?: string;
  kind?: 'lifecycle' | 'business';
}

export interface ConnectionProviderPolicy {
  object: 'connection_provider_policy';
  provider: string;
  unique_external_id: boolean;
  has_webhook_secret: boolean;
  has_dev_id: boolean;
  /** The public URL to register at the provider for uninstall and revocation notices; null for a provider without one. */
  events_url: string | null;
  updated_at: number | null;
}

export interface ConnectionProviderPolicyBody {
  unique_external_id?: boolean;
  /** Write-only. null clears it. */
  webhook_secret?: string | null;
  /** eBay only. null clears it. */
  dev_id?: string | null;
}

export interface ConnectionProviderTopics {
  object: 'connection_provider_topics';
  topics: Record<string, string[]>;
}

export interface ConnectionProviderSubscriptions {
  object: 'connection_provider_subscriptions';
  connection_id: string;
  synced_at: number | null;
  topics: Record<string, { status: 'subscribed' | 'error'; error?: string }>;
}

export interface ConnectionRelayLimits {
  object: 'connection_relay_limits';
  request_bytes: number;
  response_bytes: number;
}

export interface ConnectionTokenLimits {
  object: 'connection_token_limits';
  window_seconds: number;
  conditional_factor: number;
  per_key: { limit: number; default: number; max: number; used: number };
  per_connection: { limit: number; default: number; max: number };
  per_app: { limit: number | null; max: number };
  providers: Record<string, { limit: number; used: number }>;
}

export interface ConnectionTokenLimitsBody {
  /** Requests per minute; null restores the default. */
  per_key?: number | null;
  per_connection?: number | null;
  per_app?: number | null;
  /** provider → requests per minute; null removes one. */
  providers?: Record<string, number | null> | null;
}

export interface ConnectionReconnectSettings {
  object: 'connection_reconnect_settings';
  enabled: boolean;
  link_ttl_hours: number;
  return_url: string | null;
  providers: string[];
}

export interface ConnectionReconnectSettingsBody {
  enabled?: boolean;
  /** 1 to 720 (default 168). */
  link_ttl_hours?: number;
  /** An https URL on an allowed origin; null = Atlas's own confirmation page. */
  return_url?: string | null;
  providers?: string[];
}

export interface ConnectionReconnectLink {
  object: 'connection_reconnect_link';
  connection_id: string;
  /** Shown once. */
  url: string;
  expires_at: number;
  emailed: number;
}

export interface ConnectionTokenExchange {
  object: 'connection_token_exchange';
  connection_id: string;
  exchanged: true;
  expires_at: number;
  refresh_expires_at: number | null;
}

/** Calls through a connection's relay, its size limits and the on-prem relay agents. */
export function relayResource(request: RequestFn) {
  const ops = connectionsOpsResource(request);
  return {
    /** Make a provider call server-side with the connection's credential (`POST /v1/connections/{id}/relay`). */
    call(connectionId: string, body: ConnectionsRelayBody, idempotencyKey?: string): Promise<ConnectionsRelayResult> {
      return ops.relay(connectionId, body, idempotencyKey);
    },
    /** The instance's relay request and response size limits. */
    getLimits(): Promise<ConnectionRelayLimits> {
      return request({ method: 'GET', path: '/v1/connections/relay_limits' });
    },
    /** Set the size limits (256 KiB request and 1 MiB response by default, up to 25 MiB each). */
    setLimits(body: { request_bytes?: number; response_bytes?: number }): Promise<ConnectionRelayLimits> {
      return request({ method: 'PUT', path: '/v1/connections/relay_limits', body });
    },
    /** The on-prem relay agents (the same operations as `relayAgents`). */
    agents: relayAgentsOpsResource(request),
  };
}

/** What Atlas asks a provider to send (business topics) and what it registered for a connection. */
export function providerSubscriptionsResource(request: RequestFn) {
  return {
    /** The business topics the instance subscribes connections to (Shopify orders/create, eBay ItemSold, ...). */
    getTopics(): Promise<ConnectionProviderTopics> {
      return request({ method: 'GET', path: '/v1/connection_provider_topics' });
    },
    /** Replace the topics: `{ shopify: [...], ebay: [...] }`. Sync existing connections afterwards. */
    setTopics(topics: Record<string, string[]>): Promise<ConnectionProviderTopics> {
      return request({ method: 'PUT', path: '/v1/connection_provider_topics', body: { topics } });
    },
    /** What was last registered at the provider for a connection, per topic. */
    get(connectionId: string): Promise<ConnectionProviderSubscriptions> {
      return request({ method: 'GET', path: `/v1/connections/${enc(connectionId)}/provider_subscriptions` });
    },
    /** Register the configured topics for a connection at the provider (idempotent). */
    sync(connectionId: string): Promise<ConnectionProviderSubscriptions> {
      return request({ method: 'POST', path: `/v1/connections/${enc(connectionId)}/provider_subscriptions/sync` });
    },
  };
}

/** Per-provider instance policy: one provider account per owner, and the secret provider notices are verified with. */
export function providerPolicyResource(request: RequestFn) {
  return {
    get(provider: string): Promise<ConnectionProviderPolicy> {
      return request({ method: 'GET', path: `/v1/connection_providers/${enc(provider)}/policy` });
    },
    set(provider: string, body: ConnectionProviderPolicyBody): Promise<ConnectionProviderPolicy> {
      return request({ method: 'PUT', path: `/v1/connection_providers/${enc(provider)}/policy`, body });
    },
    /** Back to the defaults. */
    delete(provider: string): Promise<void> {
      return request({ method: 'DELETE', path: `/v1/connection_providers/${enc(provider)}/policy` });
    },
  };
}

/** Verified provider events kept per connection: read them back and announce a missed one again. */
export function providerEventsResource(request: RequestFn) {
  return {
    /** One connection's events, newest first (no payloads). */
    list(connectionId: string, query?: ConnectionProviderEventQuery): Promise<ConnectionsPage<ConnectionProviderEvent>> {
      return request({ method: 'GET', path: `/v1/connections/${enc(connectionId)}/provider_events`, query: { ...query } });
    },
    /** Every connection's events, for catching up after a webhook outage. */
    listAll(query?: ConnectionProviderEventQuery): Promise<ConnectionsPage<ConnectionProviderEvent>> {
      return request({ method: 'GET', path: '/v1/connection_provider_event_log', query: { ...query } });
    },
    /** One event with its payload. */
    get(connectionId: string, eventId: string): Promise<ConnectionProviderEvent> {
      return request({ method: 'GET', path: `/v1/connections/${enc(connectionId)}/provider_events/${enc(eventId)}` });
    },
    /** Announce it again as `connection.provider_event` with `replayed: true`. Re-announces only. */
    replay(connectionId: string, eventId: string): Promise<ConnectionProviderEvent> {
      return request({ method: 'POST', path: `/v1/connections/${enc(connectionId)}/provider_events/${enc(eventId)}/replay` });
    },
  };
}

/** The connection rate and size limits of the instance. */
export function connectionLimitsResource(request: RequestFn) {
  return {
    getRelay(): Promise<ConnectionRelayLimits> {
      return request({ method: 'GET', path: '/v1/connections/relay_limits' });
    },
    setRelay(body: { request_bytes?: number; response_bytes?: number }): Promise<ConnectionRelayLimits> {
      return request({ method: 'PUT', path: '/v1/connections/relay_limits', body });
    },
    /** Token-read rate limits (per key, connection, app and provider) with this minute's usage. */
    getToken(): Promise<ConnectionTokenLimits> {
      return request({ method: 'GET', path: '/v1/connections/token_limits' });
    },
    setToken(body: ConnectionTokenLimitsBody): Promise<ConnectionTokenLimits> {
      return request({ method: 'PUT', path: '/v1/connections/token_limits', body });
    },
  };
}

/** Hosted reconnect: the settings, a link for a connection that needs the owner again, and the activity log. */
export function connectionReconnectResource(request: RequestFn) {
  return {
    getSettings(): Promise<ConnectionReconnectSettings> {
      return request({ method: 'GET', path: '/v1/connection_reconnect_settings' });
    },
    setSettings(body: ConnectionReconnectSettingsBody): Promise<ConnectionReconnectSettings> {
      return request({ method: 'PUT', path: '/v1/connection_reconnect_settings', body });
    },
    /** Mint a hosted reconnect link (returned once); `send_email` also emails the owner through your own mail provider. */
    createLink(connectionId: string, body: { send_email?: boolean; ttl_hours?: number } = {}, idempotencyKey?: string): Promise<ConnectionReconnectLink> {
      return request({ method: 'POST', path: `/v1/connections/${enc(connectionId)}/reconnect_link`, body, idempotencyKey });
    },
  };
}

/** Operations added to `connections` by this module: the activity log and the expiring-token exchange. */
export function connectionsActivityResource(request: RequestFn) {
  return {
    /** The connection's activity log, newest first: relay calls (method, host, status), refreshes, status changes, provider events. */
    activity(connectionId: string, query?: ConnectionActivityQuery): Promise<ConnectionsPage<ConnectionActivityEntry>> {
      return request({ method: 'GET', path: `/v1/connections/${enc(connectionId)}/activity`, query: { ...query } });
    },
    /** Swap a non-expiring token (Shopify offline) for an expiring one with a refresh token. */
    exchangeToken(connectionId: string): Promise<ConnectionTokenExchange> {
      return request({ method: 'POST', path: `/v1/connections/${enc(connectionId)}/token/exchange` });
    },
  };
}
