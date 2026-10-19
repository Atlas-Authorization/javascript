import { enc, type RequestFn } from './request';

export interface WebhookEndpoint {
  object: 'webhook_endpoint';
  id: string;
  url: string;
  enabled_events: string[];
  active: boolean;
  /** Start of the current failure streak (epoch ms), or null when the last delivery succeeded. */
  failing_since?: number | null;
  disabled_at: number | null;
  created_at: number;
}

/** Create reveals the signing secret (`whsec_...`) exactly once. */
export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  secret: string;
}

export interface WebhookDelivery {
  object: 'webhook_delivery';
  id: string;
  event_id: string;
  /** The event type, or null once the event has passed its retention. */
  event_type?: string | null;
  attempt_number: number;
  max_attempts?: number;
  /** The payload that was sent (null once the event has passed its retention). */
  payload?: unknown;
  status: string;
  http_status: number | null;
  /**
   * Why the attempt failed: `webhook_redirect_not_followed` (see `location`),
   * `webhook_http_error`, `webhook_timeout`, `webhook_network_error` or
   * `webhook_url_blocked`. Null on success or while pending.
   */
  error?: string | null;
  /** The absolute `Location` of a 3xx answer. Not followed. */
  location?: string | null;
  response_snippet: string | null;
  next_retry_at: number | null;
  delivered_at: number | null;
  created_at: number;
}

export interface CreateWebhookEndpointBody {
  url: string;
  /** Each entry is `"*"` or a known event name. */
  enabled_events?: string[];
}

/** Change an endpoint in place. The signing secret is kept. */
export interface UpdateWebhookEndpointBody {
  url?: string;
  enabled_events?: string[];
  active?: boolean;
}

/** One subscribable event, described. */
export interface WebhookEventCatalogEntry {
  name: string;
  description: string;
  /** Who should act on it, e.g. `rp_sessions`, `rp_accounts`, `dsar`. Empty: no relying party needs it. */
  relevant_for: string[];
  /** Set on a superseded spelling: subscribe to this event instead. */
  deprecated_alias_of?: string;
}

/** The endpoint list plus the delivery settings that apply to every endpoint. */
export interface WebhookEndpointList {
  object?: 'list';
  data: WebhookEndpoint[];
  has_more: boolean;
  next_cursor?: string | null;
  /** Every event type an endpoint can subscribe to. */
  available_events?: string[];
  /** The same events as `available_events`, each described. */
  event_catalog?: WebhookEventCatalogEntry[];
  /** Every value `relevant_for` can hold. */
  event_audiences?: string[];
  /** The delay before each retry, in milliseconds. */
  retry_schedule_ms?: number[];
  /** Delivery attempts per event before it is marked failed. */
  max_attempts?: number;
}

export interface WebhookSigningSecret {
  object: 'webhook_secret';
  /** The `whsec_...` signing secret. */
  secret: string;
  warning?: string;
}

/** A queued delivery (from `test` or `redeliver`). */
export interface WebhookDeliveryQueued {
  object: 'webhook_delivery';
  id: string;
  event_id: string;
  status: string;
  note: string;
}

export interface ListWebhookDeliveriesParams {
  /** How many deliveries to return (1–100, default 50). */
  limit?: number;
}

export function webhooksResource(request: RequestFn) {
  return {
    endpoints: {
      list(): Promise<WebhookEndpointList> {
        return request({ method: 'GET', path: '/v1/webhook_endpoints' });
      },
      /** Update url, enabled_events or active. The signing secret is kept. */
      update(id: string, body: UpdateWebhookEndpointBody): Promise<WebhookEndpoint> {
        return request({ method: 'PATCH', path: `/v1/webhook_endpoints/${enc(id)}`, body });
      },
      /** Show the current signing secret again. Audited. */
      revealSecret(id: string): Promise<WebhookSigningSecret> {
        return request({ method: 'POST', path: `/v1/webhook_endpoints/${enc(id)}/reveal_secret` });
      },
      /** Rotate the signing secret; the new one is revealed exactly once. */
      rotateSecret(id: string): Promise<WebhookSigningSecret> {
        return request({ method: 'POST', path: `/v1/webhook_endpoints/${enc(id)}/rotate_secret` });
      },
      /** Send a synthetic `webhook.test` event to this endpoint only. */
      test(id: string): Promise<WebhookDeliveryQueued> {
        return request({ method: 'POST', path: `/v1/webhook_endpoints/${enc(id)}/test` });
      },
      /** Redeliver a past event as a fresh attempt (409 once past its retention). */
      redeliver(id: string, deliveryId: string): Promise<WebhookDeliveryQueued> {
        return request({
          method: 'POST',
          path: `/v1/webhook_endpoints/${enc(id)}/deliveries/${enc(deliveryId)}/redeliver`,
        });
      },
      create(
        body: CreateWebhookEndpointBody,
        idempotencyKey?: string,
      ): Promise<WebhookEndpointWithSecret> {
        return request({ method: 'POST', path: '/v1/webhook_endpoints', body, idempotencyKey });
      },
      delete(
        id: string,
      ): Promise<{ object: 'webhook_endpoint'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/webhook_endpoints/${enc(id)}` });
      },
    },
    /** Delivery log for an endpoint. */
    deliveries(
      id: string,
      params: ListWebhookDeliveriesParams = {},
    ): Promise<{ data: WebhookDelivery[]; has_more: boolean; next_cursor?: string | null }> {
      return request({
        method: 'GET',
        path: `/v1/webhook_endpoints/${enc(id)}/deliveries`,
        query: { ...params },
      });
    },
    /** Redeliver a past event (same as `endpoints.redeliver`). */
    redeliver(endpointId: string, deliveryId: string): Promise<WebhookDeliveryQueued> {
      return request({
        method: 'POST',
        path: `/v1/webhook_endpoints/${enc(endpointId)}/deliveries/${enc(deliveryId)}/redeliver`,
      });
    },
  };
}
