/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, paginate } from '../store';
import { engineState, intIn, oneOf, sessionFromBearer } from './support';
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

interface Balance {
  granted: number | null;
  usage: number;
  unlimited: boolean;
}
interface Bill {
  subs: Table;
  invoices: Table;
  refunds: Table;
  usage: Table;
  extensions: Map<string, Obj>;
  consumes: Map<string, Obj>;
  balances: Map<string, Balance>;
  catalogue: Map<string, { features: string[]; limits: Obj }>;
  /** What the provider owes the customer (credit left over from a downgrade), minor units per `type|id`; applied to the next invoice. */
  customerBalance: Map<string, number>;
}
const st = engineState((e: Engine): Bill => ({ subs: new Table('billing_subscriptions', e.clock.now, 'sub'), invoices: new Table('billing_invoices', e.clock.now, 'in'), refunds: new Table('billing_refunds', e.clock.now, 're'), usage: new Table('billing_usage', e.clock.now, 'bu'), extensions: new Map(), consumes: new Map(), balances: new Map(), catalogue: new Map(), customerBalance: new Map() }));

const MONTH = 30 * DAY;
const PROVIDERS = ['stripe', 'polar', 'dodo', 'creem', 'chargebee', 'autumn', 'commet', 'paddle', 'lemonsqueezy', 'revenuecat', 'appstore', 'googleplay'] as const;
const ENT_PROVIDERS = new Set(['autumn', 'commet']); // providers that own feature balances
const SCHEDULING = new Set(['stripe', 'chargebee']); // providers that can schedule a plan change for the period end
const STORE_OWNED = new Set(['revenuecat', 'appstore', 'googleplay']); // the store owns change, cancel and restore: 422 unsupported
const NO_RESTORE = new Set(['creem', ...STORE_OWNED]);
const FEATURE = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_AMOUNT = 1_000_000_000;

const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);
/** The real mapping of a refused billing operation: 409 no_subscription / conflict, 422 unsupported, 400 invalid. */
const noSub = (m: string) => new EmulatorError('CONFLICT', m, undefined, { meta: { reason: 'no_subscription' } });
const conflict = (m: string, meta?: Obj) => new EmulatorError('CONFLICT', m, undefined, meta ? { meta } : {});
const unsupported = (m: string) => Object.assign(new EmulatorError('VALIDATION_FAILED', m, undefined, { meta: { reason: 'unsupported' } }), { status: 422 });
/** A body key outside `allowed` is refused (the real routes are strict). */
function known(body: Obj, allowed: string[]): void {
  const k = Object.keys(body ?? {}).find((x) => !allowed.includes(x));
  if (k) throw new EmulatorError('UNKNOWN_FIELD', `Unknown field: ${k}.`, k);
}

function subject(e: Engine, body: Obj): { type: string; id: string } {
  const type = oneOf(body, 'subject_type', SUBJECTS);
  const id = body.subject_id;
  if (typeof id !== 'string' || !id) throw bad('subject_id is required.', 'subject_id');
  const exists = type === 'user' ? e.db.users.get(id) && !e.db.users.get(id)!.deleted : e.db.organizations.get(id);
  if (!exists) throw new EmulatorError('NOT_FOUND', `${type === 'user' ? 'User' : 'Organization'} not found.`, 'subject_id');
  return { type, id };
}

const planOf = (e: Engine, id: string | undefined | null): Obj | undefined => (id ? e.generic.get('billing/plans')?.get(id) : undefined);
const subView = (e: Engine, s: Obj): Obj =>
  e.shape('Subscription', { object: 'billing_subscription', id: s.id, subject_type: s.subject_type, subject_id: s.subject_id, plan_id: s.plan_id, status: s.status, stripe_subscription_id: s.stripe_subscription_id ?? null, stripe_customer_id: s.stripe_customer_id ?? null, current_period_end: s.current_period_end, provider: s.provider, provider_subscription_id: s.stripe_subscription_id ?? null, provider_customer_id: s.stripe_customer_id ?? null, account: 'instance', interval: s.interval ?? 'month', quantity: s.quantity ?? 1, cancel_at_period_end: Boolean(s.cancel_at_period_end), scheduled_plan_id: s.scheduled_plan_id ?? null, scheduled_interval: s.scheduled_interval ?? null, scheduled_change_at: s.scheduled_change_at ?? null, trial_end: s.trial_end ?? null, canceled_at: s.canceled_at ?? null, entitlements: s.entitlements ?? null, created_at: s.created_at, updated_at: s.updated_at });

// ── events: the subscription payload, the trial and the entitlement transition ──
const moved = (r: Obj): Obj => ({ plan_id: r.plan_id, status: r.status, interval: r.interval ?? 'month', quantity: r.quantity ?? 1, cancel_at_period_end: Boolean(r.cancel_at_period_end), current_period_end: r.current_period_end, scheduled_plan_id: r.scheduled_plan_id ?? null });
function emitSub(e: Engine, type: string, s: Obj, prev: Obj | null, reason?: string, extra: Obj = {}): void {
  e.webhooks.emit(type, { ...subView(e, s), plan: planOf(e, s.plan_id)?.slug ?? null, ...(reason ? { reason } : {}), ...extra, previous: prev ? moved(prev) : null });
}
interface EntSnap {
  planId: string;
  plan: string | null;
  status: string;
  features: string[];
  limits: Obj;
}
/** What a subject is entitled to now: its live (active or trialing) subscriptions merged; undefined when none. */
function entSnap(e: Engine, type: string, id: string): EntSnap | undefined {
  const live = st(e).subs.filter((s) => s.subject_type === type && s.subject_id === id && (s.status === 'active' || s.status === 'trialing'));
  if (!live.length) return undefined;
  const primary = live.find((s) => planOf(e, s.plan_id)?.kind !== 'addon') ?? live[0]!;
  const features = new Set<string>();
  const limits: Obj = {};
  for (const s of live) {
    const p = planOf(e, s.plan_id);
    for (const f of Array.isArray(p?.features) ? p!.features : []) features.add(f);
    for (const [k, v] of Object.entries((p?.limits ?? {}) as Obj)) limits[k] = typeof v === 'number' && typeof limits[k] === 'number' ? Math.max(limits[k], v) : (limits[k] ?? v);
  }
  return { planId: primary.plan_id, plan: planOf(e, primary.plan_id)?.slug ?? null, status: primary.status, features: [...features], limits };
}
const entSig = (x: EntSnap | undefined): string => (x ? JSON.stringify({ p: x.planId, f: [...x.features].sort(), l: Object.entries(x.limits).sort(([a], [b]) => (a < b ? -1 : 1)) }) : 'none');
/** entitlement.created / updated / deleted, only when the resolved entitlement moved. */
function emitEnt(e: Engine, type: string, id: string, before: EntSnap | undefined): void {
  const after = entSnap(e, type, id);
  if (entSig(before) === entSig(after)) return;
  const v = (x: EntSnap | undefined): Obj => ({ plan_id: x?.planId ?? null, plan: x?.plan ?? null, status: x?.status ?? null, entitled: Boolean(x), features: x?.features ?? [] });
  e.webhooks.emit(!before && after ? 'entitlement.created' : before && !after ? 'entitlement.deleted' : 'entitlement.updated', { object: 'entitlement', subject_type: type, subject_id: id, ...v(after), previous: v(before) });
}

// ── prices and invoices of a renewal or plan change ──
/** shortcut: a plan's `amount` is display text ("$9.00"); its digits read as major units, 0 when absent. */
function priceCents(plan: Obj | undefined, interval: string): number {
  const raw = interval === 'year' && plan?.interval !== 'year' ? plan?.annual_amount : plan?.amount;
  const n = parseFloat(String(raw ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const periodLen = (interval: string | undefined): number => (interval === 'year' ? 365 * DAY : MONTH);
/** One invoice line: a renewal charge, or a proration (a credit for unused time is negative). */
interface Line {
  description: string;
  amount: number;
  quantity: number;
  proration: boolean;
  plan_id: string | null;
  period_start: number;
  period_end: number;
}
const lineView = (currency: string, l: Line): Obj => ({ object: 'billing_invoice_line', description: l.description, amount: l.amount, currency, quantity: l.quantity, proration: l.proration, plan_id: l.plan_id, period: { start: l.period_start, end: l.period_end } });
const balKey2 = (s: Obj): string => `${s.subject_type}|${s.subject_id}`;
const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
/** The invoice the subscription's next billing would produce: renewal at the plan's price plus the proration items waiting, less customer balance. */
function draft(e: Engine, s: Obj, at: number): { lines: Line[]; total: number; applied: number; due: number; currency: string } {
  const plan = planOf(e, s.plan_id);
  const price = priceCents(plan, s.interval ?? 'month') * (s.quantity ?? 1);
  const lines: Line[] = [];
  if (price > 0) lines.push({ description: `${plan?.name ?? s.plan_id} (${s.interval ?? 'month'}ly)`, amount: price, quantity: s.quantity ?? 1, proration: false, plan_id: s.plan_id, period_start: at, period_end: at + periodLen(s.interval) });
  lines.push(...((s.pending_lines ?? []) as Line[]));
  const total = lines.reduce((n, l) => n + l.amount, 0);
  const applied = Math.min(Math.max(total, 0), st(e).customerBalance.get(balKey2(s)) ?? 0);
  return { lines, total, applied, due: Math.max(total, 0) - applied, currency: plan?.currency || 'usd' };
}
/**
 * An invoice for the plan's price plus the proration items waiting from earlier plan changes. A negative total (a downgrade)
 * is not paid out: it becomes customer balance and reduces the next invoice, as Stripe does. Open, with a payment_failed
 * event, when the subscription's payment is set to fail and something is due; no invoice when there is nothing to bill.
 */
function bill(e: Engine, s: Obj, at: number): boolean {
  if (!(s.pending_lines?.length) && priceCents(planOf(e, s.plan_id), s.interval ?? 'month') <= 0) return true;
  const d = draft(e, s, at);
  s.pending_lines = [];
  const key = balKey2(s);
  const balance = st(e).customerBalance;
  const fail = Boolean(s.payment_failing) && d.due > 0;
  const lines = [...d.lines];
  if (d.total < 0) balance.set(key, (balance.get(key) ?? 0) - d.total);
  else if (d.applied > 0 && !fail) balance.set(key, (balance.get(key) ?? 0) - d.applied);
  if (d.applied > 0) lines.push({ description: 'Applied customer balance', amount: -d.applied, quantity: 1, proration: false, plan_id: null, period_start: at, period_end: at });
  const due = d.due;
  const inv = st(e).invoices.insert({ subject_type: s.subject_type, subject_id: s.subject_id, subscription_id: s.id, status: fail ? 'open' : 'paid', currency: d.currency, amount_due: due, amount_paid: fail ? 0 : due, amount_refunded: 0, provider: s.provider, lines, created_at: at });
  if (fail) e.webhooks.emit('billing_invoice.payment_failed', invoiceView(e, inv));
  return !fail;
}

/**
 * The period lifecycle, applied lazily on every billing read and write so advancing the clock does the work: a trial that
 * has ended becomes active (past_due when the subscription's payment is set to fail), and each passed period end either
 * ends a subscription set to cancel, applies a scheduled plan change, or renews for another period; each billable event
 * gets an invoice.
 */
function settle(e: Engine): void {
  for (const s of st(e).subs.all()) {
    if (s.external) continue; // a webhook-driven subscription is moved by its provider, never by the clock
    for (let guard = 0; guard < 1200 && (s.status === 'trialing' || s.status === 'active'); guard++) {
      const now = e.clock.now();
      const before = entSnap(e, s.subject_type, s.subject_id);
      const prev = { ...s };
      if (s.status === 'trialing') {
        if (!s.will_end_sent && s.trial_end - 3 * DAY <= now) {
          s.will_end_sent = true;
          emitSub(e, 'billing_trial.will_end', s, null);
        }
        if (s.trial_end > now) break;
        s.updated_at = s.trial_end;
        if (s.cancel_at_period_end) {
          s.status = 'canceled';
          clearSchedule(s);
          emitSub(e, 'billing_subscription.canceled', s, prev);
        } else {
          s.status = s.payment_failing && priceCents(planOf(e, s.plan_id), s.interval ?? 'month') > 0 ? 'past_due' : 'active';
          s.current_period_end = s.trial_end + periodLen(s.interval);
          bill(e, s, s.trial_end);
        }
        emitSub(e, 'billing_trial.ended', s, prev, undefined, { converted: s.status === 'active' });
      } else {
        if (s.current_period_end > now) break;
        const at = s.current_period_end;
        s.updated_at = at;
        if (s.cancel_at_period_end) {
          s.status = 'canceled';
          clearSchedule(s);
          emitSub(e, 'billing_subscription.canceled', s, prev);
        } else {
          const reason = s.scheduled_plan_id ? 'plan_change_applied' : 'renewed';
          if (s.scheduled_plan_id) Object.assign(s, { plan_id: s.scheduled_plan_id, interval: s.scheduled_interval ?? s.interval, scheduled_plan_id: null, scheduled_interval: null, scheduled_change_at: null });
          s.current_period_end = at + periodLen(s.interval);
          if (!bill(e, s, at)) s.status = 'past_due';
          if (reason === 'plan_change_applied' || s.status !== 'active') emitSub(e, 'billing_subscription.updated', s, prev, reason);
        }
      }
      emitEnt(e, s.subject_type, s.subject_id, before);
    }
  }
}

/** The live subscription of a subject (trialing or active), newest first. */
const liveSub = (e: Engine, type: string, id: string): Obj | undefined => st(e).subs.find((s) => s.subject_type === type && s.subject_id === id && (s.status === 'active' || s.status === 'trialing'));

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

const LIVE = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
const invalid = (m: string) => new EmulatorError('VALIDATION_FAILED', m);
const clearSchedule = (s: Obj): void => void Object.assign(s, { scheduled_plan_id: null, scheduled_interval: null, scheduled_change_at: null });

/** Move a live subscription to another plan and/or interval, now or at the period end. Returns whether it was scheduled. */
function changePlan(e: Engine, s: Obj, plan: Obj, interval: string | undefined, atEnd: boolean): boolean {
  const next = interval ?? s.interval ?? 'month';
  if (!LIVE.has(s.status)) throw noSub('There is no live subscription to change. Start a checkout instead.');
  if (STORE_OWNED.has(s.provider)) throw unsupported(`${s.provider} subscriptions are changed in the store, not through Atlas.`);
  if ((plan.provider ?? s.provider) !== s.provider) throw invalid('That plan is sold through a different payment provider than this subscription.');
  if (plan.audience && plan.audience !== s.subject_type) throw invalid(`That plan is for a ${plan.audience} subject.`);
  const cur = planOf(e, s.plan_id);
  if (cur && (cur.kind === 'addon') !== (plan.kind === 'addon')) throw invalid(plan.kind === 'addon' ? 'That is an add-on plan: buy it with a checkout alongside this subscription.' : 'This subscription is an add-on; it can only move to another add-on plan.');
  if (plan.id === s.plan_id && next === (s.interval ?? 'month') && !s.scheduled_plan_id) throw conflict('The subscription is already on that plan.');
  if (next === 'year' && plan.interval !== 'year' && plan.amount !== undefined && plan.amount !== null && !plan.annual_amount && !plan.annual_price_id) throw invalid('This plan has no annual price.');
  if (atEnd && !SCHEDULING.has(s.provider)) throw unsupported(`${s.provider} cannot schedule a plan change for the period end.`);
  // shortcut: a plan needs no provider price reference here (the real route refuses a free plan with none).
  const before = entSnap(e, s.subject_type, s.subject_id);
  const prev = { ...s };
  const now = e.clock.now();
  s.updated_at = now;
  if (atEnd) {
    Object.assign(s, { scheduled_plan_id: plan.id, scheduled_interval: next, scheduled_change_at: s.current_period_end });
    emitSub(e, 'billing_subscription.updated', s, prev, 'plan_change_scheduled');
    return true;
  }
  // Proration as the provider does it (`create_prorations`): the unused part of the old plan is credited and the remaining part of the
  // new plan charged, as items waiting for the next invoice. An interval change resets the billing cycle: a new period starts now and
  // is invoiced now (renewal at the new price plus the unused-time credit). A trial is not prorated and not invoiced.
  const oldInterval = s.interval ?? 'month';
  const trialing = s.status === 'trialing';
  const qty = s.quantity ?? 1;
  const end = s.current_period_end as number;
  const frac = trialing ? 0 : Math.max(0, Math.min(1, (end - now) / periodLen(oldInterval)));
  const items: Line[] = [];
  if (frac > 0) {
    const unused = Math.round(priceCents(cur, oldInterval) * qty * frac);
    if (unused > 0) items.push({ description: `Unused time on ${cur?.name ?? s.plan_id} after ${day(now)}`, amount: -unused, quantity: qty, proration: true, plan_id: s.plan_id, period_start: now, period_end: end });
    if (next === oldInterval) {
      const remaining = Math.round(priceCents(plan, next) * qty * frac);
      if (remaining > 0) items.push({ description: `Remaining time on ${plan.name ?? plan.id} after ${day(now)}`, amount: remaining, quantity: qty, proration: true, plan_id: plan.id, period_start: now, period_end: end });
    }
  }
  Object.assign(s, { plan_id: plan.id, interval: next, pending_lines: [...(s.pending_lines ?? []), ...items] });
  clearSchedule(s);
  if (!trialing && next !== oldInterval) {
    s.current_period_end = now + periodLen(next);
    bill(e, s, now);
  }
  emitSub(e, 'billing_subscription.updated', s, prev);
  emitEnt(e, s.subject_type, s.subject_id, before);
  return false;
}

/** Cancel at the period end (default) or immediately; a pending scheduled change is released. */
function cancelSub(e: Engine, s: Obj, immediately: boolean): void {
  if (!LIVE.has(s.status)) throw noSub('There is no live subscription to cancel.');
  if (STORE_OWNED.has(s.provider)) throw unsupported(`${s.provider} subscriptions are canceled in the store, not through Atlas.`);
  if (!immediately && s.cancel_at_period_end) throw conflict('The subscription is already set to cancel at the period end.');
  const before = entSnap(e, s.subject_type, s.subject_id);
  const prev = { ...s };
  const now = e.clock.now();
  clearSchedule(s);
  Object.assign(s, { canceled_at: now, updated_at: now, cancel_at_period_end: !immediately });
  if (immediately) {
    s.status = 'canceled';
    emitSub(e, 'billing_subscription.canceled', s, prev);
    if (prev.status === 'trialing') emitSub(e, 'billing_trial.ended', s, prev, undefined, { converted: false });
  } else emitSub(e, 'billing_subscription.updated', s, prev);
  emitEnt(e, s.subject_type, s.subject_id, before);
}

/** Undo a cancellation scheduled for the period end. */
function restoreSub(e: Engine, s: Obj): void {
  if (s.status === 'canceled') throw noSub('An ended subscription cannot be restored. Start a new checkout.');
  if (!s.cancel_at_period_end) throw conflict('The subscription is not set to cancel.');
  if (NO_RESTORE.has(s.provider)) throw unsupported(`${s.provider} cannot restore a canceled subscription.`);
  const prev = { ...s };
  Object.assign(s, { cancel_at_period_end: false, canceled_at: null, updated_at: e.clock.now() });
  emitSub(e, 'billing_subscription.updated', s, prev);
}

/** The body of a change, validated as the real routes do. */
function changeInput(e: Engine, body: Obj): { plan: Obj; interval: string | undefined } {
  if (typeof body.plan_id !== 'string' || !body.plan_id.trim()) throw bad('A plan_id is required.', 'plan_id');
  const plan = planOf(e, body.plan_id.trim());
  if (!plan) throw notFound('Billing plan'); // shortcut: a plan row's `active` is not enforced here, a generic-created plan starts inactive
  if (body.interval !== undefined && body.interval !== null && body.interval !== 'month' && body.interval !== 'year') throw bad('interval must be month or year.', 'interval');
  return { plan, interval: body.interval ?? undefined };
}

/** The subscription that owns a subject's feature balances: a live one on an entitlement provider. */
const providerOwner = (e: Engine, type: string, id: string): Obj | undefined => st(e).subs.find((s) => s.subject_type === type && s.subject_id === id && (s.status === 'active' || s.status === 'trialing') && ENT_PROVIDERS.has(s.provider));
const balKey = (type: string, id: string, feature: string): string => `${type}|${id}|${feature}`;
const balView = (k: string, b: Balance): Obj => {
  const [subject_type, subject_id, feature] = k.split('|');
  return { object: 'emulator_provider_balance', subject_type, subject_id, feature, granted: b.granted, usage: b.usage, remaining: b.unlimited || b.granted === null ? null : Math.max(0, b.granted - b.usage), unlimited: b.unlimited };
};
const featureOf = (raw: unknown): string => {
  if (typeof raw !== 'string' || !FEATURE.test(raw)) throw bad('feature must be a feature key (letters, digits, "_", ".", ":" or "-", at most 100).', 'feature');
  return raw;
};
const keyOf = (raw: unknown, field: string): string => {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 200) throw bad(`${field} is required (at most 200 characters).`, field);
  return raw.trim();
};
const amountOf = (raw: unknown, fallback: number | null): number | null => {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_AMOUNT) throw bad(`amount must be a whole number from 1 to ${MAX_AMOUNT}.`, 'amount');
  return raw;
};

interface Consumed {
  allowed: boolean;
  reason: 'not_entitled' | 'limit_reached' | null;
  source: 'atlas' | 'provider';
  provider: string | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unlimited: boolean;
  replayed: boolean;
  window_start: number;
}
const consumeBody = (feature: string, amount: number, r: Consumed): Obj => ({ object: 'entitlement_consumption', allowed: r.allowed, reason: r.reason, feature, amount, source: r.source, provider: r.provider, used: r.used, limit: r.limit, remaining: r.remaining, unlimited: r.unlimited, replayed: r.replayed, window_start: r.window_start });

/** Spend units. The provider that owns the subject's balance (if any) decides; otherwise Atlas counts against the plan limit. */
function consume(e: Engine, body: Obj): Obj {
  const sub = subject(e, body);
  const feature = featureOf(body.feature);
  const amount = amountOf(body.amount ?? body.quantity, 1)!;
  const key = keyOf(body.idempotency_key ?? body.key, 'idempotency_key'); // `key` and `quantity` are the older spellings
  const s = st(e);
  const live = liveSub(e, sub.type, sub.id);
  const window_start = windowOf(e, live).from;
  const prior = s.usage.find((r) => r.source === 'consume' && r.subject_type === sub.type && r.subject_id === sub.id && r.ref_key === key);
  if (prior && (prior.feature !== feature || prior.quantity !== amount)) throw new EmulatorError('IDEMPOTENCY_CONFLICT', 'That idempotency_key was already used for a different consume.');
  const owner = providerOwner(e, sub.type, sub.id);
  const base = { source: 'atlas' as const, provider: null, used: null, limit: null, remaining: null, unlimited: false, replayed: false, window_start };
  if (owner) {
    const own = { ...base, source: 'provider' as const, provider: owner.provider as string };
    if (prior) return consumeBody(feature, amount, { ...own, allowed: true, reason: null, replayed: true });
    const bal = s.balances.get(balKey(sub.type, sub.id, feature));
    if (!bal) return consumeBody(feature, amount, { ...own, allowed: false, reason: 'not_entitled' });
    const room = bal.unlimited ? Infinity : (bal.granted ?? 0) - bal.usage;
    const view = (): Consumed => ({ ...own, allowed: true, reason: null, used: bal.usage, limit: bal.granted, remaining: bal.unlimited ? null : Math.max(0, (bal.granted ?? 0) - bal.usage), unlimited: bal.unlimited });
    if (amount > room) return consumeBody(feature, amount, { ...view(), allowed: false, reason: 'limit_reached' });
    bal.usage += amount; // the provider's own balance moves; the ledger keeps the read-back
    s.usage.insert({ subject_type: sub.type, subject_id: sub.id, feature, quantity: amount, source: 'consume', ref_key: key, subscription_id: owner.id, created_at: e.clock.now() });
    const out = view();
    if (!bal.unlimited && out.remaining === 0) e.webhooks.emit('entitlement.limit_reached', { object: 'entitlement_limit', subject_type: sub.type, subject_id: sub.id, feature, limit: out.limit, used: out.used, source: 'provider', window_start });
    return consumeBody(feature, amount, out);
  }
  const cacheKey = `${sub.type}|${sub.id}|${key}`;
  const seen = s.consumes.get(cacheKey);
  if (prior && seen) return consumeBody(feature, amount, { ...seen.out, replayed: true });
  const ent = entSnap(e, sub.type, sub.id);
  const plan = live ? planOf(e, live.plan_id) : undefined;
  // a subscription whose plan the catalogue does not know grants everything (fixtures often import against a made-up plan id)
  if (!ent || (plan && !ent.features.includes(feature) && !(feature in ent.limits))) return consumeBody(feature, amount, { ...base, allowed: false, reason: 'not_entitled' });
  const raw = ent.limits[feature];
  const unlimited = typeof raw !== 'number' || raw < 0;
  const limit = unlimited ? null : (raw as number);
  const w = windowOf(e, live);
  const before = used(e, sub.type, sub.id, feature, w);
  if (limit !== null && before + amount > limit) return consumeBody(feature, amount, { ...base, allowed: false, reason: 'limit_reached', limit, used: before, remaining: Math.max(0, limit - before) });
  s.usage.insert({ subject_type: sub.type, subject_id: sub.id, feature, quantity: amount, source: 'consume', ref_key: key, subscription_id: live!.id, created_at: e.clock.now() });
  const after = before + amount;
  const out: Consumed = { ...base, allowed: true, reason: null, used: after, limit, remaining: limit === null ? null : Math.max(0, limit - after), unlimited };
  s.consumes.set(cacheKey, { out });
  if (limit !== null && after >= limit && before < limit) e.webhooks.emit('entitlement.limit_reached', { object: 'entitlement_limit', subject_type: sub.type, subject_id: sub.id, feature, limit, used: after, source: 'atlas', window_start });
  return consumeBody(feature, amount, out);
}

/** Give back part or all of an Atlas-counted consume; a negative ledger row dated like the consume, so no refund crosses a window. */
function refundConsume(e: Engine, body: Obj): Obj {
  const sub = subject(e, body);
  const feature = featureOf(body.feature);
  const modern = body.consume_idempotency_key !== undefined;
  const consumeKey = keyOf(body.consume_idempotency_key ?? body.key, 'consume_idempotency_key');
  const refundKey = modern || body.idempotency_key !== undefined ? keyOf(body.idempotency_key, 'idempotency_key') : typeof body.refund_key === 'string' && body.refund_key ? body.refund_key : null;
  const requested = amountOf(body.amount ?? body.quantity, null);
  if (providerOwner(e, sub.type, sub.id)) throw unsupported("This subject's balances are held by its billing provider; give units back there.");
  const s = st(e);
  const orig = s.usage.find((r) => r.source === 'consume' && r.subject_type === sub.type && r.subject_id === sub.id && r.feature === feature && r.ref_key === consumeKey);
  if (refundKey) {
    const other = s.usage.find((r) => r.source === 'refund' && r.subject_type === sub.type && r.subject_id === sub.id && r.ref_key === refundKey);
    if (other && other.refund_of !== orig?.id) throw new EmulatorError('IDEMPOTENCY_CONFLICT', 'That idempotency_key was already used for a different refund.');
  }
  if (!orig) throw new EmulatorError('NOT_FOUND', 'No consume with that key for this subject and feature.');
  const w = windowOf(e, liveSub(e, sub.type, sub.id));
  const reply = (refunded: number, replayed: boolean): Obj => ({ object: 'entitlement_consume_refund', refunded, feature, used: used(e, sub.type, sub.id, feature, w), replayed });
  if (refundKey) {
    const same = s.usage.find((r) => r.source === 'refund' && r.refund_of === orig.id && r.ref_key === refundKey);
    if (same) return reply(-same.quantity, true);
  }
  const refunded = s.usage.filter((r) => r.source === 'refund' && r.refund_of === orig.id).reduce((n, r) => n + -r.quantity, 0);
  const refundable = orig.quantity - refunded;
  if (refundable <= 0 && requested === null) throw conflict('This consume was already fully refunded.', { refundable: 0 });
  const quantity = requested ?? refundable;
  if (quantity > refundable) throw conflict('That is more than the consume still has outstanding.', { refundable });
  s.usage.insert({ subject_type: sub.type, subject_id: sub.id, feature, quantity: -quantity, source: 'refund', ref_key: refundKey ?? `refund:${consumeKey}:${refunded}`, refund_of: orig.id, subscription_id: orig.subscription_id, created_at: orig.created_at });
  return reply(quantity, false);
}

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
  const routes: RouteDef[] = [
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
        const plan = planOf(e, c.body.plan_id);
        const provider = oneOf(c.body, 'provider', PROVIDERS, (PROVIDERS as readonly string[]).includes(plan?.provider) ? plan!.provider : 'stripe');
        const interval = oneOf(c.body, 'interval', ['month', 'year'], 'month');
        const now = e.clock.now();
        const cat = ENT_PROVIDERS.has(provider) ? st(e).catalogue.get(`${provider}|${plan?.provider_price_id || plan?.stripe_price_id || ''}`) : undefined;
        const before = entSnap(e, sub.type, sub.id);
        const row = st(e).subs.insert({ subject_type: sub.type, subject_id: sub.id, plan_id: c.body.plan_id, status: trialDays ? 'trialing' : 'active', stripe_subscription_id: c.body.stripe_subscription_id ?? null, stripe_customer_id: c.body.stripe_customer_id ?? null, current_period_end: now + periodLen(interval), provider, interval, quantity: 1, cancel_at_period_end: false, canceled_at: null, scheduled_plan_id: null, scheduled_interval: null, scheduled_change_at: null, payment_failing: c.body.payment_failing === true, entitlements: cat ? { features: cat.features, limits: cat.limits } : null, trial_start: trialDays ? now : null, trial_end: trialDays ? now + trialDays * DAY : null, created_at: now, updated_at: now });
        emitSub(e, 'billing_subscription.created', row, null);
        if (trialDays) e.webhooks.emit('billing_trial.started', { object: 'billing_trial', subscription_id: row.id, trial_end: row.trial_end });
        emitEnt(e, sub.type, sub.id, before);
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
        s.will_end_sent = false;
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
    { method: 'POST', pattern: '/v1/entitlements/consume', handler: (c) => ({ body: consume(c.engine, c.body) }) },
    { method: 'POST', pattern: '/v1/entitlements/consume/refund', handler: (c) => ({ body: refundConsume(c.engine, c.body) }) },
    // ── change, cancel, restore ──
    {
      method: 'POST',
      pattern: '/v1/billing/subscriptions/:id/change',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        known(c.body, ['plan_id', 'interval', 'schedule_at_period_end']);
        const s = subOf(e, c.params.id);
        const { plan, interval } = changeInput(e, c.body);
        const scheduled = changePlan(e, s, plan, interval, c.body.schedule_at_period_end === true);
        return { body: { ...subView(e, s), scheduled } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/billing/subscriptions/:id/cancel',
      scope: 'billing:write',
      handler: (c) => {
        known(c.body, ['immediately']);
        const s = subOf(c.engine, c.params.id);
        cancelSub(c.engine, s, c.body.immediately === true);
        return { body: subView(c.engine, s) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/billing/subscriptions/:id/restore',
      scope: 'billing:write',
      handler: (c) => {
        const s = subOf(c.engine, c.params.id);
        restoreSub(c.engine, s);
        return { body: subView(c.engine, s) };
      },
    },
    // ── the signed-in user's own routes (client side): the subject is the user, or an organization they administer ──
    ...(['change', 'cancel', 'restore'] as const).flatMap((op): RouteDef[] =>
      (['/v1/client/billing/subscription/' + op, '/v1/client/billing/subscriptions/:id/' + op] as const).map((pattern) => ({
        method: 'POST',
        pattern,
        public: true,
        handler: async (c: RouteContext) => {
          const e = c.engine;
          const { userId } = await sessionFromBearer(c);
          known(c.body, ['org_id', 'subscription_id', ...(op === 'change' ? ['plan_id', 'interval', 'schedule_at_period_end'] : op === 'cancel' ? ['immediately'] : [])]);
          const orgId = c.body.org_id;
          if (orgId !== undefined && typeof orgId !== 'string') throw bad('org_id must be a string.', 'org_id');
          const type = orgId ? 'org' : 'user';
          const id = orgId ?? userId;
          if (orgId) {
            // a non-member gets a 404, never a 403 (no membership oracle); only an organization admin manages billing
            const m = e.db.memberships.find((x) => x.organization_id === orgId && x.user_id === userId);
            if (!m) throw notFound('Organization');
            if (m.role !== 'org:admin') throw new EmulatorError('FORBIDDEN', 'Only an organization-wide admin can manage its billing.');
          }
          const named = c.params.id ?? c.body.subscription_id;
          const mine = st(e).subs.filter((x) => x.subject_type === type && x.subject_id === id);
          let s: Obj | undefined;
          if (named !== undefined) {
            if (typeof named !== 'string' || !named) throw bad('subscription_id must be a string.', 'subscription_id');
            s = mine.find((x) => x.id === named);
            if (!s) throw notFound('Subscription');
          } else s = mine.find((x) => LIVE.has(x.status) && planOf(e, x.plan_id)?.kind !== 'addon') ?? mine.find((x) => LIVE.has(x.status)) ?? mine[0];
          if (!s) throw noSub('There is no subscription to manage. Start a checkout instead.');
          let scheduled: boolean | undefined;
          if (op === 'change') {
            const { plan, interval } = changeInput(e, c.body);
            scheduled = changePlan(e, s, plan, interval, c.body.schedule_at_period_end === true);
          } else if (op === 'cancel') cancelSub(e, s, c.body.immediately === true);
          else restoreSub(e, s);
          const plan = planOf(e, s.plan_id);
          const { _parent, ...pub } = (plan ?? {}) as Obj;
          return { body: { object: 'billing_subscription', id: s.id, subject_type: s.subject_type, subject_id: s.subject_id, status: s.status, plan: plan ? pub : null, current_period_end: s.current_period_end, provider: s.provider, interval: s.interval ?? 'month', quantity: s.quantity ?? 1, cancel_at_period_end: Boolean(s.cancel_at_period_end), scheduled_plan_id: s.scheduled_plan_id ?? null, scheduled_interval: s.scheduled_interval ?? null, scheduled_change_at: s.scheduled_change_at ?? null, trial_end: s.trial_end ?? null, canceled_at: s.canceled_at ?? null, ...(scheduled === undefined ? {} : { scheduled }) } };
        },
      })),
    ),
    // ── plans owned by an entitlement provider: mirror the provider's features and limits ──
    {
      method: 'POST',
      pattern: '/v1/billing/plans/:id/sync_entitlements',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        const plan = planOf(e, c.params.id);
        if (!plan) throw notFound('Billing plan');
        const provider = String(plan.provider ?? 'stripe');
        if (!ENT_PROVIDERS.has(provider)) throw unsupported(`${provider} plans carry no feature definitions to sync; set features and limits on the plan.`);
        const ref = plan.provider_price_id || plan.stripe_price_id;
        if (typeof ref !== 'string' || !ref) throw invalid('A free plan has no provider plan to sync from.');
        const cat = st(e).catalogue.get(`${provider}|${ref}`);
        if (!cat) throw new EmulatorError('NOT_FOUND', `The ${provider} catalogue has no plan ${ref}. Set it with PUT /__emulator/billing/provider_catalogue.`);
        const table = e.generic.get('billing/plans')!;
        const before = [...st(e).subs.filter((x) => x.plan_id === plan.id && (x.status === 'active' || x.status === 'trialing'))].map((x) => ({ x, snap: entSnap(e, x.subject_type, x.subject_id) }));
        table.update(plan.id, { features: [...cat.features], limits: { ...cat.limits }, updated_at: e.clock.now() } as any);
        for (const { x, snap } of before) emitEnt(e, x.subject_type, x.subject_id, snap);
        const { _parent, ...out } = table.get(plan.id) as Obj;
        return { body: out };
      },
    },
    // ── emulator controls: what an entitlement provider holds ──
    {
      // PUT sets one balance of a subject's feature on the provider that owns its subscription (autumn or commet).
      method: 'PUT',
      pattern: '/__emulator/billing/provider_balances',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const sub = subject(e, c.body);
        const feature = featureOf(c.body.feature);
        const unlimited = c.body.unlimited === true;
        const granted = c.body.granted === undefined || c.body.granted === null ? null : intIn(c.body.granted, 'granted', 0, 1_000_000_000_000);
        if (!unlimited && granted === null) throw bad('Send granted (a whole number) or unlimited: true.', 'granted');
        const k = balKey(sub.type, sub.id, feature);
        const usage = c.body.usage === undefined ? (st(e).balances.get(k)?.usage ?? 0) : intIn(c.body.usage, 'usage', 0, 1_000_000_000_000);
        const b: Balance = { granted, usage, unlimited };
        st(e).balances.set(k, b);
        return { body: balView(k, b) };
      },
    },
    {
      method: 'GET',
      pattern: '/__emulator/billing/provider_balances',
      public: true,
      handler: (c) => {
        const q = (n: string) => c.query.get(n);
        const data = [...st(c.engine).balances].filter(([k]) => { const [t, i, f] = k.split('|'); return (!q('subject_type') || t === q('subject_type')) && (!q('subject_id') || i === q('subject_id')) && (!q('feature') || f === q('feature')); }).map(([k, b]) => balView(k, b));
        return { body: { object: 'list', data, has_more: false } };
      },
    },
    {
      // PUT sets the features and limits an entitlement provider reports for a plan reference; `sync_entitlements` mirrors them.
      method: 'PUT',
      pattern: '/__emulator/billing/provider_catalogue',
      public: true,
      handler: (c) => {
        const provider = oneOf(c.body, 'provider', ['autumn', 'commet']);
        if (typeof c.body.price_ref !== 'string' || !c.body.price_ref) throw bad('price_ref is required (the plan reference on the provider).', 'price_ref');
        const features = c.body.features ?? [];
        const limits = c.body.limits ?? {};
        if (!Array.isArray(features) || features.some((f: unknown) => typeof f !== 'string')) throw bad('features must be a list of strings.', 'features');
        if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.values(limits).some((v) => typeof v !== 'number')) throw bad('limits must be an object of numbers.', 'limits');
        st(c.engine).catalogue.set(`${provider}|${c.body.price_ref}`, { features, limits });
        return { body: { object: 'emulator_provider_plan', provider, price_ref: c.body.price_ref, features, limits } };
      },
    },
    {
      method: 'GET',
      pattern: '/__emulator/billing/provider_catalogue',
      public: true,
      handler: (c) => ({ body: { object: 'list', data: [...st(c.engine).catalogue].map(([k, v]) => ({ object: 'emulator_provider_plan', provider: k.split('|')[0], price_ref: k.slice(k.indexOf('|') + 1), ...v })), has_more: false } }),
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
  // every billing read and write first lets the clock catch the subscriptions up
  return routes.map((r) => ({ ...r, handler: (c: RouteContext) => (settle(c.engine), r.handler(c)) }));
}

/** The state and helpers the provider-webhook, store-link, Connect and referral-reward routes (emu4-billing.ts) share with this module. */
export const billingInternals = { st, planOf, subView, emitSub, emitEnt, entSnap, settle, liveSub, invoiceView, draft, lineView, balKey2, day, DAY, MONTH, periodLen, priceCents, bad, conflict, unsupported, known, subject, PROVIDERS, STORE_OWNED };
export type { Line as InvoiceLine };
