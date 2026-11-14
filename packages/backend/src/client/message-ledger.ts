import { enc, type RequestFn } from './request';

/**
 * The message ledger and everything that shapes delivery, over the secret-key Backend API:
 *
 *   client.messages              the ledger: every email, SMS, WhatsApp, voice and push message, with its status timeline
 *   client.suppressions          addresses, numbers and device tokens Atlas will not send to
 *   client.messaging.fallbacks   ordered fallback providers per channel (failover)
 *   client.messaging.countryRoutes, client.messaging.settings
 *   client.messageReceivers      where your providers report delivery (bounce, complaint and status callbacks)
 *
 * Recipients are masked and hashed in the ledger; the address itself is never stored there.
 */

export type MessageLedgerChannel = 'email' | 'sms' | 'whatsapp' | 'voice' | 'push';
export type MessageLedgerStatus = 'queued' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed' | 'blocked';
export type SuppressionReason = 'hard_bounce' | 'complaint' | 'unsubscribe' | 'invalid' | 'manual';

export interface MessageProviderAttempt {
  provider: string;
  ok: boolean;
  error?: string;
}

export interface Message {
  object: 'message';
  id: string;
  channel: MessageLedgerChannel;
  template: string | null;
  /** `jo***@ex***.com`, `+1•••••0123`. */
  recipient_masked: string;
  /** A keyed hash, stable within the instance; search with `list({ recipient })`. */
  recipient_hash: string;
  country: string | null;
  status: MessageLedgerStatus;
  status_detail: string | null;
  /** The transport that took it (`resend`, `ses`, `twilio`, ...). */
  provider: string | null;
  provider_message_id: string | null;
  /** The providers tried, in order; more than one means a fallback took over. */
  attempts: MessageProviderAttempt[];
  timeline: Array<{ status: MessageLedgerStatus; at: number; detail?: string }>;
  created_at: number;
  updated_at: number;
}

export interface MessageList {
  object: 'list';
  data: Message[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ListMessagesQuery {
  channel?: MessageLedgerChannel;
  status?: MessageLedgerStatus;
  template?: string;
  provider?: string;
  /** An address or E.164 number: found by its keyed hash. */
  recipient?: string;
  /** Epoch ms or ISO 8601. */
  since?: number | string;
  until?: number | string;
  /** 1-100, default 25. */
  limit?: number;
  /** A message id: the ones after it (older). */
  starting_after?: string;
}

export interface MessageSummary {
  object: 'message_summary';
  since_hours: number;
  total: number;
  by_status: Record<MessageLedgerStatus, number>;
}

export interface Suppression {
  object: 'message_suppression';
  id: string;
  channel: MessageLedgerChannel;
  address: string;
  address_masked: string;
  reason: SuppressionReason;
  /** `api`, `admin`, or the provider that reported it. */
  source: string;
  detail: string | null;
  message_id: string | null;
  created_at: number;
}

export interface SuppressionList {
  object: 'list';
  data: Suppression[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ListSuppressionsQuery {
  channel?: MessageLedgerChannel;
  reason?: SuppressionReason;
  /** Look one address up (exact match). */
  address?: string;
  /** 1-500, default 100. */
  limit?: number;
  starting_after?: string;
}

export interface AddSuppressionsBody {
  /** One address. Send this or `addresses`. */
  address?: string;
  /** Up to 1000. */
  addresses?: string[];
  /** Default `email`. Phone channels take E.164 numbers; `push` a device token. */
  channel?: MessageLedgerChannel;
  /** Default `manual`. */
  reason?: SuppressionReason;
  detail?: string | null;
}

export interface AddedSuppressions extends SuppressionList {
  /** How many were new. */
  created: number;
}

export type MessagingFallbackChannel = 'email' | 'sms' | 'push';

export interface FallbackProvider {
  object: 'messaging_fallback_provider';
  id: string;
  channel: MessagingFallbackChannel;
  position: number;
  transport: string;
  from_address: string | null;
  status: 'active' | 'disabled';
  /** Non-secret settings only. */
  config: Record<string, string>;
  /** Which secret keys are set, never their values. */
  secrets_set: Record<string, boolean>;
  updated_at: number;
}

export interface FallbackProviderList {
  object: 'list';
  data: FallbackProvider[];
  has_more: boolean;
  /** `primary`, then the id of each active fallback. */
  failover_order: string[];
}

export interface FallbackProviderBody {
  /** Any transport the channel accepts, with its own `config` keys (the same as `messaging.setEmail` / `setSms` / `setPush`). */
  transport: string;
  from_address?: string | null;
  config?: Record<string, string | number | boolean>;
  /** Lower is tried first; new providers go last. */
  position?: number;
  status?: 'active' | 'disabled';
}

export interface SmsCountryRoute {
  object: 'sms_country_route';
  id: string;
  channel: string;
  country: string;
  provider_id: string;
  updated_at: number;
}

export interface MessagingSettings {
  object: 'messaging_settings';
  /** Suppress addresses your provider reports as hard bounces, complaints, unsubscribes or invalid numbers. Default true. */
  auto_suppress: boolean;
  /** Try fallback providers when the first one errors. Default true. */
  failover_enabled: boolean;
  /** 7-730, default 90. */
  ledger_retention_days: number;
  updated_at: number | null;
}

export type MessageReceiverProvider = 'ses' | 'brevo' | 'mailgun' | 'smtp2go' | 'postmark' | 'sendgrid' | 'resend' | 'twilio' | 'vonage' | 'messagebird';

export interface MessageReceiver {
  object: 'message_receiver';
  provider: MessageReceiverProvider;
  channel: 'email' | 'sms';
  verification: 'signature' | 'signature_or_token' | 'token';
  /** The URL to register on your provider account (with its token, for a key that may see it). */
  url: string;
  token_required: boolean;
  /** For a key with `messaging:write`. Send it as a bearer header, the basic-auth password or `?t=`. */
  token?: string;
  secret_set: boolean;
  secret_help: string | null;
  events: string;
  last_event_at: number | null;
  last_error: string | null;
}

export function messageLedgerResource(request: RequestFn) {
  return {
    /** The ledger, newest first. */
    list(query: ListMessagesQuery = {}): Promise<MessageList> {
      return request({ method: 'GET', path: '/v1/messages', query: query as Record<string, string | number | boolean | undefined> });
    },
    /** Counts per status over the last `hours` (default 24, up to 720). */
    summary(query: { hours?: number } = {}): Promise<MessageSummary> {
      return request({ method: 'GET', path: '/v1/messages/summary', query });
    },
    /** One message with its full timeline and the providers tried. */
    get(id: string): Promise<Message> {
      return request({ method: 'GET', path: `/v1/messages/${enc(id)}` });
    },
  };
}

export function suppressionsResource(request: RequestFn) {
  return {
    list(query: ListSuppressionsQuery = {}): Promise<SuppressionList> {
      return request({ method: 'GET', path: '/v1/suppressions', query: query as Record<string, string | number | boolean | undefined> });
    },
    /** Add one address or up to 1000. Adding one already there updates its reason. */
    add(body: AddSuppressionsBody): Promise<AddedSuppressions> {
      return request({ method: 'POST', path: '/v1/suppressions', body });
    },
    get(id: string): Promise<Suppression> {
      return request({ method: 'GET', path: `/v1/suppressions/${enc(id)}` });
    },
    /** Take an address off the list; messages to it are sent again. */
    remove(id: string): Promise<{ object: 'message_suppression'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/suppressions/${enc(id)}` });
    },
  };
}

/** Merged into `client.messaging`. */
export function messagingRoutingResource(request: RequestFn) {
  return {
    /** Ordered fallback providers: when your provider errors, the next one is tried. */
    fallbacks: {
      list(channel: MessagingFallbackChannel): Promise<FallbackProviderList> {
        return request({ method: 'GET', path: `/v1/messaging_providers/${enc(channel)}/fallbacks` });
      },
      /** Add one (up to 5 per channel). */
      add(channel: MessagingFallbackChannel, body: FallbackProviderBody): Promise<FallbackProvider> {
        return request({ method: 'POST', path: `/v1/messaging_providers/${enc(channel)}/fallbacks`, body });
      },
      /** Change one; an omitted secret keeps the stored one. */
      update(channel: MessagingFallbackChannel, id: string, body: Partial<FallbackProviderBody>): Promise<FallbackProvider> {
        return request({ method: 'PUT', path: `/v1/messaging_providers/${enc(channel)}/fallbacks/${enc(id)}`, body });
      },
      remove(channel: MessagingFallbackChannel, id: string): Promise<{ object: 'messaging_fallback_provider'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/messaging_providers/${enc(channel)}/fallbacks/${enc(id)}` });
      },
      /** Set the order: `ids` lists every fallback of the channel exactly once. */
      reorder(channel: MessagingFallbackChannel, ids: string[]): Promise<FallbackProviderList> {
        return request({ method: 'PUT', path: `/v1/messaging_providers/${enc(channel)}/fallbacks/order`, body: { ids } });
      },
    },
    /** Per-country SMS routing: numbers in a country go through the named provider first. */
    countryRoutes: {
      list(): Promise<{ object: 'list'; data: SmsCountryRoute[]; has_more: boolean }> {
        return request({ method: 'GET', path: '/v1/messaging/country_routes' });
      },
      /** `providerId` is the id of your SMS provider or one of its fallbacks. */
      put(country: string, providerId: string): Promise<SmsCountryRoute> {
        return request({ method: 'PUT', path: '/v1/messaging/country_routes', body: { country, provider_id: providerId } });
      },
      remove(country: string): Promise<{ object: 'sms_country_route'; country: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/messaging/country_routes/${enc(country)}` });
      },
    },
    settings: {
      get(): Promise<MessagingSettings> {
        return request({ method: 'GET', path: '/v1/messaging/settings' });
      },
      put(body: Partial<Pick<MessagingSettings, 'auto_suppress' | 'failover_enabled' | 'ledger_retention_days'>>): Promise<MessagingSettings> {
        return request({ method: 'PUT', path: '/v1/messaging/settings', body });
      },
    },
  };
}

export function messageReceiversResource(request: RequestFn) {
  return {
    /** Where each provider should send its status, bounce and complaint callbacks, and how Atlas verifies them. */
    list(): Promise<{ object: 'list'; data: MessageReceiver[]; has_more: boolean }> {
      return request({ method: 'GET', path: '/v1/message_receivers' });
    },
    /** Store the secret Atlas verifies a provider's callbacks with (write-only). */
    setSecret(provider: MessageReceiverProvider, secret: string): Promise<MessageReceiver> {
      return request({ method: 'PUT', path: `/v1/message_receivers/${enc(provider)}`, body: { secret } });
    },
    removeSecret(provider: MessageReceiverProvider): Promise<{ object: 'message_receiver'; provider: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/message_receivers/${enc(provider)}` });
    },
  };
}
