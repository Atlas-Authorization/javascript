import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhook } from './webhooks';

const SECRET = 'whsec_test_secret';

/** Sign a body exactly the way the Atlas server does, for the happy path. */
function sign(id: string, timestamp: number, body: string, secret = SECRET) {
  const mac = createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'atlas-id': id,
    'atlas-timestamp': String(timestamp),
    'atlas-signature': `v1,${mac}`,
  };
}

describe('verifyWebhook', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const body = JSON.stringify({ id: 'evt_1', type: 'user.created', data: { object: 'user', id: 'usr_1' } });

  it('accepts and parses a correctly-signed delivery', () => {
    const headers = sign('evt_1', now.getTime(), body);
    const res = verifyWebhook<{ type: string }>({ body, headers, secret: SECRET, now });
    expect(res.verified).toBe(true);
    expect(res.event?.type).toBe('user.created');
  });

  it('accepts a header with several signatures when one of them matches (secret rotation)', () => {
    const ts = now.getTime();
    const stale = sign('evt_1', ts, body, 'whsec_old_secret')['atlas-signature'];
    const fresh = sign('evt_1', ts, body)['atlas-signature'];
    for (const header of [`${stale} ${fresh}`, `${fresh} ${stale}`, `v2,abc ${fresh}`]) {
      const headers = { ...sign('evt_1', ts, body), 'atlas-signature': header };
      const res = verifyWebhook({ body, headers, secret: SECRET, now });
      expect(res.verified).toBe(true);
    }
    // Only stale signatures: a mismatch, never a pass.
    const onlyStale = { ...sign('evt_1', ts, body), 'atlas-signature': `${stale} ${stale}` };
    expect(verifyWebhook({ body, headers: onlyStale, secret: SECRET, now }).reason).toBe('signature_mismatch');
    // No v1 entry at all is malformed.
    const noV1 = { ...sign('evt_1', ts, body), 'atlas-signature': 'v2,abc v0,def' };
    expect(verifyWebhook({ body, headers: noV1, secret: SECRET, now }).reason).toBe('malformed_signature');
  });

  it('returns the signed delivery id and timestamp for deduplication (ATL-S-23)', () => {
    const ts = now.getTime() - 1_000;
    const headers = sign('evt_1', ts, body);
    const res = verifyWebhook({ body, headers, secret: SECRET, now });
    expect(res.verified).toBe(true);
    expect(res.deliveryId).toBe(headers['atlas-id']);
    expect(res.timestamp).toBe(ts);
    // Never on a failed verification.
    const bad = verifyWebhook({ body: `${body} `, headers, secret: SECRET, now });
    expect(bad.deliveryId).toBeUndefined();
    expect(bad.timestamp).toBeUndefined();
  });

  it('rejects a tampered body (signature mismatch)', () => {
    const headers = sign('evt_1', now.getTime(), body);
    const res = verifyWebhook({ body: body.replace('usr_1', 'usr_hacked'), headers, secret: SECRET, now });
    expect(res.verified).toBe(false);
    expect(res.reason).toBe('signature_mismatch');
  });

  it('rejects a stale timestamp (replay window)', () => {
    const old = now.getTime() - 6 * 60_000; // 6 min > 5 min tolerance
    const headers = sign('evt_1', old, body);
    const res = verifyWebhook({ body, headers, secret: SECRET, now });
    expect(res.verified).toBe(false);
    expect(res.reason).toBe('stale_timestamp');
  });

  it('rejects a wrong secret', () => {
    const headers = sign('evt_1', now.getTime(), body, 'whsec_wrong');
    const res = verifyWebhook({ body, headers, secret: SECRET, now });
    expect(res.verified).toBe(false);
    expect(res.reason).toBe('signature_mismatch');
  });

  it('rejects missing/malformed headers', () => {
    expect(verifyWebhook({ body, headers: {}, secret: SECRET, now }).reason).toBe('missing_headers');
    const bad = { 'atlas-id': 'e', 'atlas-timestamp': String(now.getTime()), 'atlas-signature': 'garbage' };
    expect(verifyWebhook({ body, headers: bad, secret: SECRET, now }).reason).toBe('malformed_signature');
  });

  it('reads headers from a Fetch Headers object and a Buffer body', () => {
    const h = sign('evt_1', now.getTime(), body);
    const headers = new Headers(h);
    const res = verifyWebhook({ body: Buffer.from(body), headers, secret: SECRET, now });
    expect(res.verified).toBe(true);
  });
});

describe('verifyWebhook v2 (URL-covering) signatures', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  const body = JSON.stringify({ id: 'evt_2', type: 'user.created', data: {} });
  const url = 'https://hooks.example.com/atlas';
  const v2 = (u: string) =>
    createHmac('sha256', SECRET).update(`evt_2.${now.getTime()}.${u}.${body}`).digest('base64');
  const v1 = createHmac('sha256', SECRET).update(`evt_2.${now.getTime()}.${body}`).digest('base64');
  const headers = (sig: string) => ({ 'atlas-id': 'evt_2', 'atlas-timestamp': String(now.getTime()), 'atlas-signature': sig });

  it('accepts a v2 entry for the right URL', () => {
    expect(verifyWebhook({ body, headers: headers(`v2,${v2(url)}`), secret: SECRET, now, url }).verified).toBe(true);
  });
  it('rejects a v2 entry signed for another URL', () => {
    const res = verifyWebhook({ body, headers: headers(`v2,${v2('https://other.example.com/x')}`), secret: SECRET, now, url });
    expect(res.reason).toBe('signature_mismatch');
  });
  it('requireV2 ignores the v1 entry', () => {
    const both = headers(`v1,${v1} v2,${v2('https://other.example.com/x')}`);
    expect(verifyWebhook({ body, headers: both, secret: SECRET, now }).verified).toBe(true);
    expect(verifyWebhook({ body, headers: both, secret: SECRET, now, url, requireV2: true }).verified).toBe(false);
  });
  it('without url, a v2-only header is malformed (v1 verifiers are unaffected by the extra entry)', () => {
    expect(verifyWebhook({ body, headers: headers(`v2,${v2(url)}`), secret: SECRET, now }).reason).toBe('malformed_signature');
  });
});
