import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { REFERRAL_CONNECTION_TEST_REF, referralOpForPath, verifyReferralRequest } from './referrals';

const SECRET = 'referral_signing_secret_0123456789';
const now = new Date('2026-10-21T12:00:00Z');

/** Sign exactly as the Atlas server signs a referral call (the webhook scheme over the raw body). */
function sign(id: string, body: string, secret = SECRET, timestamp = now.getTime()) {
  const mac = createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'atlas-id': id,
    'atlas-timestamp': String(timestamp),
    'atlas-signature': `v1,${mac}`,
    'idempotency-key': `signup:user_1`,
    'user-agent': 'Atlas-Referrals/1',
  };
}

const signup = JSON.stringify({
  op: 'signup',
  customerRef: 'user_1',
  emailHash: 'ab'.repeat(32),
  ip: '203.0.113.7',
  ua: 'Mozilla/5.0',
  signedUpAt: '2026-10-21T11:59:00.000Z',
  programId: null,
  autoEnroll: true,
  referral: { code: 'ACME10', clickId: null, anonId: null, capturedAt: '2026-10-21T11:58:00.000Z', consent: 'not_required' },
  risk: { level: 'low', score: 0, signals: [], captcha: 'passed', emailVerified: false },
  rejected: null,
});
const erase = JSON.stringify({ op: 'erase', customerRef: 'user_1' });
const exportTest = JSON.stringify({ op: 'export', customerRef: REFERRAL_CONNECTION_TEST_REF, test: true });
const exportUser = JSON.stringify({ op: 'export', customerRef: 'user_1', test: false });
const partner = JSON.stringify({ op: 'partner', customerRef: 'user_1', code: 'ada-1', emailHash: null });
const signal = JSON.stringify({ op: 'signal', customerRef: 'user_1', type: 'fraud_confirmed', occurredAt: '2026-10-21T12:00:00.000Z', data: { reason: 'ring' } });

const verify = (body: string, path?: string, expectedOp?: Parameters<typeof verifyReferralRequest>[0]['expectedOp'], id = 'rfc_1') =>
  verifyReferralRequest({ body, headers: sign(id, body), secret: SECRET, path, expectedOp, now });

describe('verifyReferralRequest', () => {
  it('verifies a sign-up on its endpoint and types its payload', () => {
    const res = verify(signup, '/atlas/signups');
    expect(res.verified).toBe(true);
    expect(res.deliveryId).toBe('rfc_1');
    expect(res.idempotencyKey).toBe('signup:user_1');
    if (res.call?.op !== 'signup') throw new Error('expected a signup');
    expect(res.call.payload.referral?.code).toBe('ACME10');
    expect(res.call.payload.risk?.captcha).toBe('passed');
  });

  it('exposes test on export and spots the connection test', () => {
    const test = verify(exportTest, 'https://referrals.example.com/atlas/export');
    expect(test.call).toEqual({ op: 'export', test: true, payload: { op: 'export', customerRef: 'atlas_connection_test', test: true } });
    const user = verify(exportUser, '/export');
    expect(user.call?.op === 'export' && user.call.test).toBe(false);
  });

  it('verifies erase, partner and signal calls by path or by expected operation', () => {
    expect(verify(erase, '/erase').call).toEqual({ op: 'erase', payload: { op: 'erase', customerRef: 'user_1' } });
    const p = verify(partner, '/atlas/partners/');
    expect(p.call?.op === 'partner' && p.call.payload.customerRef).toBe('user_1');
    const s = verify(signal, undefined, 'signal');
    expect(s.call?.op === 'signal' && s.call.payload.type).toBe('fraud_confirmed');
    // Neither path nor expected operation: the signed op decides.
    expect(verify(partner).call?.op).toBe('partner');
  });

  it('refuses a signed body replayed against another endpoint or operation', () => {
    expect(verify(exportUser, '/atlas/erase')).toEqual({ verified: false, reason: 'op_mismatch' });
    expect(verify(signup, '/atlas/partners')).toEqual({ verified: false, reason: 'op_mismatch' });
    expect(verify(erase, undefined, 'export').reason).toBe('op_mismatch');
    expect(verify(erase, '/erase', 'signal').reason).toBe('op_mismatch');
    expect(verify(erase, '/atlas/partners/user_1').reason).toBe('unknown_endpoint');
    expect(verify(erase, '/atlas/webhooks').reason).toBe('unknown_endpoint');
  });

  it('refuses a missing, unknown or non-string op and a body that is not an object', () => {
    expect(verify(JSON.stringify({ customerRef: 'user_1' }), '/erase').reason).toBe('missing_op');
    expect(verify(JSON.stringify({ op: 'delete', customerRef: 'user_1' }), '/erase').reason).toBe('unknown_op');
    expect(verify(JSON.stringify({ op: 7 }), '/erase').reason).toBe('unknown_op');
    expect(verify('', '/export').reason).toBe('malformed_body');
    expect(verify('[1]', '/export').reason).toBe('malformed_body');
  });

  it('refuses a wrong secret, a tampered body, a stale call and missing headers', () => {
    expect(verifyReferralRequest({ body: signup, headers: sign('rfc_7', signup, 'another_secret_0123456789'), secret: SECRET, now }).reason).toBe(
      'signature_mismatch',
    );
    expect(verifyReferralRequest({ body: `${signup} `, headers: sign('rfc_7', signup), secret: SECRET, now }).reason).toBe('signature_mismatch');
    const stale = sign('rfc_7', signup, SECRET, now.getTime() - 10 * 60_000);
    expect(verifyReferralRequest({ body: signup, headers: stale, secret: SECRET, now }).reason).toBe('stale_timestamp');
    expect(verifyReferralRequest({ body: '', headers: {}, secret: SECRET, now })).toEqual({ verified: false, reason: 'missing_headers' });
  });

  it('reads Buffer bodies and Fetch Headers too', () => {
    const res = verifyReferralRequest({ body: Buffer.from(signup), headers: new Headers(sign('rfc_9', signup)), secret: SECRET, path: '/signups', now });
    expect(res.verified).toBe(true);
    expect(res.idempotencyKey).toBe('signup:user_1');
  });

  it('maps endpoint paths to operations', () => {
    expect(referralOpForPath('/a/signups')).toBe('signup');
    expect(referralOpForPath('https://x.example.com/base/partners?x=1')).toBe('partner');
    expect(referralOpForPath('/signals/')).toBe('signal');
    expect(referralOpForPath('/nope')).toBeNull();
  });
});
