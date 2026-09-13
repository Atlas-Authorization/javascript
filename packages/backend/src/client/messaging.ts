import { enc, type RequestFn } from './request';

/**
 * §BYOK messaging provider config — wire the tenant's own email/SMS provider
 * (Resend/SES/SMTP/Brevo/Mailgun, Twilio) over the secret-key BAPI.
 *
 * A provider SECRET is WRITE-ONLY: it goes in through `config` and is never
 * read back — a response reports only WHICH secret keys are set (`secrets_set`).
 * Omit a secret on an edit to keep the stored one (so a from-address change need
 * not re-enter the API key).
 */
export interface MessagingProvider {
  object: 'messaging_provider';
  channel: 'email' | 'sms';
  transport: string;
  from_address: string | null;
  status: string;
  /** Non-secret config only — secret values are stripped before serialising. */
  config: Record<string, unknown>;
  /** Which secret keys are set for this transport, never their values. */
  secrets_set: Record<string, boolean>;
  updated_at: number;
}

export interface MessagingProviders {
  object: 'messaging_providers';
  email: MessagingProvider | null;
  sms: MessagingProvider | null;
}

export interface MessagingProviderInput {
  /** The transport, e.g. `resend`, `ses`, `smtp` (email) or `twilio` (sms). */
  transport: string;
  from_address?: string;
  /** Transport config; carries the write-only secret keys on write. */
  config?: Record<string, unknown>;
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

export function messagingResource(request: RequestFn) {
  return {
    /** The instance's configured email and SMS providers, secrets omitted. */
    get(): Promise<MessagingProviders> {
      return request({ method: 'GET', path: '/v1/messaging_providers' });
    },
    setEmail(body: MessagingProviderInput): Promise<MessagingProvider> {
      return request({ method: 'PUT', path: '/v1/messaging_providers/email', body });
    },
    setSms(body: MessagingProviderInput): Promise<MessagingProvider> {
      return request({ method: 'PUT', path: '/v1/messaging_providers/sms', body });
    },
    deleteChannel(channel: 'email' | 'sms'): Promise<DeletedMessagingProvider> {
      return request({ method: 'DELETE', path: `/v1/messaging_providers/${enc(channel)}` });
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
