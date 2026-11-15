import { describe, expect, it } from 'vitest';
import { verifyStandardWebhook } from './webhooks';
import { verifyStandardWebhookRequest, verifyStandardWebhookWeb } from './webhooks-web';
import { signAtlasWebhook, signStandardWebhook } from './rp-testing';
import { verifyAtlasWebhook } from './webhooks-web';

const secret = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
const payload = { type: 'invoice.paid', data: { id: 'inv_1' } };

describe('verifyStandardWebhookWeb', () => {
  it('verifies a signed delivery and agrees with the Node verifier', async () => {
    const signed = await signStandardWebhook({ secret, payload, id: 'msg_1' });
    const web = await verifyStandardWebhookWeb<{ type: string }>({ body: signed.body, headers: signed.headers, secret });
    expect(web).toMatchObject({ verified: true, deliveryId: 'msg_1' });
    expect(web.event?.type).toBe('invoice.paid');
    expect(verifyStandardWebhook({ body: signed.body, headers: signed.headers, secret }).verified).toBe(true);
  });

  it('refuses tampering, a wrong secret, a stale timestamp and missing headers', async () => {
    const signed = await signStandardWebhook({ secret, payload });
    expect((await verifyStandardWebhookWeb({ body: `${signed.body} `, headers: signed.headers, secret })).reason).toBe('signature_mismatch');
    const other = `whsec_${Buffer.from('another-secret-another-secret-12').toString('base64')}`;
    expect((await verifyStandardWebhookWeb({ body: signed.body, headers: signed.headers, secret: other })).reason).toBe('signature_mismatch');
    const old = await signStandardWebhook({ secret, payload, timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect((await verifyStandardWebhookWeb({ body: old.body, headers: old.headers, secret })).reason).toBe('stale_timestamp');
    expect((await verifyStandardWebhookWeb({ body: signed.body, headers: { 'webhook-id': 'x' }, secret })).reason).toBe('missing_headers');
    expect((await verifyStandardWebhookWeb({ body: signed.body, headers: { ...signed.headers, 'webhook-signature': 'v1' }, secret })).reason).toBe('malformed_signature');
  });

  it('accepts any signature in a rotation list and reads a Request', async () => {
    const signed = await signStandardWebhook({ secret, payload });
    const headers = { ...signed.headers, 'webhook-signature': `v1,AAAA ${signed.headers['webhook-signature']}` };
    const res = await verifyStandardWebhookRequest(new Request('https://app.test/hook', { method: 'POST', body: signed.body, headers }), { secret });
    expect(res.verified).toBe(true);
  });
});

describe('signAtlasWebhook', () => {
  it('produces a delivery verifyAtlasWebhook accepts', async () => {
    const signed = await signAtlasWebhook({ secret: 'whsec_x', payload });
    expect((await verifyAtlasWebhook({ body: signed.body, headers: signed.headers, secret: 'whsec_x' })).verified).toBe(true);
  });
});
