import { enc, type RequestFn } from './request';

/**
 * Messaging providers — wire your own email or SMS provider (Resend, SES, SMTP,
 * Brevo, Mailgun; Twilio, Vonage, MessageBird, Plivo, Telnyx, Sinch, Infobip,
 * ClickSend, Bandwidth, AWS SNS) over the secret-key Backend API.
 *
 * Each transport accepts an exact set of `config` keys; the API refuses an
 * unknown key with a 422 naming `config.<key>`. These types mirror that schema,
 * so a typo or another provider's key name fails to compile.
 *
 * A provider SECRET is WRITE-ONLY: it goes in through `config` and is never
 * read back — a response reports only WHICH secret keys are set (`secrets_set`).
 *
 * Required keys: every key marked "Required on first setup" must be sent the
 * first time you configure a transport (or when you switch the channel to a
 * different transport). When you update the SAME transport, the stored config is
 * kept: omit a key — or send it as `''` — and its stored value (including a
 * stored secret) stays. So a from-address change need not re-enter the API key.
 */

// ── Transports ──────────────────────────────────────────────────────────────

/** Email transports accepted by `PUT /v1/messaging_providers/email`. */
export type EmailTransport = 'resend' | 'ses' | 'smtp' | 'brevo' | 'mailgun';

/** SMS transports accepted by `PUT /v1/messaging_providers/sms`. */
export type SmsTransport =
  | 'twilio'
  | 'vonage'
  | 'messagebird'
  | 'plivo'
  | 'telnyx'
  | 'sinch'
  | 'infobip'
  | 'clicksend'
  | 'bandwidth'
  | 'aws_sns';

export type MessagingTransport = EmailTransport | SmsTransport;

// ── Per-transport config (first-setup shape: required keys are required) ──

/** Sender number or ID for an SMS provider. `from_address` on the request takes precedence. */
interface SmsFrom {
  /** Sender number or ID for this provider. Optional; `from_address` on the request takes precedence. */
  from?: string;
}

/** Resend. */
export interface ResendConfig {
  /** Resend API key (`re_…`). Required on first setup. Write-only: never returned. */
  api_key: string;
}

/** Brevo. */
export interface BrevoConfig {
  /** Brevo API key (`xkeysib-…`). Required on first setup. Write-only: never returned. */
  api_key: string;
}

/** Mailgun. */
export interface MailgunConfig {
  /** Mailgun private API key. Required on first setup. Write-only: never returned. */
  api_key: string;
  /** Your Mailgun sending domain, e.g. `mg.example.com`. Required on first setup. */
  domain: string;
  /** Mailgun region. Default `us`. */
  region?: 'us' | 'eu';
}

/** Amazon SES. */
export interface SesConfig {
  /** AWS region, e.g. `us-east-1`. Required on first setup. */
  region: string;
  /** IAM access key ID. Required on first setup. Write-only: never returned. */
  access_key_id: string;
  /** IAM secret access key. Required on first setup. Write-only: never returned. */
  secret_access_key: string;
  /** STS session token, only for temporary credentials. Write-only: never returned. */
  session_token?: string;
}

/** Any SMTP server. */
export interface SmtpConfig {
  /** SMTP server hostname, e.g. `smtp.example.com`. Required on first setup. */
  host: string;
  /** SMTP port (1-65535). Default 587. */
  port?: number;
  /** Use implicit TLS. Default: `true` on port 465, otherwise STARTTLS. */
  secure?: boolean;
  /** SMTP username, if the server requires authentication. */
  username?: string;
  /** SMTP password or app password. Write-only: never returned. */
  password?: string;
}

/** Twilio. */
export interface TwilioConfig extends SmsFrom {
  /** Twilio Account SID (`AC…`). Required on first setup. */
  account_sid: string;
  /** Twilio auth token. Required on first setup. Write-only: never returned. */
  auth_token: string;
  /** WhatsApp-enabled sender number, for the WhatsApp channel. */
  whatsapp_from?: string;
  /** Voice-capable number, for the voice channel. */
  voice_from?: string;
}

/** Vonage. */
export interface VonageConfig extends SmsFrom {
  /** Vonage API key. Required on first setup. */
  api_key: string;
  /** Vonage API secret. Required on first setup. Write-only: never returned. */
  api_secret: string;
}

/** MessageBird (Bird). */
export interface MessagebirdConfig extends SmsFrom {
  /** MessageBird (Bird) access key. Required on first setup. Write-only: never returned. */
  access_key: string;
}

/** Plivo. */
export interface PlivoConfig extends SmsFrom {
  /** Plivo Auth ID. Required on first setup. */
  auth_id: string;
  /** Plivo auth token. Required on first setup. Write-only: never returned. */
  auth_token: string;
}

/** Telnyx. */
export interface TelnyxConfig extends SmsFrom {
  /** Telnyx API key. Required on first setup. Write-only: never returned. */
  api_key: string;
}

/** Sinch. */
export interface SinchConfig extends SmsFrom {
  /** Sinch service plan ID. Required on first setup. */
  service_plan_id: string;
  /** Sinch API token. Required on first setup. Write-only: never returned. */
  api_token: string;
  /** Sinch API region, a short lowercase code such as `us` or `eu`. Default `us`. */
  region?: string;
}

/** Infobip. */
export interface InfobipConfig extends SmsFrom {
  /** Your Infobip base URL, e.g. `https://xxxxx.api.infobip.com`. Must be https. Required on first setup. */
  base_url: string;
  /** Infobip API key. Required on first setup. Write-only: never returned. */
  api_key: string;
}

/** ClickSend. */
export interface ClicksendConfig extends SmsFrom {
  /** ClickSend username (your login email). Required on first setup. */
  username: string;
  /** ClickSend API key. Required on first setup. Write-only: never returned. */
  api_key: string;
}

/** Bandwidth. */
export interface BandwidthConfig extends SmsFrom {
  /** Bandwidth account ID. Required on first setup. */
  account_id: string;
  /** Bandwidth messaging application ID. Required on first setup. */
  application_id: string;
  /** Bandwidth API username. Required on first setup. */
  username: string;
  /** Bandwidth API password. Required on first setup. Write-only: never returned. */
  password: string;
}

/** Amazon SNS. */
export interface AwsSnsConfig extends SmsFrom {
  /** AWS region, e.g. `us-east-1`. Required on first setup. */
  region: string;
  /** IAM access key ID. Required on first setup. */
  access_key_id: string;
  /** IAM secret access key. Required on first setup. Write-only: never returned. */
  secret_access_key: string;
  /** STS session token, only for temporary credentials. Write-only: never returned. */
  session_token?: string;
}

/** The `config` shape for each transport, keyed by transport. */
export interface MessagingTransportConfigs {
  resend: ResendConfig;
  ses: SesConfig;
  smtp: SmtpConfig;
  brevo: BrevoConfig;
  mailgun: MailgunConfig;
  twilio: TwilioConfig;
  vonage: VonageConfig;
  messagebird: MessagebirdConfig;
  plivo: PlivoConfig;
  telnyx: TelnyxConfig;
  sinch: SinchConfig;
  infobip: InfobipConfig;
  clicksend: ClicksendConfig;
  bandwidth: BandwidthConfig;
  aws_sns: AwsSnsConfig;
}

/** The write-only (secret) keys of each transport — never present in a response. */
export interface MessagingSecretKeys {
  resend: 'api_key';
  ses: 'access_key_id' | 'secret_access_key' | 'session_token';
  smtp: 'password';
  brevo: 'api_key';
  mailgun: 'api_key';
  twilio: 'auth_token';
  vonage: 'api_secret';
  messagebird: 'access_key';
  plivo: 'auth_token';
  telnyx: 'api_key';
  sinch: 'api_token';
  infobip: 'api_key';
  clicksend: 'api_key';
  bandwidth: 'password';
  aws_sns: 'secret_access_key' | 'session_token';
}

// ── Request bodies ──────────────────────────────────────────────────────────

interface ProviderBodyBase<T extends MessagingTransport> {
  transport: T;
  /**
   * Email: the From address, e.g. `"Acme <no-reply@acme.com>"` — a sender your
   * provider accepts. SMS: the sender number in E.164 format, e.g. `+15551234567`.
   */
  from_address?: string;
}

/**
 * First setup of transport `T` (or a switch to it): `config` carries every
 * required key.
 */
export interface MessagingProviderSetup<T extends MessagingTransport> extends ProviderBodyBase<T> {
  config: MessagingTransportConfigs[T];
}

/**
 * An update of the transport already configured on the channel: every `config`
 * key is optional. An omitted (or `''`) key keeps its stored value — including a
 * stored secret.
 */
export interface MessagingProviderUpdate<T extends MessagingTransport> extends ProviderBodyBase<T> {
  config?: Partial<MessagingTransportConfigs[T]>;
}

/** Body for `messaging.setEmail` — discriminated by `transport`. */
export type EmailProviderInput = {
  [T in EmailTransport]: MessagingProviderSetup<T> | MessagingProviderUpdate<T>;
}[EmailTransport];

/** Body for `messaging.setSms` — discriminated by `transport`. */
export type SmsProviderInput = {
  [T in SmsTransport]: MessagingProviderSetup<T> | MessagingProviderUpdate<T>;
}[SmsTransport];

/** First-setup body for the email channel. Use with `satisfies` to require every required key. */
export type EmailProviderSetup = { [T in EmailTransport]: MessagingProviderSetup<T> }[EmailTransport];

/** First-setup body for the SMS channel. Use with `satisfies` to require every required key. */
export type SmsProviderSetup = { [T in SmsTransport]: MessagingProviderSetup<T> }[SmsTransport];

/**
 * @deprecated The untyped body accepted before per-transport typing. Use
 * {@link EmailProviderInput} / {@link SmsProviderInput} instead; the API refuses
 * any `config` key the transport does not use.
 */
export interface MessagingProviderInput {
  /** The transport, e.g. `resend`, `ses`, `smtp` (email) or `twilio` (sms). */
  transport: string;
  from_address?: string;
  /** Transport config; carries the write-only secret keys on write. */
  config?: Record<string, unknown>;
}

// ── Responses ───────────────────────────────────────────────────────────────

/** The non-secret config keys of transport `T`. */
type PublicConfigKey<T extends MessagingTransport> = Exclude<
  keyof MessagingTransportConfigs[T],
  MessagingSecretKeys[T]
>;

/**
 * A configured provider as returned by the API. `config` holds the non-secret
 * settings only (values come back as strings, e.g. `port: "587"`); secrets are
 * never returned — `secrets_set` says which ones are stored.
 */
export interface MessagingProviderOf<C extends 'email' | 'sms', T extends MessagingTransport> {
  object: 'messaging_provider';
  channel: C;
  transport: T;
  from_address: string | null;
  status: string;
  /** Non-secret config only — secret values are never returned. */
  config: { [K in PublicConfigKey<T>]?: string };
  /** For each secret key of this transport: whether a value is stored. Never the value. */
  secrets_set: { [K in MessagingSecretKeys[T]]: boolean };
  updated_at: number;
}

export type EmailProvider = { [T in EmailTransport]: MessagingProviderOf<'email', T> }[EmailTransport];
export type SmsProvider = { [T in SmsTransport]: MessagingProviderOf<'sms', T> }[SmsTransport];

/** Either channel's provider. Narrow on `transport` (or `channel`) to read its config. */
export type MessagingProvider = EmailProvider | SmsProvider;

export interface MessagingProviders {
  object: 'messaging_providers';
  email: EmailProvider | null;
  sms: SmsProvider | null;
}

export interface MessagingTestResult {
  object: 'messaging_test';
  channel: string;
  sent_to: string;
  ok: true;
}

export interface DeletedMessagingProvider {
  object: 'messaging_provider';
  channel: string;
  deleted: true;
}

/**
 * The deprecated untyped body, accepted only when `transport` is a plain
 * `string` (not a known literal) — so a typed literal with a wrong key still
 * fails to compile instead of falling through to the legacy overload.
 */
type LegacyInput<T extends string> = Omit<MessagingProviderInput, 'transport'> & {
  transport: T;
} & (string extends T ? unknown : never);

export function messagingResource(request: RequestFn) {
  function setEmail(body: EmailProviderInput): Promise<EmailProvider>;
  /** @deprecated Pass a typed {@link EmailProviderInput}. */
  function setEmail<T extends string>(body: LegacyInput<T>): Promise<MessagingProvider>;
  function setEmail(body: unknown): Promise<MessagingProvider> {
    return request({ method: 'PUT', path: '/v1/messaging_providers/email', body });
  }

  function setSms(body: SmsProviderInput): Promise<SmsProvider>;
  /** @deprecated Pass a typed {@link SmsProviderInput}. */
  function setSms<T extends string>(body: LegacyInput<T>): Promise<MessagingProvider>;
  function setSms(body: unknown): Promise<MessagingProvider> {
    return request({ method: 'PUT', path: '/v1/messaging_providers/sms', body });
  }

  return {
    /** The instance's configured email and SMS providers, secrets omitted. */
    get(): Promise<MessagingProviders> {
      return request({ method: 'GET', path: '/v1/messaging_providers' });
    },
    /**
     * Configure (or update) the email provider. `config` keys are checked per
     * `transport`; on an update of the same transport, omitted keys — including
     * secrets — keep their stored values.
     */
    setEmail,
    /**
     * Configure (or update) the SMS provider. `config` keys are checked per
     * `transport`; on an update of the same transport, omitted keys — including
     * secrets — keep their stored values.
     */
    setSms,
    /**
     * Remove a channel's provider. Removing the email provider is refused with
     * `409 EMAIL_PROVIDER_IN_USE` (`meta.features` names them) while
     * email-dependent features are on and nothing else would deliver for the
     * instance; pass `{ force: true }` to remove it anyway — those features then
     * stop being offered until a provider is configured again.
     */
    deleteChannel(
      channel: 'email' | 'sms',
      options: { force?: boolean } = {},
    ): Promise<DeletedMessagingProvider> {
      return request({
        method: 'DELETE',
        path: `/v1/messaging_providers/${enc(channel)}`,
        ...(options.force ? { query: { force: 'true' } } : {}),
      });
    },
    /** Send a fixed, clearly-marked test message through the channel's provider. */
    test(channel: 'email' | 'sms', body: { to: string }): Promise<MessagingTestResult> {
      return request({
        method: 'POST',
        path: `/v1/messaging_providers/${enc(channel)}/test`,
        body,
      });
    },
  };
}
