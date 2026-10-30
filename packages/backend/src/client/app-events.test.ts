import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createAtlasClient } from './index';
import { verifyStandardWebhook } from '../webhooks';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

function mockFetch(body: unknown) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}
const client = (f: typeof fetch) => createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: f });

describe('appEvents (application webhooks)', () => {
  it('publishes an event to one organization', async () => {
    const { impl, calls } = mockFetch({ object: 'app_event', id: 'evt_1', idempotent_replay: false });
    const r = await client(impl).appEvents.publish({ organization_id: 'org_1', type: 'call.completed', data: { call_id: 'c1' }, idempotency_key: 'c1' });
    expect(r.id).toBe('evt_1');
    expect([calls[0]!.method, calls[0]!.url]).toEqual(['POST', `${API_URL}/v1/app_events`]);
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ organization_id: 'org_1', type: 'call.completed', data: { call_id: 'c1' }, idempotency_key: 'c1' });
  });

  it('manages the catalog and an organization’s endpoints at the right paths', async () => {
    const { impl, calls } = mockFetch({});
    const c = client(impl);
    await c.appEvents.types.create({ type: 'call.completed' });
    await c.appEvents.types.update('call.completed', { deprecated: true });
    await c.appEvents.endpoints.create('org_1', { url: 'https://hooks.example.com/a', enabled_events: ['call.completed'] });
    await c.appEvents.endpoints.revealSecret('org_1', 'wh_1');
    await c.appEvents.endpoints.test('org_1', 'wh_1', { wait: '10s' });
    await c.appEvents.endpoints.redeliver('org_1', 'wh_1', 'whd_1');
    await c.appEvents.endpoints.replay('org_1', 'wh_1', { since: 'failing_since' });
    expect(calls.map((x) => `${x.method} ${x.url.replace(API_URL, '')}`)).toEqual([
      'POST /v1/app_event_types',
      'PATCH /v1/app_event_types/call.completed',
      'POST /v1/organizations/org_1/app_webhook_endpoints',
      'POST /v1/organizations/org_1/app_webhook_endpoints/wh_1/reveal_secret',
      'POST /v1/organizations/org_1/app_webhook_endpoints/wh_1/test?wait=10s',
      'POST /v1/organizations/org_1/app_webhook_endpoints/wh_1/deliveries/whd_1/redeliver',
      'POST /v1/organizations/org_1/app_webhook_endpoints/wh_1/replay',
    ]);
  });
});

describe('verifyStandardWebhook', () => {
  const key = Buffer.alloc(32, 7);
  const secret = `whsec_${key.toString('base64')}`;
  const now = new Date('2026-10-30T12:00:00Z');
  const ts = Math.floor(now.getTime() / 1000);
  const body = JSON.stringify({ id: 'evt_1', type: 'call.completed', data: { call_id: 'c1' } });
  const sig = (k: Buffer, t = ts) => `v1,${createHmac('sha256', k).update(`evt_1.${t}.${body}`).digest('base64')}`;
  const headers = (s: string, t = ts) => ({ 'webhook-id': 'evt_1', 'webhook-timestamp': String(t), 'webhook-signature': s });

  it('accepts a correct signature (also among several, as during a rotation)', () => {
    expect(verifyStandardWebhook({ body, headers: headers(sig(key)), secret, now }).verified).toBe(true);
    const both = `${sig(Buffer.alloc(32, 1))} ${sig(key)}`;
    const r = verifyStandardWebhook<{ type: string }>({ body, headers: headers(both), secret, now });
    expect(r.verified).toBe(true);
    expect(r.event?.type).toBe('call.completed');
    expect(r.deliveryId).toBe('evt_1');
  });

  it('rejects a wrong key, a tampered body, a stale timestamp and missing headers', () => {
    expect(verifyStandardWebhook({ body, headers: headers(sig(Buffer.alloc(32, 1))), secret, now }).reason).toBe('signature_mismatch');
    expect(verifyStandardWebhook({ body: `${body} `, headers: headers(sig(key)), secret, now }).reason).toBe('signature_mismatch');
    expect(verifyStandardWebhook({ body, headers: headers(sig(key, ts - 301), ts - 301), secret, now }).reason).toBe('stale_timestamp');
    expect(verifyStandardWebhook({ body, headers: { 'webhook-id': 'evt_1' }, secret, now }).reason).toBe('missing_headers');
    // The secret is the base64 AFTER whsec_, never the literal string.
    const literal = `v1,${createHmac('sha256', secret).update(`evt_1.${ts}.${body}`).digest('base64')}`;
    expect(verifyStandardWebhook({ body, headers: headers(literal), secret, now }).verified).toBe(false);
  });
});
