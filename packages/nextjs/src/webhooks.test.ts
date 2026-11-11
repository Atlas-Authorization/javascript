import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createBeforeUserCreateHandler, createWebhookHandler, memoryDedupeStore } from './webhooks';

const SECRET = 'whsec_test';
function signed(payload: object, id = 'msg_1', secret = SECRET, extra: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  const ts = Date.now();
  const mac = createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');
  return new Request('https://app.example.com/hook', {
    method: 'POST',
    body,
    headers: { 'atlas-id': id, 'atlas-timestamp': String(ts), 'atlas-signature': `v1,${mac}`, ...extra },
  });
}

describe('createWebhookHandler', () => {
  it('answers 503 without a secret', async () => {
    const res = await createWebhookHandler({ secret: undefined, onEvent: vi.fn() })(signed({ type: 'x' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('webhook_secret_missing');
  });

  it('rejects a bad signature with 400 and never calls onEvent', async () => {
    const onEvent = vi.fn();
    const res = await createWebhookHandler({ secret: SECRET, onEvent })(signed({ type: 'x' }, 'm', 'other'));
    expect(res.status).toBe(400);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('dedupes by event id', async () => {
    const onEvent = vi.fn();
    const h = createWebhookHandler({ secret: SECRET, onEvent, store: memoryDedupeStore() });
    expect((await h(signed({ type: 'user.created' }))).status).toBe(200);
    expect((await (await h(signed({ type: 'user.created' }))).json()).duplicate).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('releases the entry and answers 500 when onEvent throws, so the retry runs', async () => {
    const onEvent = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const h = createWebhookHandler({ secret: SECRET, onEvent });
    expect((await h(signed({ type: 'user.created' }))).status).toBe(500);
    expect((await h(signed({ type: 'user.created' }))).status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('answers the test delivery without calling onEvent unless asked', async () => {
    const onEvent = vi.fn();
    expect((await createWebhookHandler({ secret: SECRET, onEvent })(signed({ type: 'webhook.test' }))).status).toBe(200);
    expect(onEvent).not.toHaveBeenCalled();
    await createWebhookHandler({ secret: SECRET, onEvent, handleTest: true })(signed({ type: 'webhook.test' }));
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe('createBeforeUserCreateHandler', () => {
  it('returns external_id for a signed call', async () => {
    const res = await createBeforeUserCreateHandler({ secret: SECRET, externalId: async () => 'u_1' })(
      signed({ type: 'user.before_create', test: false, data: {} }),
    );
    expect(await res.json()).toEqual({ external_id: 'u_1' });
  });

  it('answers a test call without calling externalId', async () => {
    const externalId = vi.fn();
    const res = await createBeforeUserCreateHandler({ secret: SECRET, externalId })(
      signed({ type: 'user.before_create', test: true }, 'm', SECRET, { 'atlas-test': '1' }),
    );
    expect(res.status).toBe(200);
    expect(externalId).not.toHaveBeenCalled();
  });

  it('503 without a secret, 401 on a bad signature, 500 when externalId throws', async () => {
    const ok = { externalId: () => 'x' };
    expect((await createBeforeUserCreateHandler({ secret: '', ...ok })(signed({}))).status).toBe(503);
    expect((await createBeforeUserCreateHandler({ secret: SECRET, ...ok })(signed({}, 'm', 'bad'))).status).toBe(401);
    const boom = createBeforeUserCreateHandler({ secret: SECRET, externalId: () => { throw new Error('x'); } });
    expect((await boom(signed({ type: 'user.before_create' }))).status).toBe(500);
  });
});
