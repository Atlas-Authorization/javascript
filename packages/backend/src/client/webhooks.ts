import { enc, type RequestFn } from './request';

export interface WebhookEndpoint {
  object: 'webhook_endpoint';
  id: string;
  url: string;
  enabled_events: string[];
  active: boolean;
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
  attempt_number: number;
  status: string;
  http_status: number | null;
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

export function webhooksResource(request: RequestFn) {
  return {
    endpoints: {
      list(): Promise<{ data: WebhookEndpoint[]; has_more: false }> {
        return request({ method: 'GET', path: '/v1/webhook_endpoints' });
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
    deliveries(id: string): Promise<{ data: WebhookDelivery[]; has_more: false }> {
      return request({ method: 'GET', path: `/v1/webhook_endpoints/${enc(id)}/deliveries` });
    },
  };
}
