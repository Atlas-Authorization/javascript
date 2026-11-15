/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { Table, newId, paginate } from '../store';
import { billingInternals as B } from './billing';
import { audit, bad, providerOf, withStatus } from './emu4-billing-core';
import { engineState } from './support';

/**
 * Stripe Connect payouts (accounts, onboarding links, transfers), the credit ledger and referral rewards. Connect needs the
 * Stripe credentials stored first (`PUT /v1/billing/providers/stripe`), as in production; Stripe's side of an account is the
 * test's to play (`/__emulator/billing/connect/...`). Referral attribution is the test's to set up with
 * `/__emulator/referrals/...`; the reward sweep that the production worker runs on a timer runs whenever rewards are read,
 * voided or run.
 */
const KEY_MAX = 200;
const MAX_TRANSFER = 100_000_000;
const DAY = B.DAY;

interface ProviderAccount {
  details_submitted: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requirements_due: string[];
  country: string | null;
}
interface RewardRules {
  enabled: boolean;
  trigger: 'signup' | 'first_payment';
  referrer_amount: number;
  referee_amount: number;
  currency: string;
  hold_days: number;
  max_rewards_per_referrer: number | null;
  updated_at: number | null;
}
interface X {
  accounts: Table;
  transfers: Table;
  /** What Stripe holds for each connected account, by provider account id; the row copy is refreshed from it. */
  stripe: Map<string, ProviderAccount>;
  fault: { times: number; message: string } | null;
  credits: Table;
  referrals: Table;
  rewards: Table;
  rules: RewardRules | null;
}
const st = engineState((e: Engine): X => ({ accounts: new Table('billing_connect_accounts', e.clock.now, 'bca'), transfers: new Table('billing_transfers', e.clock.now, 'btr'), stripe: new Map(), fault: null, credits: new Table('billing_credits', e.clock.now, 'bcr'), referrals: new Table('user_referrals', e.clock.now, 'uref'), rewards: new Table('referral_rewards', e.clock.now, 'rrw'), rules: null }));

const connectKey = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > KEY_MAX) throw bad(`idempotency_key is required (at most ${KEY_MAX} characters).`, 'idempotency_key');
  return raw.trim();
};
/** The Stripe credentials must be stored before any Connect call (503 NOT_CONFIGURED), exactly as in production. */
function needStripe(e: Engine): void {
  if (!providerOf(e, 'stripe')) throw new EmulatorError('NOT_CONFIGURED', 'Add your own Stripe credentials (PUT /v1/billing/providers/stripe) before using Connect payouts.', undefined, { meta: {} });
}
const accountView = (a: Obj): Obj => ({ object: 'billing_connect_account', id: a.id, subject_type: a.subject_type, subject_id: a.subject_id, provider_account_id: a.provider_account_id, country: a.country ?? null, details_submitted: a.details_submitted, charges_enabled: a.charges_enabled, payouts_enabled: a.payouts_enabled, requirements_due: a.requirements_due, refreshed_at: a.refreshed_at ?? null, created_at: a.created_at });
const transferView = (t: Obj): Obj => ({ object: 'billing_transfer', id: t.id, account_id: t.account_id, subject_type: t.subject_type, subject_id: t.subject_id, amount: t.amount, currency: t.currency, description: t.description ?? null, status: t.status, provider_transfer_id: t.provider_transfer_id ?? null, failure: t.failure ?? null, source_ref: t.source_ref ?? null, created_at: t.created_at });
const refresh = (e: Engine, a: Obj): Obj => {
  needStripe(e);
  const live = st(e).stripe.get(a.provider_account_id);
  if (live) Object.assign(a, { details_submitted: live.details_submitted, charges_enabled: live.charges_enabled, payouts_enabled: live.payouts_enabled, requirements_due: [...live.requirements_due], country: live.country ?? a.country, refreshed_at: e.clock.now() });
  return a;
};
const httpsUrl = (raw: unknown, name: string): string => {
  if (typeof raw !== 'string' || raw.length > 2048) throw bad(`${name} must be an https URL.`, name);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw bad(`${name} must be an https URL.`, name);
  }
  if (u.protocol !== 'https:' || u.username || u.password) throw bad(`${name} must be an https URL without credentials.`, name);
  return u.toString();
};
const limitOf = (c: RouteContext, max: number): number => Math.min(Math.max(Number(c.query.get('limit')) || 100, 1), max);

// ── credits ──
const creditView = (c: Obj): Obj => ({ object: 'billing_credit', id: c.id, subject_type: c.subject_type, subject_id: c.subject_id, amount: c.amount, currency: c.currency, reason: c.reason ?? null, kind: c.kind, source_ref: c.source_ref ?? null, applied: Boolean(c.applied), provider: c.provider ?? null, created_at: c.created_at });
const balance = (e: Engine, type: string, id: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const c of st(e).credits.all()) if (c.subject_type === type && c.subject_id === id) out[c.currency] = (out[c.currency] ?? 0) + c.amount;
  return out;
};
/** Post a credit; idempotent on its source ref. When the subject already has a Stripe customer the credit (and any waiting ones) reach its balance now. */
function postCredit(e: Engine, input: { type: string; id: string; amount: number; currency: string; reason: string | null; kind: string; sourceRef: string | null }): { row: Obj; created: boolean } {
  const s = st(e);
  const have = input.sourceRef ? s.credits.find((c) => c.source_ref === input.sourceRef) : undefined;
  if (have) return { row: have, created: false };
  const row = s.credits.insert({ subject_type: input.type, subject_id: input.id, amount: input.amount, currency: input.currency.toLowerCase(), reason: input.reason, kind: input.kind, source_ref: input.sourceRef, applied: false, provider: null, created_at: e.clock.now() });
  const held = B.st(e).subs.find((x) => x.subject_type === input.type && x.subject_id === input.id && x.provider === 'stripe' && x.stripe_customer_id);
  if (held) for (const c of s.credits.filter((x) => x.subject_type === input.type && x.subject_id === input.id && !x.applied)) Object.assign(c, { applied: true, provider: 'stripe' });
  return { row, created: true };
}
const grantedEvent = (e: Engine, row: Obj): void => {
  e.webhooks.emit('billing_credit.granted', { object: 'billing_credit', id: row.id, subject_type: row.subject_type, subject_id: row.subject_id, amount: row.amount, currency: row.currency, reason: row.reason, kind: row.kind, applied: Boolean(row.applied), balance: balance(e, row.subject_type, row.subject_id) });
};

// ── referral rewards ──
const TRIGGERS = ['signup', 'first_payment'];
const DEFAULT_RULES: RewardRules = { enabled: false, trigger: 'first_payment', referrer_amount: 0, referee_amount: 0, currency: 'usd', hold_days: 0, max_rewards_per_referrer: null, updated_at: null };
const rulesView = (r: RewardRules | null): Obj => ({ object: 'referral_reward_rules', ...(r ?? DEFAULT_RULES) });
const rewardView = (r: Obj): Obj => ({ object: 'referral_reward', id: r.id, role: r.role, referrer_user_id: r.referrer_user_id, referee_user_id: r.referee_user_id, recipient_user_id: r.recipient_user_id, trigger: r.trigger, amount: r.amount, currency: r.currency, status: r.status, release_at: r.release_at, credit_id: r.credit_id ?? null, granted_at: r.granted_at ?? null, voided_at: r.voided_at ?? null, void_reason: r.void_reason ?? null, created_at: r.created_at });

function parseRules(e: Engine, body: Obj): RewardRules {
  const known = ['enabled', 'trigger', 'referrer_amount', 'referee_amount', 'currency', 'hold_days', 'max_rewards_per_referrer'];
  const unknown = Object.keys(body).find((k) => !known.includes(k));
  if (unknown) throw bad(`Unknown field ${unknown}.`, unknown);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw bad('enabled must be a boolean.', 'enabled');
  if (body.trigger !== undefined && (typeof body.trigger !== 'string' || !TRIGGERS.includes(body.trigger))) throw bad('trigger must be signup or first_payment.', 'trigger');
  const amount = (v: unknown, name: string): number => {
    if (v === undefined) return 0;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100_000_000) throw bad(`${name} must be a whole number of minor units (0 to 100000000).`, name);
    return v;
  };
  const referrer = amount(body.referrer_amount, 'referrer_amount');
  const referee = amount(body.referee_amount, 'referee_amount');
  if (body.currency !== undefined && (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency))) throw bad('currency must be a three-letter code.', 'currency');
  const h = body.hold_days;
  if (h !== undefined && (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h > 365)) throw bad('hold_days must be an integer from 0 to 365.', 'hold_days');
  const m = body.max_rewards_per_referrer;
  if (m !== undefined && m !== null && (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > 100_000)) throw bad('max_rewards_per_referrer must be a positive integer or null.', 'max_rewards_per_referrer');
  if (body.enabled === true && referrer === 0 && referee === 0) throw bad('Set referrer_amount or referee_amount before turning rewards on.', 'referrer_amount');
  return { enabled: body.enabled === true, trigger: (body.trigger as RewardRules['trigger'] | undefined) ?? 'first_payment', referrer_amount: referrer, referee_amount: referee, currency: ((body.currency as string | undefined) ?? 'usd').toLowerCase(), hold_days: (h as number | undefined) ?? 0, max_rewards_per_referrer: (m as number | null | undefined) ?? null, updated_at: e.clock.now() };
}

const liveUser = (e: Engine, id: string): boolean => Boolean(e.db.users.get(id) && !e.db.users.get(id)!.deleted);
const paidBefore = (e: Engine, userId: string): boolean => B.st(e).invoices.all().some((i) => i.subject_type === 'user' && i.subject_id === userId && i.status === 'paid' && i.amount_paid > 0);

/** Create the rewards the rules owe, then grant the ones whose hold has run out. */
function runRewards(e: Engine): { created: number; granted: number; voided: number } {
  const s = st(e);
  const rules = s.rules;
  const out = { created: 0, granted: 0, voided: 0 };
  if (!rules?.enabled) return out;
  const now = e.clock.now();
  let found = 0;
  for (const r of s.referrals.all()) {
    if (found >= 200) break;
    if (r.status !== 'attributed' || r.flagged_at || !r.referrer_user_id) continue;
    if (s.rewards.find((w) => w.referee_user_id === r.user_id)) continue;
    if (rules.trigger === 'first_payment' && !paidBefore(e, r.user_id)) continue;
    found++;
    if (r.referrer_user_id === r.user_id || !liveUser(e, r.referrer_user_id)) continue; // a self-referral earns nothing
    const release = now + rules.hold_days * DAY;
    const capped = rules.max_rewards_per_referrer !== null && s.rewards.filter((w) => w.referrer_user_id === r.referrer_user_id && w.role === 'referrer' && (w.status === 'pending' || w.status === 'granted')).length >= rules.max_rewards_per_referrer;
    for (const role of ['referrer', 'referee'] as const) {
      const amount = role === 'referrer' ? rules.referrer_amount : rules.referee_amount;
      if (amount <= 0 || (role === 'referrer' && capped)) continue;
      if (s.rewards.find((w) => w.referee_user_id === r.user_id && w.role === role)) continue;
      s.rewards.insert({ referee_user_id: r.user_id, referrer_user_id: r.referrer_user_id, recipient_user_id: role === 'referrer' ? r.referrer_user_id : r.user_id, role, trigger: rules.trigger, amount, currency: rules.currency, status: 'pending', release_at: release, credit_id: null, granted_at: null, voided_at: null, void_reason: null, created_at: now });
      out.created++;
    }
  }
  for (const w of s.rewards.all().filter((x) => x.status === 'pending' && x.release_at <= now).sort((a, b) => a.release_at - b.release_at)) {
    const ref = s.referrals.find((r) => r.user_id === w.referee_user_id);
    if (!ref || ref.status !== 'attributed' || ref.flagged_at) {
      Object.assign(w, { status: 'voided', voided_at: now, void_reason: 'referral_no_longer_valid' });
      out.voided++;
      e.webhooks.emit('referral_reward.voided', rewardView(w));
      continue;
    }
    const { row, created } = postCredit(e, { type: 'user', id: w.recipient_user_id, amount: w.amount, currency: w.currency, reason: w.role === 'referrer' ? 'Referral reward' : 'Welcome reward from a referral', kind: 'grant', sourceRef: `referral_reward:${w.id}` });
    Object.assign(w, { status: 'granted', granted_at: now, credit_id: row.id });
    if (created) grantedEvent(e, row);
    e.webhooks.emit('referral_reward.granted', rewardView(w));
    out.granted++;
  }
  return out;
}

export function emu4BillingCommerceHandlers(): RouteDef[] {
  const account = (e: Engine, id: string | undefined): Obj => {
    const a = st(e).accounts.get(id);
    if (!a) throw new EmulatorError('NOT_FOUND', 'Unknown connected account.');
    return a;
  };
  const sweeping = (r: RouteDef): RouteDef => ({ ...r, handler: (c) => (B.settle(c.engine), runRewards(c.engine), r.handler(c)) });
  return [
    // ── Stripe Connect ──
    {
      method: 'POST',
      pattern: '/v1/billing/connect/accounts',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        B.known(c.body, ['subject_type', 'subject_id', 'email', 'country', 'idempotency_key']);
        const sub = B.subject(e, c.body);
        connectKey(c.body.idempotency_key);
        const b = c.body;
        if (b.email !== undefined && (typeof b.email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(b.email) || b.email.length > 320)) throw bad('email must be an email address.', 'email');
        if (b.country !== undefined && (typeof b.country !== 'string' || !/^[A-Z]{2}$/.test(b.country))) throw bad('country must be a two-letter ISO country code (upper case).', 'country');
        const s = st(e);
        const have = s.accounts.find((a) => a.subject_type === sub.type && a.subject_id === sub.id);
        if (have) return { body: accountView(have) };
        needStripe(e);
        const providerId = newId('acct', e.clock.now());
        const country = (b.country as string | undefined) ?? 'US';
        const live: ProviderAccount = { details_submitted: false, charges_enabled: false, payouts_enabled: false, requirements_due: ['business_profile.url', 'external_account', 'tos_acceptance.date', 'tos_acceptance.ip'], country };
        s.stripe.set(providerId, live);
        const row = s.accounts.insert({ subject_type: sub.type, subject_id: sub.id, provider_account_id: providerId, ...live, refreshed_at: e.clock.now(), created_at: e.clock.now() });
        audit(e, 'billing_connect_account.created', 'billing_connect_account', row.id, { subject_type: sub.type, subject_id: sub.id });
        return { status: 201, body: accountView(row) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/billing/connect/accounts',
      scope: 'billing:read',
      handler: (c) => {
        const limit = limitOf(c, 200);
        const rows = st(c.engine).accounts.all();
        const after = c.query.get('starting_after');
        if (after && !st(c.engine).accounts.get(after)) throw bad('Unknown starting_after cursor.', 'starting_after');
        const page = paginate(rows, { limit, startingAfter: after ?? undefined });
        return { body: { object: 'list', data: page.data.map(accountView), has_more: page.has_more, next_cursor: page.next_cursor } };
      },
    },
    { method: 'GET', pattern: '/v1/billing/connect/accounts/:id', scope: 'billing:read', handler: (c) => ({ body: accountView(account(c.engine, c.params.id)) }) },
    { method: 'POST', pattern: '/v1/billing/connect/accounts/:id/refresh', scope: 'billing:write', handler: (c) => ({ body: accountView(refresh(c.engine, account(c.engine, c.params.id))) }) },
    {
      method: 'POST',
      pattern: '/v1/billing/connect/accounts/:id/onboarding_link',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        B.known(c.body, ['return_url', 'refresh_url', 'type']);
        const a = account(e, c.params.id);
        if (c.body.type !== undefined && c.body.type !== 'onboarding' && c.body.type !== 'update') throw bad('type must be onboarding or update.', 'type');
        needStripe(e);
        httpsUrl(c.body.return_url, 'return_url');
        httpsUrl(c.body.refresh_url, 'refresh_url');
        audit(e, 'billing_connect_account.link_created', 'billing_connect_account', a.id, { type: c.body.type ?? 'onboarding' });
        return { status: 201, body: { object: 'billing_connect_link', account_id: a.id, url: `https://connect.emulator.invalid/${c.body.type === 'update' ? 'update' : 'onboarding'}/${crypto.randomUUID()}`, expires_at: e.clock.now() + 5 * 60_000 } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/billing/connect/transfers',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        const s = st(e);
        B.known(c.body, ['account_id', 'amount', 'currency', 'description', 'source_ref', 'idempotency_key']);
        const b = c.body;
        const key = connectKey(b.idempotency_key);
        if (typeof b.account_id !== 'string' || b.account_id === '') throw bad('account_id is required.', 'account_id');
        if (typeof b.amount !== 'number' || !Number.isInteger(b.amount) || b.amount < 1 || b.amount > MAX_TRANSFER) throw bad('amount must be a whole number of minor units (at least 1).', 'amount');
        if (typeof b.currency !== 'string' || !/^[A-Za-z]{3}$/.test(b.currency)) throw bad('currency must be a three-letter code.', 'currency');
        if (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 300)) throw bad('description must be text of at most 300 characters.', 'description');
        if (b.source_ref !== undefined && (typeof b.source_ref !== 'string' || b.source_ref.length > 200)) throw bad('source_ref must be text of at most 200 characters.', 'source_ref');
        const currency = b.currency.toLowerCase();
        const prior = s.transfers.find((t) => t.idempotency_key === key);
        if (prior) {
          if (prior.account_id !== b.account_id || prior.amount !== b.amount || prior.currency !== currency) throw new EmulatorError('IDEMPOTENCY_CONFLICT', 'That idempotency_key was already used for a different transfer.');
          return { body: transferView(prior) };
        }
        // Stripe is asked for the account's readiness before any money moves: the stored flag may be stale.
        const a = refresh(e, account(e, b.account_id));
        if (!a.payouts_enabled) throw new EmulatorError('CONFLICT', 'That account cannot receive payouts yet. Finish onboarding first.', undefined, { meta: { requirements_due: a.requirements_due } });
        const row = s.transfers.insert({ account_id: a.id, subject_type: a.subject_type, subject_id: a.subject_id, amount: b.amount, currency, description: b.description ?? null, source_ref: b.source_ref ?? null, idempotency_key: key, status: 'pending', provider_transfer_id: null, failure: null, created_at: e.clock.now() });
        if (s.fault && s.fault.times > 0) {
          const message = s.fault.message;
          if (--s.fault.times === 0) s.fault = null;
          Object.assign(row, { status: 'failed', failure: message.slice(0, 300) });
          throw bad(`Stripe refused the transfer: ${message}`, 'amount');
        }
        Object.assign(row, { status: 'paid', provider_transfer_id: newId('tr', e.clock.now()) });
        audit(e, 'billing_transfer.created', 'billing_transfer', row.id, { account_id: a.id, amount: b.amount, currency, status: row.status });
        e.webhooks.emit('billing_transfer.created', transferView(row));
        return { status: 201, body: transferView(row) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/billing/connect/transfers',
      scope: 'billing:read',
      handler: (c) => {
        const acct = c.query.get('account_id');
        const rows = st(c.engine).transfers.all().filter((t) => !acct || t.account_id === acct).slice(0, limitOf(c, 500));
        return { body: { object: 'list', data: rows.map(transferView), has_more: false, next_cursor: null } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/billing/connect/transfers/:id',
      scope: 'billing:read',
      handler: (c) => {
        const t = st(c.engine).transfers.get(c.params.id);
        if (!t) throw new EmulatorError('NOT_FOUND', 'Unknown transfer.');
        return { body: transferView(t) };
      },
    },
    {
      // Stripe's side of a connected account: finishing onboarding turns payouts on. The stored row only follows on refresh (or before a transfer).
      method: 'POST',
      pattern: '/__emulator/billing/connect/accounts/:id/provider_state',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const a = account(e, c.params.id);
        const live = st(e).stripe.get(a.provider_account_id)!;
        for (const k of ['details_submitted', 'charges_enabled', 'payouts_enabled'] as const) {
          if (c.body[k] === undefined) continue;
          if (typeof c.body[k] !== 'boolean') throw bad(`${k} must be true or false.`, k);
          live[k] = c.body[k];
        }
        if (c.body.requirements_due !== undefined) {
          if (!Array.isArray(c.body.requirements_due) || c.body.requirements_due.some((x: unknown) => typeof x !== 'string')) throw bad('requirements_due must be a list of strings.', 'requirements_due');
          live.requirements_due = c.body.requirements_due;
        }
        return { body: { object: 'emulator_connect_provider_state', account_id: a.id, provider_account_id: a.provider_account_id, ...live } };
      },
    },
    {
      // Make the next `times` transfers fail at Stripe.
      method: 'POST',
      pattern: '/__emulator/billing/connect/faults',
      public: true,
      handler: (c) => {
        const times = Number(c.body.times ?? 1);
        if (!Number.isInteger(times) || times < 1 || times > 1000) throw bad('times must be an integer from 1 to 1000.', 'times');
        st(c.engine).fault = { times, message: typeof c.body.message === 'string' && c.body.message ? c.body.message : 'Insufficient funds in the platform balance.' };
        return { body: { ok: true, times } };
      },
    },
    // ── credit ledger ──
    {
      method: 'GET',
      pattern: '/v1/billing/credits',
      scope: 'billing:read',
      handler: (c) => {
        const type = c.query.get('subject_type');
        const id = c.query.get('subject_id');
        if (!type || (type !== 'user' && type !== 'org') || !id) throw bad('subject_type (user or org) and subject_id are required.', 'subject_id');
        const rows = st(c.engine).credits.all().filter((x) => x.subject_type === type && x.subject_id === id).slice(0, limitOf(c, 500));
        return { body: { object: 'billing_credit_ledger', subject_type: type, subject_id: id, balance: balance(c.engine, type, id), data: rows.map(creditView) } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/billing/credits',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        B.known(c.body, ['subject_type', 'subject_id', 'amount', 'currency', 'reason', 'idempotency_key']);
        const b = c.body;
        if (typeof b.subject_type !== 'string' || (b.subject_type !== 'user' && b.subject_type !== 'org') || typeof b.subject_id !== 'string' || !b.subject_id) throw bad('subject_type (user or org) and subject_id are required.', 'subject_id');
        if (typeof b.amount !== 'number' || !Number.isInteger(b.amount) || b.amount === 0 || Math.abs(b.amount) > 100_000_000) throw bad('amount must be a non-zero integer in minor units.', 'amount');
        if (typeof b.currency !== 'string' || !/^[a-zA-Z]{3}$/.test(b.currency)) throw bad('currency must be a 3-letter code.', 'currency');
        const key = typeof b.idempotency_key === 'string' && b.idempotency_key ? b.idempotency_key.slice(0, 200) : null;
        const { row, created } = postCredit(e, { type: b.subject_type, id: b.subject_id, amount: b.amount, currency: b.currency, reason: typeof b.reason === 'string' ? b.reason.slice(0, 300) : null, kind: b.amount > 0 ? 'grant' : 'adjustment', sourceRef: key });
        if (created) {
          grantedEvent(e, row);
          audit(e, 'billing_credit.posted', 'billing_credit', row.id, { subject_type: row.subject_type, subject_id: row.subject_id, amount: row.amount, currency: row.currency });
        }
        return { status: created ? 201 : 200, body: creditView(row) };
      },
    },
    // ── referral rewards ──
    { method: 'GET', pattern: '/v1/referral_reward_rules', scope: 'billing:read', handler: (c) => ({ body: rulesView(st(c.engine).rules) }) },
    {
      method: 'PUT',
      pattern: '/v1/referral_reward_rules',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        const rules = parseRules(e, c.body);
        st(e).rules = rules;
        audit(e, 'referral_reward_rules.updated', 'referral_reward_rules', e.instanceId, { enabled: rules.enabled, trigger: rules.trigger, referrer_amount: rules.referrer_amount, referee_amount: rules.referee_amount, currency: rules.currency, hold_days: rules.hold_days });
        return { body: rulesView(rules) };
      },
    },
    sweeping({
      method: 'GET',
      pattern: '/v1/referral_rewards',
      scope: 'billing:read',
      handler: (c) => {
        const q = (k: string) => c.query.get(k) ?? undefined;
        if (q('status') !== undefined && !['pending', 'granted', 'voided'].includes(q('status')!)) throw bad('status must be pending, granted or voided.', 'status');
        const s = st(c.engine);
        const after = q('starting_after');
        if (after && !s.rewards.get(after)) throw bad('Unknown starting_after cursor.', 'starting_after');
        const rows = s.rewards.all().filter((r) => (!q('status') || r.status === q('status')) && (!q('recipient_user_id') || r.recipient_user_id === q('recipient_user_id')) && (!q('referrer_user_id') || r.referrer_user_id === q('referrer_user_id')));
        const page = paginate(rows, { limit: limitOf(c, 500), startingAfter: after });
        return { body: { object: 'list', data: page.data.map(rewardView), has_more: page.has_more, next_cursor: page.next_cursor } };
      },
    }),
    sweeping({
      method: 'GET',
      pattern: '/v1/referral_rewards/:id',
      scope: 'billing:read',
      handler: (c) => {
        const r = st(c.engine).rewards.get(c.params.id);
        if (!r) throw new EmulatorError('NOT_FOUND', 'Unknown reward.');
        return { body: rewardView(r) };
      },
    }),
    sweeping({
      method: 'POST',
      pattern: '/v1/referral_rewards/:id/void',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        B.known(c.body, ['reason']);
        const reason = c.body.reason;
        if (reason !== undefined && (typeof reason !== 'string' || reason.length > 300)) throw bad('reason must be text of at most 300 characters.', 'reason');
        const r = st(e).rewards.get(c.params.id);
        if (!r) throw new EmulatorError('NOT_FOUND', 'Unknown reward.');
        if (r.status === 'granted') throw bad('A granted reward is already a credit; post a negative credit to take it back.', 'id');
        if (r.status === 'pending') {
          Object.assign(r, { status: 'voided', voided_at: e.clock.now(), void_reason: reason ?? 'voided_by_admin' });
          e.webhooks.emit('referral_reward.voided', rewardView(r));
        }
        audit(e, 'referral_reward.voided', 'referral_reward', r.id, { status: r.status });
        return { body: rewardView(r) };
      },
    }),
    {
      method: 'POST',
      pattern: '/v1/referral_rewards/run',
      scope: 'billing:write',
      handler: (c) => {
        B.settle(c.engine);
        return { body: { object: 'referral_reward_run', ...runRewards(c.engine) } };
      },
    },
    // ── referral attribution, the test's to set up ──
    {
      method: 'POST',
      pattern: '/__emulator/referrals/attribute',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const referee = c.body.referee_user_id;
        const referrer = c.body.referrer_user_id;
        if (typeof referee !== 'string' || !liveUser(e, referee)) throw new EmulatorError('NOT_FOUND', 'User not found.', 'referee_user_id');
        if (referrer !== undefined && referrer !== null && (typeof referrer !== 'string' || !liveUser(e, referrer))) throw new EmulatorError('NOT_FOUND', 'User not found.', 'referrer_user_id');
        const status = c.body.status ?? 'attributed';
        if (!['attributed', 'pending', 'rejected'].includes(status)) throw bad('status must be attributed, pending or rejected.', 'status');
        const s = st(e);
        const have = s.referrals.find((r) => r.user_id === referee);
        const fields = { user_id: referee, referrer_user_id: referrer ?? null, status, flagged_at: null };
        const row = have ? Object.assign(have, fields) : s.referrals.insert({ ...fields, created_at: e.clock.now() });
        return { body: { object: 'emulator_referral', id: row.id, referee_user_id: row.user_id, referrer_user_id: row.referrer_user_id, status: row.status, flagged_at: row.flagged_at } };
      },
    },
    {
      method: 'POST',
      pattern: '/__emulator/referrals/flag',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const row = st(e).referrals.find((r) => r.user_id === c.body.referee_user_id);
        if (!row) throw new EmulatorError('NOT_FOUND', 'No referral for that user.', 'referee_user_id');
        row.flagged_at = c.body.flagged === false ? null : e.clock.now();
        return { body: { object: 'emulator_referral', id: row.id, referee_user_id: row.user_id, referrer_user_id: row.referrer_user_id, status: row.status, flagged_at: row.flagged_at } };
      },
    },
  ];
}
