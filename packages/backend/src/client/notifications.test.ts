import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

/** A fetch mock that records calls and replies with the queued responses. */
function mockFetch(responses: Array<{ status?: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> =
    [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body as string | undefined,
    });
    const status = spec?.status ?? 200;
    const nullBody = status === 204 || status === 205 || status === 304;
    const payload = nullBody
      ? null
      : (spec?.text ?? (spec?.body === undefined ? '' : JSON.stringify(spec.body)));
    return new Response(payload, { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function setup(body: unknown = {}, status = 200) {
  const { impl, calls } = mockFetch([{ status, body }]);
  const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl });
  const last = () => calls[calls.length - 1]!;
  return { atlas, last };
}

describe('notifications', () => {
  it('send', async () => {
    const { atlas, last } = setup({ object: 'notification', id: 'ntf_1', status: 'suppressed' });
    const r = await atlas.notifications.send(
      { user_id: 'user_1', template: 'new_device', data: { device: 'Mac' } },
      'idem-n',
    );
    expect(r.status).toBe('suppressed');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/notifications`);
    expect(JSON.parse(last().body!)).toEqual({ user_id: 'user_1', template: 'new_device', data: { device: 'Mac' } });
    expect(last().headers['idempotency-key']).toBe('idem-n');
  });

  it('categories', async () => {
    const { atlas, last } = setup({ object: 'notification_category', key: 'billing', label: 'Billing' });
    await atlas.notifications.categories.list();
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/notification_categories`);

    await atlas.notifications.categories.create({ key: 'billing', label: 'Billing' });
    expect(last().method).toBe('POST');
    expect(JSON.parse(last().body!)).toEqual({ key: 'billing', label: 'Billing' });

    await atlas.notifications.categories.update('billing', { label: 'Invoices' });
    expect(last().method).toBe('PUT');
    expect(last().url).toBe(`${API_URL}/v1/notification_categories/billing`);
    expect(JSON.parse(last().body!)).toEqual({ label: 'Invoices' });

    await atlas.notifications.categories.delete('billing');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/notification_categories/billing`);
  });

  it('templates', async () => {
    const { atlas, last } = setup({ object: 'notification_template', name: 'invoice' });
    await atlas.notifications.templates.list();
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/notification_templates`);

    const body = { name: 'invoice', subject: 'Hi {{name}}', body: 'Body', category: 'billing' };
    await atlas.notifications.templates.create(body);
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/notification_templates`);
    expect(JSON.parse(last().body!)).toEqual(body);

    await atlas.notifications.templates.get('invoice');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/notification_templates/invoice`);

    await atlas.notifications.templates.update('invoice', { subject: 's', body: 'b', category: 'billing' });
    expect(last().method).toBe('PUT');
    expect(last().url).toBe(`${API_URL}/v1/notification_templates/invoice`);
    expect(JSON.parse(last().body!)).toEqual({ subject: 's', body: 'b', category: 'billing' });

    await atlas.notifications.templates.delete('invoice');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/notification_templates/invoice`);
  });
});
