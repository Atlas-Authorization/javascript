import { createHmac } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { MESSAGE_DELIVERY_EVENT_TYPES, verifyMessageDelivery, type MessageDeliveryEvent } from './message-delivery';

const secret = 'whsec_delivery';

function signed(event: Record<string, unknown>, opts: { secret?: string; timestamp?: number } = {}) {
  const body = JSON.stringify(event);
  const ts = opts.timestamp ?? Date.now();
  const sig = createHmac('sha256', opts.secret ?? secret).update(`msg_1.${ts}.${body}`).digest('base64');
  return { body, secret, headers: { 'atlas-id': 'msg_1', 'atlas-timestamp': String(ts), 'atlas-signature': `v1,${sig}` } };
}

const bounce = {
  id: 'evt_1',
  type: 'email.bounced',
  timestamp: Date.now(),
  data: { object: 'message_delivery', message_id: 'msg_1', channel: 'email', recipient: 'a@example.com', bounce_type: 'hard', reason: 'mailbox full', ledger_id: 'msg_1' },
};

describe('verifyMessageDelivery', () => {
  it('hands back the event narrowed on type once the signature verifies', () => {
    const r = verifyMessageDelivery(signed(bounce));
    expect(r.verified).toBe(true);
    expectTypeOf(r.event).toEqualTypeOf<MessageDeliveryEvent | undefined>();
    if (r.event?.type === 'email.bounced') {
      expect(r.event.data.bounce_type).toBe('hard');
      expect(r.event.data.recipient).toBe('a@example.com');
    } else {
      throw new Error('not narrowed');
    }
    expect(r.deliveryId).toBe('msg_1');
  });

  it('narrows a suppression event to its own data', () => {
    const r = verifyMessageDelivery(signed({ id: 'evt_2', type: 'message_suppression.created', timestamp: Date.now(), data: { object: 'message_suppression', id: 'sup_1', channel: 'sms', recipient: '+15550001111', reason: 'invalid', source: 'twilio', message_id: null, at: 1 } }));
    if (r.event?.type !== 'message_suppression.created') throw new Error('not narrowed');
    expect(r.event.data.reason).toBe('invalid');
  });

  it('covers every delivery event type exactly once', () => {
    expect(new Set(MESSAGE_DELIVERY_EVENT_TYPES).size).toBe(MESSAGE_DELIVERY_EVENT_TYPES.length);
    for (const t of ['email.delivered', 'email.bounced', 'email.complained', 'email.failed', 'sms.delivered', 'sms.failed', 'message_suppression.created']) {
      expect(MESSAGE_DELIVERY_EVENT_TYPES).toContain(t);
    }
  });

  it('is verified but carries no event for an event kind it does not know', () => {
    const r = verifyMessageDelivery(signed({ id: 'evt_3', type: 'user.created', timestamp: Date.now(), data: {} }));
    expect(r.verified).toBe(true);
    expect(r.event).toBeUndefined();
  });

  it('refuses a wrong secret, a stale timestamp and missing headers, with no event', () => {
    const wrong = verifyMessageDelivery(signed(bounce, { secret: 'whsec_other' }));
    expect(wrong).toMatchObject({ verified: false });
    expect(wrong.event).toBeUndefined();
    expect(verifyMessageDelivery(signed(bounce, { timestamp: Date.now() - 3_600_000 }))).toMatchObject({ verified: false, reason: 'stale_timestamp' });
    expect(verifyMessageDelivery({ body: JSON.stringify(bounce), secret, headers: {} })).toMatchObject({ verified: false, reason: 'missing_headers' });
    expect(verifyMessageDelivery({ ...signed(bounce), body: JSON.stringify({ ...bounce, type: 'sms.failed' }) }).verified).toBe(false);
  });
});
