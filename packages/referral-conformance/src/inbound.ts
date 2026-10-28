import { standardWebhookSignature } from './sign';
import { matchShape, type Shape } from './shape';

/**
 * Events a Referalli-style platform sends Atlas (two-way sync), signed the
 * Standard Webhooks way with the endpoint's own `whsec_` secret. Each case is
 * the exact body and what Atlas must read from it.
 *
 * A platform's emitter conforms when its events have the same shape
 * ({@link validateInboundEvent}); an Atlas-compatible receiver conforms when it
 * reads these into the stated updates.
 */

export interface InboundEventCase {
  id: string;
  title: string;
  /** The JSON body as sent. */
  event: Record<string, unknown>;
  /** What Atlas must take from it. `null` means the event is ignored. */
  expectedUpdate: {
    type: string;
    customerRef: string | null;
    referralId: string | null;
    /** The referral status Atlas ends up with. */
    referralStatus: string | null;
    referrerExternalRef?: string | null;
  } | null;
  why: string;
}

/** The fields every referral event carries. */
export const INBOUND_EVENT_SHAPE: Shape = {
  topic: 'string',
  'createdAt?': 'string',
  data: { 'customerRef?': 'string|null', 'referralId?': 'string|null', 'status?': 'string|null', 'partnerExternalRef?': 'string|null' },
};

export const INBOUND_EVENT_CASES: readonly InboundEventCase[] = [
  {
    id: 'inbound.referral_created',
    title: 'referral.created names the customer and the referral',
    event: {
      topic: 'referral.created',
      createdAt: '2026-10-21T15:00:00.000Z',
      data: { customerRef: 'usr_8812', referralId: 'ref_1001', status: 'active', partnerExternalRef: 'usr_1' },
    },
    expectedUpdate: { type: 'referral.created', customerRef: 'usr_8812', referralId: 'ref_1001', referralStatus: 'active', referrerExternalRef: 'usr_1' },
    why: 'A referral can be created after sign-up (a code attached later).',
  },
  {
    id: 'inbound.referral_voided_thin',
    title: 'referral.voided with only the referral id still applies, as void',
    event: {
      topic: 'referral.voided',
      createdAt: '2026-10-21T15:05:00.000Z',
      data: { referralId: 'ref_1001' },
    },
    expectedUpdate: { type: 'referral.voided', customerRef: null, referralId: 'ref_1001', referralStatus: 'void' },
    why: 'A thin payload must not be dropped: Atlas matches by the platform referral id and implies the status from the topic.',
  },
  {
    id: 'inbound.referral_voided_full',
    title: 'referral.voided with the customer and status',
    event: {
      topic: 'referral.voided',
      createdAt: '2026-10-21T15:05:00.000Z',
      data: { customerRef: 'usr_8812', referralId: 'ref_1001', status: 'void' },
    },
    expectedUpdate: { type: 'referral.voided', customerRef: 'usr_8812', referralId: 'ref_1001', referralStatus: 'void' },
    why: 'The full form: the user is matched by customerRef.',
  },
  {
    id: 'inbound.referral_held',
    title: 'referral.held implies pending_review when no status is given',
    event: { topic: 'referral.held', createdAt: '2026-10-21T15:10:00.000Z', data: { customerRef: 'usr_8812', referralId: 'ref_1001' } },
    expectedUpdate: { type: 'referral.held', customerRef: 'usr_8812', referralId: 'ref_1001', referralStatus: 'pending_review' },
    why: 'The topic carries the status when the data does not.',
  },
  {
    id: 'inbound.referral_approved',
    title: 'referral.approved implies active',
    event: { topic: 'referral.approved', createdAt: '2026-10-21T15:15:00.000Z', data: { customerRef: 'usr_8812', referralId: 'ref_1001' } },
    expectedUpdate: { type: 'referral.approved', customerRef: 'usr_8812', referralId: 'ref_1001', referralStatus: 'active' },
    why: 'Releasing a held referral.',
  },
  {
    id: 'inbound.other_topic_ignored',
    title: 'A topic Atlas does not act on is ignored (and still answered 200)',
    event: { topic: 'payout.created', createdAt: '2026-10-21T15:20:00.000Z', data: { payoutId: 'po_1' } },
    expectedUpdate: null,
    why: 'Atlas subscribes to referral.* only; anything else must not fail the delivery.',
  },
];

export interface SignedInboundEvent {
  id: string;
  /** The raw body. */
  body: string;
  headers: Record<string, string>;
}

/** Sign an event the way a platform's webhook endpoint does. */
export function signInboundEvent(
  c: InboundEventCase,
  opts: { secret: string; nowSeconds: number; deliveryId?: string },
): SignedInboundEvent {
  const id = opts.deliveryId ?? `msg_${c.id}`;
  const body = JSON.stringify(c.event);
  return {
    id: c.id,
    body,
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(opts.nowSeconds),
      'webhook-signature': standardWebhookSignature(opts.secret, id, opts.nowSeconds, body),
    },
  };
}

/** Whether an event a platform emits has the fields Atlas reads. Returns the problems. */
export function validateInboundEvent(event: unknown): string[] {
  return matchShape(event, INBOUND_EVENT_SHAPE);
}
