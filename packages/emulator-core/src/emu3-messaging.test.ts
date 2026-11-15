/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { client, makeEngine } from './test-support';
import type { Engine } from './engine';

const raw = async (e: Engine, method: string, path: string, body?: string, headers: Record<string, string> = {}) => {
  const res = await e.handle(new Request(`http://emulator.test${path}`, { method, headers, body }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const keysOf = async (e: Engine): Promise<Record<string, any>> => Object.fromEntries((await client(e, null)('GET', '/__emulator/messaging/signing_keys')).json.data.map((k: any) => [k.provider, k]));
const cbPath = (e: Engine, provider: string) => `/v1/webhooks/${provider}/${e.instanceId}`;
/** Post the callback the sign helper built. */
const deliver = (e: Engine, cb: any, headers: Record<string, string> = cb.headers) => {
  const u = new URL(cb.url);
  return raw(e, 'POST', u.pathname + u.search, cb.body, headers);
};
const sign = async (e: Engine, body: Record<string, unknown>) => (await client(e, null)('POST', '/__emulator/messaging/sign', body)).json;
const ledger = async (e: Engine, q: string) => (await client(e)('GET', `/v1/messages?${q}`)).json.data;
const events = (e: Engine, type: string) => e.webhooks.events.filter((x) => x.type === type);

const EMAIL_CONFIG: Record<string, Record<string, string>> = {
  ses: { region: 'us-east-1', access_key_id: 'AKIAEXAMPLE', secret_access_key: 'secret' },
  mailgun: { api_key: 'key', domain: 'mg.example.com' },
};
/** An engine whose channel provider is `provider`, with a verification secret stored where the scheme needs one; one message sent through it. */
async function arrange(provider: string, channel: 'email' | 'sms') {
  const e = makeEngine();
  const call = client(e);
  const keys = await keysOf(e);
  const config = channel === 'email' ? (EMAIL_CONFIG[provider] ?? { api_key: 'key' }) : provider === 'twilio' ? { account_sid: 'AC1', auth_token: keys.twilio.secret } : provider === 'vonage' ? { api_key: 'k', api_secret: 's' } : { access_key: 'k' };
  const put = await call('PUT', `/v1/messaging_providers/${channel}`, { transport: provider, from_address: channel === 'email' ? 'app@example.com' : '+15550001111', config });
  expect(put.status).toBe(200);
  if (provider === 'resend' || provider === 'mailgun') expect((await call('PUT', `/v1/message_receivers/${provider}`, { secret: keys[provider].secret })).status).toBe(200);
  const to = channel === 'email' ? 'ada@example.com' : '+4915112345678';
  e.messages.send({ channel, to, subject: 'hi', meta: { template: 'welcome' } });
  const [row] = await ledger(e, `recipient=${encodeURIComponent(to)}`);
  return { e, call, row, to };
}

describe('per-channel providers', () => {
  it('configures a provider per channel, keeps secrets write-only and refuses what the real API refuses', async () => {
    const e = makeEngine();
    const call = client(e);
    expect((await call('GET', '/v1/messaging_providers/push')).json).toMatchObject({ object: 'messaging_provider', configured: false, channel: 'push' });
    expect((await call('GET', '/v1/messaging_providers/fax')).status).toBe(404);
    expect((await call('PUT', '/v1/messaging_providers/email', { transport: 'carrier_pigeon' })).status).toBe(400);
    const missing = await call('PUT', '/v1/messaging_providers/email', { transport: 'resend', config: {} });
    expect(missing.status).toBe(400);
    expect(missing.json.errors[0].code).toBe('VALIDATION_FAILED');
    // a Twilio provider needs a sender
    expect((await call('PUT', '/v1/messaging_providers/sms', { transport: 'twilio', config: { account_sid: 'AC1', auth_token: 't' } })).status).toBe(400);

    const saved = (await call('PUT', '/v1/messaging_providers/email', { transport: 'resend', from_address: 'app@example.com', config: { api_key: 're_live_secret' } })).json;
    expect(saved).toMatchObject({ object: 'messaging_provider', configured: true, channel: 'email', transport: 'resend', secrets_set: { api_key: true } });
    expect(JSON.stringify(saved)).not.toContain('re_live_secret');
    // an edit that leaves the secret out keeps it
    const edited = (await call('PUT', '/v1/messaging_providers/email', { transport: 'resend', from_address: 'other@example.com' })).json;
    expect(edited).toMatchObject({ from_address: 'other@example.com', secrets_set: { api_key: true } });
    expect((await call('GET', '/v1/messaging_providers')).json).toMatchObject({ object: 'messaging_providers', sms: null, push: null, email: { transport: 'resend' } });
    expect((await call('PUT', '/v1/messaging_providers/push', { transport: 'expo' })).status).toBe(200);
    expect((await call('DELETE', '/v1/messaging_providers/push')).json).toMatchObject({ deleted: true });
    expect((await call('DELETE', '/v1/messaging_providers/push')).status).toBe(404);
    expect((await call('DELETE', '/v1/messaging_providers/fax')).status).toBe(400);
  });

  it('records provider and channel on every ledger row and routes WhatsApp and voice through the SMS provider', async () => {
    const e = makeEngine();
    const call = client(e);
    e.messages.send({ channel: 'email', to: 'plain@example.com' });
    expect((await ledger(e, 'recipient=plain@example.com'))[0]).toMatchObject({ channel: 'email', provider: 'emulator' });
    await call('PUT', '/v1/messaging_providers/email', { transport: 'brevo', config: { api_key: 'k' } });
    await call('PUT', '/v1/messaging_providers/sms', { transport: 'twilio', from_address: '+15550001111', config: { account_sid: 'AC1', auth_token: 't' } });
    e.messages.send({ channel: 'email', to: 'b@example.com' });
    e.messages.send({ channel: 'whatsapp', to: '+4915112345678' });
    e.messages.send({ channel: 'voice', to: '+4915112345679' });
    expect((await ledger(e, 'recipient=b@example.com'))[0]).toMatchObject({ channel: 'email', provider: 'brevo', status: 'delivered' });
    expect((await ledger(e, 'channel=whatsapp'))[0]).toMatchObject({ channel: 'whatsapp', provider: 'twilio' });
    expect((await ledger(e, 'channel=voice'))[0]).toMatchObject({ channel: 'voice', provider: 'twilio' });
    // WhatsApp and voice need Twilio: another SMS transport leaves them with no provider
    await call('PUT', '/v1/messaging_providers/sms', { transport: 'vonage', config: { api_key: 'k', api_secret: 's' } });
    e.messages.send({ channel: 'whatsapp', to: '+4915112345680' });
    expect((await ledger(e, 'recipient=%2B4915112345680'))[0]).toMatchObject({ status: 'failed', status_detail: 'no whatsapp provider is configured', provider: null });
    e.messages.send({ channel: 'sms', to: '+4915112345681' });
    expect((await ledger(e, 'recipient=%2B4915112345681'))[0]).toMatchObject({ status: 'delivered', provider: 'vonage' });
  });

  it('refuses a channel with no provider when providers are required, and refuses a test send either way', async () => {
    const e = makeEngine();
    const call = client(e);
    const anon = client(e, null);
    expect((await anon('POST', '/__emulator/messaging/require_providers', { enabled: 'yes' })).status).toBe(400);
    await anon('POST', '/__emulator/messaging/require_providers', { enabled: true });
    e.messages.send({ channel: 'email', to: 'ada@example.com' });
    expect((await ledger(e, 'recipient=ada@example.com'))[0]).toMatchObject({ status: 'failed', status_detail: 'no email provider is configured', channel: 'email' });
    await call('PUT', '/v1/messaging_providers/email', { transport: 'resend', config: { api_key: 'k' } });
    e.messages.send({ channel: 'email', to: 'bo@example.com' });
    expect((await ledger(e, 'recipient=bo@example.com'))[0]).toMatchObject({ status: 'delivered', provider: 'resend' });
    await anon('POST', '/__emulator/messaging/require_providers', { enabled: false });

    const fresh = makeEngine();
    const c2 = client(fresh);
    const refused = await c2('POST', '/v1/messaging_providers/email/test', { to: 'ada@example.com' });
    expect(refused.json.errors[0]).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(refused.json.errors[0].message).toContain('No email provider is configured');
    expect((await c2('POST', '/v1/messaging_providers/fax/test', { to: 'x' })).status).toBe(400);
    expect((await c2('POST', '/v1/messaging_providers/email/test', {})).json.errors[0].param).toBe('to');
    expect((await c2('POST', '/v1/messaging_providers/sms/test', { to: '12345' })).json.errors[0].param).toBe('to');
  });

  it('sends a test through the configured provider, throttled per key, and fails over across providers per channel', async () => {
    const e = makeEngine();
    const call = client(e);
    await call('PUT', '/v1/messaging_providers/email', { transport: 'resend', config: { api_key: 'k' } });
    const sent = await call('POST', '/v1/messaging_providers/email/test', { to: 'Ada@Example.com' });
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ object: 'messaging_test', channel: 'email', ok: true, accepted: true, provider: 'resend' });
    expect((await ledger(e, 'template=provider_test'))[0]).toMatchObject({ channel: 'email', provider: 'resend' });
    expect((await call('POST', '/v1/messaging_providers/email/test', { to: 'ada@example.com' })).status).toBe(429);
    e.clock.advance(20_000);

    // failover across providers: the resend slot fails once, the smtp2go fallback delivers; a fault on the sms channel does not touch email
    await call('POST', '/v1/messaging_providers/email/fallbacks', { transport: 'smtp2go' });
    const anon = client(e, null);
    expect((await anon('POST', '/__emulator/messaging/faults', { provider: 'resend', channel: 'fax', times: 1 })).status).toBe(400);
    await anon('POST', '/__emulator/messaging/faults', { provider: 'resend', channel: 'sms', times: 1 });
    await anon('POST', '/__emulator/messaging/faults', { provider: 'resend', channel: 'email', times: 1 });
    e.messages.send({ channel: 'email', to: 'cy@example.com' });
    const row = (await ledger(e, 'recipient=cy@example.com'))[0];
    expect(row).toMatchObject({ status: 'delivered', provider: 'smtp2go', channel: 'email' });
    expect(row.attempts.map((a: any) => [a.provider, a.channel, a.status])).toEqual([['resend', 'email', 'failed'], ['smtp2go', 'email', 'sent']]);
    // a test whose every provider fails is a 502
    await anon('POST', '/__emulator/messaging/faults', { provider: 'resend', times: 1 });
    await anon('POST', '/__emulator/messaging/faults', { provider: 'smtp2go', times: 1 });
    e.clock.advance(20_000);
    const down = await call('POST', '/v1/messaging_providers/email/test', { to: 'dee@example.com' });
    expect(down.status).toBe(502);
    expect(down.json.errors[0].meta).toMatchObject({ ok: false, accepted: false });
  });
});

describe('provider callbacks', () => {
  const CASES: Array<[string, 'email' | 'sms']> = [['resend', 'email'], ['mailgun', 'email'], ['brevo', 'email'], ['smtp2go', 'email'], ['ses', 'email'], ['twilio', 'sms'], ['vonage', 'sms'], ['messagebird', 'sms']];
  for (const [provider, channel] of CASES) {
    it(`${provider}: a signed bounce updates the ledger and suppresses once; tampered, stale and unsigned callbacks are refused`, async () => {
      const { e, call, row, to } = await arrange(provider, channel);
      expect(row).toMatchObject({ provider, channel });
      expect(row.provider_message_id).toBeTruthy();
      const cb = await sign(e, { provider, message_id: row.id, event: 'bounced' });
      expect(cb).toMatchObject({ object: 'messaging_callback', provider, method: 'POST' });

      const ok = await deliver(e, cb);
      expect(ok).toMatchObject({ status: 200, json: { received: true } });
      const after = (await call('GET', `/v1/messages/${row.id}`)).json;
      expect(after.status).toBe(channel === 'email' ? 'bounced' : 'failed');
      expect(after.timeline[after.timeline.length - 1].status).toBe(after.status);
      const sup = (await call('GET', `/v1/suppressions?address=${encodeURIComponent(to)}`)).json.data[0];
      expect(sup).toMatchObject({ channel, source: provider, message_id: row.id, reason: channel === 'email' ? 'hard_bounce' : 'invalid' });
      expect(events(e, 'message_suppression.created')).toHaveLength(1);
      const deliveries = events(e, channel === 'email' ? 'email.bounced' : 'sms.failed').length;
      expect(deliveries).toBe(1);

      // a redelivery of the same provider event changes nothing
      expect((await deliver(e, cb)).status).toBe(200);
      expect(events(e, 'message_suppression.created')).toHaveLength(1);
      expect(events(e, channel === 'email' ? 'email.bounced' : 'sms.failed')).toHaveLength(1);
      // a later "delivered" never moves a bounced message back
      const late = await sign(e, { provider, message_id: row.id, event: 'delivered' });
      expect((await deliver(e, late)).status).toBe(200);
      expect((await call('GET', `/v1/messages/${row.id}`)).json.status).toBe(after.status);

      // refusals: nothing changes and the answer is the one the real receiver gives
      const fresh = await arrange(provider, channel);
      const refusals: any[] = [];
      refusals.push(await deliver(fresh.e, await sign(fresh.e, { provider, message_id: fresh.row.id, event: 'bounced', tamper: 'signature' })));
      // only the signed schemes carry a timestamp to go stale
      if (['resend', 'mailgun'].includes(provider)) refusals.push(await deliver(fresh.e, await sign(fresh.e, { provider, message_id: fresh.row.id, event: 'bounced', tamper: 'stale' })));
      const unsigned = await sign(fresh.e, { provider, message_id: fresh.row.id, event: 'bounced' });
      // no signature header, no URL token, and (Mailgun, which signs inside the body) no signature object
      const stripped = provider === 'mailgun' ? JSON.stringify({ ...JSON.parse(unsigned.body), signature: {} }) : unsigned.body;
      refusals.push(await raw(fresh.e, 'POST', cbPath(fresh.e, provider), stripped, { 'content-type': unsigned.headers['content-type'] }));
      for (const r of refusals) {
        expect(r.status).toBe(401);
        expect(r.json.errors[0]).toMatchObject({ code: 'UNAUTHENTICATED' });
      }
      expect(refusals[0].json.errors[0].message).toBe(provider === 'brevo' ? 'Invalid webhook token.' : 'Invalid webhook signature.');
      expect((await fresh.call('GET', `/v1/messages/${fresh.row.id}`)).json.status).toBe('delivered');
      expect((await fresh.call('GET', '/v1/suppressions')).json.data).toHaveLength(0);
      expect(events(fresh.e, 'message_suppression.created')).toHaveLength(0);
    });
  }

  it('turns auto-suppression off, counts a complaint, and keeps a soft bounce out of the suppression list', async () => {
    const { e, call, row } = await arrange('resend', 'email');
    const soft = await sign(e, { provider: 'resend', message_id: row.id, event: 'bounced', bounce: 'soft' });
    expect((await deliver(e, soft)).status).toBe(200);
    expect((await call('GET', `/v1/messages/${row.id}`)).json).toMatchObject({ status: 'failed' });
    expect((await call('GET', '/v1/suppressions')).json.data).toHaveLength(0);
    await call('PUT', '/v1/messaging/settings', { auto_suppress: false });
    const complaint = await sign(e, { provider: 'resend', message_id: row.id, event: 'complained' });
    expect((await deliver(e, complaint)).status).toBe(200);
    expect((await call('GET', `/v1/messages/${row.id}`)).json.status).toBe('complained');
    expect((await call('GET', '/v1/suppressions')).json.data).toHaveLength(0);
    expect(events(e, 'email.complained')).toHaveLength(1);
  });

  it('verifies SendGrid (ECDSA) and Postmark callbacks and suppresses a hard bounce even with no ledger row', async () => {
    const e = makeEngine();
    const call = client(e);
    const keys = await keysOf(e);
    // SendGrid: with no key stored the URL token is the credential, then the signed event webhook once a key is stored
    const tokenMode = await sign(e, { provider: 'sendgrid', provider_message_id: 'x1', recipient: 'a@example.com', event: 'bounced' });
    expect(tokenMode.headers.authorization).toBeTruthy();
    expect((await deliver(e, tokenMode)).status).toBe(200);
    expect((await call('PUT', '/v1/message_receivers/sendgrid', { secret: 'not a key' })).status).toBe(400);
    expect((await call('PUT', '/v1/message_receivers/sendgrid', { secret: keys.sendgrid.secret })).status).toBe(200);
    const signed = await sign(e, { provider: 'sendgrid', provider_message_id: 'x2', recipient: 'b@example.com', event: 'bounced' });
    expect(signed.headers['x-twilio-email-event-webhook-signature']).toBeTruthy();
    expect((await deliver(e, signed)).status).toBe(200);
    expect((await call('GET', '/v1/suppressions?address=b@example.com')).json.data[0]).toMatchObject({ reason: 'hard_bounce', source: 'sendgrid' });
    expect((await deliver(e, tokenMode)).status).toBe(401); // a stored key switches the receiver to signatures
    expect((await deliver(e, await sign(e, { provider: 'sendgrid', provider_message_id: 'x3', recipient: 'c@example.com', event: 'bounced', tamper: 'signature' }))).status).toBe(401);
    expect((await deliver(e, await sign(e, { provider: 'sendgrid', provider_message_id: 'x3', recipient: 'c@example.com', event: 'bounced', tamper: 'stale' }))).status).toBe(401);
    // Postmark: basic auth with the token as the password
    const pm = await sign(e, { provider: 'postmark', provider_message_id: 'p1', recipient: 'd@example.com', event: 'complained' });
    expect((await deliver(e, pm)).status).toBe(200);
    expect((await call('GET', '/v1/suppressions?address=d@example.com')).json.data[0]).toMatchObject({ reason: 'complaint', source: 'postmark' });
    expect((await deliver(e, pm, { 'content-type': 'application/json', authorization: 'Basic ' + btoa('atlas:wrong') })).status).toBe(401);
  });

  it('verifies each scheme exactly as a sender computes it (independent HMACs)', async () => {
    const { e, call, row } = await arrange('twilio', 'sms');
    const keys = await keysOf(e);
    // Twilio: base64 HMAC-SHA1 over the URL and the sorted fields, with the SMS provider's auth token
    const params = { MessageSid: row.provider_message_id, MessageStatus: 'delivered', To: '+4915112345678' };
    const url = `${e.issuer}${cbPath(e, 'twilio')}`;
    const sig = createHmac('sha1', keys.twilio.secret).update(url + Object.keys(params).sort().map((k) => k + (params as any)[k]).join('')).digest('base64');
    const form = new URLSearchParams(params).toString();
    const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig };
    expect((await raw(e, 'POST', cbPath(e, 'twilio'), form, headers)).status).toBe(200);
    expect((await raw(e, 'POST', cbPath(e, 'twilio'), form + '&Extra=1', headers)).status).toBe(401);
    expect((await raw(e, 'POST', cbPath(e, 'twilio'), form, { ...headers, 'x-twilio-signature': 'AAAA' })).status).toBe(401);

    // Resend (Svix): HMAC-SHA256 over id.timestamp.body with the base64 key behind whsec_
    const secret = keys.resend.secret as string;
    await call('PUT', '/v1/message_receivers/resend', { secret });
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_1', to: ['q@example.com'] } });
    const ts = String(Math.floor(Date.now() / 1000));
    const svix = createHmac('sha256', Buffer.from(secret.replace('whsec_', ''), 'base64')).update(`msg_1.${ts}.${body}`).digest('base64');
    const h = { 'content-type': 'application/json', 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${svix}` };
    expect((await raw(e, 'POST', cbPath(e, 'resend'), body, h)).status).toBe(200);
    expect((await raw(e, 'POST', cbPath(e, 'resend'), body + ' ', h)).status).toBe(401);
    expect((await raw(e, 'POST', cbPath(e, 'resend'), body, { ...h, 'svix-id': 'msg_2' })).status).toBe(401);
    // a verified body that is not JSON is a 400, not a 401
    const junk = 'not json';
    const junkSig = createHmac('sha256', Buffer.from(secret.replace('whsec_', ''), 'base64')).update(`msg_3.${ts}.${junk}`).digest('base64');
    const bad = await raw(e, 'POST', cbPath(e, 'resend'), junk, { ...h, 'svix-id': 'msg_3', 'svix-signature': `v1,${junkSig}` });
    expect(bad).toMatchObject({ status: 400, json: { errors: [{ code: 'VALIDATION_FAILED' }] } });

    // Vonage: md5hash and HMAC-MD5 signatures over the sorted parameters
    const v = { messageId: 'v1', status: 'delivered', msisdn: '4915112345678', timestamp: ts };
    const base = Object.keys(v).sort().map((k) => `&${k}=${(v as any)[k]}`).join('');
    for (const [spec, sigv] of [['md5hash:topsecret', createHash('md5').update(base + 'topsecret').digest('hex')], ['md5:topsecret', createHmac('md5', 'topsecret').update(base).digest('hex')], ['sha512:topsecret', createHmac('sha512', 'topsecret').update(base).digest('hex')]] as const) {
      expect((await call('PUT', '/v1/message_receivers/vonage', { secret: spec })).status).toBe(200);
      const f = new URLSearchParams({ ...v, sig: sigv }).toString();
      expect((await raw(e, 'POST', cbPath(e, 'vonage'), f, { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(200);
      expect((await raw(e, 'POST', cbPath(e, 'vonage'), f.replace('delivered', 'failed'), { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(401);
      // Vonage also calls back with GET
      expect((await raw(e, 'GET', `${cbPath(e, 'vonage')}?${f}`)).status).toBe(200);
    }
  });

  it('refuses callbacks with no stored secret or for another instance, with the same answer, and reports on the receivers list', async () => {
    const e = makeEngine();
    const call = client(e);
    const keys = await keysOf(e);
    const anyRefusal = async (provider: string, extra: Record<string, string> = {}) => raw(e, 'POST', cbPath(e, provider), '{}', { 'content-type': 'application/json', ...extra });
    for (const p of ['resend', 'mailgun', 'brevo', 'smtp2go', 'postmark', 'sendgrid', 'ses', 'twilio', 'vonage', 'messagebird']) {
      const r = await anyRefusal(p);
      expect(r.status).toBe(401);
      expect(r.json.errors[0].code).toBe('UNAUTHENTICATED');
    }
    // Twilio with a valid-looking signature but no SMS provider to take the auth token from
    expect((await anyRefusal('twilio', { 'x-twilio-signature': 'abc' })).status).toBe(401);
    // another instance id gets the same refusal, even with a correct token
    const token = keys.brevo.token;
    const brevo = (id: string) => raw(e, 'POST', `/v1/webhooks/brevo/${id}`, JSON.stringify({ event: 'delivered', 'message-id': 'x' }), { 'content-type': 'application/json', authorization: `Bearer ${token}` });
    expect((await brevo(e.instanceId)).status).toBe(200);
    expect((await brevo('ins_other')).status).toBe(401);

    const list = (await call('GET', '/v1/message_receivers')).json.data;
    const byProvider = Object.fromEntries(list.map((r: any) => [r.provider, r]));
    expect(byProvider.brevo).toMatchObject({ token_required: true, secret_set: false, token });
    expect(typeof byProvider.brevo.last_event_at).toBe('number');
    expect(byProvider.resend.last_error).toBe('signature did not verify');
    expect(byProvider.ses.url).toContain('?t=');
    expect(byProvider.postmark.url).not.toContain('?t=');
    // a read-only key does not see tokens
    const ro = makeEngine({ secretKeys: [{ key: 'sk_ro', scopes: ['messaging:read'] }] });
    expect((await client(ro, 'sk_ro')('GET', '/v1/message_receivers')).json.data.find((r: any) => r.provider === 'brevo').token).toBeUndefined();
    expect((await client(ro, 'sk_ro')('PUT', '/v1/message_receivers/mailgun', { secret: 'k' })).status).toBe(403);
    // secrets
    expect((await call('PUT', '/v1/message_receivers/brevo', { secret: 'x' })).status).toBe(400);
    expect((await call('PUT', '/v1/message_receivers/resend', { secret: 'plain' })).status).toBe(400);
    expect((await call('PUT', '/v1/message_receivers/ses', { secret: 'topic' })).status).toBe(400);
    expect((await call('PUT', '/v1/message_receivers/nope', { secret: 'x' })).status).toBe(404);
    expect((await call('PUT', '/v1/message_receivers/mailgun', { secret: 'k' })).json).toMatchObject({ object: 'message_receiver', secret_set: true });
    expect((await call('DELETE', '/v1/message_receivers/mailgun')).json).toMatchObject({ deleted: true });
    expect((await call('DELETE', '/v1/message_receivers/mailgun')).status).toBe(404);
  });

  it('refuses an SNS message signed with an unknown certificate and honours the topic allow-list', async () => {
    const { e, call, row } = await arrange('ses', 'email');
    const cb = await sign(e, { provider: 'ses', message_id: row.id, event: 'delivered' });
    const defaultTopic = await sign(e, { provider: 'ses', message_id: row.id, event: 'complained' });
    const forged = { ...JSON.parse(cb.body), SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/other.pem' };
    expect((await deliver(e, { ...cb, body: JSON.stringify(forged) })).status).toBe(401);
    expect((await deliver(e, { ...cb, body: JSON.stringify({ ...forged, SigningCertURL: 'https://evil.example/cert.pem' }) })).status).toBe(401);
    expect((await call('PUT', '/v1/message_receivers/ses', { secret: 'arn:aws:sns:us-east-1:123456789012:other-topic' })).status).toBe(200);
    // a correctly signed message from a topic that is not on the list is refused; the helper signs for the stored topic
    expect((await deliver(e, defaultTopic)).status).toBe(401);
    expect((await deliver(e, await sign(e, { provider: 'ses', message_id: row.id, event: 'delivered' }))).status).toBe(200);
  });

  it('lists test signing keys and validates the sign helper', async () => {
    const e = makeEngine();
    const anon = client(e, null);
    const keys = await keysOf(e);
    expect(Object.keys(keys).sort()).toEqual(['brevo', 'mailgun', 'messagebird', 'postmark', 'resend', 'sendgrid', 'ses', 'smtp2go', 'twilio', 'vonage']);
    expect(keys.resend.secret).toMatch(/^whsec_/);
    expect(keys.vonage.secret).toMatch(/^sha256:/);
    expect(keys.ses).toMatchObject({ signing_cert_url: expect.stringContaining('amazonaws.com'), public_key: expect.any(String) });
    expect(keys.brevo.token).toBeTruthy();
    expect(keys.mailgun.token).toBeNull();
    // stable per instance
    expect((await keysOf(e)).resend.secret).toBe(keys.resend.secret);
    expect((await anon('POST', '/__emulator/messaging/sign', { provider: 'nope' })).status).toBe(400);
    expect((await anon('POST', '/__emulator/messaging/sign', { provider: 'resend', event: 'exploded' })).status).toBe(400);
    expect((await anon('POST', '/__emulator/messaging/sign', { provider: 'resend', message_id: 'msg_nope' })).status).toBe(404);
    expect((await anon('POST', '/__emulator/messaging/sign', { provider: 'resend' })).status).toBe(400);
    expect((await anon('POST', '/__emulator/messaging/sign', { provider: 'resend', provider_message_id: 'x', recipient: 'a@example.com', tamper: 'wrong' })).status).toBe(400);
  });
});
