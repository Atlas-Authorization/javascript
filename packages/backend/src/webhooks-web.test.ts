import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyAtlasWebhook, verifyAtlasWebhookRequest, verifyWebhook } from './webhooks';

/** The Web Crypto verifier must agree with the Node one on every delivery. */

const SECRET = 'whsec_test_secret';
const now = new Date('2026-11-01T12:00:00Z');
const body = JSON.stringify({ id: 'evt_1', type: 'user.updated', data: { object: 'user', id: 'user_1' } });

function sign(id: string, timestamp: number, material: string, secret = SECRET, version = 'v1') {
  const mac = createHmac('sha256', secret).update(material).digest('base64');
  return { 'atlas-id': id, 'atlas-timestamp': String(timestamp), 'atlas-signature': `${version},${mac}` };
}

describe('verifyAtlasWebhook (Web Crypto)', () => {
  const ts = now.getTime();

  it('accepts a correctly signed delivery from a string, bytes or a Headers object', async () => {
    const headers = sign('msg_1', ts, `msg_1.${ts}.${body}`);
    for (const b of [body, new TextEncoder().encode(body), new TextEncoder().encode(body).buffer]) {
      const res = await verifyAtlasWebhook<{ type: string }>({ body: b, headers, secret: SECRET, now });
      expect(res).toMatchObject({ verified: true, deliveryId: 'msg_1', timestamp: ts });
      expect(res.event?.type).toBe('user.updated');
    }
    const res = await verifyAtlasWebhook({ body, headers: new Headers(headers), secret: SECRET, now });
    expect(res.verified).toBe(true);
  });

  it('agrees with the Node verifier on tampering, staleness and malformed headers', async () => {
    const good = sign('msg_1', ts, `msg_1.${ts}.${body}`);
    const cases = [
      { body: `${body} `, headers: good },
      { body, headers: { ...good, 'atlas-id': 'msg_2' } },
      { body, headers: sign('msg_1', ts, `msg_1.${ts}.${body}`, 'whsec_other') },
      { body, headers: sign('msg_1', ts - 6 * 60_000, `msg_1.${ts - 6 * 60_000}.${body}`) },
      { body, headers: sign('msg_1', ts + 6 * 60_000, `msg_1.${ts + 6 * 60_000}.${body}`) },
      { body, headers: { ...good, 'atlas-signature': 'v1' } },
      { body, headers: { 'atlas-id': 'msg_1' } },
    ];
    for (const c of cases) {
      const web = await verifyAtlasWebhook({ ...c, secret: SECRET, now });
      const node = verifyWebhook({ ...c, secret: SECRET, now });
      expect(web.verified).toBe(false);
      expect(web.reason).toBe(node.reason);
    }
  });

  it('accepts one matching entry among several (secret rotation) and checks v2 only with the url', async () => {
    const url = 'https://app.example.com/webhooks/atlas';
    const v1 = sign('msg_1', ts, `msg_1.${ts}.${body}`)['atlas-signature'];
    const stale = sign('msg_1', ts, `msg_1.${ts}.${body}`, 'whsec_old')['atlas-signature'];
    const v2 = sign('msg_1', ts, `msg_1.${ts}.${url}.${body}`, SECRET, 'v2')['atlas-signature'];
    const base = sign('msg_1', ts, '');
    expect((await verifyAtlasWebhook({ body, headers: { ...base, 'atlas-signature': `${stale} ${v1}` }, secret: SECRET, now })).verified).toBe(true);
    // Only a v2 entry, without the url: nothing to check, so malformed.
    expect((await verifyAtlasWebhook({ body, headers: { ...base, 'atlas-signature': v2 }, secret: SECRET, now })).reason).toBe('malformed_signature');
    expect((await verifyAtlasWebhook({ body, headers: { ...base, 'atlas-signature': v2 }, secret: SECRET, now, url })).verified).toBe(true);
    // requireV2: a v1 entry alone no longer passes, and a v2 for another URL fails.
    expect((await verifyAtlasWebhook({ body, headers: { ...base, 'atlas-signature': v1 }, secret: SECRET, now, url, requireV2: true })).verified).toBe(false);
    expect((await verifyAtlasWebhook({ body, headers: { ...base, 'atlas-signature': v2 }, secret: SECRET, now, url: `${url}x`, requireV2: true })).reason).toBe('signature_mismatch');
  });

  it('fails closed on an empty secret', async () => {
    const headers = sign('msg_1', ts, `msg_1.${ts}.${body}`, '');
    expect((await verifyAtlasWebhook({ body, headers, secret: '', now })).verified).toBe(false);
  });

  it('reads a Fetch Request', async () => {
    const request = new Request('https://app.example.com/webhooks/atlas', {
      method: 'POST',
      headers: sign('msg_1', ts, `msg_1.${ts}.${body}`),
      body,
    });
    const res = await verifyAtlasWebhookRequest<{ id: string }>(request, { secret: SECRET, now });
    expect(res.verified).toBe(true);
    expect(res.event?.id).toBe('evt_1');
  });
});
