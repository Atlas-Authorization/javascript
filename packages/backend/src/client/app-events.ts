import { enc, type RequestFn } from './request';
import type { ListPage } from './types';
import type {
  ListWebhookDeliveriesParams,
  WebhookBulkResult,
  WebhookDelivery,
  WebhookDeliveryQueued,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  WebhookTestResult,
  WebhookWindow,
} from './webhooks';

/**
 * Application webhooks: send YOUR app's own events (`call.completed`,
 * `invoice.paid`) to endpoints your customers (organizations) register.
 * Atlas signs them (Standard Webhooks), retries, tracks health, auto-disables
 * a dead endpoint and keeps the delivery log with redeliver and replay.
 *
 * ```ts
 * await atlas.appEvents.types.create({ type: 'call.completed', description: 'A call finished.' });
 * await atlas.appEvents.publish({ organization_id: org.id, type: 'call.completed', data: { call_id }, idempotency_key: call_id });
 * ```
 */

export interface AppEventType {
  object: 'app_event_type';
  id: string;
  type: string;
  description: string | null;
  /** JSON Schema every published `data` must match; null = any object. */
  schema: Record<string, unknown> | null;
  /** Still publishable; hidden from the endpoint picker. */
  deprecated: boolean;
  created_at: number;
  updated_at: number;
}

export interface CreateAppEventTypeBody {
  /** Lowercase dotted name, e.g. `call.completed`. */
  type: string;
  description?: string | null;
  schema?: Record<string, unknown> | null;
  deprecated?: boolean;
}

export type UpdateAppEventTypeBody = Omit<CreateAppEventTypeBody, 'type'>;

export interface PublishAppEventBody {
  /** The organization (your customer) whose endpoints receive the event. */
  organization_id?: string;
  /** Shorthand for `organization_id`. */
  org?: string;
  type: string;
  data: Record<string, unknown>;
  /** A repeat with the same key returns the first event and queues nothing (kept 90 days). */
  idempotency_key?: string;
}

export interface AppEvent {
  object: 'app_event';
  id: string;
  type: string;
  organization_id: string;
  data: Record<string, unknown>;
  idempotency_key: string | null;
  created_at: number;
}

export interface PublishedAppEvent extends AppEvent {
  /** true: an earlier publish with the same key; nothing new was queued. */
  idempotent_replay: boolean;
  /** First publish only: how many endpoints it was queued for, and which. */
  deliveries_queued?: number;
  endpoint_ids?: string[];
}

export interface AppWebhookEndpointBody {
  url?: string;
  /** Types from your catalog, or `['*']` (the default) for all of them. */
  enabled_events?: string[];
  description?: string | null;
  active?: boolean;
}

export function appEventsResource(request: RequestFn) {
  const base = (orgId: string) => `/v1/organizations/${enc(orgId)}/app_webhook_endpoints`;
  return {
    /** Publish one event to one organization's subscribed endpoints. */
    publish(body: PublishAppEventBody): Promise<PublishedAppEvent> {
      return request({ method: 'POST', path: '/v1/app_events', body });
    },
    /** One organization's published events, newest first. */
    list(query: { organization_id: string; type?: string; limit?: number; starting_after?: string }): Promise<ListPage<AppEvent>> {
      return request({ method: 'GET', path: '/v1/app_events', query });
    },
    get(eventId: string): Promise<AppEvent> {
      return request({ method: 'GET', path: `/v1/app_events/${enc(eventId)}` });
    },

    /** Your event catalog. */
    types: {
      list(): Promise<ListPage<AppEventType>> {
        return request({ method: 'GET', path: '/v1/app_event_types' });
      },
      create(body: CreateAppEventTypeBody): Promise<AppEventType> {
        return request({ method: 'POST', path: '/v1/app_event_types', body });
      },
      /** By `aet_` id or by name. */
      get(idOrType: string): Promise<AppEventType> {
        return request({ method: 'GET', path: `/v1/app_event_types/${enc(idOrType)}` });
      },
      update(idOrType: string, body: UpdateAppEventTypeBody): Promise<AppEventType> {
        return request({ method: 'PATCH', path: `/v1/app_event_types/${enc(idOrType)}`, body });
      },
      delete(idOrType: string): Promise<{ object: 'app_event_type'; id: string; type: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/app_event_types/${enc(idOrType)}` });
      },
    },

    /** One organization's endpoints for your events. */
    endpoints: {
      list(orgId: string): Promise<ListPage<WebhookEndpoint>> {
        return request({ method: 'GET', path: base(orgId) });
      },
      get(orgId: string, endpointId: string): Promise<WebhookEndpoint> {
        return request({ method: 'GET', path: `${base(orgId)}/${enc(endpointId)}` });
      },
      /** The `whsec_` secret is in this response only (or `revealSecret`). */
      create(orgId: string, body: AppWebhookEndpointBody & { url: string }): Promise<WebhookEndpointWithSecret> {
        return request({ method: 'POST', path: base(orgId), body });
      },
      update(orgId: string, endpointId: string, body: AppWebhookEndpointBody): Promise<WebhookEndpoint> {
        return request({ method: 'PATCH', path: `${base(orgId)}/${enc(endpointId)}`, body });
      },
      delete(orgId: string, endpointId: string): Promise<{ object: 'webhook_endpoint'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `${base(orgId)}/${enc(endpointId)}` });
      },
      /** The previous secret keeps signing for 24 hours. */
      rotateSecret(
        orgId: string,
        endpointId: string,
      ): Promise<{ object: 'webhook_secret'; secret: string; overlap_seconds: number; previous_secret_expires_at: number | null }> {
        return request({ method: 'POST', path: `${base(orgId)}/${enc(endpointId)}/rotate_secret` });
      },
      revealSecret(orgId: string, endpointId: string): Promise<{ object: 'webhook_secret'; secret: string }> {
        return request({ method: 'POST', path: `${base(orgId)}/${enc(endpointId)}/reveal_secret` });
      },
      /** `wait: '10s'` attempts it now and returns the result. */
      test(orgId: string, endpointId: string, opts: { wait?: string } = {}): Promise<WebhookTestResult | WebhookDeliveryQueued> {
        return request({ method: 'POST', path: `${base(orgId)}/${enc(endpointId)}/test`, query: opts });
      },
      deliveries(orgId: string, endpointId: string, query: ListWebhookDeliveriesParams = {}): Promise<ListPage<WebhookDelivery>> {
        return request({ method: 'GET', path: `${base(orgId)}/${enc(endpointId)}/deliveries`, query: query as Record<string, string | number | undefined> });
      },
      redeliver(orgId: string, endpointId: string, deliveryId: string): Promise<WebhookDeliveryQueued> {
        return request({ method: 'POST', path: `${base(orgId)}/${enc(endpointId)}/deliveries/${enc(deliveryId)}/redeliver` });
      },
      /** Re-send what the endpoint missed since `since` (or `'failing_since'`). */
      replay(orgId: string, endpointId: string, body: WebhookWindow & { event_type?: string }): Promise<WebhookBulkResult> {
        return request({ method: 'POST', path: `${base(orgId)}/${enc(endpointId)}/replay`, body });
      },
    },
  };
}
