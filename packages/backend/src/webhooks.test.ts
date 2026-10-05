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
