import { metadataQuery, type ProvisioningFields, type ProvisioningInput, type ProvisioningMetadata } from './compliance';
import { enc, type RequestFn } from './request';

export type WebhookDestinationType = 'https' | 'aws_eventbridge' | 'gcp_pubsub' | 'cloudflare_queue' | 'segment' | 'ga4' | 'mixpanel' | 'posthog' | 'amplitude' | 'customerio' | 'slack';

/** Where deliveries go. Credentials are never returned. */
export type WebhookDestination =
  | { type: 'https' }
  | { type: 'aws_eventbridge'; region: string; event_bus_name: string; source?: string }
  | { type: 'gcp_pubsub'; project_id: string; topic_id: string }
  | { type: 'cloudflare_queue'; account_id: string; queue_id: string }
  | ({ type: 'segment' | 'mixpanel' | 'posthog' | 'amplitude' | 'customerio'; region?: 'us' | 'eu' } & AnalyticsOptions)
  | ({ type: 'ga4'; measurement_id: string } & AnalyticsOptions)
  | ({ type: 'slack' } & AnalyticsOptions);

/** Shared by the analytics and messaging destinations: person-identifying fields are dropped unless `include_pii`. */
export interface AnalyticsOptions {
  include_pii?: boolean;
  /** Rename events: `{ 'user.created': 'Signed Up' }`. */
  event_map?: Record<string, string>;
}

/** Your own credentials for an event destination (stored encrypted, write-only). */
export type WebhookDestinationCredentials =
  | { access_key_id: string; secret_access_key: string; session_token?: string }
  | { service_account_json: string | Record<string, unknown> }
  | { api_token: string }
  | { write_key: string }
  | { api_secret: string }
  | { project_token: string }
  | { project_api_key: string }
  | { api_key: string }
  | { site_id: string; api_key: string }
  | { webhook_url: string };

export interface WebhookLastFailure {
  at: number;
  status: number | null;
  error: string | null;
}

export interface WebhookAutoDisableRule {
  after_failing_ms: number;
  after_consecutive_failures: number;
  consecutive_failures_min_failing_ms: number;
  description: string;
}

export interface WebhookRetention {
  events_days: number;
  delivery_log_days: number;
  replay_window_days: number;
}

export interface WebhookEndpoint extends ProvisioningFields {
  object: 'webhook_endpoint';
  id: string;
  /** The HTTPS receiver, or a descriptor such as `aws-eventbridge://us-east-1/default`. */
  url: string;
  description?: string | null;
  enabled_events: string[];
  /** Which names `*` delivers under. */
  event_naming?: 'canonical' | 'legacy';
  active: boolean;
  /** A third-party receiver: preflight does not flag its host. */
  external?: boolean;
  signature_versions?: Array<'v1' | 'v2'>;
  destination?: WebhookDestination & { credentials_set?: boolean };
  health?: 'healthy' | 'failing' | 'disabled';
  /** Start of the current failure streak (epoch ms), or null when the last delivery succeeded. */
  failing_since?: number | null;
  /** Start of the streak that preceded the last re-enable (epoch ms); what `since: 'failing_since'` resolves to once the live streak is cleared. */
  last_failing_since?: number | null;
  disabled_at: number | null;
  last_success_at?: number | null;
  last_failure?: WebhookLastFailure | null;
  consecutive_failures?: number;
  /** Share of attempts in the last 24 hours that succeeded (0–1), null with none. */
  success_rate_24h?: number | null;
  attempts_24h?: { succeeded: number; failed: number };
  /** Who is emailed when it fails; null = the account's owners. */
  alert_contacts?: string[] | null;
  alerts_sent?: { first_sent_at: number | null; second_sent_at: number | null; disabled_sent_at: number | null };
  auto_disable?: WebhookAutoDisableRule;
  /** On an update that re-enabled the endpoint: the replay that re-sends what it missed. */
  replay?: { since: number; method: 'POST'; path: string; note: string } | null;
  /** On create / upsert: whether this call created it. */
  created?: boolean;
  updated_at?: number;
  /**
   * While a secret rotation overlap is open: when the previous secret stops
   * signing deliveries (epoch ms). Until then every delivery carries two
   * signatures, one per secret. Null otherwise.
   */
  previous_secret_expires_at?: number | null;
  created_at: number;
}

/**
 * What a response sealed with `X-Secret-Recipient` (the client's
 * `secretRecipient` option) says it sealed: each listed field arrives as
 * `sealed_<field>` instead of in plaintext.
 */
export interface SecretsSealed {
  algorithm: string;
  recipient: string;
  fields: string[];
}

/**
 * Create reveals the signing secret (`whsec_...`) exactly once. With a
 * `secretRecipient` it arrives as `sealed_secret` (open it with
 * `openSealedSecret`) and `secret` is absent.
 */
export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  secret: string;
  sealed_secret?: string;
  secrets_sealed?: SecretsSealed;
}

export interface WebhookDelivery {
  object: 'webhook_delivery';
  id: string;
  event_id: string;
  /** The name the event was delivered as, or null once the event has passed its retention. */
  event_type?: string | null;
  latency_ms?: number | null;
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

export interface WebhookEndpointSettings {
  /** Each entry is `"*"` or an event name (canonical or a deprecated spelling). */
  enabled_events?: string[];
  event_naming?: 'canonical' | 'legacy';
  external?: boolean;
  signature_versions?: Array<'v1' | 'v2'>;
  /** Up to 20 addresses; null = the account's owners. */
  alert_contacts?: string[] | null;
  description?: string | null;
  /** An event destination instead of an HTTPS url. */
  destination?: WebhookDestination;
  destination_credentials?: WebhookDestinationCredentials;
}

export interface CreateWebhookEndpointBody extends WebhookEndpointSettings, ProvisioningInput {
  /** Required unless `destination` is an event destination. */
  url?: string;
}

/** Change an endpoint in place. The signing secret is kept. */
export interface UpdateWebhookEndpointBody extends WebhookEndpointSettings {
  url?: string;
  active?: boolean;
  /** Replaces the provisioning metadata. */
  metadata?: ProvisioningMetadata;
}

/** Find-or-create by url. */
export interface UpsertWebhookEndpointBody extends WebhookEndpointSettings {
  url: string;
}

/** The inline result of `test(id, { wait })`. */
export interface WebhookTestResult {
  object: 'webhook_test_result';
  delivery_id: string;
  event_id: string;
  status: 'success' | 'failed';
  http_status: number | null;
  latency_ms: number | null;
  response_snippet: string | null;
  error: string | null;
  signature_header_sent: string | null;
  will_retry: boolean;
}

export interface WebhookWindow {
  /** Epoch ms or ISO 8601 (at most 90 days ago), or the keyword `'failing_since'` for the endpoint's own failure streak. */
  since?: number | string;
  until?: number | string;
}

export interface WebhookBulkResult {
  object: 'webhook_redelivery' | 'webhook_replay';
  endpoint_id: string;
  queued: number;
  events_considered?: number;
  has_more: boolean;
  /** Pass as `since` to continue. */
  next_since: number | null;
  retention: WebhookRetention;
}

export interface EgressIps {
  object: 'egress_ips';
  /** false: this deployment does not send from fixed addresses. */
  static: boolean;
  ipv4: string[];
  ipv6: string[];
  applies_to: string[];
  note: string;
}

export type DeliveryTargetKind = 'webhook_endpoint' | 'referral_connection' | 'backchannel_receiver' | 'integration';

export interface DeliveryHealth {
  object: 'delivery_health';
  kind: DeliveryTargetKind;
  target_id: string;
  url: string | null;
  label: string | null;
  state: 'healthy' | 'failing' | 'disabled';
  failing_since: number | null;
  disabled_at: number | null;
  last_success_at: number | null;
  last_failure: WebhookLastFailure | null;
  consecutive_failures: number;
  success_rate_24h: number | null;
  attempts_24h: { succeeded: number; failed: number };
  alert_contacts: string[] | null;
  alerts: { first_sent_at: number | null; second_sent_at: number | null; disabled_sent_at: number | null };
}

/** One subscribable event, described. */
export interface WebhookEventCatalogEntry {
  name: string;
  description: string;
  /** Who should act on it, e.g. `rp_sessions`, `rp_accounts`, `dsar`. Empty: no relying party needs it. */
  relevant_for: string[];
  /** Set on a deprecated spelling: subscribe to this canonical event instead. */
  deprecated_alias_of?: string;
  /** `rename`: sent whenever the canonical event is; `companion`: only for some occurrences. */
  alias_kind?: 'rename' | 'companion';
  deprecated_at?: string;
  /** After this the deprecated spelling is no longer sent (ISO 8601). */
  sunset_at?: string;
  /** JSON pointer to this event's payload schema in the OpenAPI document (`components.schemas.WebhookEvent.<name>`). */
  payload_schema?: string;
  version?: number;
  /** When the event became available (YYYY-MM-DD). */
  since?: string;
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
  auto_disable?: WebhookAutoDisableRule;
  retention?: WebhookRetention;
  signature_versions?: string[];
  destination_types?: Array<{ type: WebhookDestinationType; name: string; config: string[]; credentials: string[] }>;
}

export interface WebhookSigningSecret {
  object: 'webhook_secret';
  /** The `whsec_...` signing secret (absent when sealed: see `sealed_secret`). */
  secret: string;
  /** With a `secretRecipient`: the secret sealed to it. */
  sealed_secret?: string;
  secrets_sealed?: SecretsSealed;
  /** On a rotation: the overlap applied, in seconds. */
  overlap_seconds?: number;
  /** On a rotation: when the previous secret stops signing deliveries (epoch ms), or null when it already has. */
  previous_secret_expires_at?: number | null;
  warning?: string;
}

export interface RotateWebhookSecretBody {
  /**
   * How long the previous secret keeps signing deliveries (as a second
   * `atlas-signature` entry), in seconds. Default 0: it stops at once. At most
   * 604800 (7 days). Set it only once every receiver verifies with a verifier
   * that accepts several signatures (this package 0.9.1+).
   */
  overlap_seconds?: number;
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
  /** How many deliveries to return (1–1000, default 50). */
  limit?: number;
  starting_after?: string;
  status?: 'pending' | 'success' | 'failed';
  /** Comma-separated event names. */
  event_type?: string;
  /** Epoch ms or ISO 8601. */
  since?: number | string;
  until?: number | string;
}

export function webhooksResource(request: RequestFn) {
  return {
    endpoints: {
      /** `includeDeprecated` adds the deprecated event spellings to the catalogue. */
      /** `metadata` filters on provisioning tags (`?metadata[key]=value`). */
      list(opts: { includeDeprecated?: boolean; metadata?: ProvisioningMetadata } = {}): Promise<WebhookEndpointList> {
        return request({
          method: 'GET',
          path: '/v1/webhook_endpoints',
          query: { ...(opts.includeDeprecated ? { include_deprecated: 'true' } : {}), ...metadataQuery(opts.metadata) },
        });
      },
      get(id: string): Promise<WebhookEndpoint> {
        return request({ method: 'GET', path: `/v1/webhook_endpoints/${enc(id)}` });
      },
      /**
       * Find-or-create by url: updates the endpoint with this url to `body`, or
       * creates it (then `secret` is in the result, once). Safe to run on every deploy.
       */
      upsertByUrl(
        body: UpsertWebhookEndpointBody,
        idempotencyKey?: string,
      ): Promise<WebhookEndpoint & { secret?: string; created: boolean }> {
        return request({ method: 'PUT', path: '/v1/webhook_endpoints/by_url', body, idempotencyKey });
      },
      /** Update url, enabled_events or active. The signing secret is kept. */
      update(id: string, body: UpdateWebhookEndpointBody): Promise<WebhookEndpoint> {
        return request({ method: 'PATCH', path: `/v1/webhook_endpoints/${enc(id)}`, body });
      },
      /** Show the current signing secret again. Audited. */
      revealSecret(id: string): Promise<WebhookSigningSecret> {
        return request({ method: 'POST', path: `/v1/webhook_endpoints/${enc(id)}/reveal_secret` });
      },
      /**
       * Rotate the signing secret; the new one is revealed exactly once. By
       * default the old secret stops signing at once; for `overlap_seconds`
       * every delivery is signed with both, so a verifier holding either passes.
       */
      rotateSecret(id: string, body?: RotateWebhookSecretBody): Promise<WebhookSigningSecret> {
        return request({ method: 'POST', path: `/v1/webhook_endpoints/${enc(id)}/rotate_secret`, body });
      },
      /** Send a synthetic `webhook.test` event to this endpoint only (queued for the worker). */
      test(id: string): Promise<WebhookDeliveryQueued> {
        return request({ method: 'POST', path: `/v1/webhook_endpoints/${enc(id)}/test` });
      },
      /**
       * Send `webhook.test` now and return the result: status, HTTP status,
       * latency, response snippet, error and the signature header sent.
       * `wait` is at most 10 s (`'10s'`, `'5000ms'`).
       */
      testNow(id: string, wait: string = '10s'): Promise<WebhookTestResult> {
        return request({ method: 'POST', path: `/v1/webhook_endpoints/${enc(id)}/test`, query: { wait } });
      },
      /** Bulk redeliver every event whose latest attempt in the window has `status` (default failed). */
      redeliverWindow(
        id: string,
        body: WebhookWindow & { status?: 'failed' | 'success' } = {},
        idempotencyKey?: string,
      ): Promise<WebhookBulkResult> {
        return request({ method: 'POST', path: `/v1/webhook_endpoints/${enc(id)}/redeliver`, body, idempotencyKey });
      },
      /** Re-send everything since `since` the endpoint subscribes to and has not received. */
      replay(
        id: string,
        body: WebhookWindow & { since: number | string; event_type?: string },
        idempotencyKey?: string,
      ): Promise<WebhookBulkResult> {
        return request({ method: 'POST', path: `/v1/webhook_endpoints/${enc(id)}/replay`, body, idempotencyKey });
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
    /** The addresses deliveries leave from (public). */
    egressIps(): Promise<EgressIps> {
      return request({ method: 'GET', path: '/v1/meta/egress_ips' });
    },
    /** Delivery health of every outbound target (webhooks, referral connection, back-channel receivers, integrations). */
    health(params: { kind?: DeliveryTargetKind; state?: 'unhealthy' | 'all' } = {}): Promise<{
      data: DeliveryHealth[];
      has_more: boolean;
      unhealthy_count: number;
    }> {
      return request({ method: 'GET', path: '/v1/delivery_health', query: { ...params } });
    },
    /** Set who is emailed when a target fails (null = the account's owners). */
    setAlertContacts(kind: DeliveryTargetKind, targetId: string, alertContacts: string[] | null): Promise<DeliveryHealth> {
      return request({
        method: 'PUT',
        path: `/v1/delivery_health/${enc(kind)}/${enc(targetId)}/alert_contacts`,
        body: { alert_contacts: alertContacts },
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
