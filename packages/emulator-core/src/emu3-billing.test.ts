/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import type { Engine } from './engine';
import { client, makeEngine } from './test-support';

const DAY = 86_400_000;
const types = (e: Engine, t: string) => e.webhooks.events.filter((x) => x.type === t);
const err = (r: { json: any }) => r.json.errors[0];

async function world() {
  const e = makeEngine();
  const call = client(e);
  const anon = client(e, null);
  const user = async (tag: string) => (await call('POST', '/v1/users', { email_address: `${tag}@example.com` })).json;
  const plan = async (body: Record<string, unknown>) => (await call('POST', '/v1/billing/plans', { active: true, ...body })).json;
  const sub = async (u: { id: string }, plan_id: string, extra: Record<string, unknown> = {}) => (await call('POST', '/v1/billing/subscriptions/import', { subject_type: 'user', subject_id: u.id, plan_id, ...extra })).json;
  const advance = (days: number) => anon('POST', '/__emulator/time/advance', { ms: days * DAY });
  return { e, call, anon, user, plan, sub, advance };
}

describe('billing: change plan', () => {
  it('moves a subscription now, prorates and emits the subscription and entitlement events', async () => {
    const { e, call, user, plan, sub } = await world();
    const u = await user('chg');
    const a = await plan({ name: 'A', slug: 'a', amount: '10.00', features: ['fa'] });
    const b = await plan({ name: 'B', slug: 'b', amount: '20.00', features: ['fb'] });
    const s = await sub(u, a.id);
    expect(s).toMatchObject({ interval: 'month', quantity: 1, cancel_at_period_end: false, scheduled_plan_id: null, canceled_at: null, account: 'instance' });
    const r = await call('POST', `/v1/billing/subscriptions/${s.id}/change`, { plan_id: b.id });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ plan_id: b.id, scheduled: false, scheduled_plan_id: null });
    // an immediate change is prorated: the items wait for the next invoice (see emu4-billing.test.ts)
    expect((await call('GET', `/v1/billing/invoices?subject_id=${u.id}`)).json.data).toHaveLength(0);
    expect(types(e, 'billing_subscription.updated')).toHaveLength(1);
    expect(types(e, 'entitlement.updated')).toHaveLength(1);
    expect((await call('GET', `/v1/billing/subscriptions/${s.id}`)).json.plan_id).toBe(b.id);
  });

  it('refuses what the real route refuses', async () => {
    const { call, user, plan, sub } = await world();
    const u = await user('ref');
    const a = await plan({ name: 'A', slug: 'a' });
    const orgPlan = await plan({ name: 'O', slug: 'o', audience: 'org' });
    const addon = await plan({ name: 'AD', slug: 'ad', kind: 'addon' });
    const au = await plan({ name: 'AU', slug: 'au', provider: 'autumn' });
    const s = await sub(u, a.id);
    const change = (body: unknown, id = s.id) => call('POST', `/v1/billing/subscriptions/${id}/change`, body);
    expect((await change({ plan_id: a.id })).status).toBe(409); // already on it
    expect((await change({})).status).toBe(400);
    expect((await change({ plan_id: 'plan_nope' })).status).toBe(404);
    expect((await change({ plan_id: a.id, interval: 'week' })).status).toBe(400);
    const unknown = await change({ plan_id: a.id, plan: 'x' });
    expect(unknown.status).toBe(422);
    expect(err(unknown).code).toBe('UNKNOWN_FIELD');
    expect((await change({ plan_id: orgPlan.id })).status).toBe(400);
    expect((await change({ plan_id: addon.id })).status).toBe(400);
    expect((await change({ plan_id: au.id })).status).toBe(400); // another provider
    expect((await change({ plan_id: a.id }, 'sub_nope')).status).toBe(404);
    const sched = await change({ plan_id: a.id, interval: 'year', schedule_at_period_end: true });
    expect(sched.status).toBe(200);
    const u2 = await user('ref2');
    const auSub = await sub(u2, au.id);
    const other = await plan({ name: 'AU2', slug: 'au2', provider: 'autumn' });
    const noSchedule = await change({ plan_id: other.id, schedule_at_period_end: true }, auSub.id);
    expect(noSchedule.status).toBe(422);
    expect(err(noSchedule).meta).toEqual({ reason: 'unsupported' });
    await call('POST', `/v1/billing/subscriptions/${s.id}/cancel`, { immediately: true });
    const ended = await change({ plan_id: orgPlan.id });
    expect(ended.status).toBe(409);
    expect(err(ended).meta).toEqual({ reason: 'no_subscription' });
  });

  it('schedules a change for the period end and applies it when the clock passes it, then renews with an invoice', async () => {
    const { e, call, user, plan, sub, advance } = await world();
    const u = await user('sch');
    const a = await plan({ name: 'A', slug: 'a', amount: '10.00', features: ['fa'] });
    const b = await plan({ name: 'B', slug: 'b', amount: '20.00', features: ['fb'] });
    const s = await sub(u, a.id);
    const r = (await call('POST', `/v1/billing/subscriptions/${s.id}/change`, { plan_id: b.id, schedule_at_period_end: true })).json;
    expect(r).toMatchObject({ scheduled: true, plan_id: a.id, scheduled_plan_id: b.id, scheduled_interval: 'month', scheduled_change_at: s.current_period_end });
    expect((await call('GET', `/v1/billing/invoices?subject_id=${u.id}`)).json.data).toHaveLength(0);
    await advance(31);
    const after = (await call('GET', `/v1/billing/subscriptions/${s.id}`)).json;
    expect(after).toMatchObject({ plan_id: b.id, scheduled_plan_id: null, scheduled_change_at: null, status: 'active' });
    expect(after.current_period_end).toBe(s.current_period_end + 30 * DAY);
    expect((await call('GET', `/v1/billing/invoices?subject_id=${u.id}`)).json.data).toHaveLength(1);
    expect(types(e, 'entitlement.updated')).toHaveLength(1);
    await advance(30);
    const invoices = (await call('GET', `/v1/billing/invoices?subject_id=${u.id}`)).json.data;
    expect(invoices).toHaveLength(2);
    expect(invoices.every((i: any) => i.amount_paid === 2000)).toBe(true);
  });
});

describe('billing: cancel and restore', () => {
  it('cancels at the period end, can be restored, and ends when the period passes', async () => {
    const { e, call, user, plan, sub, advance } = await world();
    const u = await user('can');
    const a = await plan({ name: 'A', slug: 'a', limits: { seats: 2 } });
    const s = await sub(u, a.id);
    expect((await call('POST', `/v1/billing/subscriptions/${s.id}/restore`)).status).toBe(409); // not canceling
    const c1 = (await call('POST', `/v1/billing/subscriptions/${s.id}/cancel`, {})).json;
    expect(c1).toMatchObject({ status: 'active', cancel_at_period_end: true });
    expect(typeof c1.canceled_at).toBe('number');
    expect((await call('POST', `/v1/billing/subscriptions/${s.id}/cancel`, {})).status).toBe(409);
    expect((await call('POST', `/v1/billing/subscriptions/${s.id}/restore`)).json).toMatchObject({ cancel_at_period_end: false, canceled_at: null });
    await call('POST', `/v1/billing/subscriptions/${s.id}/cancel`, {});
    await advance(31);
    expect((await call('GET', `/v1/billing/subscriptions/${s.id}`)).json.status).toBe('canceled');
    expect(types(e, 'billing_subscription.canceled')).toHaveLength(1);
    expect(types(e, 'entitlement.deleted')).toHaveLength(1);
    const restore = await call('POST', `/v1/billing/subscriptions/${s.id}/restore`);
    expect(restore.status).toBe(409);
    expect(err(restore).meta).toEqual({ reason: 'no_subscription' });
    const consume = await call('POST', '/v1/entitlements/consume', { subject_type: 'user', subject_id: u.id, feature: 'seats', idempotency_key: 'k' });
    expect(consume.json).toMatchObject({ allowed: false, reason: 'not_entitled' });
  });

  it('cancels immediately and releases a scheduled change', async () => {
    const { e, call, user, plan, sub } = await world();
    const u = await user('imm');
    const a = await plan({ name: 'A', slug: 'a' });
    const b = await plan({ name: 'B', slug: 'b' });
    const s = await sub(u, a.id, { trial_days: 5 });
    await call('POST', `/v1/billing/subscriptions/${s.id}/change`, { plan_id: b.id, schedule_at_period_end: true });
    const r = (await call('POST', `/v1/billing/subscriptions/${s.id}/cancel`, { immediately: true })).json;
    expect(r).toMatchObject({ status: 'canceled', cancel_at_period_end: false, scheduled_plan_id: null });
    expect(types(e, 'billing_subscription.canceled')).toHaveLength(1);
    expect(types(e, 'billing_trial.ended')[0]!.payload.data).toMatchObject({ converted: false });
    expect((await call('POST', `/v1/billing/subscriptions/${s.id}/cancel`, {})).status).toBe(409);
  });
});

describe('billing: trials and renewals follow the clock', () => {
  it('converts a trial to active with an invoice and warns before it ends', async () => {
    const { e, call, user, plan, sub, advance } = await world();
    const u = await user('tri');
    const a = await plan({ name: 'A', slug: 'a', amount: '$5.00', currency: 'eur' });
    const s = await sub(u, a.id, { trial_days: 14 });
    await advance(12);
    await call('GET', `/v1/billing/subscriptions/${s.id}`);
    expect(types(e, 'billing_trial.will_end')).toHaveLength(1);
    await advance(3);
    const after = (await call('GET', `/v1/billing/subscriptions/${s.id}`)).json;
    expect(after.status).toBe('active');
    expect(types(e, 'billing_trial.ended')[0]!.payload.data).toMatchObject({ converted: true, id: s.id });
    const inv = (await call('GET', `/v1/billing/invoices?subject_id=${u.id}`)).json.data;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ amount_paid: 500, currency: 'eur', subscription_id: s.id });
  });

  it('moves to past_due with a payment_failed event when the payment is set to fail', async () => {
    const { e, call, user, plan, sub, advance } = await world();
    const u = await user('fail');
    const a = await plan({ name: 'A', slug: 'a', amount: '9' });
    const s = await sub(u, a.id, { trial_days: 3, payment_failing: true });
    await advance(4);
    expect((await call('GET', `/v1/billing/subscriptions/${s.id}`)).json.status).toBe('past_due');
    expect(types(e, 'billing_trial.ended')[0]!.payload.data).toMatchObject({ converted: false });
    expect(types(e, 'billing_invoice.payment_failed')).toHaveLength(1);
    expect((await call('GET', `/v1/billing/invoices?subject_id=${u.id}`)).json.data[0]).toMatchObject({ status: 'open', amount_paid: 0 });
  });

  it('keeps POST /__emulator/billing/invoices working', async () => {
    const { anon, user } = await world();
    const u = await user('inv');
    const r = await anon('POST', '/__emulator/billing/invoices', { subject_type: 'user', subject_id: u.id, amount_paid: 700 });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ amount_paid: 700, status: 'paid' });
  });
});

describe('billing: consume on Atlas and on an entitlement provider', () => {
  it('answers in the real shape on Atlas, with conflicts and replays', async () => {
    const { e, call, user, plan, sub } = await world();
    const u = await user('atl');
    const p = await plan({ name: 'P', slug: 'p', limits: { api: 2 } });
    await sub(u, p.id);
    const consume = (body: Record<string, unknown>) => call('POST', '/v1/entitlements/consume', { subject_type: 'user', subject_id: u.id, feature: 'api', ...body });
    const one = await consume({ idempotency_key: 'a', amount: 1 });
    expect(one.json).toMatchObject({ object: 'entitlement_consumption', allowed: true, reason: null, feature: 'api', amount: 1, source: 'atlas', provider: null, used: 1, limit: 2, remaining: 1, unlimited: false, replayed: false });
    expect(typeof one.json.window_start).toBe('number');
    expect((await consume({ idempotency_key: 'a', amount: 1 })).json.replayed).toBe(true);
    const conflict = await consume({ idempotency_key: 'a', amount: 2 });
    expect(conflict.status).toBe(409);
    expect(err(conflict).code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await consume({ idempotency_key: 'b', amount: 1 })).json).toMatchObject({ allowed: true, remaining: 0 });
    expect(types(e, 'entitlement.limit_reached')).toHaveLength(1);
    expect((await consume({ idempotency_key: 'c' })).json).toMatchObject({ allowed: false, reason: 'limit_reached', used: 2 });
    expect((await consume({ feature: 'other', idempotency_key: 'd' })).json).toMatchObject({ allowed: false, reason: 'not_entitled' });
    expect((await consume({ idempotency_key: 'e', amount: 0 })).status).toBe(400);
    expect((await consume({ idempotency_key: '' })).status).toBe(400);

    const refund = (body: Record<string, unknown>) => call('POST', '/v1/entitlements/consume/refund', { subject_type: 'user', subject_id: u.id, feature: 'api', ...body });
    const r1 = await refund({ consume_idempotency_key: 'a', idempotency_key: 'r1', amount: 1 });
    expect(r1.json).toMatchObject({ object: 'entitlement_consume_refund', refunded: 1, feature: 'api', used: 1, replayed: false });
    expect((await refund({ consume_idempotency_key: 'a', idempotency_key: 'r1', amount: 1 })).json).toMatchObject({ refunded: 1, replayed: true });
    const over = await refund({ consume_idempotency_key: 'a', idempotency_key: 'r2', amount: 1 });
    expect(over.status).toBe(409);
    expect(err(over).meta).toEqual({ refundable: 0 });
    expect((await refund({ consume_idempotency_key: 'zzz', idempotency_key: 'r3' })).status).toBe(404);
    const clash = await refund({ consume_idempotency_key: 'b', idempotency_key: 'r1' });
    expect(err(clash).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('lets the provider own the balance of a subscription on Autumn or Commet', async () => {
    const { e, call, anon, user, plan, sub } = await world();
    const u = await user('prv');
    const p = await plan({ name: 'P', slug: 'p', provider: 'autumn', stripe_price_id: 'au_1', limits: { api: 100 } });
    const s = await sub(u, p.id);
    expect(s.provider).toBe('autumn');
    const consume = (body: Record<string, unknown>) => call('POST', '/v1/entitlements/consume', { subject_type: 'user', subject_id: u.id, feature: 'api', ...body });
    expect((await consume({ idempotency_key: 'x' })).json).toMatchObject({ allowed: false, reason: 'not_entitled', source: 'provider', provider: 'autumn' });
    const set = await anon('PUT', '/__emulator/billing/provider_balances', { subject_type: 'user', subject_id: u.id, feature: 'api', granted: 3 });
    expect(set.json).toMatchObject({ granted: 3, usage: 0, remaining: 3, unlimited: false });
    expect((await anon('PUT', '/__emulator/billing/provider_balances', { subject_type: 'user', subject_id: u.id, feature: 'api' })).status).toBe(400);
    const a = await consume({ idempotency_key: 'a', amount: 2 });
    expect(a.json).toMatchObject({ allowed: true, source: 'provider', provider: 'autumn', used: 2, limit: 3, remaining: 1, replayed: false });
    expect((await consume({ idempotency_key: 'a', amount: 2 })).json).toMatchObject({ allowed: true, replayed: true, used: null });
    expect((await consume({ idempotency_key: 'b', amount: 2 })).json).toMatchObject({ allowed: false, reason: 'limit_reached', used: 2, remaining: 1 });
    expect((await consume({ idempotency_key: 'c', amount: 1 })).json).toMatchObject({ allowed: true, remaining: 0 });
    expect(types(e, 'entitlement.limit_reached')).toHaveLength(1);
    expect((await anon('GET', `/__emulator/billing/provider_balances?subject_id=${u.id}`)).json.data[0]).toMatchObject({ usage: 3, remaining: 0 });
    expect((await call('GET', `/v1/billing/usage?subject_type=user&subject_id=${u.id}&feature=api`)).json.total).toBe(3);
    const refund = await call('POST', '/v1/entitlements/consume/refund', { subject_type: 'user', subject_id: u.id, feature: 'api', consume_idempotency_key: 'a', idempotency_key: 'r' });
    expect(refund.status).toBe(422);
    expect(err(refund).meta).toEqual({ reason: 'unsupported' });
    await anon('PUT', '/__emulator/billing/provider_balances', { subject_type: 'user', subject_id: u.id, feature: 'api', unlimited: true });
    expect((await consume({ idempotency_key: 'd', amount: 500 })).json).toMatchObject({ allowed: true, unlimited: true, remaining: null });
  });

  it('mirrors a provider plan catalogue into the plan and refuses a Stripe plan', async () => {
    const { e, call, anon, user, plan, sub } = await world();
    const u = await user('syn');
    const p = await plan({ name: 'P', slug: 'p', provider: 'commet', stripe_price_id: 'cm_1', features: ['old'] });
    await sub(u, p.id);
    const missing = await call('POST', `/v1/billing/plans/${p.id}/sync_entitlements`);
    expect(missing.status).toBe(404);
    expect((await anon('PUT', '/__emulator/billing/provider_catalogue', { provider: 'commet', price_ref: 'cm_1', features: ['api', 'seats'], limits: { seats: 5 } })).status).toBe(200);
    const r = await call('POST', `/v1/billing/plans/${p.id}/sync_entitlements`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ features: ['api', 'seats'], limits: { seats: 5 } });
    expect(types(e, 'entitlement.updated')).toHaveLength(1);
    const stripePlan = await plan({ name: 'S', slug: 's', stripe_price_id: 'price_1' });
    const refused = await call('POST', `/v1/billing/plans/${stripePlan.id}/sync_entitlements`);
    expect(refused.status).toBe(422);
    expect((await call('POST', '/v1/billing/plans/plan_nope/sync_entitlements')).status).toBe(404);
    expect((await anon('GET', '/__emulator/billing/provider_catalogue')).json.data).toHaveLength(1);
  });
});

describe('billing: the signed-in user manages their own subscription', () => {
  it('cancels, restores and changes through the session, for the user and for an administered organization', async () => {
    const { e, call, user, plan, sub } = await world();
    const u = await user('cli');
    const member = await user('cli-m');
    const outsider = await user('cli-o');
    const bearer = async (id: string) => ({ authorization: `Bearer ${(await call('POST', '/v1/sessions', { user_id: id })).json.jwt}` });
    const a = await plan({ name: 'A', slug: 'a' });
    const b = await plan({ name: 'B', slug: 'b' });
    const s = await sub(u, a.id);
    const as = await bearer(u.id);
    const cancel = await call('POST', '/v1/client/billing/subscription/cancel', {}, as);
    expect(cancel.json).toMatchObject({ object: 'billing_subscription', id: s.id, cancel_at_period_end: true, plan: { id: a.id } });
    expect((await call('POST', `/v1/client/billing/subscriptions/${s.id}/restore`, {}, as)).json.cancel_at_period_end).toBe(false);
    const change = await call('POST', '/v1/client/billing/subscription/change', { plan_id: b.id }, as);
    expect(change.json).toMatchObject({ scheduled: false, plan: { id: b.id } });
    expect((await call('POST', '/v1/client/billing/subscriptions/sub_nope/cancel', {}, as)).status).toBe(404);
    expect((await call('POST', '/v1/client/billing/subscription/cancel', { surprise: 1 }, as)).status).toBe(422);
    expect((await client(e, null)('POST', '/v1/client/billing/subscription/cancel', {})).status).toBe(401);
    const nobody = await call('POST', '/v1/client/billing/subscription/cancel', {}, await bearer(outsider.id));
    expect(nobody.status).toBe(409);
    expect(err(nobody).meta).toEqual({ reason: 'no_subscription' });

    const org = (await call('POST', '/v1/organizations', { name: 'Acme', created_by: u.id })).json;
    await call('POST', `/v1/organizations/${org.id}/memberships`, { user_id: member.id, role: 'org:member' });
    const orgPlan = await plan({ name: 'OP', slug: 'op', audience: 'org' });
    const os = (await call('POST', '/v1/billing/subscriptions/import', { subject_type: 'org', subject_id: org.id, plan_id: orgPlan.id })).json;
    const asOrg = await call('POST', '/v1/client/billing/subscription/cancel', { org_id: org.id }, as);
    expect(asOrg.json).toMatchObject({ id: os.id, subject_type: 'org', cancel_at_period_end: true });
    expect((await call('POST', '/v1/client/billing/subscription/cancel', { org_id: org.id }, await bearer(member.id))).status).toBe(403);
    expect((await call('POST', '/v1/client/billing/subscription/cancel', { org_id: org.id }, await bearer(outsider.id))).status).toBe(404);
  });
});
