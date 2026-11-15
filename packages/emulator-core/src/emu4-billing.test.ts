/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import type { Engine } from './engine';
import { client, makeEngine } from './test-support';

const DAY = 86_400_000;
const types = (e: Engine, t: string) => e.webhooks.events.filter((x) => x.type === t);
const err = (r: { json: any }) => r.json.errors[0];
const STRIPE = { secret_key: 'sk_test_abc', webhook_secret: 'whsec_abc' };
const PADDLE = { api_key: 'pdl_key', webhook_secret: 'pdl_secret' };
const LEMON = { api_key: 'lmn_key', webhook_secret: 'lmn_secret' };
const RC = { api_key: 'rc_key', webhook_secret: 'rc-secret', project_id: 'proj1' };
const APPSTORE = { private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', key_id: 'ABCDE12345', issuer_id: '12345678-1234-1234-1234-123456789012', bundle_id: 'com.example.app' };

async function world() {
  const e = makeEngine();
  const call = client(e);
  const anon = client(e, null);
  const user = async (tag: string) => (await call('POST', '/v1/users', { email_address: `${tag}@example.com` })).json;
  const plan = async (body: Record<string, unknown>) => (await call('POST', '/v1/billing/plans', { active: true, ...body })).json;
  /** Fields the generic plan layer does not take from a create (provider and price references). */
  const setPlan = (id: string, patch: Record<string, unknown>) => e.generic.get('billing/plans')!.update(id, patch);
  const sub = async (u: { id: string }, plan_id: string, extra: Record<string, unknown> = {}) => (await call('POST', '/v1/billing/subscriptions/import', { subject_type: 'user', subject_id: u.id, plan_id, ...extra })).json;
  const advance = (days: number) => anon('POST', '/__emulator/time/advance', { ms: days * DAY });
  const provider = (name: string, config: Record<string, string>, extra: Record<string, unknown> = {}) => call('PUT', `/v1/billing/providers/${name}`, { config, ...extra });
  const deliver = (body: Record<string, unknown>) => anon('POST', '/__emulator/billing/webhooks/deliver', body);
  const subsOf = async (u: { id: string }) => (await call('GET', `/v1/billing/subscriptions?subject_id=${u.id}`)).json.data;
  const invoicesOf = async (u: { id: string }) => (await call('GET', `/v1/billing/invoices?subject_id=${u.id}`)).json.data;
  return { e, call, anon, user, plan, setPlan, sub, advance, provider, deliver, subsOf, invoicesOf };
}

describe('billing: proration', () => {
  it('prorates an upgrade into items on the next invoice', async () => {
    const { call, anon, user, plan, sub, advance, invoicesOf } = await world();
    const u = await user('pr1');
    const a = await plan({ name: 'A', slug: 'a', amount: '10.00' });
    const b = await plan({ name: 'B', slug: 'b', amount: '20.00' });
    const s = await sub(u, a.id);
    await advance(10);
    expect((await call('POST', `/v1/billing/subscriptions/${s.id}/change`, { plan_id: b.id })).status).toBe(200);
    expect(await invoicesOf(u)).toHaveLength(0); // a mid-cycle change invoices nothing yet
    const up = (await anon('GET', `/__emulator/billing/subscriptions/${s.id}/upcoming_invoice`)).json;
    expect(up.lines.map((l: any) => l.amount)).toEqual([2000, -667, 1333]); // renewal at the new price, unused time on A, remaining time on B
    expect(up.lines.map((l: any) => l.proration)).toEqual([false, true, true]);
    expect(up.lines[1].description).toMatch(/^Unused time on A after \d{4}-\d{2}-\d{2}$/);
    expect(up).toMatchObject({ total: 2666, amount_due: 2666, applied_balance: 0, currency: 'usd' });
    await advance(21);
    const [inv] = await invoicesOf(u);
    expect(inv).toMatchObject({ amount_due: 2666, amount_paid: 2666, status: 'paid' });
    const lines = (await anon('GET', `/__emulator/billing/invoices/${inv.id}/lines`)).json.data;
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ object: 'billing_invoice_line', amount: -667, proration: true, currency: 'usd' });
    await advance(30);
    expect((await invoicesOf(u)).map((i: any) => i.amount_due)).toEqual([2000, 2666]); // the items were used up once
  });

  it('turns a downgrade into customer balance that the next invoices draw down', async () => {
    const { call, anon, user, plan, sub, advance, invoicesOf } = await world();
    const u = await user('pr2');
    const b = await plan({ name: 'B', slug: 'b', amount: '20.00' });
    const c = await plan({ name: 'C', slug: 'c', amount: '1.00' });
    const s = await sub(u, b.id);
    await advance(15);
    await call('POST', `/v1/billing/subscriptions/${s.id}/change`, { plan_id: c.id });
    const up = (await anon('GET', `/__emulator/billing/subscriptions/${s.id}/upcoming_invoice`)).json;
    expect(up.lines.map((l: any) => l.amount)).toEqual([100, -1000, 50]);
    expect(up).toMatchObject({ total: -850, amount_due: 0 });
    await advance(16);
    const [first] = await invoicesOf(u);
    expect(first).toMatchObject({ amount_due: 0, status: 'paid' });
    const balance = async () => (await anon('GET', `/__emulator/billing/customer_balance?subject_type=user&subject_id=${u.id}`)).json.balance;
    expect(await balance()).toBe(850);
    await advance(30);
    const [second] = await invoicesOf(u);
    expect(second.amount_due).toBe(0);
    const lines = (await anon('GET', `/__emulator/billing/invoices/${second.id}/lines`)).json.data;
    expect(lines.map((l: any) => l.amount)).toEqual([100, -100]);
    expect(lines[1].description).toBe('Applied customer balance');
    expect(await balance()).toBe(750);
  });

  it('resets the billing cycle and invoices at once on an interval change', async () => {
    const { call, anon, e, user, plan, sub, advance, invoicesOf } = await world();
    const u = await user('pr3');
    const a = await plan({ name: 'A', slug: 'a', amount: '10.00' });
    const y = await plan({ name: 'Y', slug: 'y', amount: '120.00', interval: 'year' });
    const s = await sub(u, a.id);
    await advance(10);
    const r = await call('POST', `/v1/billing/subscriptions/${s.id}/change`, { plan_id: y.id, interval: 'year' });
    expect(r.json).toMatchObject({ plan_id: y.id, interval: 'year', scheduled: false });
    expect(r.json.current_period_end).toBeGreaterThan(e.clock.now() + 364 * DAY);
    const invoices = await invoicesOf(u);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ amount_due: 11333, status: 'paid' });
    const lines = (await anon('GET', `/__emulator/billing/invoices/${invoices[0].id}/lines`)).json.data;
    expect(lines.map((l: any) => l.amount)).toEqual([12000, -667]);
  });

  it('does not prorate or invoice a trial', async () => {
    const { call, anon, user, plan, sub, invoicesOf } = await world();
    const u = await user('pr4');
    const a = await plan({ name: 'A', slug: 'a', amount: '10.00' });
    const b = await plan({ name: 'B', slug: 'b', amount: '20.00' });
    const s = await sub(u, a.id, { trial_days: 5 });
    expect((await call('POST', `/v1/billing/subscriptions/${s.id}/change`, { plan_id: b.id })).status).toBe(200);
    expect(await invoicesOf(u)).toHaveLength(0);
    const up = (await anon('GET', `/__emulator/billing/subscriptions/${s.id}/upcoming_invoice`)).json;
    expect(up.lines.map((l: any) => l.amount)).toEqual([2000]);
  });

  it('leaves change, cancel and restore of a store-owned subscription to the store', async () => {
    const { call, user, plan, sub } = await world();
    const u = await user('pr5');
    const a = await plan({ name: 'A', slug: 'a' });
    const b = await plan({ name: 'B', slug: 'b' });
    const rc = await sub(u, a.id, { provider: 'revenuecat' });
    const change = await call('POST', `/v1/billing/subscriptions/${rc.id}/change`, { plan_id: b.id });
    expect(change.status).toBe(422);
    expect(err(change).meta).toEqual({ reason: 'unsupported' });
    expect((await call('POST', `/v1/billing/subscriptions/${rc.id}/cancel`, {})).status).toBe(422);
    const u2 = await user('pr5b');
    const creem = await sub(u2, a.id, { provider: 'creem' });
    expect((await call('POST', `/v1/billing/subscriptions/${creem.id}/cancel`, {})).status).toBe(200);
    const restore = await call('POST', `/v1/billing/subscriptions/${creem.id}/restore`);
    expect(restore.status).toBe(422);
    expect(err(restore).meta).toEqual({ reason: 'unsupported' });
  });
});

describe('billing providers', () => {
  it('keeps secrets write-only and checks each provider the way the real route does', async () => {
    const { e, call, user, plan, sub } = await world();
    expect((await call('GET', '/v1/billing/providers')).json).toMatchObject({ object: 'list', data: [] });
    expect((await call('GET', '/v1/billing/providers/stripe')).json).toMatchObject({ object: 'billing_provider', configured: false, provider: 'stripe' });
    const put = await call('PUT', '/v1/billing/providers/stripe', { config: { ...STRIPE, publishable_key: 'pk_test_1' } });
    expect([200, 201]).toContain(put.status); // the document decides which
    expect(put.json).toMatchObject({ object: 'billing_provider', configured: true, provider: 'stripe', environment: 'test', status: 'active', config: { publishable_key: 'pk_test_1' }, secrets_set: { secret_key: true, webhook_secret: true } });
    expect(put.json.webhook_url).toBe(`${e.issuer}/v1/webhooks/billing/${e.instanceId}/stripe`);
    expect(put.json.capabilities).toMatchObject({ connect: true, refunds: true, scheduleAtPeriodEnd: true });
    expect(JSON.stringify(put.json)).not.toContain('sk_test_abc');
    expect(JSON.stringify((await call('GET', '/v1/billing/providers')).json)).not.toContain('whsec_abc');
    const again = await call('PUT', '/v1/billing/providers/stripe', { config: { publishable_key: 'pk_test_2' } }); // secrets left out are kept
    expect(again.status).toBe(200);
    expect(again.json.secrets_set).toEqual({ secret_key: true, webhook_secret: true });
    expect(again.json.config).toEqual({ publishable_key: 'pk_test_2' });

    const refuse = async (provider: string, body: unknown, status = 400) => {
      const r = await call('PUT', `/v1/billing/providers/${provider}`, body);
      expect(r.status).toBe(status);
      return r;
    };
    await refuse('paddle', { config: {} }); // the API key is required
    await refuse('paddle', { config: { ...PADDLE, store_id: '1' } }); // another provider's key
    await refuse('paddle', { config: { ...PADDLE, api_key: 7 } });
    await refuse('paddle', { config: 'x' });
    expect(err(await refuse('paddle', { config: PADDLE, extra: 1 }, 422)).code).toBe('UNKNOWN_FIELD');
    await refuse('stripe', { config: { secret_key: 'sk_live_abc' }, environment: 'test' });
    await refuse('stripe', { config: { secret_key: 'nope' } });
    await refuse('stripe', { config: { webhook_secret: 'bad' } });
    await refuse('stripe', { config: { publishable_key: 'pk_live_1' } });
    await refuse('lemonsqueezy', { config: { ...LEMON, store_id: 'abc' } });
    await refuse('chargebee', { config: { api_key: 'k' } });
    await refuse('autumn', { config: { secret_key: 'nope' } });
    await refuse('appstore', { config: { ...APPSTORE, private_key: 'x' } });
    await refuse('appstore', { config: { ...APPSTORE, key_id: 'short' } });
    await refuse('googleplay', { config: { service_account_json: '{}' } });
    await refuse('paddle', { config: PADDLE, environment: 'staging' });
    expect((await call('PUT', '/v1/billing/providers/nope', { config: {} })).status).toBe(404);
    expect((await call('GET', '/v1/billing/providers/nope')).status).toBe(404);

    expect((await call('PUT', '/v1/billing/providers/revenuecat', { config: { api_key: 'k', webhook_secret: 's' } })).status).not.toBe(400);
    expect((await call('POST', '/v1/billing/providers/revenuecat/test')).json).toMatchObject({ object: 'billing_provider_test', ok: false });
    await call('PUT', '/v1/billing/providers/revenuecat', { config: { project_id: 'p1' } });
    expect((await call('POST', '/v1/billing/providers/revenuecat/test')).json).toMatchObject({ ok: true, account: 'p1' });
    expect((await call('POST', '/v1/billing/providers/googleplay/test')).status).toBe(404);

    const u = await user('prov');
    const a = await plan({ name: 'A', slug: 'a' });
    await sub(u, a.id); // a live stripe subscription
    const blocked = await call('DELETE', '/v1/billing/providers/stripe');
    expect(blocked.status).toBe(409);
    expect(err(blocked).meta).toEqual({ live_subscriptions: 1 });
    expect((await call('DELETE', '/v1/billing/providers/stripe?force=true')).json).toEqual({ object: 'billing_provider', provider: 'stripe', deleted: true });
    expect((await call('DELETE', '/v1/billing/providers/stripe')).status).toBe(404);
  });
});

describe('billing provider webhooks', () => {
  it('stripe: verifies the signature, files the subscription from its reference and follows the lifecycle', async () => {
    const { e, call, user, plan, setPlan, provider, deliver, subsOf, invoicesOf } = await world();
    await provider('stripe', STRIPE);
    const u = await user('st1');
    const p = await plan({ name: 'Pro', slug: 'pro', features: ['f1'], amount: '10.00', stripe_price_id: 'price_pro' });
    const q = await plan({ name: 'Max', slug: 'max', features: ['f1', 'f2'], amount: '30.00', stripe_price_id: 'price_max' });
    setPlan(p.id, { provider: 'stripe' });
    setPlan(q.id, { provider: 'stripe' });
    const end = e.clock.now() + 30 * DAY; // fixed, so a replay carries the very same period end
    const d = (body: Record<string, unknown>) => deliver({ provider: 'stripe', subscription_id: 'sub_x1', subject_type: 'user', subject_id: u.id, plan_id: p.id, current_period_end: end, ...body });

    const created = await d({ event: 'subscription.created' });
    expect(created.json).toMatchObject({ status: 200, response: { received: true } });
    const [s] = await subsOf(u);
    expect(s).toMatchObject({ provider: 'stripe', status: 'active', plan_id: p.id, provider_subscription_id: 'sub_x1', provider_customer_id: 'cus_sub_x1', cancel_at_period_end: false });
    expect(types(e, 'billing_subscription.created')).toHaveLength(1);
    expect(types(e, 'billing_subscription.created')[0]!.payload.data).toMatchObject({ provider: 'stripe', plan: 'pro' });
    expect(types(e, 'entitlement.created')).toHaveLength(1);
    expect((await d({ event: 'subscription.created' })).json.status).toBe(200); // a replay moves nothing
    expect(types(e, 'billing_subscription.created')).toHaveLength(1);
    expect(types(e, 'billing_subscription.updated')).toHaveLength(0);

    await d({ event: 'subscription.updated', plan_id: q.id });
    expect((await subsOf(u))[0]).toMatchObject({ plan_id: q.id });
    expect(types(e, 'billing_subscription.updated')).toHaveLength(1);
    expect(types(e, 'entitlement.updated')).toHaveLength(1);

    await d({ event: 'subscription.updated', plan_id: q.id, cancel_at_period_end: true });
    expect((await subsOf(u))[0]).toMatchObject({ cancel_at_period_end: true, status: 'active' });

    await d({ event: 'payment.failed', plan_id: q.id, amount: 3000 });
    expect(types(e, 'billing_invoice.payment_failed')).toHaveLength(1);
    expect(types(e, 'billing_invoice.payment_failed')[0]!.payload.data.invoice).toMatchObject({ amount_due: 3000, currency: 'usd' });
    const [inv] = await invoicesOf(u);
    expect(inv).toMatchObject({ status: 'open', amount_due: 3000, amount_paid: 0, provider: 'stripe' });
    await d({ event: 'payment.succeeded', plan_id: q.id, amount: 3000, invoice_id: inv.id });
    expect(await invoicesOf(u)).toHaveLength(2); // another invoice id: a new row

    await d({ event: 'subscription.canceled', plan_id: q.id });
    expect((await subsOf(u))[0]).toMatchObject({ status: 'canceled', cancel_at_period_end: false });
    expect(types(e, 'billing_subscription.canceled')).toHaveLength(1);
    expect(types(e, 'entitlement.deleted')).toHaveLength(1);
    expect((await call('GET', '/v1/billing/providers/stripe')).json.last_webhook_at).toBeGreaterThan(0);
  });

  it('refuses a bad, stale or reformatted delivery and one with no configured secret', async () => {
    const { e, anon, user, plan, provider, deliver, subsOf } = await world();
    const u = await user('st2');
    const p = await plan({ name: 'Pro', slug: 'pro', stripe_price_id: 'price_pro' });
    const body = { provider: 'stripe', event: 'subscription.created', subscription_id: 'sub_y', subject_type: 'user', subject_id: u.id, plan_id: p.id };
    expect((await anon('POST', '/__emulator/billing/webhooks/sign', body)).status).toBe(400); // not configured yet
    const none = await anon('POST', `/v1/webhooks/billing/${e.instanceId}/stripe`, {});
    expect(none.status).toBe(404);
    expect(err(none).code).toBe('NOT_CONFIGURED');
    expect((await anon('POST', '/v1/webhooks/billing/ins_other/stripe', {})).status).toBe(404);
    expect((await anon('POST', `/v1/webhooks/billing/${e.instanceId}/nope`, {})).status).toBe(404);
    await provider('stripe', STRIPE);
    for (const tamper of ['signature', 'stale']) {
      const r = await deliver({ ...body, tamper });
      expect(r.json.status).toBe(400);
      expect(r.json.response.errors[0].code).toBe('VALIDATION_FAILED');
    }
    expect(await subsOf(u)).toHaveLength(0);
    const sign = (await anon('POST', '/__emulator/billing/webhooks/sign', body)).json;
    expect(sign).toMatchObject({ object: 'billing_webhook', method: 'POST', url: `${e.issuer}/v1/webhooks/billing/${e.instanceId}/stripe` });
    expect(sign.headers['stripe-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const post = (raw: string) => e.handle(new Request(sign.url, { method: 'POST', headers: sign.headers, body: raw }));
    expect((await post(JSON.stringify(JSON.parse(sign.body), null, 2))).status).toBe(400); // the signature covers the exact bytes
    expect((await post(sign.body)).status).toBe(200);
    expect(await subsOf(u)).toHaveLength(1);
    // a delivery that names no known reference is accepted and files nothing
    const lost = await deliver({ ...body, subscription_id: 'sub_z', omit_ref: true });
    expect(lost.json.status).toBe(200);
    expect(await subsOf(u)).toHaveLength(1);
    expect((await anon('POST', '/__emulator/billing/webhooks/sign', { ...body, provider: 'polar' })).status).toBe(400);
  });

  it('paddle: the timestamped HMAC, subscriptions, transactions and a trial', async () => {
    const { e, user, plan, setPlan, provider, deliver, subsOf, invoicesOf } = await world();
    await provider('paddle', PADDLE);
    const u = await user('pd1');
    const p = await plan({ name: 'Pro', slug: 'pro', amount: '15.00' });
    setPlan(p.id, { provider: 'paddle', provider_price_id: 'pri_1' });
    const d = (body: Record<string, unknown>) => deliver({ provider: 'paddle', subscription_id: 'sub_pd', subject_type: 'user', subject_id: u.id, plan_id: p.id, ...body });
    expect((await d({ event: 'subscription.created', tamper: 'stale' })).json.status).toBe(400);
    expect((await d({ event: 'subscription.created', tamper: 'signature' })).json.status).toBe(400);
    expect((await d({ event: 'subscription.created', trial_end: e.clock.now() + 7 * DAY })).json.status).toBe(200);
    expect((await subsOf(u))[0]).toMatchObject({ provider: 'paddle', status: 'trialing', plan_id: p.id });
    expect(types(e, 'billing_trial.started')).toHaveLength(1);
    await d({ event: 'subscription.updated', plan_id: p.id });
    expect((await subsOf(u))[0].status).toBe('active');
    expect(types(e, 'billing_trial.ended')[0]!.payload.data).toMatchObject({ converted: true });
    await d({ event: 'payment.succeeded', amount: 1500, invoice_id: 'txn_1' });
    expect((await invoicesOf(u))[0]).toMatchObject({ status: 'paid', amount_paid: 1500, provider: 'paddle' });
    await d({ event: 'subscription.updated', cancel_at_period_end: true });
    expect((await subsOf(u))[0].cancel_at_period_end).toBe(true);
    await d({ event: 'subscription.canceled' });
    expect((await subsOf(u))[0].status).toBe('canceled');
    expect((await d({ event: 'trial.will_end' })).status).toBe(400);
  });

  it('lemon squeezy: the body HMAC, then a failed payment', async () => {
    const { e, user, plan, setPlan, provider, deliver, subsOf, invoicesOf } = await world();
    await provider('lemonsqueezy', LEMON);
    const u = await user('lm1');
    const p = await plan({ name: 'Pro', slug: 'pro', amount: '9.00' });
    setPlan(p.id, { provider: 'lemonsqueezy', provider_price_id: '4242' });
    const d = (body: Record<string, unknown>) => deliver({ provider: 'lemonsqueezy', subscription_id: '77', subject_type: 'user', subject_id: u.id, plan_id: p.id, ...body });
    expect((await d({ event: 'subscription.created', tamper: 'signature' })).json.status).toBe(400);
    expect((await d({ event: 'subscription.created' })).json.status).toBe(200);
    expect((await subsOf(u))[0]).toMatchObject({ provider: 'lemonsqueezy', status: 'active', provider_subscription_id: '77' });
    await d({ event: 'payment.failed', amount: 900 });
    expect(types(e, 'billing_invoice.payment_failed')).toHaveLength(1);
    expect((await invoicesOf(u))[0]).toMatchObject({ status: 'open', amount_due: 900 });
    await d({ event: 'subscription.updated', status: 'past_due' });
    expect((await subsOf(u))[0].status).toBe('past_due');
    await d({ event: 'subscription.canceled' });
    expect((await subsOf(u))[0].status).toBe('canceled');
  });

  it('revenuecat: the shared secret, the app user as the subject, and sandbox events dropped', async () => {
    const { e, user, plan, setPlan, provider, deliver, subsOf } = await world();
    await provider('revenuecat', RC);
    const u = await user('rc1');
    const stranger = await user('rc2');
    const p = await plan({ name: 'Pro', slug: 'pro' });
    setPlan(p.id, { provider: 'revenuecat', provider_price_id: 'prod_rc' });
    const d = (body: Record<string, unknown>) => deliver({ provider: 'revenuecat', subscription_id: 'ot9', subject_id: u.id, plan_id: p.id, ...body });
    expect((await d({ event: 'subscription.created', tamper: 'signature' })).json.status).toBe(400);
    expect((await d({ event: 'subscription.created', environment: 'SANDBOX' })).json.status).toBe(200);
    expect(await subsOf(u)).toHaveLength(0); // a sandbox purchase never grants a live entitlement
    expect((await d({ event: 'subscription.created' })).json.status).toBe(200);
    expect((await subsOf(u))[0]).toMatchObject({ provider: 'revenuecat', status: 'active', plan_id: p.id });
    expect(types(e, 'billing_subscription.created')).toHaveLength(1);
    expect(await subsOf(stranger)).toHaveLength(0);
    await d({ event: 'subscription.updated', cancel_at_period_end: true });
    expect((await subsOf(u))[0].cancel_at_period_end).toBe(true);
    await d({ event: 'payment.failed' });
    expect((await subsOf(u))[0].status).toBe('past_due');
    await d({ event: 'subscription.canceled' });
    expect((await subsOf(u))[0].status).toBe('canceled');
  });

  it('never lets the clock renew or end a subscription the provider owns', async () => {
    const { user, plan, provider, deliver, subsOf, invoicesOf, advance } = await world();
    await provider('stripe', STRIPE);
    const u = await user('own');
    const p = await plan({ name: 'Pro', slug: 'pro', amount: '10.00', stripe_price_id: 'price_pro' });
    await deliver({ provider: 'stripe', event: 'subscription.created', subscription_id: 'sub_own', subject_type: 'user', subject_id: u.id, plan_id: p.id });
    await advance(100);
    expect((await subsOf(u))[0].status).toBe('active');
    expect(await invoicesOf(u)).toHaveLength(0);
  });
});

describe('store links', () => {
  it('mints one stable token per subject and plan and refuses what the real route refuses', async () => {
    const { call, user, plan, setPlan } = await world();
    const u = await user('sl1');
    const p = await plan({ name: 'App', slug: 'app' });
    setPlan(p.id, { provider: 'appstore', provider_price_id: 'com.app.pro' });
    const body = { subject_type: 'user', subject_id: u.id, plan_id: p.id };
    const first = await call('POST', '/v1/billing/store_links', body);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ object: 'billing_store_link', subject_type: 'user', subject_id: u.id, plan_id: p.id, provider: 'appstore' });
    expect(first.json.token).toMatch(/^[0-9a-f-]{36}$/);
    const second = await call('POST', '/v1/billing/store_links', body);
    expect(second.status).toBe(200);
    expect(second.json.token).toBe(first.json.token);
    const web = await plan({ name: 'Web', slug: 'web' });
    expect((await call('POST', '/v1/billing/store_links', { ...body, plan_id: web.id })).status).toBe(400); // a web plan
    const off = await plan({ name: 'Off', slug: 'off', active: false });
    setPlan(off.id, { provider: 'googleplay' });
    expect((await call('POST', '/v1/billing/store_links', { ...body, plan_id: off.id })).status).toBe(400);
    const org = await plan({ name: 'Org', slug: 'org', audience: 'org' });
    setPlan(org.id, { provider: 'appstore' });
    expect((await call('POST', '/v1/billing/store_links', { ...body, plan_id: org.id })).status).toBe(400);
    expect((await call('POST', '/v1/billing/store_links', { ...body, plan_id: 'plan_nope' })).status).toBe(404);
    expect((await call('POST', '/v1/billing/store_links', { ...body, subject_id: 'user_nope' })).status).toBe(404);
    expect((await call('POST', '/v1/billing/store_links', { ...body, extra: 1 })).status).toBe(422);
    expect((await call('POST', '/v1/billing/store_links', { subject_type: 'user', subject_id: u.id })).status).toBe(400);
  });

  it('files a purchase only through a token of this instance for the plan it was minted for', async () => {
    const { e, call, anon, user, plan, setPlan, provider, subsOf, invoicesOf, advance } = await world();
    await provider('appstore', APPSTORE);
    const u = await user('sl2');
    const pro = await plan({ name: 'Pro', slug: 'pro', features: ['f'], amount: '5.00' });
    const other = await plan({ name: 'Other', slug: 'other' });
    setPlan(pro.id, { provider: 'appstore', provider_price_id: 'com.app.pro' });
    setPlan(other.id, { provider: 'appstore', provider_price_id: 'com.app.other' });
    const link = (await call('POST', '/v1/billing/store_links', { subject_type: 'user', subject_id: u.id, plan_id: pro.id })).json;
    const buy = (extra: Record<string, unknown>) => anon('POST', '/__emulator/billing/store_purchases', { provider: 'appstore', original_transaction_id: 'ot1', product_id: 'com.app.pro', ...extra });
    expect((await buy({ account_token: 'not-minted-here' })).json).toMatchObject({ handled: false, subscription_id: null });
    expect((await buy({})).json.handled).toBe(false); // no token at all
    expect((await buy({ account_token: link.token, product_id: 'com.app.other' })).json.handled).toBe(false); // the token is for another plan
    expect(await subsOf(u)).toHaveLength(0);
    const ok = await buy({ account_token: link.token });
    expect(ok.json).toMatchObject({ object: 'billing_store_purchase', handled: true });
    const [s] = await subsOf(u);
    expect(s).toMatchObject({ provider: 'appstore', status: 'active', plan_id: pro.id, provider_subscription_id: 'ot1' });
    expect(types(e, 'billing_subscription.created')).toHaveLength(1);
    expect(types(e, 'entitlement.created')).toHaveLength(1);
    // a known subscription needs no token again
    await buy({ event: 'cancel' });
    expect((await subsOf(u))[0].cancel_at_period_end).toBe(true);
    // the store owns change, cancel and restore
    expect((await call('POST', `/v1/billing/subscriptions/${s.id}/change`, { plan_id: other.id })).status).toBe(422);
    expect((await call('POST', `/v1/billing/subscriptions/${s.id}/cancel`, {})).status).toBe(422);
    await advance(60);
    expect((await subsOf(u))[0].status).toBe('active'); // only the store moves it
    expect(await invoicesOf(u)).toHaveLength(0);
    await buy({ event: 'expire' });
    expect((await subsOf(u))[0].status).toBe('canceled');
    expect(types(e, 'billing_subscription.canceled')).toHaveLength(1);
    expect((await anon('POST', '/__emulator/billing/store_purchases', { provider: 'googleplay', original_transaction_id: 'x', product_id: 'y' })).status).toBe(404); // googleplay is not configured
  });
});

describe('Stripe Connect', () => {
  it('needs the stripe credentials first, then onboards, pays and keeps the ledger', async () => {
    const { e, call, anon, user, provider } = await world();
    const u = await user('cn1');
    const open = { subject_type: 'user', subject_id: u.id, idempotency_key: 'k1' };
    const noStripe = await call('POST', '/v1/billing/connect/accounts', open);
    expect(noStripe.status).toBe(503);
    expect(err(noStripe).code).toBe('NOT_CONFIGURED');
    await provider('stripe', STRIPE);
    const created = await call('POST', '/v1/billing/connect/accounts', { ...open, email: 'pay@example.com', country: 'GB' });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ object: 'billing_connect_account', subject_type: 'user', subject_id: u.id, country: 'GB', details_submitted: false, charges_enabled: false, payouts_enabled: false });
    expect(created.json.provider_account_id).toMatch(/^acct_/);
    expect(created.json.requirements_due.length).toBeGreaterThan(0);
    const id = created.json.id;
    const twin = await call('POST', '/v1/billing/connect/accounts', { ...open, idempotency_key: 'k2' });
    expect(twin.status).toBe(200);
    expect(twin.json.id).toBe(id);
    expect((await call('GET', `/v1/billing/connect/accounts/${id}`)).json.id).toBe(id);
    expect((await call('GET', '/v1/billing/connect/accounts/bca_nope')).status).toBe(404);
    expect((await call('POST', '/v1/billing/connect/accounts', { ...open, subject_type: 'team' })).status).toBe(400);
    expect((await call('POST', '/v1/billing/connect/accounts', { subject_type: 'user', subject_id: u.id })).status).toBe(400); // no key
    expect((await call('POST', '/v1/billing/connect/accounts', { ...open, email: 'nope' })).status).toBe(400);
    expect((await call('POST', '/v1/billing/connect/accounts', { ...open, country: 'gb' })).status).toBe(400);
    expect((await call('POST', '/v1/billing/connect/accounts', { subject_type: 'user', subject_id: 'user_nope', idempotency_key: 'k' })).status).toBe(404);

    const transfer = (extra: Record<string, unknown> = {}) => call('POST', '/v1/billing/connect/transfers', { account_id: id, amount: 500, currency: 'USD', idempotency_key: 't1', description: 'payout', ...extra });
    const notReady = await transfer();
    expect(notReady.status).toBe(409);
    expect(err(notReady).meta.requirements_due.length).toBeGreaterThan(0);
    // Stripe finishes onboarding: the stored row only follows once refreshed (a transfer refreshes first)
    await anon('POST', `/__emulator/billing/connect/accounts/${id}/provider_state`, { details_submitted: true, charges_enabled: true, payouts_enabled: true, requirements_due: [] });
    expect((await call('GET', `/v1/billing/connect/accounts/${id}`)).json.payouts_enabled).toBe(false);
    expect((await call('POST', `/v1/billing/connect/accounts/${id}/refresh`)).json).toMatchObject({ payouts_enabled: true, details_submitted: true, requirements_due: [] });

    const paid = await transfer();
    expect(paid.status).toBe(201);
    expect(paid.json).toMatchObject({ object: 'billing_transfer', account_id: id, subject_id: u.id, amount: 500, currency: 'usd', description: 'payout', status: 'paid', failure: null, source_ref: null });
    expect(paid.json.provider_transfer_id).toMatch(/^tr_/);
    expect(types(e, 'billing_transfer.created')).toHaveLength(1);
    expect(types(e, 'billing_transfer.created')[0]!.payload.data).toMatchObject({ id: paid.json.id, amount: 500 });
    const replay = await transfer();
    expect(replay.status).toBe(200);
    expect(replay.json.id).toBe(paid.json.id);
    expect(types(e, 'billing_transfer.created')).toHaveLength(1); // paid once
    const conflict = await transfer({ amount: 600 });
    expect(conflict.status).toBe(409);
    expect(err(conflict).code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await call('GET', `/v1/billing/connect/transfers/${paid.json.id}`)).json.id).toBe(paid.json.id);
    expect((await call('GET', '/v1/billing/connect/transfers/btr_nope')).status).toBe(404);
    expect((await call('GET', `/v1/billing/connect/transfers?account_id=${id}`)).json.data).toHaveLength(1);
    for (const bad of [{ amount: 0 }, { amount: 1.5 }, { currency: 'dollars' }, { description: 'x'.repeat(301) }, { source_ref: 'x'.repeat(201) }, { account_id: '' }, { idempotency_key: '' }]) {
      expect((await transfer({ idempotency_key: 't9', ...bad })).status).toBe(400);
    }
    expect((await transfer({ idempotency_key: 't9', account_id: 'bca_nope' })).status).toBe(404);
    expect((await transfer({ idempotency_key: 't9', nope: 1 })).status).toBe(422);

    // Stripe refuses: the attempt stays in the ledger as failed
    await anon('POST', '/__emulator/billing/connect/faults', { times: 1, message: 'Insufficient funds in the platform balance.' });
    const refused = await transfer({ idempotency_key: 't2' });
    expect(refused.status).toBe(400);
    expect(err(refused).message).toContain('Insufficient funds');
    const ledger = (await call('GET', '/v1/billing/connect/transfers')).json.data;
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ status: 'failed', failure: 'Insufficient funds in the platform balance.', provider_transfer_id: null });
    expect(types(e, 'billing_transfer.created')).toHaveLength(1);
    expect((await transfer({ idempotency_key: 't3' })).status).toBe(201);
  });

  it('hands out an https onboarding link and pages the accounts', async () => {
    const { call, user, provider } = await world();
    await provider('stripe', STRIPE);
    const a = await user('cn2');
    const b = await user('cn3');
    const first = (await call('POST', '/v1/billing/connect/accounts', { subject_type: 'user', subject_id: a.id, idempotency_key: 'a' })).json;
    await call('POST', '/v1/billing/connect/accounts', { subject_type: 'user', subject_id: b.id, idempotency_key: 'b' });
    const link = (body: Record<string, unknown>) => call('POST', `/v1/billing/connect/accounts/${first.id}/onboarding_link`, body);
    const ok = await link({ return_url: 'https://app.example.com/done', refresh_url: 'https://app.example.com/retry' });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ object: 'billing_connect_link', account_id: first.id });
    expect(ok.json.url).toMatch(/^https:\/\//);
    expect(ok.json.expires_at).toBeGreaterThan(Date.now() - 1000);
    expect((await link({ return_url: 'http://app.example.com/done', refresh_url: 'https://app.example.com/retry' })).status).toBe(400);
    expect((await link({ return_url: 'https://user:pw@app.example.com/', refresh_url: 'https://app.example.com/retry' })).status).toBe(400);
    expect((await link({ return_url: 'https://app.example.com/done' })).status).toBe(400);
    expect((await link({ return_url: 'https://a.example.com', refresh_url: 'https://a.example.com', type: 'other' })).status).toBe(400);
    expect((await call('POST', '/v1/billing/connect/accounts/bca_nope/onboarding_link', { return_url: 'https://a.example.com', refresh_url: 'https://a.example.com' })).status).toBe(404);
    const page = (await call('GET', '/v1/billing/connect/accounts?limit=1')).json;
    expect(page.data).toHaveLength(1);
    expect(page.has_more).toBe(true);
    const rest = (await call('GET', `/v1/billing/connect/accounts?limit=1&starting_after=${page.next_cursor}`)).json;
    expect(rest.data).toHaveLength(1);
    expect(rest.data[0].id).not.toBe(page.data[0].id);
    expect((await call('GET', '/v1/billing/connect/accounts?starting_after=bca_nope')).status).toBe(400);
  });
});

describe('credit ledger', () => {
  it('posts idempotently, announces the grant and reaches the customer balance when there is one', async () => {
    const { e, call, user, plan, sub } = await world();
    const u = await user('cr1');
    const post = (body: Record<string, unknown>) => call('POST', '/v1/billing/credits', { subject_type: 'user', subject_id: u.id, currency: 'USD', ...body });
    const first = await post({ amount: 500, idempotency_key: 'c1', reason: 'goodwill' });
    expect([200, 201]).toContain(first.status);
    expect(first.json).toMatchObject({ object: 'billing_credit', amount: 500, currency: 'usd', kind: 'grant', reason: 'goodwill', source_ref: 'c1', applied: false, provider: null });
    expect(types(e, 'billing_credit.granted')).toHaveLength(1);
    expect(types(e, 'billing_credit.granted')[0]!.payload.data).toMatchObject({ id: first.json.id, applied: false, balance: { usd: 500 } });
    const replay = await post({ amount: 500, idempotency_key: 'c1' });
    expect(replay.json.id).toBe(first.json.id);
    expect(types(e, 'billing_credit.granted')).toHaveLength(1);
    expect((await post({ amount: -100, idempotency_key: 'c2' })).json.kind).toBe('adjustment');
    const ledger = (await call('GET', `/v1/billing/credits?subject_type=user&subject_id=${u.id}`)).json;
    expect(ledger).toMatchObject({ object: 'billing_credit_ledger', subject_type: 'user', subject_id: u.id, balance: { usd: 400 } });
    expect(ledger.data).toHaveLength(2);
    // once the subject has a Stripe customer, a new credit and the waiting ones are pushed to it
    const p = await plan({ name: 'A', slug: 'a' });
    await sub(u, p.id, { stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' });
    const third = await post({ amount: 50, idempotency_key: 'c3' });
    expect(third.json).toMatchObject({ applied: true, provider: 'stripe' });
    expect((await call('GET', `/v1/billing/credits?subject_type=user&subject_id=${u.id}`)).json.data.every((c: any) => c.applied)).toBe(true);
    for (const bad of [{ amount: 0 }, { amount: 1.5 }, { amount: 1_000_000_000 }, { currency: 'dollars' }, { subject_id: '' }, { subject_type: 'team' }, { nope: 1 }]) {
      expect((await post({ amount: 5, idempotency_key: 'x', ...bad })).status).toBeGreaterThanOrEqual(400);
    }
    expect((await call('GET', '/v1/billing/credits')).status).toBe(400);
    expect((await call('GET', '/v1/billing/credits?subject_type=team&subject_id=x')).status).toBe(400);
  });
});

describe('referral rewards', () => {
  const setup = async () => {
    const w = await world();
    const attribute = (referee: { id: string }, referrer: { id: string }) => w.anon('POST', '/__emulator/referrals/attribute', { referee_user_id: referee.id, referrer_user_id: referrer.id });
    const pay = (u: { id: string }) => w.anon('POST', '/__emulator/billing/invoices', { subject_type: 'user', subject_id: u.id, amount_paid: 1000 });
    const rewards = async (q = '') => (await w.call('GET', `/v1/referral_rewards${q}`)).json;
    const run = async () => (await w.call('POST', '/v1/referral_rewards/run', {})).json;
    const rules = (body: Record<string, unknown>) => w.call('PUT', '/v1/referral_reward_rules', body);
    return { ...w, attribute, pay, rewards, run, rules };
  };

  it('validates and stores the terms, off by default', async () => {
    const { call, rules } = await setup();
    expect((await call('GET', '/v1/referral_reward_rules')).json).toEqual({ object: 'referral_reward_rules', enabled: false, trigger: 'first_payment', referrer_amount: 0, referee_amount: 0, currency: 'usd', hold_days: 0, max_rewards_per_referrer: null, updated_at: null });
    for (const bad of [{ trigger: 'nope' }, { enabled: 'yes' }, { referrer_amount: -1 }, { referee_amount: 1.5 }, { currency: 'dollars' }, { hold_days: 366 }, { max_rewards_per_referrer: 0 }, { enabled: true }, { nope: 1 }]) {
      expect((await rules(bad)).status).toBe(400);
    }
    const ok = await rules({ enabled: true, referrer_amount: 500, referee_amount: 200, currency: 'EUR', hold_days: 7, max_rewards_per_referrer: 1 });
    expect(ok.json).toMatchObject({ enabled: true, trigger: 'first_payment', referrer_amount: 500, referee_amount: 200, currency: 'eur', hold_days: 7, max_rewards_per_referrer: 1 });
    expect(ok.json.updated_at).toBeGreaterThan(0);
    expect((await rules({ referrer_amount: 100 })).json).toMatchObject({ enabled: false, trigger: 'first_payment', referee_amount: 0, hold_days: 0, max_rewards_per_referrer: null }); // a field left out returns to its default
  });

  it('grants credits after the first payment and the hold, once, and respects the cap', async () => {
    const { e, call, user, attribute, pay, rewards, run, rules, advance } = await setup();
    const referrer = await user('rf1');
    const a = await user('rf2');
    const b = await user('rf3');
    await rules({ enabled: true, referrer_amount: 500, referee_amount: 200, currency: 'EUR', hold_days: 7, max_rewards_per_referrer: 1 });
    await attribute(a, referrer);
    expect((await rewards()).data).toHaveLength(0); // no payment yet
    await pay(a);
    expect(await run()).toEqual({ object: 'referral_reward_run', created: 2, granted: 0, voided: 0 });
    const pending = (await rewards()).data;
    expect(pending).toHaveLength(2);
    expect(pending.map((r: any) => r.role).sort()).toEqual(['referee', 'referrer']);
    const mine = pending.find((r: any) => r.role === 'referrer');
    expect(mine).toMatchObject({ object: 'referral_reward', referrer_user_id: referrer.id, referee_user_id: a.id, recipient_user_id: referrer.id, trigger: 'first_payment', amount: 500, currency: 'eur', status: 'pending', credit_id: null, granted_at: null });
    expect(mine.release_at - mine.created_at).toBe(7 * DAY);
    expect(await run()).toMatchObject({ created: 0, granted: 0 }); // one reward per referee and role
    expect((await rewards(`?recipient_user_id=${a.id}`)).data).toHaveLength(1);
    expect((await rewards(`?referrer_user_id=${referrer.id}&status=pending`)).data).toHaveLength(2);
    expect((await call('GET', `/v1/referral_rewards/${mine.id}`)).json.id).toBe(mine.id);

    // the cap counts pending and granted rewards of the referrer: a second referee earns only their own reward
    await attribute(b, referrer);
    await pay(b);
    expect(await run()).toMatchObject({ created: 1 });
    expect((await rewards(`?recipient_user_id=${b.id}`)).data).toHaveLength(1);
    expect((await rewards(`?recipient_user_id=${referrer.id}`)).data).toHaveLength(1);

    await advance(7);
    const granted = (await rewards('?status=granted')).data;
    expect(granted).toHaveLength(3);
    const g = granted.find((r: any) => r.id === mine.id);
    expect(g.credit_id).toMatch(/^bcr_/);
    expect(g.granted_at).toBeGreaterThan(0);
    expect(types(e, 'referral_reward.granted')).toHaveLength(3);
    expect(types(e, 'billing_credit.granted')).toHaveLength(3);
    const ledger = (await call('GET', `/v1/billing/credits?subject_type=user&subject_id=${referrer.id}`)).json;
    expect(ledger.balance).toEqual({ eur: 500 });
    expect(ledger.data[0]).toMatchObject({ id: g.credit_id, reason: 'Referral reward', source_ref: `referral_reward:${mine.id}`, kind: 'grant' });
    expect((await call('GET', `/v1/billing/credits?subject_type=user&subject_id=${a.id}`)).json.data[0].reason).toBe('Welcome reward from a referral');
    expect(await run()).toMatchObject({ created: 0, granted: 0, voided: 0 }); // paid once
    expect(types(e, 'billing_credit.granted')).toHaveLength(3);
    const voidGranted = await call('POST', `/v1/referral_rewards/${mine.id}/void`, {});
    expect(voidGranted.status).toBe(400);
  });

  it('voids a reward when the referral is flagged during the hold, and by hand', async () => {
    const { e, call, anon, user, attribute, pay, rewards, run, rules, advance } = await setup();
    const referrer = await user('fl1');
    const flagged = await user('fl2');
    const other = await user('fl3');
    await rules({ enabled: true, trigger: 'signup', referrer_amount: 300, hold_days: 3 });
    await attribute(flagged, referrer);
    await attribute(other, referrer);
    await attribute(referrer, referrer); // a self-referral earns nothing
    expect(await run()).toMatchObject({ created: 2 });
    expect((await rewards()).data.every((r: any) => r.trigger === 'signup' && r.status === 'pending')).toBe(true);
    await anon('POST', '/__emulator/referrals/flag', { referee_user_id: flagged.id });
    const manual = (await rewards(`?referrer_user_id=${referrer.id}`)).data.find((r: any) => r.referee_user_id === other.id);
    const voided = await call('POST', `/v1/referral_rewards/${manual.id}/void`, { reason: 'fraud' });
    expect(voided.json).toMatchObject({ status: 'voided', void_reason: 'fraud' });
    expect(voided.json.voided_at).toBeGreaterThan(0);
    expect((await call('POST', `/v1/referral_rewards/${manual.id}/void`, {})).json.status).toBe('voided');
    await advance(3);
    const all = (await rewards()).data;
    expect(all.find((r: any) => r.referee_user_id === flagged.id)).toMatchObject({ status: 'voided', void_reason: 'referral_no_longer_valid', credit_id: null });
    expect(all.some((r: any) => r.status === 'granted')).toBe(false);
    expect(types(e, 'referral_reward.granted')).toHaveLength(0);
    expect((await call('GET', `/v1/billing/credits?subject_type=user&subject_id=${referrer.id}`)).json.data).toHaveLength(0);
    expect((await call('POST', '/v1/referral_rewards/rrw_nope/void', {})).status).toBe(404);
    expect((await call('POST', `/v1/referral_rewards/${manual.id}/void`, { reason: 'x'.repeat(301) })).status).toBe(400);
    expect((await call('GET', '/v1/referral_rewards/rrw_nope')).status).toBe(404);
    expect((await call('GET', '/v1/referral_rewards?status=nope')).status).toBe(400);
    expect((await call('GET', '/v1/referral_rewards?starting_after=rrw_nope')).status).toBe(400);
    await pay(other);
  });

  it('grants at once with no hold on the signup trigger', async () => {
    const { call, user, attribute, run, rules } = await setup();
    const referrer = await user('sg1');
    const referee = await user('sg2');
    await rules({ enabled: true, trigger: 'signup', referrer_amount: 100, referee_amount: 100 });
    await attribute(referee, referrer);
    expect(await run()).toEqual({ object: 'referral_reward_run', created: 2, granted: 2, voided: 0 });
    expect((await call('GET', `/v1/billing/credits?subject_type=user&subject_id=${referee.id}`)).json.balance).toEqual({ usd: 100 });
  });
});
