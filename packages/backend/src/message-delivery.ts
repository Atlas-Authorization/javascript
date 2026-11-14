import { verifyWebhook, type VerifyWebhookInput } from './webhooks';
import type { WebhookVerifyFailure } from './webhook-common';

/**
 * A typed receiver for the message-delivery events Atlas sends about the messages that left through YOUR
 * providers: `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, `sms.delivered`,
 * `sms.failed` and `message_suppression.created`. It verifies the Atlas signature (same rules as
 * `verifyWebhook`) and hands back the event narrowed on `type`.
 *
 * ```ts
 * const r = verifyMessageDelivery({ body: rawBody, headers, secret });
 * if (!r.verified) return res.sendStatus(400);
 * if (r.event?.type === 'email.bounced') await markUndeliverable(r.event.data.recipient, r.event.data.bounce_type);
 * ```
 *
 * `verified: true` with no `event` means the signature is good and the event is some other kind (or newer
 * than this package): handle it with `verifyWebhook`. Look the message up with
 * `client.messages.get(event.data.ledger_id)`.
 */

import type { MessageLedgerChannel } from './client/message-ledger';

/** `data` of the delivery events: a message the provider reported on. */
export interface MessageDeliveryData {
  object: 'message_delivery';
  /** The ledger id (`GET /v1/messages/{id}`) when Atlas could match the report to a message, else the provider's id. */
  message_id: string;
  channel: MessageLedgerChannel;
  recipient: string | null;
  /** A short reason, never message content. */
  reason?: string;
  bounce_type?: 'hard' | 'soft' | 'unknown';
  provider?: string | null;
  provider_message_id?: string | null;
  ledger_id?: string | null;
  at?: number;
  [key: string]: unknown;
}

/** `data` of `message_suppression.created`. */
export interface MessageSuppressionData {
  object: 'message_suppression';
  id: string;
  channel: MessageLedgerChannel;
  recipient: string;
  reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'invalid' | 'manual';
  source: string;
  message_id: string | null;
  at: number;
  [key: string]: unknown;
}

interface Envelope {
  id: string;
  timestamp: number;
  instance_id?: string;
  idempotency_key?: string | null;
}

export type MessageDeliveryEvent =
  | (Envelope & { type: 'email.delivered' | 'email.bounced' | 'email.complained' | 'email.failed' | 'sms.delivered' | 'sms.failed'; data: MessageDeliveryData })
  | (Envelope & { type: 'message_suppression.created'; data: MessageSuppressionData });

export const MESSAGE_DELIVERY_EVENT_TYPES = [
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.failed',
  'sms.delivered',
  'sms.failed',
  'message_suppression.created',
] as const;

export interface VerifyMessageDeliveryResult {
  verified: boolean;
  reason?: WebhookVerifyFailure;
  /** Present when the signature verified and the event is a message-delivery event. */
  event?: MessageDeliveryEvent;
  deliveryId?: string;
  timestamp?: number;
}

export function verifyMessageDelivery(input: VerifyWebhookInput): VerifyMessageDeliveryResult {
  const r = verifyWebhook<{ type?: string }>(input);
  if (!r.verified) return { verified: false, ...(r.reason ? { reason: r.reason } : {}) };
  const type = r.event?.type;
  const known = (MESSAGE_DELIVERY_EVENT_TYPES as readonly string[]).includes(type ?? '');
  return {
    verified: true,
    ...(known ? { event: r.event as unknown as MessageDeliveryEvent } : {}),
    ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}),
    ...(r.timestamp !== undefined ? { timestamp: r.timestamp } : {}),
  };
}
