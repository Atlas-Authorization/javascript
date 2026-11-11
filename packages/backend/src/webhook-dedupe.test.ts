import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { memoryWebhookStore, sqlWebhookDedupeStore, verifyAndDedupe, verifyWebhookAndDedupe, WebhookVerificationError } from './webhook-dedupe';

const SECRET = 'whsec_test_secret';
const now = new Date('2026-11-01T12:00:00Z');
const ts = now.getTime();
const body = JSON.stringify({ id: 'evt_1', type: 'user.updated', data: { id: 'user_1' } });

function req(id = 'msg_1', secret = SECRET) {
  const mac = createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');
  return new Request('https://app.example.com/hooks', {
    method: 'POST',
    body,
    headers: { 'atlas-id': id, 'atlas-timestamp': String(ts), 'atlas-signature': `v1,${mac}` },
  });
}

describe('verifyAndDedupe', () => {
  it('flags a redelivery of the same atlas-id as a duplicate', async () => {
    const store = memoryWebhookStore();
    const opts = { secret: SECRET, store, ttlSeconds: 60, now };
    const first = await verifyAndDedupe<{ type: string }>(req(), opts);
    expect(first).toMatchObject({ duplicate: false, deliveryId: 'msg_1' });
    expect(first.event.type).toBe('user.updated');
    expect((await verifyAndDedupe(req(), opts)).duplicate).toBe(true);
    expect((await verifyAndDedupe(req('msg_2'), opts)).duplicate).toBe(false);
  });

  it('throws on a bad signature and never touches the store', async () => {
    const store = memoryWebhookStore();
    await expect(verifyAndDedupe(req('msg_1', 'whsec_other'), { secret: SECRET, store, now })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
    expect((await verifyAndDedupe(req(), { secret: SECRET, store, now })).duplicate).toBe(false);
  });

  it('release() lets a retry through after a failed handler', async () => {
    const store = memoryWebhookStore();
    const opts = { secret: SECRET, store, now };
    await (await verifyAndDedupe(req(), opts)).release();
    expect((await verifyAndDedupe(req(), opts)).duplicate).toBe(false);
  });

  it('forgets an id after its ttl', async () => {
    let t = 0;
    const store = memoryWebhookStore(() => t);
    expect(await store.setIfAbsent('k', 10)).toBe(true);
    t = 11_000;
    expect(await store.setIfAbsent('k', 10)).toBe(true);
  });
});

describe('verifyWebhookAndDedupe (Node / raw body)', () => {
  const input = (id = 'msg_1', secret = SECRET) => ({
    body: Buffer.from(body),
    headers: {
      'atlas-id': id,
      'atlas-timestamp': String(ts),
      'atlas-signature': `v1,${createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64')}`,
    },
    secret: SECRET,
    now,
  });

  it('flags a redelivery, release() frees it', async () => {
    const store = memoryWebhookStore();
    const first = await verifyWebhookAndDedupe<{ type: string }>({ ...input(), store });
    expect(first).toMatchObject({ duplicate: false, deliveryId: 'msg_1' });
    expect(first.event.type).toBe('user.updated');
    expect((await verifyWebhookAndDedupe({ ...input(), store })).duplicate).toBe(true);
    await first.release();
    expect((await verifyWebhookAndDedupe({ ...input(), store })).duplicate).toBe(false);
  });

  it('throws on a bad signature without touching the store', async () => {
    const store = memoryWebhookStore();
    await expect(verifyWebhookAndDedupe({ ...input('msg_1', 'whsec_other'), store })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
    expect((await verifyWebhookAndDedupe({ ...input(), store })).duplicate).toBe(false);
  });
});

describe('sqlWebhookDedupeStore dialects', () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const q = (rows: any[], affectedRows?: number) => async (sql: string, params: unknown[]) => (seen.push({ sql, params }), { rows, affectedRows });

  it('postgres is the default: $1 placeholders and an interval', async () => {
    seen.length = 0;
    expect(await sqlWebhookDedupeStore({ query: q([{ key: 'k' }]) }).setIfAbsent('k', 60)).toBe(true);
    expect(seen[0]!.sql).toContain('$1');
    expect(seen[0]!.sql).toContain('::interval');
  });

  it('sqlite uses ? and epoch milliseconds', async () => {
    seen.length = 0;
    const store = sqlWebhookDedupeStore({ query: q([]), dialect: 'sqlite' });
    expect(await store.setIfAbsent('k', 60)).toBe(false);
    expect(seen[0]!.sql).toContain('values (?, ?)');
    expect(seen[0]!.sql).not.toContain('$1');
    expect(typeof seen[0]!.params[1]).toBe('number');
  });

  it('mysql drops an expired row, inserts ignoring a duplicate, and claims on an affected row', async () => {
    seen.length = 0;
    expect(await sqlWebhookDedupeStore({ query: q([], 1), dialect: 'mysql' }).setIfAbsent('k', 60)).toBe(true);
    expect(seen[0]!.sql).toMatch(/^delete .*`key` = \?/);
    expect(seen[1]!.sql).toMatch(/^insert ignore/);
    expect(await sqlWebhookDedupeStore({ query: q([], 0), dialect: 'mysql' }).setIfAbsent('k', 60)).toBe(false);
  });
});
