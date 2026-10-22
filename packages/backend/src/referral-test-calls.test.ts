import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createTestIssuer } from './testing';
import { verifyReferralRequest } from './referrals';
import { verifyWebhook } from './webhooks';
import {
  referralEmailHash,
  referallySignature,
  signAtlasReferralCall,
  signReferallyCall,
  signReferralUpdatedEvent,
} from './referral-test-calls';

const SECRET = 'referral_signing_secret_0123456789';
const NOW = Date.parse('2026-10-21T14:03:11Z');

/** Verify an x-referally-signature exactly as the spec defines it. */
function referallyVerifies(header: string, payload: string, secret: string): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const expected = createHmac('sha256', secret).update(`${m[1]}.${payload}`).digest('hex');
  return expected === m[2];
}

describe('signAtlasReferralCall', () => {
  it('signs a call that verifyReferralRequest accepts on its endpoint', () => {
    const call = signAtlasReferralCall({
      baseUrl: 'https://platform.example.com/atlas/',
      secret: SECRET,
      op: 'alias',
      payload: { customerRef: 'usr_8812', fromCustomerRef: 'user_1', toCustomerRef: 'usr_8812' },
      callId: 'rfc_1',
      now: NOW,
    });
    expect(call.url).toBe('https://platform.example.com/atlas/aliases');
    expect(call.method).toBe('POST');
    expect(call.headers['atlas-referrals-version']).toBe('2026-10-21');
    expect(call.headers['idempotency-key']).toBe('alias:usr_8812');
    const r = verifyReferralRequest({
      body: call.body!,
      headers: call.headers,
      secret: SECRET,
      path: new URL(call.url).pathname,
      now: new Date(NOW),
    });
    expect(r.verified).toBe(true);
    expect(r.deliveryId).toBe('rfc_1');
    expect(r.call?.op).toBe('alias');
    expect(verifyReferralRequest({ body: call.body!, headers: call.headers, secret: 'wrong_secret_wrong_secret', now: new Date(NOW) }).verified).toBe(false);
  });
});

describe('signReferallyCall', () => {
  it('signs a POST over the raw body with unix seconds and the version header', () => {
    const body = { customerRef: 'usr_8812', signedUpAt: '2026-10-21T14:03:11Z', referral: { code: 'WJXQGLBW', consent: 'not_required' } };
    const call = signReferallyCall({ baseUrl: 'https://referrals.example.com/', connectionId: 'conn_1', secret: SECRET, op: 'signups', body, now: NOW });
    expect(call.url).toBe('https://referrals.example.com/v1/auth/connections/conn_1/signups');
    expect(call.method).toBe('POST');
    expect(call.headers['referally-version']).toBe('2026-10-21');
    expect(call.headers['x-referally-signature']).toMatch(new RegExp(`^t=${NOW / 1000},v1=`));
    expect(referallyVerifies(call.headers['x-referally-signature']!, call.body!, SECRET)).toBe(true);
    expect(referallyVerifies(call.headers['x-referally-signature']!, call.body!, 'other')).toBe(false);
  });

  it('signs a GET export over the raw query string', () => {
    const call = signReferallyCall({ baseUrl: 'https://referrals.example.com', connectionId: 'conn_1', secret: SECRET, op: 'export', customerRef: 'usr 1', now: NOW });
    expect(call.method).toBe('GET');
    expect(call.body).toBeUndefined();
    expect(call.url).toBe('https://referrals.example.com/v1/auth/connections/conn_1/export?customerRef=usr+1');
    expect(referallyVerifies(call.headers['x-referally-signature']!, 'customerRef=usr+1', SECRET)).toBe(true);
    expect(() => signReferallyCall({ baseUrl: 'https://r.example.com', connectionId: 'c', secret: SECRET, op: 'export' })).toThrow(/customerRef/);
  });

  it('signs an empty payload for a body-less ping as "{}"', () => {
    const call = signReferallyCall({ baseUrl: 'https://r.example.com', connectionId: 'c', secret: SECRET, op: 'ping', now: NOW });
    expect(call.body).toBe('{}');
    expect(call.request().method).toBe('POST');
    expect(referallySignature(SECRET, '', 1)).toMatch(/^t=1,v1=[0-9a-f]{64}$/);
  });

  it('hashes emails as Atlas does', () => {
    expect(referralEmailHash(' A@B.com ')).toBe(referralEmailHash('a@b.com'));
    expect(referralEmailHash(null)).toBeNull();
  });
});

describe('createTestIssuer referral calls', () => {
  it('uses the issuer clock', async () => {
    const fx = await createTestIssuer({ now: () => NOW });
    const a = fx.referralCall({ baseUrl: 'https://p.example.com', secret: SECRET, op: 'ping', payload: { customerRef: 'atlas_connection_test' } });
    expect(a.headers['atlas-timestamp']).toBe(String(NOW));
    const b = fx.referallyCall({ baseUrl: 'https://r.example.com', connectionId: 'c', secret: SECRET, op: 'users', body: { customerRef: 'u', status: 'suspended' } });
    expect(b.headers['x-referally-signature']).toMatch(new RegExp(`^t=${NOW / 1000},`));
  });
});

describe('signReferralUpdatedEvent', () => {
  const INBOUND = 'https://api.example.test/v1/webhooks/referrals/ins_1';

  it('signs a referral.updated event like an Atlas webhook, to the inbound URL', () => {
    const call = signReferralUpdatedEvent({
      inboundUrl: INBOUND,
      secret: SECRET,
      event: { customerRef: 'usr_8812', referralId: 'ref_1', status: 'qualified', partnerId: 'pn_2' },
      occurredAt: NOW - 1000,
      eventId: 'rfe_1',
      now: NOW,
    });
    expect(call.url).toBe(INBOUND);
    expect(call.method).toBe('POST');
    expect(call.headers['atlas-id']).toBe('rfe_1');
    expect(call.headers['atlas-timestamp']).toBe(String(NOW));
    const expected = createHmac('sha256', SECRET).update(`rfe_1.${NOW}.${call.body}`).digest('base64');
    expect(call.headers['atlas-signature']).toBe(`v1,${expected}`);
    const r = verifyWebhook<Record<string, unknown>>({ body: call.body!, headers: call.headers, secret: SECRET, now: new Date(NOW) });
    expect(r.verified).toBe(true);
    expect(r.event).toEqual({
      type: 'referral.updated',
      occurredAt: new Date(NOW - 1000).toISOString(),
      customerRef: 'usr_8812',
      referralId: 'ref_1',
      status: 'qualified',
      partnerId: 'pn_2',
    });
    expect(verifyWebhook({ body: call.body!, headers: call.headers, secret: 'wrong_secret_wrong_secret', now: new Date(NOW) }).verified).toBe(false);
  });

  it('defaults occurredAt to now, keeps an ISO occurredAt, and needs a referral reference', () => {
    const a = signReferralUpdatedEvent({ inboundUrl: INBOUND, secret: SECRET, event: { referralId: 'ref_1' }, now: NOW });
    expect(JSON.parse(a.body!).occurredAt).toBe(new Date(NOW).toISOString());
    expect(a.headers['atlas-id']).toMatch(/^rfe_[0-9a-f]{16}$/);
    const b = signReferralUpdatedEvent({ inboundUrl: INBOUND, secret: SECRET, event: { customerRef: 'u' }, occurredAt: '2026-10-20T00:00:00Z', now: NOW });
    expect(JSON.parse(b.body!).occurredAt).toBe('2026-10-20T00:00:00Z');
    expect(() => signReferralUpdatedEvent({ inboundUrl: INBOUND, secret: SECRET, event: { status: 'qualified' } })).toThrow(/customerRef or referralId/);
  });

  it('is on the test issuer with its clock', async () => {
    const fx = await createTestIssuer({ now: () => NOW });
    const e = fx.referralUpdatedEvent({ inboundUrl: INBOUND, secret: SECRET, event: { customerRef: 'u' } });
    expect(e.headers['atlas-timestamp']).toBe(String(NOW));
    expect(verifyWebhook({ body: e.body!, headers: e.headers, secret: SECRET, now: new Date(NOW) }).verified).toBe(true);
  });
});
