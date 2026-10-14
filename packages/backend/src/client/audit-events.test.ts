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

function setup(spec: { status?: number; body?: unknown; text?: string } = { body: {} }) {
  const { impl, calls } = mockFetch([spec]);
  const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl });
  const last = () => calls[calls.length - 1]!;
  return { atlas, last };
}

const event = { actor: { type: 'user', id: 'u1' }, action: 'invoice.sent', organization_id: 'org_1', occurred_at: 1700000000000 };

describe('auditEvents', () => {
  it('create and batch', async () => {
    const { atlas, last } = setup({ status: 201, body: { object: 'audit_event', id: 'ae_1' } });
    const e = await atlas.auditEvents.create(event, 'idem-a');
    expect(e.id).toBe('ae_1');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/audit_events`);
    expect(JSON.parse(last().body!)).toEqual(event);
    expect(last().headers['idempotency-key']).toBe('idem-a');

    await atlas.auditEvents.createBatch([event, event]);
    expect(last().url).toBe(`${API_URL}/v1/audit_events/batch`);
    expect(JSON.parse(last().body!)).toEqual({ events: [event, event] });
  });

  it('list with filters', async () => {
    const { atlas, last } = setup({ body: { object: 'list', data: [], has_more: false, next_cursor: null } });
    await atlas.auditEvents.list({
      organization_id: 'org_1',
      actor_id: 'a,b',
      any_of: true,
      from: 1,
      to: 2,
      metadata_key: 'k',
      metadata_value: 'v',
      limit: 10,
      starting_after: 'ae_9',
    });
    expect(last().method).toBe('GET');
    expect(last().url).toBe(
      `${API_URL}/v1/audit_events?organization_id=org_1&actor_id=a%2Cb&any_of=true&from=1&to=2&metadata_key=k&metadata_value=v&limit=10&starting_after=ae_9`,
    );
  });

  it('export returns raw text', async () => {
    const jsonl = '{"id":"ae_1"}\n{"id":"ae_2"}\n';
    const { atlas, last } = setup({ text: jsonl });
    const out = await atlas.auditEvents.export({ format: 'jsonl', action: 'invoice.sent' });
    expect(out).toBe(jsonl);
    expect(last().url).toBe(`${API_URL}/v1/audit_events/export?format=jsonl&action=invoice.sent`);
  });

  it('deleteAll (test-mode reset)', async () => {
    const { atlas, last } = setup({ body: { object: 'audit_events.bulk_delete', deleted: 3 } });
    const r = await atlas.auditEvents.deleteAll({ organization_id: 'org_1' });
    expect(r.deleted).toBe(3);
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/audit_events?organization_id=org_1`);
    await atlas.auditEvents.deleteAll();
    expect(last().url).toBe(`${API_URL}/v1/audit_events`);
  });
});
