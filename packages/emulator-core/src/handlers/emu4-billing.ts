/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { billingInternals as B } from './billing';
import { WEBHOOK_SECRET, audit, bad, providerOf, providerState, withStatus, type ProviderCfg } from './emu4-billing-core';
import { emu4BillingCommerceHandlers } from './emu4-billing-x';
import { engineState, oneOf } from './support';

/**
 * Round-four billing: payment-provider credentials (`/v1/billing/providers`), the per-instance provider webhook with the
 * provider's own signature checks (Stripe, Paddle, Lemon Squeezy, RevenueCat), app-store purchase links, and the
 * helpers that sign provider deliveries so a test can play them. Stripe Connect payouts, the credit ledger and referral
 * rewards are in emu4-billing-x.ts; proration is in billing.ts, with the read-only helpers at the end of this file.
 *
 * `POST /__emulator/billing/webhooks/sign` returns the exact URL, headers and body a provider would send, signed with the
 * secret stored for that provider (`tamper: signature | stale` breaks it on purpose); `.../deliver` also posts it. Nothing
 * here calls a payment provider: the provider side is the test's to play.
 */
const PROVIDER_NAMES = B.PROVIDERS as readonly string[];
const SECRET: Record<string, string[]> = { stripe: ['secret_key', 'webhook_secret'], polar: ['access_token', 'webhook_secret'], dodo: ['api_key', 'webhook_secret'], creem: ['api_key', 'webhook_secret'], chargebee: ['api_key', 'webhook_password'], autumn: ['secret_key', 'webhook_secret'], commet: ['api_key', 'webhook_secret'], paddle: ['api_key', 'webhook_secret'], lemonsqueezy: ['api_key', 'webhook_secret'], revenuecat: ['api_key', 'webhook_secret'], appstore: ['private_key'], googleplay: ['service_account_json'] };
const PUBLIC: Record<string, string[]> = { stripe: ['publishable_key', 'portal_configuration_id'], polar: ['organization_id'], dodo: [], creem: [], chargebee: ['site', 'webhook_username'], autumn: [], commet: ['seat_feature_code'], paddle: [], lemonsqueezy: ['store_id'], revenuecat: ['project_id'], appstore: ['key_id', 'issuer_id', 'bundle_id'], googleplay: ['package_name', 'push_audience', 'push_service_account'] };
const REQUIRED: Record<string, string> = { stripe: 'secret_key', polar: 'access_token', dodo: 'api_key', creem: 'api_key', chargebee: 'api_key', autumn: 'secret_key', commet: 'api_key', paddle: 'api_key', lemonsqueezy: 'api_key', revenuecat: 'api_key', appstore: 'private_key', googleplay: 'service_account_json' };
const BASE = { embeddedCheckout: false, portal: true, scheduleAtPeriodEnd: false, restore: true, seats: false, metering: false, paymentMethod: false, importSubscription: false, featureCheck: false, planSync: false };
const capabilities = (c: ProviderCfg): Obj => {
  const caps: Record<string, Obj> = {
    stripe: { ...BASE, embeddedCheckout: true, scheduleAtPeriodEnd: true, seats: true, metering: true, paymentMethod: true, importSubscription: true, discounts: true, credits: true, refunds: true, trialExtend: true, connect: true },
    polar: { ...BASE },
    dodo: { ...BASE, seats: true },
    creem: { ...BASE, restore: false, seats: true },
    chargebee: { ...BASE, scheduleAtPeriodEnd: true, seats: true, metering: true, paymentMethod: true },
    autumn: { ...BASE, seats: true, metering: true, featureCheck: true, planSync: true },
    commet: { ...BASE, seats: Boolean(c.config.seat_feature_code), metering: true, featureCheck: true, planSync: true },
    paddle: { ...BASE, seats: true },
    lemonsqueezy: { ...BASE, seats: true },
    revenuecat: { ...BASE, portal: false, restore: false },
    appstore: { ...BASE, restore: false },
    googleplay: { ...BASE, restore: false },
  };
  return caps[c.provider]!;
};

interface State {
  storeLinks: Table;
  /** Providers' subscriptions that already had their one trial recorded: `type|id`. */
  trials: Set<string>;
}
const st = engineState((e: Engine): State => ({ storeLinks: new Table('billing_store_links', e.clock.now, 'bsl'), trials: new Set() }));

const webhookUrl = (e: Engine, provider: string): string => `${e.issuer}/v1/webhooks/billing/${e.instanceId}/${provider}`;
const notFoundProvider = () => new EmulatorError('NOT_FOUND', `Unknown billing provider. Use one of ${PROVIDER_NAMES.join(', ')}.`);
const parseProvider = (raw: string | undefined): string => {
  if (!raw || !PROVIDER_NAMES.includes(raw)) throw notFoundProvider();
  return raw;
};

function providerView(e: Engine, c: ProviderCfg): Obj {
  const secretsSet = Object.fromEntries(SECRET[c.provider]!.map((k) => [k, Boolean(c.config[k])]));
  const config = Object.fromEntries(PUBLIC[c.provider]!.filter((k) => c.config[k] !== undefined).map((k) => [k, c.config[k]]));
  return { object: 'billing_provider', configured: true, provider: c.provider, environment: c.environment, status: c.status, config, secrets_set: secretsSet, webhook_url: webhookUrl(e, c.provider), capabilities: capabilities(c), last_verified_at: c.last_verified_at, last_webhook_at: c.last_webhook_at, updated_at: c.updated_at };
}

/** The write rules of `PUT /v1/billing/providers/{provider}`: only the provider's own keys, secrets kept when left blank, per-provider format checks. */
function prepareConfig(e: Engine, provider: string, body: Obj): { environment: 'live' | 'test'; config: Record<string, string> } {
  B.known(body, ['environment', 'config']);
  const raw = body.config;
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) throw bad('config must be an object of strings.', 'config');
  const secret = new Set(SECRET[provider]);
  const allowed = new Set([...SECRET[provider]!, ...PUBLIC[provider]!]);
  const existing = providerOf(e, provider);
  const config: Record<string, string> = { ...(existing?.config ?? {}) };
  for (const [k, v] of Object.entries((raw ?? {}) as Obj)) {
    if (!allowed.has(k)) throw bad(`${provider} does not take config.${k}. Allowed: ${[...allowed].join(', ')}.`, `config.${k}`);
    if (v !== undefined && v !== null && typeof v !== 'string') throw bad(`config.${k} must be a string.`, `config.${k}`);
    const t = typeof v === 'string' ? v.trim() : undefined;
    if (t) config[k] = t;
    else if (!secret.has(k) && v !== undefined) delete config[k];
  }
  if (!config[REQUIRED[provider]!]) throw bad(`config.${REQUIRED[provider]} is required.`, `config.${REQUIRED[provider]}`);
  const envRaw = body.environment;
  if (envRaw !== undefined && envRaw !== 'live' && envRaw !== 'test') throw bad('environment must be live or test.', 'environment');
  let environment: 'live' | 'test';
  if (provider === 'stripe') {
    const key = config.secret_key!;
    const fromKey = /^(sk|rk)_test_/.test(key) ? 'test' : /^(sk|rk)_live_/.test(key) ? 'live' : null;
    if (!fromKey) throw bad('secret_key must be a Stripe secret (sk_) or restricted (rk_) key.', 'config.secret_key');
    if (envRaw !== undefined && envRaw !== fromKey) throw bad(`That is a ${fromKey} Stripe key; environment must match it.`, 'environment');
    if (config.webhook_secret && !config.webhook_secret.startsWith('whsec_')) throw bad('webhook_secret must be the endpoint signing secret (whsec_…).', 'config.webhook_secret');
    if (config.publishable_key && !/^pk_(test|live)_/.test(config.publishable_key)) throw bad('publishable_key must be a Stripe publishable key (pk_…).', 'config.publishable_key');
    if (config.publishable_key && !config.publishable_key.startsWith(`pk_${fromKey}_`)) throw bad('publishable_key and secret_key must be from the same mode.', 'config.publishable_key');
    environment = fromKey;
  } else environment = (envRaw as 'live' | 'test' | undefined) ?? existing?.environment ?? 'live';
  if (provider === 'chargebee') {
    if (!config.site) throw bad('config.site is required (your Chargebee site name, e.g. acme or acme-test).', 'config.site');
    if (!/^[a-z0-9-]+$/.test(config.site)) throw bad('config.site must be the Chargebee site name only (lowercase letters, digits and hyphens), not a URL.', 'config.site');
    if (config.webhook_username && !config.webhook_password) throw bad('Set config.webhook_password together with config.webhook_username.', 'config.webhook_password');
  }
  if (provider === 'autumn') {
    if (!/^am_sk_/.test(config.secret_key!)) throw bad('secret_key must be an Autumn secret key (am_sk_…).', 'config.secret_key');
    if (config.webhook_secret && !config.webhook_secret.startsWith('whsec_')) throw bad('webhook_secret must be the endpoint signing secret (whsec_…).', 'config.webhook_secret');
  }
  if (provider === 'commet' && config.seat_feature_code && !/^[A-Za-z0-9_.:-]{1,100}$/.test(config.seat_feature_code)) throw bad('seat_feature_code must be a Commet feature code.', 'config.seat_feature_code');
  if (provider === 'lemonsqueezy' && config.store_id && !/^\d{1,12}$/.test(config.store_id)) throw bad('store_id must be the numeric Lemon Squeezy store id.', 'config.store_id');
  if (provider === 'revenuecat' && config.project_id && !/^[A-Za-z0-9_-]{1,64}$/.test(config.project_id)) throw bad('project_id must be your RevenueCat project id.', 'config.project_id');
  if (provider === 'appstore') {
    if (!/^-{5}BEGIN PRIVATE KEY-{5}[\s\S]+-{5}END PRIVATE KEY-{5}\s*$/.test(config.private_key!)) throw bad('private_key must be the App Store Connect API key (.p8, PEM text).', 'config.private_key');
    for (const k of ['key_id', 'issuer_id', 'bundle_id']) if (!config[k]) throw bad(`config.${k} is required for the App Store.`, `config.${k}`);
    if (!/^[A-Z0-9]{10}$/.test(config.key_id!)) throw bad('key_id must be the 10-character App Store Connect key id.', 'config.key_id');
    if (!/^[0-9a-f-]{36}$/i.test(config.issuer_id!)) throw bad('issuer_id must be the App Store Connect issuer id (a UUID).', 'config.issuer_id');
    if (!/^[A-Za-z0-9.-]{3,155}$/.test(config.bundle_id!)) throw bad('bundle_id must be your app bundle id.', 'config.bundle_id');
  }
  if (provider === 'googleplay') {
    let sa: Obj | null = null;
    try {
      sa = JSON.parse(config.service_account_json!);
    } catch {
      sa = null;
    }
    if (!sa || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') throw bad('service_account_json must be the Google service account key file (JSON with client_email and private_key).', 'config.service_account_json');
    for (const k of ['package_name', 'push_audience', 'push_service_account']) if (!config[k]) throw bad(`config.${k} is required for Google Play.`, `config.${k}`);
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(config.package_name!)) throw bad('package_name must be your Android package name.', 'config.package_name');
    if (!/^https:\/\//.test(config.push_audience!)) throw bad('push_audience must be the https URL set as the audience on the Pub/Sub push subscription.', 'config.push_audience');
    if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(config.push_service_account!)) throw bad('push_service_account must be the service account the push subscription authenticates as.', 'config.push_service_account');
  }
  return { environment, config };
}

// ── signing and verifying provider deliveries ──
const enc = new TextEncoder();
async function hmacHex(secret: string, material: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(material) as BufferSource))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const same = (a: string, b: string): boolean => {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
};
const STRIPE_TOLERANCE = 300;
const PADDLE_TOLERANCE = 300;
const sigError = (message = 'Invalid webhook signature.') => bad(message);

/** The headers a provider signs a delivery with. `salt` breaks the signature on purpose. */
export async function signProvider(provider: string, secret: string, raw: string, nowSec: number, salt = ''): Promise<Record<string, string>> {
  switch (provider) {
    case 'stripe':
      return { 'stripe-signature': `t=${nowSec},v1=${await hmacHex(secret + salt, `${nowSec}.${raw}`)}` };
    case 'paddle':
      return { 'paddle-signature': `ts=${nowSec};h1=${await hmacHex(secret + salt, `${nowSec}:${raw}`)}` };
    case 'lemonsqueezy':
      return { 'x-signature': await hmacHex(secret + salt, raw) };
    case 'revenuecat':
      return { authorization: `Bearer ${secret}${salt}` };
    default:
      throw bad(`The emulator signs and verifies Stripe, Paddle, Lemon Squeezy and RevenueCat deliveries; ${provider} is not modelled.`, 'provider');
  }
}

async function verifyDelivery(e: Engine, provider: string, cfg: ProviderCfg, raw: string, headers: Headers): Promise<void> {
  const secret = cfg.config.webhook_secret;
  const nowSec = e.clock.now() / 1000;
  switch (provider) {
    case 'stripe': {
      const header = headers.get('stripe-signature');
      if (!secret || !header) throw sigError();
      let t = '';
      const given: string[] = [];
      for (const part of header.split(',')) {
        const i = part.indexOf('=');
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k === 't') t = v;
        else if (k === 'v1') given.push(v);
      }
      if (!/^\d+$/.test(t) || !given.length) throw sigError();
      const expected = await hmacHex(secret, `${t}.${raw}`);
      if (!given.some((g) => same(g, expected))) throw sigError();
      if (Math.abs(nowSec - Number(t)) > STRIPE_TOLERANCE) throw sigError('Webhook timestamp outside the tolerance window.');
      return;
    }
    case 'paddle': {
      const header = headers.get('paddle-signature');
      if (!secret || !header) throw sigError();
      let ts = '';
      const given: string[] = [];
      for (const part of header.split(';')) {
        const i = part.indexOf('=');
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k === 'ts') ts = v;
        else if (k === 'h1' && /^[0-9a-f]+$/i.test(v)) given.push(v.toLowerCase());
      }
      if (!/^\d+$/.test(ts) || !given.length) throw sigError();
      const expected = await hmacHex(secret, `${ts}:${raw}`);
      if (!given.some((g) => same(g, expected))) throw sigError();
      if (Math.abs(nowSec - Number(ts)) > PADDLE_TOLERANCE) throw sigError('Webhook timestamp outside the tolerance window.');
      return;
    }
    case 'lemonsqueezy': {
      const given = headers.get('x-signature');
      if (!secret || !given || !/^[0-9a-f]+$/i.test(given)) throw sigError();
      if (!same(given.toLowerCase(), await hmacHex(secret, raw))) throw sigError();
      return;
    }
    case 'revenuecat': {
      const given = (headers.get('authorization') ?? '').trim();
      if (!secret || !given || !(same(given, secret.trim()) || same(given, `Bearer ${secret.trim()}`))) throw sigError();
      return;
    }
    default:
      throw withStatus(new EmulatorError('VALIDATION_FAILED', `The emulator verifies Stripe, Paddle, Lemon Squeezy and RevenueCat deliveries; ${provider} is not modelled.`, undefined, { meta: { reason: 'unsupported' } }), 422);
  }
}

// ── normalising a verified delivery ──
interface Ref {
  instance: string;
  type: 'user' | 'org';
  id: string;
  plan: string;
}
interface NSub {
  id: string;
  customerId: string | null;
  status: string;
  refs: string[];
  quantity: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: number | null;
  canceledAt: number | null;
  ref: Ref | null;
  accountToken: string | null;
  hint: { type: 'user' | 'org'; id: string } | null;
  deleted?: boolean;
  /** A checkout completion names the subscription but carries no state: it never regresses a known one. */
  fromCheckout?: boolean;
}
interface NInvoice {
  id: string;
  subscriptionId: string;
  number: string | null;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  failed: boolean;
  periodStart: number | null;
  periodEnd: number | null;
}
type NEvent = { kind: 'sub'; sub: NSub } | { kind: 'invoice'; invoice: NInvoice } | { kind: 'will_end'; subscriptionId: string; trialEnd: number | null };

const REF_PREFIX = 'bsub';
export const encodeRef = (r: Ref): string => [REF_PREFIX, r.instance, r.type, r.id, r.plan].join(':');
function decodeRef(raw: unknown): Ref | null {
  if (typeof raw !== 'string' || !raw.startsWith(`${REF_PREFIX}:`)) return null;
  const p = raw.split(':');
  if (p.length !== 5 || (p[2] !== 'user' && p[2] !== 'org') || !p[1] || !p[3] || !p[4]) return null;
  return { instance: p[1], type: p[2], id: p[3], plan: p[4] };
}
const hintOf = (id: unknown): NSub['hint'] => (typeof id === 'string' ? (/^user_[0-9A-Za-z]{10,}$/.test(id) ? { type: 'user', id } : /^org_[0-9A-Za-z]{10,}$/.test(id) ? { type: 'org', id } : null) : null);
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const secs = (v: unknown): number | null => (typeof v === 'number' ? v * 1000 : null);
const date = (v: unknown): number | null => {
  if (typeof v === 'number') return v;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};
const blankSub = (id: string): NSub => ({ id, customerId: null, status: 'incomplete', refs: [], quantity: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, trialEnd: null, canceledAt: null, ref: null, accountToken: null, hint: null });

function normalizeStripe(body: Obj): NEvent[] {
  const type = str(body.type) ?? '';
  const o = obj(obj(body.data).object);
  const sub = (): NSub => {
    const item = obj(obj(o.items).data instanceof Array ? (obj(o.items).data as any[])[0] : undefined);
    return { ...blankSub(str(o.id) ?? ''), customerId: str(o.customer), status: str(o.status) ?? 'incomplete', refs: [str(obj(item.price).id)].filter(Boolean) as string[], quantity: num(item.quantity), currentPeriodEnd: secs(o.current_period_end), cancelAtPeriodEnd: o.cancel_at_period_end === true, trialEnd: secs(o.trial_end), canceledAt: secs(o.ended_at), ref: decodeRef(obj(o.metadata).atlas_ref) };
  };
  switch (type) {
    case 'checkout.session.completed': {
      const ref = decodeRef(o.client_reference_id);
      const id = str(o.subscription);
      return ref && id ? [{ kind: 'sub', sub: { ...blankSub(id), customerId: str(o.customer), status: 'active', ref, fromCheckout: true } }] : [];
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return sub().id ? [{ kind: 'sub', sub: sub() }] : [];
    case 'customer.subscription.deleted':
      return sub().id ? [{ kind: 'sub', sub: { ...sub(), status: 'canceled', deleted: true } }] : [];
    case 'customer.subscription.trial_will_end':
      return [{ kind: 'will_end', subscriptionId: str(o.id) ?? '', trialEnd: secs(o.trial_end) }];
    case 'invoice.finalized':
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed':
    case 'invoice.updated': {
      const subscriptionId = str(o.subscription);
      if (!subscriptionId) return [];
      return [{ kind: 'invoice', invoice: { id: str(o.id) ?? '', subscriptionId, number: str(o.number), status: str(o.status) ?? 'draft', amountDue: num(o.amount_due) ?? 0, amountPaid: num(o.amount_paid) ?? 0, currency: str(o.currency) ?? 'usd', failed: type === 'invoice.payment_failed', periodStart: secs(o.period_start), periodEnd: secs(o.period_end) } }];
    }
    default:
      return [];
  }
}

function normalizePaddle(body: Obj): NEvent[] {
  const type = str(body.event_type) ?? '';
  const d = obj(body.data);
  if (type.startsWith('subscription.')) {
    const first = obj(Array.isArray(d.items) ? d.items[0] : undefined);
    const status = str(d.status) ?? 'incomplete';
    const sub: NSub = { ...blankSub(str(d.id) ?? ''), customerId: str(d.customer_id), status, refs: [str(obj(first.price).id) ?? str(first.price_id)].filter(Boolean) as string[], quantity: num(first.quantity), currentPeriodEnd: date(obj(d.current_billing_period).ends_at) ?? date(d.next_billed_at), cancelAtPeriodEnd: obj(d.scheduled_change).action === 'cancel', trialEnd: status === 'trialing' ? date(obj(first.trial_dates).ends_at) : null, canceledAt: date(d.canceled_at), ref: decodeRef(obj(d.custom_data).atlas_ref) };
    if (!sub.id) return [];
    return [{ kind: 'sub', sub: type === 'subscription.canceled' ? { ...sub, status: 'canceled', deleted: true } : sub }];
  }
  if (['transaction.completed', 'transaction.paid', 'transaction.payment_failed', 'transaction.past_due'].includes(type)) {
    const subscriptionId = str(d.subscription_id);
    if (!subscriptionId) return [];
    const failed = type === 'transaction.payment_failed' || type === 'transaction.past_due';
    const total = Number(str(obj(obj(d.details).totals).grand_total) ?? num(obj(obj(d.details).totals).grand_total) ?? 0);
    const amount = Number.isFinite(total) ? total : 0;
    const paid = !failed;
    const period = obj(d.billing_period);
    return [{ kind: 'invoice', invoice: { id: str(d.id) ?? '', subscriptionId, number: str(d.invoice_number), status: paid ? 'paid' : 'open', amountDue: amount, amountPaid: paid ? amount : 0, currency: (str(d.currency_code) ?? 'usd').toLowerCase(), failed, periodStart: date(period.starts_at), periodEnd: date(period.ends_at) } }];
  }
  return [];
}

function normalizeLemon(body: Obj): NEvent[] {
  const name = str(obj(body.meta).event_name) ?? '';
  const custom = obj(obj(body.meta).custom_data);
  const d = obj(body.data);
  const a = obj(d.attributes);
  const asId = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
  if (name.startsWith('subscription_') && !name.startsWith('subscription_payment_')) {
    const raw = str(a.status) ?? 'incomplete';
    const cancelled = a.cancelled === true || raw === 'cancelled';
    const map: Record<string, string> = { on_trial: 'trialing', active: 'active', paused: 'paused', past_due: 'past_due', unpaid: 'unpaid', cancelled: 'active', expired: 'canceled' };
    const ended = raw === 'expired';
    const sub: NSub = { ...blankSub(str(d.id) ?? ''), customerId: asId(a.customer_id), status: map[raw] ?? raw, refs: [asId(a.variant_id)].filter(Boolean) as string[], quantity: num(obj(a.first_subscription_item).quantity), currentPeriodEnd: date(cancelled ? (a.ends_at ?? a.renews_at) : a.renews_at) ?? date(a.ends_at), cancelAtPeriodEnd: cancelled && !ended, trialEnd: raw === 'on_trial' ? date(a.trial_ends_at) : null, canceledAt: ended ? (date(a.ends_at) ?? 0) : null, ref: decodeRef(custom.atlas_ref) };
    if (!sub.id) return [];
    return [{ kind: 'sub', sub: name === 'subscription_expired' ? { ...sub, status: 'canceled', deleted: true } : sub }];
  }
  if (['subscription_payment_success', 'subscription_payment_recovered', 'subscription_payment_failed'].includes(name)) {
    const subscriptionId = asId(a.subscription_id);
    if (!subscriptionId) return [];
    const failed = name === 'subscription_payment_failed';
    const total = num(a.total) ?? 0;
    const paid = !failed && str(a.status) === 'paid';
    return [{ kind: 'invoice', invoice: { id: str(d.id) ?? '', subscriptionId, number: null, status: failed ? 'open' : paid ? 'paid' : 'open', amountDue: total, amountPaid: paid ? total : 0, currency: (str(a.currency) ?? 'usd').toLowerCase(), failed, periodStart: null, periodEnd: null } }];
  }
  return [];
}

const RC_ENTITLING = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT']);
function normalizeRevenueCat(body: Obj, environment: 'live' | 'test'): NEvent[] {
  const ev = obj(body.event);
  const type = str(ev.type) ?? '';
  if (str(ev.environment) !== (environment === 'live' ? 'PRODUCTION' : 'SANDBOX')) return [];
  const id = str(ev.original_transaction_id) ?? str(ev.transaction_id);
  const appUser = str(ev.app_user_id) ?? str(ev.original_app_user_id);
  const hint = hintOf(appUser);
  if (!id || !hint) return [];
  const product = str(ev.new_product_id) ?? str(ev.product_id);
  const entitlements = Array.isArray(ev.entitlement_ids) ? (ev.entitlement_ids.filter((x) => typeof x === 'string') as string[]) : [];
  const expiry = num(ev.expiration_at_ms);
  const base: NSub = { ...blankSub(id), customerId: appUser, status: 'active', refs: [product, ...entitlements].filter(Boolean) as string[], quantity: 1, currentPeriodEnd: expiry, hint };
  if (RC_ENTITLING.has(type)) {
    const trial = str(ev.period_type) === 'TRIAL';
    return [{ kind: 'sub', sub: { ...base, status: trial ? 'trialing' : 'active', trialEnd: trial ? expiry : null } }];
  }
  switch (type) {
    case 'CANCELLATION': {
      const reason = str(ev.cancel_reason);
      return reason === 'CUSTOMER_SUPPORT' || reason === 'DEVELOPER_INITIATED' ? [{ kind: 'sub', sub: { ...base, status: 'canceled', deleted: true } }] : [{ kind: 'sub', sub: { ...base, cancelAtPeriodEnd: true } }];
    }
    case 'BILLING_ISSUE':
      return [{ kind: 'sub', sub: { ...base, status: 'past_due' } }];
    case 'SUBSCRIPTION_PAUSED':
      return [{ kind: 'sub', sub: { ...base, status: 'paused' } }];
    case 'EXPIRATION':
      return [{ kind: 'sub', sub: { ...base, status: 'canceled', deleted: true } }];
    default:
      return [];
  }
}

// ── the reducer: what a verified delivery does to the emulator's billing state ──
/** A plan sells to users unless it says org (the generic row leaves the field empty). */
const audienceOf = (plan: Obj): string => (plan.audience === 'org' ? 'org' : 'user');
const planTable = (e: Engine): Table | undefined => e.generic.get('billing/plans');
/** The plan a provider price reference (or one of its alternate spellings) is configured as. */
function matchPlan(e: Engine, provider: string, refs: string[]): { plan: Obj; interval: string } | undefined {
  const plans = planTable(e)?.all() ?? [];
  for (const ref of refs) {
    for (const p of plans) {
      if ((p.provider ?? 'stripe') !== provider) continue;
      if (p.provider_price_id === ref || p.stripe_price_id === ref) return { plan: p, interval: p.interval === 'year' ? 'year' : 'month' };
      if (p.annual_price_id === ref) return { plan: p, interval: 'year' };
    }
  }
  return undefined;
}
/** A subscription of this provider's, filed through the token a store link minted: only for a token of this instance, and only when the product is the plan the token was minted for. */
function tokenRef(e: Engine, provider: string, n: NSub): Ref | null {
  if (!n.accountToken) return null;
  const link = st(e).storeLinks.find((l) => l.token === n.accountToken);
  const m = link ? matchPlan(e, provider, n.refs) : undefined;
  return link && m && m.plan.id === link.plan_id ? { instance: e.instanceId, type: link.subject_type, id: link.subject_id, plan: link.plan_id } : null;
}
/** A subscription whose provider customer IS the subject (RevenueCat app user id = Atlas id): the subject must exist and the plan be of this provider and audience. */
function hintRef(e: Engine, provider: string, n: NSub): Ref | null {
  const h = n.hint;
  if (!h) return null;
  const exists = h.type === 'user' ? e.db.users.get(h.id) && !e.db.users.get(h.id)!.deleted : e.db.organizations.get(h.id);
  const m = exists ? matchPlan(e, provider, n.refs) : undefined;
  return m && audienceOf(m.plan) === h.type ? { instance: e.instanceId, type: h.type, id: h.id, plan: m.plan.id } : null;
}

const moveSig = (r: Obj): string => JSON.stringify([r.plan_id, r.status, r.interval ?? 'month', r.quantity ?? 1, Boolean(r.cancel_at_period_end), r.current_period_end, r.scheduled_plan_id ?? null]);

function applySub(e: Engine, provider: string, n: NSub): boolean {
  const s = B.st(e);
  let row = s.subs.find((r) => r.provider === provider && r.stripe_subscription_id === n.id);
  const now = e.clock.now();
  if (!row) {
    const ref = n.ref ?? (n.deleted ? null : (tokenRef(e, provider, n) ?? hintRef(e, provider, n)));
    if (!ref || ref.instance !== e.instanceId) return false;
    const named = B.planOf(e, ref.plan);
    if (!named) return false;
    const m = matchPlan(e, provider, n.refs);
    // the plan the subscription is actually on wins over the one the reference names, as long as it is for this audience
    const plan = m && audienceOf(m.plan) === ref.type && m.plan.id !== named.id ? m.plan : named;
    const interval = m && m.plan.id === plan.id ? m.interval : plan.interval === 'year' ? 'year' : 'month';
    const before = B.entSnap(e, ref.type, ref.id);
    const status = n.deleted ? 'canceled' : n.status;
    row = s.subs.insert({ subject_type: ref.type, subject_id: ref.id, plan_id: plan.id, status, stripe_subscription_id: n.id, stripe_customer_id: n.customerId, current_period_end: n.currentPeriodEnd ?? now + B.periodLen(interval), provider, interval, quantity: n.quantity ?? 1, cancel_at_period_end: n.cancelAtPeriodEnd, canceled_at: n.deleted ? (n.canceledAt ?? now) : null, scheduled_plan_id: null, scheduled_interval: null, scheduled_change_at: null, payment_failing: false, entitlements: null, trial_start: status === 'trialing' ? now : null, trial_end: n.trialEnd, external: true, pending_lines: [], created_at: now, updated_at: now });
    B.emitSub(e, 'billing_subscription.created', row, null);
    const who = `${ref.type}|${ref.id}`;
    if (row.status === 'trialing' && !st(e).trials.has(who)) {
      st(e).trials.add(who);
      B.emitSub(e, 'billing_trial.started', row, null);
    }
    B.emitEnt(e, ref.type, ref.id, before);
    return true;
  }
  if (n.fromCheckout) return true; // a completed checkout must not regress what the subscription events already filed
  const prev = { ...row };
  const before = B.entSnap(e, row.subject_type, row.subject_id);
  const m = matchPlan(e, provider, n.refs);
  const status = n.deleted ? 'canceled' : n.status;
  Object.assign(row, {
    ...(m ? { plan_id: m.plan.id, interval: m.interval } : {}),
    status,
    ...(n.currentPeriodEnd !== null ? { current_period_end: n.currentPeriodEnd } : {}),
    ...(n.quantity !== null ? { quantity: n.quantity } : {}),
    cancel_at_period_end: status === 'canceled' ? false : n.cancelAtPeriodEnd,
    ...(n.trialEnd !== null ? { trial_end: n.trialEnd } : {}),
    ...(!row.stripe_customer_id && n.customerId ? { stripe_customer_id: n.customerId } : {}),
    ...(status === 'canceled' ? { canceled_at: n.canceledAt || row.canceled_at || now, scheduled_plan_id: null, scheduled_interval: null, scheduled_change_at: null } : {}),
    ...(status !== 'canceled' && n.cancelAtPeriodEnd && !row.canceled_at ? { canceled_at: now } : {}),
    updated_at: now,
  });
  if (row.scheduled_plan_id && m && m.plan.id === row.scheduled_plan_id) Object.assign(row, { scheduled_plan_id: null, scheduled_interval: null, scheduled_change_at: null });
  if (row.status === 'canceled' && prev.status !== 'canceled') B.emitSub(e, 'billing_subscription.canceled', row, prev);
  else if (moveSig(prev) !== moveSig(row)) B.emitSub(e, 'billing_subscription.updated', row, prev);
  const who = `${row.subject_type}|${row.subject_id}`;
  if (row.status === 'trialing' && prev.status !== 'trialing' && !st(e).trials.has(who)) {
    st(e).trials.add(who);
    B.emitSub(e, 'billing_trial.started', row, null);
  } else if (prev.status === 'trialing' && row.status !== 'trialing') B.emitSub(e, 'billing_trial.ended', row, prev, undefined, { converted: row.status === 'active' });
  B.emitEnt(e, row.subject_type, row.subject_id, before);
  return true;
}

function applyInvoice(e: Engine, provider: string, n: NInvoice, failedEvent: boolean): boolean {
  const s = B.st(e);
  const sub = s.subs.find((r) => r.provider === provider && r.stripe_subscription_id === n.subscriptionId);
  if (!sub) return false;
  const have = s.invoices.find((i) => i.provider === provider && i.provider_invoice_id === n.id);
  const fields = { subject_type: sub.subject_type, subject_id: sub.subject_id, subscription_id: sub.id, status: n.status, currency: n.currency, amount_due: n.amountDue, amount_paid: n.amountPaid, provider, provider_invoice_id: n.id, number: n.number };
  if (have) Object.assign(have, fields);
  else s.invoices.insert({ ...fields, amount_refunded: 0, lines: [], created_at: e.clock.now() });
  if (failedEvent) B.emitSub(e, 'billing_invoice.payment_failed', sub, null, undefined, { invoice: { provider_invoice_id: n.id, number: n.number, amount_due: n.amountDue, currency: n.currency, hosted_invoice_url: null } });
  return true;
}

/** Apply normalised events; returns whether any of them found a subscription to move. */
function reduce(e: Engine, provider: string, events: NEvent[]): boolean[] {
  return events.map((ev) => {
    if (ev.kind === 'sub') return applySub(e, provider, ev.sub);
    if (ev.kind === 'invoice') return applyInvoice(e, provider, ev.invoice, ev.invoice.failed);
    const sub = B.st(e).subs.find((r) => r.provider === provider && r.stripe_subscription_id === ev.subscriptionId);
    if (!sub) return false;
    B.emitSub(e, 'billing_trial.will_end', sub, null, undefined, { trial_end: ev.trialEnd ?? sub.trial_end ?? null });
    return true;
  });
}

// ── the raw-body hook: a signature covers the exact bytes ──
const RAW_BILLING = /^\/v1\/webhooks\/billing\/[^/]+\/[a-z]+\/?$/;
const rawBodies = new WeakMap<Request, string>();
/** Called once by the engine: hand the provider webhook route the bytes that were signed. */
export function installBillingWebhooks(e: Engine): void {
  const handle = e.handle.bind(e);
  e.handle = async (request: Request) => {
    if (request.method !== 'POST' || !RAW_BILLING.test(new URL(request.url).pathname)) return handle(request);
    const raw = await request.text();
    const headers = new Headers(request.headers);
    headers.set('content-type', 'application/json');
    const next = new Request(request.url, { method: 'POST', headers, body: '{}' });
    rawBodies.set(next, raw);
    return handle(next);
  };
}

async function receive(c: RouteContext): Promise<{ status: number; body: unknown }> {
  const e = c.engine;
  const provider = c.params.provider!;
  if (!PROVIDER_NAMES.includes(provider)) throw withStatus(new EmulatorError('NOT_FOUND', 'Unknown billing provider.'), 404);
  const cfg = c.params.instanceId === e.instanceId ? providerOf(e, provider) : undefined;
  if (!cfg || !cfg.config[WEBHOOK_SECRET[provider]!]) throw withStatus(new EmulatorError('NOT_CONFIGURED', 'Billing webhooks are not configured for this instance and provider.'), 404);
  const raw = rawBodies.get(c.request) ?? JSON.stringify(c.body);
  await verifyDelivery(e, provider, cfg, raw, c.request.headers);
  let body: Obj = {};
  try {
    body = JSON.parse(raw);
  } catch {
    body = {};
  }
  cfg.last_webhook_at = e.clock.now();
  B.settle(e);
  const events = provider === 'stripe' ? normalizeStripe(body) : provider === 'paddle' ? normalizePaddle(body) : provider === 'lemonsqueezy' ? normalizeLemon(body) : normalizeRevenueCat(body, cfg.environment);
  reduce(e, provider, events);
  return { status: 200, body: { received: true } };
}

// ── playing a provider: build, sign and deliver a delivery ──
const WEBHOOK_PROVIDERS = ['stripe', 'paddle', 'lemonsqueezy', 'revenuecat'] as const;
const SCENARIOS = ['subscription.created', 'subscription.updated', 'subscription.canceled', 'trial.will_end', 'payment.succeeded', 'payment.failed'] as const;

function priceRefOf(plan: Obj | undefined, interval: string, provider: string): string {
  if (!plan) return 'price_unknown';
  const own = provider === 'stripe' ? [plan.stripe_price_id, plan.provider_price_id] : [plan.provider_price_id, plan.stripe_price_id];
  return String((interval === 'year' ? plan.annual_price_id : undefined) ?? own.find((x) => typeof x === 'string' && x) ?? `price_${plan.id}`);
}

/** The provider-shaped payload for a scenario. */
function buildPayload(e: Engine, provider: string, cfg: ProviderCfg, b: Obj): Obj {
  const event = oneOf(b, 'event', SCENARIOS);
  const subId = typeof b.subscription_id === 'string' && b.subscription_id ? b.subscription_id : (() => { throw bad('subscription_id is required (the provider\'s own subscription id).', 'subscription_id'); })();
  const plan = typeof b.plan_id === 'string' ? B.planOf(e, b.plan_id) : undefined;
  if (typeof b.plan_id === 'string' && !plan) throw notFound('Billing plan');
  const interval = oneOf(b, 'interval', ['month', 'year'], 'month');
  const subjectType = b.subject_type === undefined ? undefined : oneOf(b, 'subject_type', ['user', 'org']);
  const subjectId = typeof b.subject_id === 'string' ? b.subject_id : undefined;
  const ref = !b.omit_ref && plan && subjectType && subjectId ? encodeRef({ instance: e.instanceId, type: subjectType as 'user' | 'org', id: subjectId, plan: plan.id }) : undefined;
  const priceRef = typeof b.product_id === 'string' ? b.product_id : priceRefOf(plan, interval, provider);
  const customer = typeof b.customer_id === 'string' ? b.customer_id : `cus_${subId}`;
  const now = e.clock.now();
  const end = typeof b.current_period_end === 'number' ? b.current_period_end : now + B.periodLen(interval);
  const trialEnd = typeof b.trial_end === 'number' ? b.trial_end : null;
  const cancelAtEnd = b.cancel_at_period_end === true;
  const amount = typeof b.amount === 'number' ? b.amount : B.priceCents(plan, interval);
  const currency = typeof b.currency === 'string' ? b.currency : 'usd';
  const status = typeof b.status === 'string' ? b.status : event === 'payment.failed' ? 'past_due' : trialEnd ? 'trialing' : 'active';
  const evId = `evt_${Math.floor(now)}_${subId}`;
  const invoiceId = typeof b.invoice_id === 'string' ? b.invoice_id : `inv_${Math.floor(now)}_${subId}`;
  if (provider === 'stripe') {
    const subObj = { id: subId, object: 'subscription', customer, status: event === 'subscription.canceled' ? 'canceled' : status, cancel_at_period_end: cancelAtEnd, current_period_end: Math.floor(end / 1000), trial_end: trialEnd ? Math.floor(trialEnd / 1000) : null, ended_at: event === 'subscription.canceled' ? Math.floor(now / 1000) : null, items: { data: [{ id: `si_${subId}`, quantity: typeof b.quantity === 'number' ? b.quantity : 1, price: { id: priceRef } }] }, metadata: ref ? { atlas_ref: ref } : {} };
    switch (event) {
      case 'subscription.created': return { id: evId, object: 'event', type: 'customer.subscription.created', data: { object: subObj } };
      case 'subscription.updated': return { id: evId, object: 'event', type: 'customer.subscription.updated', data: { object: subObj } };
      case 'subscription.canceled': return { id: evId, object: 'event', type: 'customer.subscription.deleted', data: { object: subObj } };
      case 'trial.will_end': return { id: evId, object: 'event', type: 'customer.subscription.trial_will_end', data: { object: subObj } };
      default: return { id: evId, object: 'event', type: event === 'payment.failed' ? 'invoice.payment_failed' : 'invoice.payment_succeeded', data: { object: { id: invoiceId, object: 'invoice', subscription: subId, customer, number: invoiceId.toUpperCase(), status: event === 'payment.failed' ? 'open' : 'paid', amount_due: amount, amount_paid: event === 'payment.failed' ? 0 : amount, currency, period_start: Math.floor(now / 1000), period_end: Math.floor(end / 1000) } } };
    }
  }
  if (provider === 'paddle') {
    const sub = { id: subId, customer_id: customer, status: event === 'subscription.canceled' ? 'canceled' : status, items: [{ price: { id: priceRef }, quantity: typeof b.quantity === 'number' ? b.quantity : 1, ...(trialEnd ? { trial_dates: { ends_at: new Date(trialEnd).toISOString() } } : {}) }], current_billing_period: { starts_at: new Date(now).toISOString(), ends_at: new Date(end).toISOString() }, scheduled_change: cancelAtEnd ? { action: 'cancel', effective_at: new Date(end).toISOString() } : null, canceled_at: event === 'subscription.canceled' ? new Date(now).toISOString() : null, custom_data: ref ? { atlas_ref: ref } : {} };
    switch (event) {
      case 'subscription.created': return { event_id: evId, event_type: 'subscription.created', data: sub };
      case 'subscription.updated': return { event_id: evId, event_type: 'subscription.updated', data: sub };
      case 'subscription.canceled': return { event_id: evId, event_type: 'subscription.canceled', data: sub };
      case 'trial.will_end': throw bad('Paddle sends no trial warning; use subscription.updated.', 'event');
      default: return { event_id: evId, event_type: event === 'payment.failed' ? 'transaction.payment_failed' : 'transaction.completed', data: { id: invoiceId, subscription_id: subId, customer_id: customer, invoice_number: invoiceId.toUpperCase(), currency_code: currency.toUpperCase(), details: { totals: { grand_total: String(amount) } }, billing_period: { starts_at: new Date(now).toISOString(), ends_at: new Date(end).toISOString() } } };
    }
  }
  if (provider === 'lemonsqueezy') {
    const lemonStatus = event === 'subscription.canceled' ? 'expired' : cancelAtEnd ? 'cancelled' : trialEnd ? 'on_trial' : status === 'past_due' ? 'past_due' : 'active';
    const meta = (name: string) => ({ event_name: name, custom_data: ref ? { atlas_ref: ref } : {} });
    const sub = { id: subId, type: 'subscriptions', attributes: { status: lemonStatus, cancelled: cancelAtEnd, customer_id: customer, variant_id: priceRef, renews_at: new Date(end).toISOString(), ends_at: cancelAtEnd || event === 'subscription.canceled' ? new Date(end).toISOString() : null, trial_ends_at: trialEnd ? new Date(trialEnd).toISOString() : null, first_subscription_item: { quantity: typeof b.quantity === 'number' ? b.quantity : 1 } } };
    switch (event) {
      case 'subscription.created': return { meta: meta('subscription_created'), data: sub };
      case 'subscription.updated': return { meta: meta('subscription_updated'), data: sub };
      case 'subscription.canceled': return { meta: meta('subscription_expired'), data: sub };
      case 'trial.will_end': throw bad('Lemon Squeezy sends no trial warning; use subscription.updated.', 'event');
      default: return { meta: meta(event === 'payment.failed' ? 'subscription_payment_failed' : 'subscription_payment_success'), data: { id: invoiceId, type: 'subscription-invoices', attributes: { subscription_id: subId, customer_id: customer, total: amount, status: event === 'payment.failed' ? 'open' : 'paid', currency, urls: { invoice_url: null } } } };
    }
  }
  // revenuecat
  const environment = typeof b.environment === 'string' ? b.environment : cfg.environment === 'live' ? 'PRODUCTION' : 'SANDBOX';
  const user = subjectId ?? (typeof b.app_user_id === 'string' ? b.app_user_id : '');
  const rc = (type: string, extra: Obj = {}) => ({ api_version: '1.0', event: { type, id: evId, app_user_id: user, original_app_user_id: user, original_transaction_id: subId, transaction_id: subId, product_id: priceRef, expiration_at_ms: end, environment, period_type: trialEnd ? 'TRIAL' : 'NORMAL', entitlement_ids: [], ...extra } });
  switch (event) {
    case 'subscription.created': return rc('INITIAL_PURCHASE');
    case 'subscription.updated': return cancelAtEnd ? rc('CANCELLATION', { cancel_reason: 'UNSUBSCRIBE' }) : rc(typeof b.product_id === 'string' ? 'PRODUCT_CHANGE' : 'RENEWAL');
    case 'subscription.canceled': return rc('EXPIRATION');
    case 'payment.failed': return rc('BILLING_ISSUE');
    default: throw bad(`RevenueCat has no ${event} event.`, 'event');
  }
}

async function signed(c: RouteContext): Promise<{ provider: string; url: string; headers: Record<string, string>; body: string }> {
  const e = c.engine;
  const provider = oneOf(c.body, 'provider', WEBHOOK_PROVIDERS);
  const cfg = providerOf(e, provider);
  const secret = cfg?.config.webhook_secret;
  if (!cfg || !secret) throw bad(`Configure ${provider} first: PUT /v1/billing/providers/${provider} with config.webhook_secret.`, 'provider');
  const tamper = c.body.tamper === undefined ? undefined : oneOf(c.body, 'tamper', ['signature', 'stale']);
  const payload = c.body.payload !== undefined ? obj(c.body.payload) : buildPayload(e, provider, cfg, c.body);
  const raw = JSON.stringify(payload);
  const nowSec = Math.floor(e.clock.now() / 1000) - (tamper === 'stale' ? 3600 : 0);
  const headers = await signProvider(provider, secret, raw, nowSec, tamper === 'signature' ? 'tampered' : '');
  return { provider, url: webhookUrl(e, provider), headers: { 'content-type': 'application/json', ...headers }, body: raw };
}

// ── store purchases: the verified notification of an app store, played ──
const STORE_EVENTS = ['purchase', 'renewal', 'cancel', 'billing_issue', 'expire', 'refund'] as const;

export function emu4BillingHandlers(): RouteDef[] {
  const settled = (r: RouteDef): RouteDef => ({ ...r, handler: (c: RouteContext) => (B.settle(c.engine), r.handler(c)) });
  const routes: RouteDef[] = [
    // ── provider credentials ──
    {
      method: 'GET',
      pattern: '/v1/billing/providers',
      handler: (c) => ({ body: { object: 'list', data: [...providerState(c.engine).values()].map((p) => providerView(c.engine, p)), has_more: false } }),
    },
    {
      method: 'GET',
      pattern: '/v1/billing/providers/:provider',
      handler: (c) => {
        const provider = parseProvider(c.params.provider);
        const cfg = providerOf(c.engine, provider);
        if (!cfg) return { body: { object: 'billing_provider', configured: false, provider, message: `No ${provider} credentials are configured. PUT /v1/billing/providers/${provider} to add them.` } };
        return { body: providerView(c.engine, cfg) };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/billing/providers/:provider',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        const provider = parseProvider(c.params.provider);
        const existed = providerOf(e, provider);
        const { environment, config } = prepareConfig(e, provider, c.body);
        const now = e.clock.now();
        const cfg: ProviderCfg = { provider, environment, status: 'active', config, last_verified_at: existed?.last_verified_at ?? null, last_webhook_at: existed?.last_webhook_at ?? null, updated_at: now };
        providerState(e).set(provider, cfg);
        audit(e, `billing_provider.${existed ? 'updated' : 'created'}`, 'billing_provider', provider, { provider });
        return { status: existed ? 200 : 201, body: providerView(e, cfg) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/billing/providers/:provider/test',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        const provider = parseProvider(c.params.provider);
        const cfg = providerOf(e, provider);
        if (!cfg) throw new EmulatorError('NOT_FOUND', `No ${provider} credentials are configured.`);
        audit(e, 'billing_provider.tested', 'billing_provider', provider, { provider });
        // The emulator reaches no provider: a stored key passes, except the two checks the real adapters make before calling out.
        if (provider === 'revenuecat' && !cfg.config.project_id) return { body: { object: 'billing_provider_test', provider, ok: false, error: 'Set config.project_id (your RevenueCat project id).', account: null } };
        cfg.last_verified_at = e.clock.now();
        return { body: { object: 'billing_provider_test', provider, ok: true, error: null, account: provider === 'stripe' ? 'acct_emulator' : provider === 'revenuecat' ? (cfg.config.project_id ?? null) : null } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/billing/providers/:provider',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        const provider = parseProvider(c.params.provider);
        if (!providerOf(e, provider)) throw new EmulatorError('NOT_FOUND', `No ${provider} credentials are configured.`);
        const live = B.st(e).subs.filter((s) => s.provider === provider && ['active', 'trialing', 'past_due', 'unpaid', 'paused'].includes(s.status)).length;
        if (live > 0 && c.query.get('force') !== 'true') throw new EmulatorError('CONFLICT', `${live} live subscription(s) run on these ${provider} credentials. Removing them stops their webhooks and plan changes. Pass force=true to remove anyway.`, undefined, { meta: { live_subscriptions: live } });
        providerState(e).delete(provider);
        audit(e, 'billing_provider.deleted', 'billing_provider', provider, { provider });
        return { body: { object: 'billing_provider', provider, deleted: true } };
      },
    },
    // ── the per-instance provider webhook ──
    { method: 'POST', pattern: '/v1/webhooks/billing/:instanceId/:provider', public: true, handler: receive },
    {
      method: 'POST',
      pattern: '/__emulator/billing/webhooks/sign',
      public: true,
      handler: async (c) => ({ body: { object: 'billing_webhook', method: 'POST', ...(await signed(c)) } }),
    },
    {
      method: 'POST',
      pattern: '/__emulator/billing/webhooks/deliver',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const s = await signed(c);
        const res = await e.handle(new Request(s.url, { method: 'POST', headers: s.headers, body: s.body }));
        const text = await res.text();
        return { body: { object: 'billing_webhook_delivery', provider: s.provider, url: s.url, status: res.status, response: text ? JSON.parse(text) : null, body: s.body } };
      },
    },
    // ── store links: the token an app hands the app store at purchase ──
    {
      method: 'POST',
      pattern: '/v1/billing/store_links',
      scope: 'billing:write',
      handler: (c) => {
        const e = c.engine;
        B.known(c.body, ['subject_type', 'subject_id', 'plan_id']);
        const sub = B.subject(e, c.body);
        if (typeof c.body.plan_id !== 'string' || !c.body.plan_id) throw bad('plan_id is required.', 'plan_id');
        const plan = B.planOf(e, c.body.plan_id);
        if (!plan) throw new EmulatorError('NOT_FOUND', 'Unknown plan.');
        if (plan.provider !== 'appstore' && plan.provider !== 'googleplay') throw bad('Store links are for plans sold through appstore or googleplay.', 'plan_id');
        if (!plan.active) throw bad('That plan is not active.', 'plan_id');
        if (audienceOf(plan) !== sub.type) throw bad(`That plan is for ${audienceOf(plan)} subjects.`, 'plan_id');
        let row = st(e).storeLinks.find((l) => l.subject_type === sub.type && l.subject_id === sub.id && l.plan_id === plan.id);
        const created = !row;
        if (!row) {
          row = st(e).storeLinks.insert({ token: crypto.randomUUID(), subject_type: sub.type, subject_id: sub.id, plan_id: plan.id, created_at: e.clock.now() });
          audit(e, 'billing_store_link.created', 'billing_store_link', row.id, { subject_type: sub.type, subject_id: sub.id, plan_id: plan.id, provider: plan.provider });
        }
        return { status: created ? 201 : 200, body: { object: 'billing_store_link', id: row.id, token: row.token, subject_type: row.subject_type, subject_id: row.subject_id, plan_id: row.plan_id, provider: plan.provider, created_at: row.created_at } };
      },
    },
    {
      // Stands in for a verified App Store or Google Play notification: the emulator cannot mint Apple's certificate chain
      // or a Google token, so the delivery arrives already trusted and goes through the same attribution rules.
      method: 'POST',
      pattern: '/__emulator/billing/store_purchases',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const provider = oneOf(c.body, 'provider', ['appstore', 'googleplay']);
        if (!providerOf(e, provider)) throw withStatus(new EmulatorError('NOT_CONFIGURED', 'Billing webhooks are not configured for this instance and provider.'), 404);
        const event = oneOf(c.body, 'event', STORE_EVENTS, 'purchase');
        const id = typeof c.body.original_transaction_id === 'string' && c.body.original_transaction_id ? c.body.original_transaction_id : (() => { throw bad('original_transaction_id is required.', 'original_transaction_id'); })();
        const product = typeof c.body.product_id === 'string' ? c.body.product_id : (() => { throw bad('product_id is required (the store product id of the plan).', 'product_id'); })();
        const expires = typeof c.body.expires_at === 'number' ? c.body.expires_at : e.clock.now() + B.MONTH;
        const base: NSub = { ...blankSub(id), customerId: typeof c.body.account_token === 'string' ? c.body.account_token : null, status: 'active', refs: [product], quantity: 1, currentPeriodEnd: expires, accountToken: typeof c.body.account_token === 'string' ? c.body.account_token : null };
        const n: NSub = event === 'cancel' ? { ...base, cancelAtPeriodEnd: true } : event === 'billing_issue' ? { ...base, status: 'past_due' } : event === 'expire' || event === 'refund' ? { ...base, status: 'canceled', deleted: true } : { ...base, status: c.body.trial === true ? 'trialing' : 'active', trialEnd: c.body.trial === true ? expires : null };
        B.settle(e);
        const handled = reduce(e, provider, [{ kind: 'sub', sub: n }])[0]!;
        const row = B.st(e).subs.find((r) => r.provider === provider && r.stripe_subscription_id === id);
        return { body: { object: 'billing_store_purchase', provider, event, handled, subscription_id: row?.id ?? null } };
      },
    },
    // ── proration, read-only: what the next invoice holds ──
    {
      method: 'GET',
      pattern: '/__emulator/billing/invoices/:id/lines',
      public: true,
      handler: (c) => {
        const inv = B.st(c.engine).invoices.get(c.params.id);
        if (!inv) throw notFound('Invoice');
        return { body: { object: 'list', data: ((inv.lines ?? []) as any[]).map((l) => B.lineView(inv.currency, l)), has_more: false } };
      },
    },
    {
      method: 'GET',
      pattern: '/__emulator/billing/subscriptions/:id/upcoming_invoice',
      public: true,
      handler: (c) => {
        const e = c.engine;
        B.settle(e);
        const s = B.st(e).subs.get(c.params.id);
        if (!s) throw notFound('Subscription');
        if (s.status === 'canceled' || s.cancel_at_period_end) return { body: { object: 'emulator_upcoming_invoice', subscription_id: s.id, lines: [], total: 0, applied_balance: 0, amount_due: 0, currency: 'usd', period_end: s.current_period_end } };
        const d = B.draft(e, s, s.current_period_end);
        return { body: { object: 'emulator_upcoming_invoice', subscription_id: s.id, lines: d.lines.map((l) => B.lineView(d.currency, l)), total: d.total, applied_balance: d.applied, amount_due: d.due, currency: d.currency, period_end: s.current_period_end } };
      },
    },
    {
      // The provider-side credit a downgrade left behind; the next invoice draws on it.
      method: 'GET',
      pattern: '/__emulator/billing/customer_balance',
      public: true,
      handler: (c) => {
        const type = c.query.get('subject_type');
        const id = c.query.get('subject_id');
        if (!type || !id) throw bad('subject_type and subject_id are required.', 'subject_id');
        return { body: { object: 'emulator_customer_balance', subject_type: type, subject_id: id, balance: B.st(c.engine).customerBalance.get(`${type}|${id}`) ?? 0 } };
      },
    },
  ];
  return [...routes.map((r) => (r.pattern.startsWith('/v1/billing/') || r.pattern.startsWith('/__emulator/billing/store') ? settled(r) : r)), ...emu4BillingCommerceHandlers()];
}
