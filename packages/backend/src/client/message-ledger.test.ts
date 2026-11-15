import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const API_URL = 'https://api.example.test';

function setup(reply: unknown = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  return { c: createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: fetchImpl }), calls };
}

describe('messages (the ledger)', () => {
  it('lists with the filters as query parameters, dropping the unset ones', async () => {
    const { c, calls } = setup({ object: 'list', data: [], has_more: false, next_cursor: null });
    await c.messages.list({ channel: 'sms', status: 'failed', recipient: '+442071838750', limit: 10, template: undefined });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/messages');
    expect(Object.fromEntries(url.searchParams)).toEqual({ channel: 'sms', status: 'failed', recipient: '+442071838750', limit: '10' });
    expect(calls[0]!.method).toBe('GET');
  });

  it('lists with no query at all', async () => {
    const { c, calls } = setup();
    await c.messages.list();
    expect(calls[0]!.url).toBe(`${API_URL}/v1/messages`);
  });

  it('gets one message with its id encoded, and the summary window', async () => {
    const { c, calls } = setup();
    await c.messages.get('msg/odd id');
    await c.messages.summary({ hours: 48 });
    expect(calls[0]!.url).toBe(`${API_URL}/v1/messages/msg%2Fodd%20id`);
    expect(calls[1]!.url).toBe(`${API_URL}/v1/messages/summary?hours=48`);
  });
});

describe('messages.send', () => {
  it('posts the body with the idempotency key', async () => {
    const calls: Array<{ method: string; body: unknown; key: string | null }> = [];
    const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('idempotency-key') });
      return new Response(JSON.stringify({ object: 'message', id: 'msg_1' }), { status: 201 });
    }) as unknown as typeof fetch;
    const c = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: fetchImpl });
    await c.messages.send({ to: 'jo@example.com', subject: 'Hi', text: 'Hello', tags: { a: 'b' } }, 'key-1');
    expect(calls[0]).toEqual({ method: 'POST', body: { to: 'jo@example.com', subject: 'Hi', text: 'Hello', tags: { a: 'b' } }, key: 'key-1' });
  });
});

describe('suppressions', () => {
  it('adds one or many addresses with the body as given', async () => {
    const { c, calls } = setup();
    await c.suppressions.add({ addresses: ['a@example.com', 'b@example.com'], reason: 'hard_bounce', detail: 'imported' });
    expect(calls[0]).toEqual({ url: `${API_URL}/v1/suppressions`, method: 'POST', body: { addresses: ['a@example.com', 'b@example.com'], reason: 'hard_bounce', detail: 'imported' } });
  });

  it('lists, gets and removes', async () => {
    const { c, calls } = setup();
    await c.suppressions.list({ channel: 'sms', reason: 'invalid' });
    await c.suppressions.get('sup_1');
    await c.suppressions.remove('sup_1');
    expect(calls.map((x) => [x.method, x.url.replace(API_URL, '')])).toEqual([
      ['GET', '/v1/suppressions?channel=sms&reason=invalid'],
      ['GET', '/v1/suppressions/sup_1'],
      ['DELETE', '/v1/suppressions/sup_1'],
    ]);
  });
});

describe('messaging routing, mounted next to the provider setters', () => {
  it('keeps the existing provider setters', () => {
    const { c } = setup();
    expect(typeof c.messaging.setEmail).toBe('function');
    expect(typeof c.messaging.fallbacks.add).toBe('function');
  });

  it('manages fallbacks per channel', async () => {
    const { c, calls } = setup();
    await c.messaging.fallbacks.list('sms');
    await c.messaging.fallbacks.add('sms', { transport: 'vonage', from_address: 'Acme', config: { api_key: 'k', api_secret: 's' } });
    await c.messaging.fallbacks.update('sms', 'mfb_1', { status: 'disabled' });
    await c.messaging.fallbacks.reorder('sms', ['mfb_2', 'mfb_1']);
    await c.messaging.fallbacks.remove('sms', 'mfb_1');
    expect(calls.map((x) => [x.method, x.url.replace(API_URL, ''), x.body])).toEqual([
      ['GET', '/v1/messaging_providers/sms/fallbacks', undefined],
      ['POST', '/v1/messaging_providers/sms/fallbacks', { transport: 'vonage', from_address: 'Acme', config: { api_key: 'k', api_secret: 's' } }],
      ['PUT', '/v1/messaging_providers/sms/fallbacks/mfb_1', { status: 'disabled' }],
      ['PUT', '/v1/messaging_providers/sms/fallbacks/order', { ids: ['mfb_2', 'mfb_1'] }],
      ['DELETE', '/v1/messaging_providers/sms/fallbacks/mfb_1', undefined],
    ]);
  });

  it('manages country routes and settings', async () => {
    const { c, calls } = setup();
    await c.messaging.countryRoutes.list();
    await c.messaging.countryRoutes.put('DE', 'mfb_1');
    await c.messaging.countryRoutes.remove('DE');
    await c.messaging.settings.get();
    await c.messaging.settings.put({ auto_suppress: false, ledger_retention_days: 30 });
    expect(calls.map((x) => [x.method, x.url.replace(API_URL, ''), x.body])).toEqual([
      ['GET', '/v1/messaging/country_routes', undefined],
      ['PUT', '/v1/messaging/country_routes', { country: 'DE', provider_id: 'mfb_1' }],
      ['DELETE', '/v1/messaging/country_routes/DE', undefined],
      ['GET', '/v1/messaging/settings', undefined],
      ['PUT', '/v1/messaging/settings', { auto_suppress: false, ledger_retention_days: 30 }],
    ]);
  });
});

describe('messageReceivers', () => {
  it('lists, stores and removes a verification secret', async () => {
    const { c, calls } = setup();
    await c.messageReceivers.list();
    await c.messageReceivers.setSecret('mailgun', 'signing-key');
    await c.messageReceivers.removeSecret('mailgun');
    expect(calls.map((x) => [x.method, x.url.replace(API_URL, ''), x.body])).toEqual([
      ['GET', '/v1/message_receivers', undefined],
      ['PUT', '/v1/message_receivers/mailgun', { secret: 'signing-key' }],
      ['DELETE', '/v1/message_receivers/mailgun', undefined],
    ]);
  });
});
