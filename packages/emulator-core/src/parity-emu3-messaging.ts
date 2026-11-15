import type { ParityRequest } from './parity';

const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, group: 'messaging', ...rest });
const providerShape = ['updated_at', 'config', 'secrets_set', 'from_address', 'mode', 'id'];
/** Provider callbacks are public routes a real instance refuses without a valid signature or URL token: every one answers the same 401 whether or not the instance exists. */
const CALLBACK_PROVIDERS = ['resend', 'brevo', 'ses', 'mailgun', 'smtp2go', 'postmark', 'sendgrid', 'vonage', 'messagebird'];

/** Per-channel providers, the receiver secrets, and the signed provider callbacks. */
export const emu3MessagingParityRequests: ParityRequest[] = [
  q('emu3 provider email', 'PUT', '/v1/messaging_providers/email', { body: { transport: 'resend', from_address: 'parity@example.com', config: { api_key: 're_parity' } }, tolerate: providerShape }),
  q('emu3 provider sms', 'PUT', '/v1/messaging_providers/sms', { body: { transport: 'twilio', from_address: '+15550001111', config: { account_sid: 'ACparity{{rand}}', auth_token: 'parity-token' } }, tolerate: providerShape }),
  q('emu3 provider push', 'PUT', '/v1/messaging_providers/push', { body: { transport: 'expo' }, tolerate: providerShape }),
  q('emu3 providers', 'GET', '/v1/messaging_providers', { tolerate: ['email', 'sms', 'push', 'managed_email', 'development_email'] }),
  q('emu3 provider one', 'GET', '/v1/messaging_providers/sms', { tolerate: providerShape }),
  q('emu3 provider delete push', 'DELETE', '/v1/messaging_providers/push'),
  // With no push provider configured a test send is refused.
  q('emu3 provider test refused', 'POST', '/v1/messaging_providers/push/test', { body: { to: 'ExponentPushToken[parity]' } }),
  q('emu3 provider delete sms', 'DELETE', '/v1/messaging_providers/sms'),
  q('emu3 provider delete email', 'DELETE', '/v1/messaging_providers/email'),
  q('emu3 receiver secret', 'PUT', '/v1/message_receivers/mailgun', { body: { secret: 'key-parity' }, tolerate: ['url', 'events', 'last_event_at', 'last_error', 'channel', 'verification', 'token_required', 'secret_help', 'token'] }),
  q('emu3 receiver secret delete', 'DELETE', '/v1/message_receivers/mailgun'),
  ...CALLBACK_PROVIDERS.map((p) => q(`emu3 callback ${p}`, 'POST', `/v1/webhooks/${p}/ins_parity`, { anonymous: true, body: {} })),
  q('emu3 callback twilio', 'POST', '/v1/webhooks/twilio/ins_parity', { anonymous: true, form: { MessageSid: 'SMparity', MessageStatus: 'delivered', To: '+15550001111' } }),
  q('emu3 callback vonage get', 'GET', '/v1/webhooks/vonage/ins_parity?messageId=m1&status=delivered', { anonymous: true }),
  q('emu3 callback messagebird get', 'GET', '/v1/webhooks/messagebird/ins_parity?id=m1&status=delivered', { anonymous: true }),
];
