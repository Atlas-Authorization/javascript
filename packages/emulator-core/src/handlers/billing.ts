/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, paginate } from '../store';
import { engineState, intIn, oneOf } from './support';
import { listReply, pageOf } from './util';

/**
 * Billing on top of the engine's own state: subscriptions (imported, with trials that can be extended), invoices and
 * refunds, the usage ledger (single report, batch, read-back) and entitlement consume and refund. One ledger holds usage:
 * a report is a positive row, a consume a positive row, a refund a negative row dated like the consume it undoes, so the
 * read-back and the limit check always agree. Plans, coupons and the rest of the catalogue are the generic CRUD layer's;
 * a plan's numeric `limits` are what a consume checks. Invoices come from the provider in production: create them here
 * with `POST /__emulator/billing/invoices`.
 */
const DAY = 86_400_000;
const MAX_TRIAL_MS = 365 * DAY;
const BATCH_MAX = 100;
const SUBJECTS = ['user', 'org'] as const;

interface Bill {
  subs: Table;
  invoices: Table;
  refunds: Table;
  usage: Table;
  extensions: Map<string, Obj>;
  limitFired: Set<string>;
  consumes: Map<string, Obj>;
}
const st = engineState((e: Engine): Bill => ({ subs: new Table('billing_subscriptions', e.clock.now, 'sub'), invoices: new Table('billing_invoices', e.clock.now, 'in'), refunds: new Table('billing_refunds', e.clock.now, 're'), usage: new Table('billing_usage', e.clock.now, 'bu'), extensions: new Map(), limitFired: new Set(), consumes: new Map() }));

const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);

function subject(e: Engine, body: Obj): { type: string; id: string } {
  const type = oneOf(body, 'subject_type', SUBJECTS);
  const id = body.subject_id;
  if (typeof id !== 'string' || !id) throw bad('subject_id is required.', 'subject_id');
  const exists = type === 'user' ? e.db.users.get(id) && !e.db.users.get(id)!.deleted : e.db.organizations.get(id);
  if (!exists) throw new EmulatorError('NOT_FOUND', `${type === 'user' ? 'User' : 'Organization'} not found.`, 'subject_id');
  return { type, id };
}

const subView = (e: Engine, s: Obj): Obj =>
  e.shape('Subscription', { object: 'billing_subscription', id: s.id, subject_type: s.subject_type, subject_id: s.subject_id, plan_id: s.plan_id, status: s.status, stripe_subscription_id: s.stripe_subscription_id ?? null, stripe_customer_id: s.stripe_customer_id ?? null, current_period_end: s.current_period_end, provider: s.provider, cancel_at_period_end: false, entitlements: null, trial_end: s.trial_end ?? null, created_at: s.created_at, updated_at: s.updated_at });

/** The live subscription of a subject (trialing or active), newest first. */
const liveSub = (e: Engine, type: string, id: string): Obj | undefined => st(e).subs.find((s) => s.subject_type === type && s.subject_id === id && (s.status === 'active' || s.status === 'trialing'));

const planLimit = (e: Engine, planId: string, feature: string): number | null => {
  const plan = e.generic.get('billing/plans')?.get(planId);
  const v = plan?.limits?.[feature];
  return typeof v === 'number' && v >= 0 ? v : null; // none or -1 = unlimited
};

const monthStart = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
/** The window a consume counts in: the subscription's period, else the UTC month. */
const windowOf = (e: Engine, sub: Obj | undefined): { from: number; to: number } => {
  const now = e.clock.now();
  if (sub?.current_period_end && sub.current_period_end > now) return { from: sub.current_period_end - 30 * DAY, to: sub.current_period_end };
  const from = monthStart(now);
  const d = new Date(from);
  return { from, to: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
};
const used = (e: Engine, type: string, id: string, feature: string, w: { from: number; to: number }): number =>
  st(e).usage.filter((r) => r.subject_type === type && r.subject_id === id && r.feature === feature && r.created_at >= w.from && r.created_at < w.to).reduce((n, r) => n + r.quantity, 0);

function recordUsage(e: Engine, input: Obj): { row: Obj; duplicate: boolean } {
  const s = st(e);
  const sub = subject(e, input);
  if (typeof input.feature !== 'string' || !input.feature) throw bad('feature is required.', 'feature');
  if (typeof input.quantity !== 'number' || !Number.isFinite(input.quantity) || input.quantity <= 0) throw bad('quantity must be a positive number.', 'quantity');
  if (input.idempotency_key !== undefined && (typeof input.idempotency_key !== 'string' || !input.idempotency_key || input.idempotency_key.length > 200)) throw bad('idempotency_key must be a non-empty string of at most 200 characters.', 'idempotency_key');
  if (input.idempotency_key) {
    const have = s.usage.find((r) => r.source === 'report' && r.subject_type === sub.type && r.subject_id === sub.id && r.ref_key === input.idempotency_key);
    if (have) return { row: have, duplicate: true };
  }
  const row = s.usage.insert({ subject_type: sub.type, subject_id: sub.id, feature: input.feature, quantity: input.quantity, source: 'report', ref_key: input.idempotency_key ?? null, subscription_id: input.subscription_id ?? liveSub(e, sub.type, sub.id)?.id ?? null, created_at: e.clock.now() });
  return { row, duplicate: false };
}
const usageView = (r: Obj, duplicate = false): Obj => ({ object: 'billing_usage', id: r.id, subject_type: r.subject_type, subject_id: r.subject_id, feature: r.feature, quantity: r.quantity, source: r.source, subscription_id: r.subscription_id, recorded: !duplicate, duplicate, created_at: r.created_at });

const invoiceView = (e: Engine, i: Obj): Obj => ({ object: 'billing_invoice', id: i.id, subject_type: i.subject_type, subject_id: i.subject_id, subscription_id: i.subscription_id ?? null, status: i.status, currency: i.currency, amount_due: i.amount_due, amount_paid: i.amount_paid, amount_refunded: i.amount_refunded, provider: i.provider, refunds: st(e).refunds.filter((r) => r.invoice_id === i.id).reverse().map(refundView), created_at: i.created_at });
const refundView = (r: Obj): Obj => ({ object: 'billing_refund', id: r.id, invoice_id: r.invoice_id, amount: r.amount, currency: r.currency, reason: r.reason ?? null, status: 'succeeded', idempotency_key: r.idempotency_key, created_at: r.created_at });

export function billingHandlers(): RouteDef[] {
  const subOf = (e: Engine, id: string | undefined): Obj => {
    const s = st(e).subs.get(id);
    if (!s) throw notFound('Subscription');
    return s;
  };
  const invoiceOf = (e: Engine, id: string | undefined): Obj => {
    const i = st(e).invoices.get(id);
    if (!i) throw notFound('Invoice');
    return i;
  };
  const consumeResult = (e: Engine, k: Obj): Obj => ({ object: 'entitlement_consume', ...k });

  return [
    // ── subscriptions (imported) ──
    {
      method: 'POST',
      pattern: '/v1/billing/subscriptions/import',
      handler: (c) => {
        const e = c.engine;
        const sub = subject(e, c.body);
        if (typeof c.body.plan_id !== 'string' || !c.body.plan_id) throw bad('plan_id is required.', 'plan_id');
        const plans = e.generic.get('billing/plans');
        if (plans && plans.size && !plans.get(c.body.plan_id)) throw new EmulatorError('NOT_FOUND', 'Plan not found.', 'plan_id');
        if (liveSub(e, sub.type, sub.id) && !c.body.add_on) throw new EmulatorError('CONFLICT', 'This subject already has a live subscription.');
        const trialDays = c.body.trial_days === undefined ? 0 : intIn(c.body.trial_days, 'trial_days', 0, 365);
        const now = e.clock.now();
        const row = st(e).subs.insert({ subject_type: sub.type, subject_id: sub.id, plan_id: c.body.plan_id, status: trialDays ? 'trialing' : 'active', stripe_subscription_id: c.body.stripe_subscription_id ?? null, stripe_customer_id: c.body.stripe_customer_id ?? null, current_period_end: now + 30 * DAY, provider: 'stripe', trial_start: trialDays ? now : null, trial_end: trialDays ? now + trialDays * DAY : null, created_at: now, updated_at: now });
        e.webhooks.emit('billing_subscription.created', subView(e, row));
        if (trialDays) e.webhooks.emit('billing_trial.started', { object: 'billing_trial', subscription_id: row.id, trial_end: row.trial_end });
        return { status: 201, body: subView(e, row) };
      },
    },
    { method: 'GET', pattern: '/v1/billing/subscriptions', handler: (c) => listReply(c, st(c.engine).subs.filter((s) => (!c.query.get('subject_id') || s.subject_id === c.query.get('subject_id')) && (!c.query.get('status') || s.status === c.query.get('status'))), (s) => subView(c.engine, s)) },
    { method: 'GET', pattern: '/v1/billing/subscriptions/:id', handler: (c) => ({ body: subView(c.engine, subOf(c.engine, c.params.id)) }) },
    {
      // `days` xor `trial_end`; only a trialing subscription; 365 days from the trial start at most; idempotent on `idempotency_key`.
      method: 'POST',
      pattern: '/v1/billing/subscriptions/:id/extend_trial',
      handler: (c) => {
        const e = c.engine;
        const s = subOf(e, c.params.id);
        const key = c.body.idempotency_key;
        if (key !== undefined && (typeof key !== 'string' || !key || key.length > 200)) throw bad('idempotency_key must be a non-empty string of at most 200 characters.', 'idempotency_key');
        const cacheKey = key ? `${s.id}|${key}` : null;
        const seen = cacheKey ? st(e).extensions.get(cacheKey) : undefined;
        if (seen) return { body: subView(e, s) };
        if ((c.body.days === undefined) === (c.body.trial_end === undefined)) throw bad('Send days or trial_end, not both and not neither.', 'days');
        if (s.status !== 'trialing') throw new EmulatorError('CONFLICT', `Only a trialing subscription can be extended; this one is ${s.status}.`);
        const target = c.body.days !== undefined ? s.trial_end + intIn(c.body.days, 'days', 1, 365) * DAY : Number(c.body.trial_end);
        if (!Number.isFinite(target) || target <= s.trial_end) throw bad('The new trial end must be later than the current one.', 'trial_end');
        if (target - s.trial_start > MAX_TRIAL_MS) throw bad('A trial can last at most 365 days in total.', 'days');
        const before = s.trial_end;
        s.trial_end = target;
        s.current_period_end = Math.max(s.current_period_end, target);
        s.updated_at = e.clock.now();
        if (cacheKey) st(e).extensions.set(cacheKey, { at: s.updated_at });
        e.webhooks.emit('billing_trial.extended', { object: 'billing_trial', subscription_id: s.id, previous_trial_end: before, trial_end: target });
        return { body: subView(e, s) };
      },
    },
    // ── invoices and refunds ──
    {
      method: 'POST',
      pattern: '/__emulator/billing/invoices',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const sub = subject(e, c.body);
        const paid = intIn(c.body.amount_paid, 'amount_paid', 0, 100_000_000);
        const status = oneOf(c.body, 'status', ['draft', 'open', 'paid', 'void', 'uncollectible'], 'paid');
        const inv = st(e).invoices.insert({ subject_type: sub.type, subject_id: sub.id, subscription_id: c.body.subscription_id ?? liveSub(e, sub.type, sub.id)?.id ?? null, status, currency: c.body.currency ?? 'usd', amount_due: c.body.amount_due ?? paid, amount_paid: status === 'paid' ? paid : 0, amount_refunded: 0, provider: c.body.provider ?? 'stripe', created_at: e.clock.now() });
        return { status: 201, body: invoiceView(e, inv) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/billing/invoices',
      handler: (c) => {
        const q = (k: string) => c.query.get(k) ?? undefined;
        const rows = st(c.engine).invoices.all().filter((i) => (!q('subject_type') || i.subject_type === q('subject_type')) && (!q('subject_id') || i.subject_id === q('subject_id')) && (!q('status') || i.status === q('status')));
        return listReply(c, rows, (i) => invoiceView(c.engine, i));
      },
    },
    { method: 'GET', pattern: '/v1/billing/invoices/:id', handler: (c) => ({ body: invoiceView(c.engine, invoiceOf(c.engine, c.params.id)) }) },
    {
      // Partial or full. `idempotency_key` is required; the same key returns the same refund. Never refunds more than was paid.
      method: 'POST',
      pattern: '/v1/billing/invoices/:id/refund',
      handler: (c) => {
        const e = c.engine;
        const inv = invoiceOf(e, c.params.id);
        const key = c.body.idempotency_key;
        if (typeof key !== 'string' || !key || key.length > 200) throw bad('idempotency_key is required (a non-empty string of at most 200 characters).', 'idempotency_key');
        const seen = st(e).refunds.find((r) => r.invoice_id === inv.id && r.idempotency_key === key);
        if (seen) return { body: refundView(seen) };
        if (inv.provider !== 'stripe') throw bad(`The ${inv.provider} provider does not support refunds.`, 'provider');
        if (inv.status !== 'paid') throw new EmulatorError('CONFLICT', `Only a paid invoice can be refunded; this one is ${inv.status}.`);
        const room = inv.amount_paid - inv.amount_refunded;
        if (room <= 0) throw new EmulatorError('CONFLICT', 'This invoice is already fully refunded.');
        const amount = c.body.amount === undefined ? room : intIn(c.body.amount, 'amount', 1, room);
        if (c.body.reason !== undefined && (typeof c.body.reason !== 'string' || c.body.reason.length > 500)) throw bad('reason is text up to 500 characters.', 'reason');
        inv.amount_refunded += amount;
        const r = st(e).refunds.insert({ invoice_id: inv.id, amount, currency: inv.currency, reason: c.body.reason ?? null, idempotency_key: key, created_at: e.clock.now() });
        e.webhooks.emit('billing_refund.created', { ...refundView(r), subject_type: inv.subject_type, subject_id: inv.subject_id });
        return { status: 201, body: refundView(r) };
      },
    },
    // ── usage ──
    {
      method: 'POST',
      pattern: '/v1/billing/usage',
      handler: (c) => {
        const r = recordUsage(c.engine, c.body);
        return { body: usageView(r.row, r.duplicate) };
      },
    },
    {
      // Per-event idempotency and result; not all-or-nothing.
      method: 'POST',
      pattern: '/v1/billing/usage/batch',
      handler: (c) => {
        const events = c.body.events;
        if (!Array.isArray(events) || !events.length || events.length > BATCH_MAX) throw bad(`events is a list of 1 to ${BATCH_MAX} usage events.`, 'events');
        const results = events.map((ev: Obj, index: number): Obj => {
          try {
            if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw bad('Each event is an object.', `events[${index}]`);
            const r = recordUsage(c.engine, ev);
            return { index, status: r.duplicate ? 'duplicate' : 'recorded', id: r.row.id };
          } catch (err) {
            if (!(err instanceof EmulatorError)) throw err;
            return { index, status: 'error', error: { code: err.code, message: err.message, ...(err.param ? { param: err.param } : {}) } };
          }
        });
        const count = (s: string) => results.filter((r) => r.status === s).length;
        return { body: { object: 'billing_usage_batch', results, recorded: count('recorded'), duplicates: count('duplicate'), failed: count('error') } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/billing/usage',
      handler: (c) => {
        const e = c.engine;
        const sub = subject(e, { subject_type: c.query.get('subject_type'), subject_id: c.query.get('subject_id') });
        const feature = c.query.get('feature');
        const t = (k: string): number | undefined => {
          const v = c.query.get(k);
          if (v === null) return undefined;
          const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
          if (Number.isNaN(n)) throw bad(`${k} must be epoch milliseconds or an ISO 8601 time.`, k);
          return n;
        };
        let [since, until] = [t('since'), t('until')];
        const period = c.query.get('period');
        if (period !== null && period !== 'current') throw bad('period must be current.', 'period');
        if (period === 'current') ({ from: since, to: until } = windowOf(e, liveSub(e, sub.type, sub.id)));
        const rows = st(e).usage.all().filter((r) => r.subject_type === sub.type && r.subject_id === sub.id && (!feature || r.feature === feature) && (since === undefined || r.created_at >= since) && (until === undefined || r.created_at < until));
        const byFeature: Record<string, number> = {};
        for (const r of rows) byFeature[r.feature] = (byFeature[r.feature] ?? 0) + r.quantity;
        const body: Obj = { object: 'billing_usage_summary', subject_type: sub.type, subject_id: sub.id, since: since ?? null, until: until ?? null, total: rows.reduce((n, r) => n + r.quantity, 0), by_feature: byFeature };
        if (c.query.get('events') === 'true') {
          const page = paginate(rows, pageOf(c));
          Object.assign(body, { events: page.data.map((r) => usageView(r)), has_more: page.has_more, next_cursor: page.next_cursor });
        }
        return { body };
      },
    },
    // ── entitlement consume and refund ──
    {
      // Atlas-metered: limit = the plan's numeric limit (none or -1 = unlimited), window = subscription period else UTC month.
      method: 'POST',
      pattern: '/v1/entitlements/consume',
      handler: (c) => {
        const e = c.engine;
        const sub = subject(e, c.body);
        if (typeof c.body.feature !== 'string' || !c.body.feature) throw bad('feature is required.', 'feature');
        const key = c.body.key;
        if (typeof key !== 'string' || !key || key.length > 200) throw bad('key is required: an idempotency key of at most 200 characters.', 'key');
        const quantity = c.body.quantity === undefined ? 1 : c.body.quantity;
        if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) throw bad('quantity must be a positive number.', 'quantity');
        const cacheKey = `${sub.type}|${sub.id}|${c.body.feature}|${key}`;
        const seen = st(e).consumes.get(cacheKey);
        if (seen) return { body: consumeResult(e, { ...seen, duplicate: true }) };
        const live = liveSub(e, sub.type, sub.id);
        const feature = c.body.feature as string;
        const base = { subject_type: sub.type, subject_id: sub.id, feature, key, quantity };
        if (!live) {
          const out = { ...base, allowed: false, reason: 'no_subscription', limit: null, used: null, remaining: null, duplicate: false };
          return { body: consumeResult(e, out) };
        }
        const w = windowOf(e, live);
        const limit = planLimit(e, live.plan_id, feature);
        const before = used(e, sub.type, sub.id, feature, w);
        if (limit !== null && before + quantity > limit) {
          const out = { ...base, allowed: false, reason: 'limit_reached', limit, used: before, remaining: Math.max(0, limit - before), duplicate: false };
          return { body: consumeResult(e, out) };
        }
        st(e).usage.insert({ subject_type: sub.type, subject_id: sub.id, feature, quantity, source: 'consume', ref_key: key, subscription_id: live.id, created_at: e.clock.now() });
        const after = before + quantity;
        const out = { ...base, allowed: true, reason: null, limit, used: after, remaining: limit === null ? null : limit - after, duplicate: false };
        st(e).consumes.set(cacheKey, out);
        if (limit !== null && after >= limit) {
          const fired = `${cacheKey.split('|').slice(0, 3).join('|')}|${w.from}`;
          if (!st(e).limitFired.has(fired)) {
            st(e).limitFired.add(fired);
            e.webhooks.emit('entitlement.limit_reached', { object: 'entitlement_limit', subject_type: sub.type, subject_id: sub.id, feature, limit, used: after, window_start: w.from });
          }
        }
        return { body: consumeResult(e, out) };
      },
    },
    {
      // A negative row dated like the consume it undoes, so a refund never moves usage into another window.
      method: 'POST',
      pattern: '/v1/entitlements/consume/refund',
      handler: (c) => {
        const e = c.engine;
        const sub = subject(e, c.body);
        const feature = c.body.feature;
        const key = c.body.key;
        if (typeof feature !== 'string' || !feature) throw bad('feature is required.', 'feature');
        if (typeof key !== 'string' || !key) throw bad('key is required: the key of the consume to refund.', 'key');
        const orig = st(e).usage.find((r) => r.source === 'consume' && r.subject_type === sub.type && r.subject_id === sub.id && r.feature === feature && r.ref_key === key);
        if (!orig) throw notFound('Consume with that key');
        const refunded = st(e).usage.filter((r) => r.source === 'refund' && r.refund_of === orig.id).reduce((n, r) => n + -r.quantity, 0);
        if (c.body.quantity === undefined && orig.quantity - refunded <= 0) throw new EmulatorError('CONFLICT', 'This consume was already fully refunded.');
        const quantity = c.body.quantity === undefined ? orig.quantity - refunded : c.body.quantity;
        if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) throw bad('quantity must be a positive number.', 'quantity');
        const refundKey = typeof c.body.refund_key === 'string' && c.body.refund_key ? c.body.refund_key : null;
        if (refundKey) {
          const same = st(e).usage.find((r) => r.source === 'refund' && r.refund_of === orig.id && r.ref_key === refundKey);
          if (same) return { body: { object: 'entitlement_refund', key, feature, refunded: -same.quantity, duplicate: true } };
        }
        if (quantity > orig.quantity - refunded) throw new EmulatorError('CONFLICT', `Only ${orig.quantity - refunded} of this consume can still be refunded.`, 'quantity');
        st(e).usage.insert({ subject_type: sub.type, subject_id: sub.id, feature, quantity: -quantity, source: 'refund', ref_key: refundKey ?? `refund:${key}:${refunded}`, refund_of: orig.id, subscription_id: orig.subscription_id, created_at: orig.created_at });
        return { body: { object: 'entitlement_refund', key, feature, refunded: quantity, duplicate: false } };
      },
    },
    // ── coupons: the wider update (expiry, plan scope, first-time-only) ──
    {
      method: 'PATCH',
      pattern: '/v1/billing/coupons/:id',
      handler: (c: RouteContext) => {
        const e = c.engine;
        const t = e.generic.get('billing/coupons');
        const row = t?.get(c.params.id);
        if (!t || !row) throw notFound('Coupon');
        const b = c.body;
        const patch: Obj = {};
        if (b.name !== undefined) {
          if (typeof b.name !== 'string' || !b.name || b.name.length > 200) throw bad('name must be 1 to 200 characters.', 'name');
          patch.name = b.name;
        }
        if (b.expires_at !== undefined) {
          if (b.expires_at !== null && (!Number.isInteger(b.expires_at) || b.expires_at <= e.clock.now())) throw bad('expires_at must be a future time in epoch milliseconds, or null.', 'expires_at');
          patch.expires_at = b.expires_at;
        }
        if (b.plan_ids !== undefined) {
          if (!Array.isArray(b.plan_ids) || b.plan_ids.some((p: unknown) => typeof p !== 'string')) throw bad('plan_ids must be a list of plan ids.', 'plan_ids');
          const plans = e.generic.get('billing/plans');
          const unknown = plans && plans.size ? b.plan_ids.find((p: string) => !plans.get(p)) : undefined;
          if (unknown) throw bad(`Unknown plan ${unknown}.`, 'plan_ids');
          patch.plan_ids = b.plan_ids;
        }
        if (b.first_time_only !== undefined) {
          if (typeof b.first_time_only !== 'boolean') throw bad('first_time_only must be true or false.', 'first_time_only');
          patch.first_time_only = b.first_time_only;
        }
        if (b.max_redemptions !== undefined) {
          if (!Number.isInteger(b.max_redemptions) || b.max_redemptions < (row.times_redeemed ?? 0)) throw bad('max_redemptions must be a whole number not below the redemptions so far.', 'max_redemptions');
          patch.max_redemptions = b.max_redemptions;
        }
        t.update(row.id, { ...patch, updated_at: e.clock.now() } as any);
        const { _parent, ...out } = t.get(row.id) as Obj;
        return { body: out };
      },
    },
  ];
}
