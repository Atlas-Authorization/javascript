/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { bytesToB64url, sha256 } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import { SNS_CERT_URL, prepareCallback, receiverToken, testKeys, testSecret, verifyCallback, type DeliveryEvent, type EventStatus, type TestKeys } from '../messaging-callbacks';
import type { Obj } from '../openapi';
import { Table, paginate } from '../store';
import { engineState, intIn, oneOf } from './support';
import { pageOf } from './util';
import { snsCertificateFor, snsState } from './emu4-sns';

/**
 * The messaging layer behind every email, SMS, WhatsApp, voice and push message the engine sends: the message ledger
 * (`GET /v1/messages`, one row per message with attempts and a delivery timeline), the suppression list (a suppressed
 * recipient is never sent to, and bounces and complaints add entries automatically), provider failover (an ordered list of
 * fallback providers tried when the primary fails) and per-country SMS routes. Nothing leaves the process: delivery
 * means the message reached `engine.messages`. To exercise failover, make a provider fail with
 * `POST /__emulator/messaging/faults`; to play a provider's delivery callback, `POST /__emulator/messaging/feedback`.
 *
 * Per-channel providers: `PUT /v1/messaging_providers/{email,sms,push}` picks the provider of a channel (WhatsApp and voice ride
 * the SMS provider's Twilio account, as on the real API), every ledger row records the `provider` and `channel` it went through, and
 * `POST /__emulator/messaging/require_providers` makes a channel with no provider fail instead of using the built-in sink.
 *
 * Provider callbacks: `POST /v1/webhooks/{provider}/{instance_id}` verifies each provider's own signature (or URL token) before
 * it touches the ledger. `GET /__emulator/messaging/signing_keys` lists the test secrets and `POST /__emulator/messaging/sign`
 * builds a correctly signed (or tampered, or stale) callback for a ledger message.
 */
const CHANNELS = ['email', 'sms', 'whatsapp', 'voice', 'push'] as const;
const STATUSES = ['queued', 'sent', 'delivered', 'failed', 'bounced', 'complained', 'suppressed'] as const;
const REASONS = ['hard_bounce', 'complaint', 'unsubscribe', 'invalid', 'manual'] as const;
const FALLBACK_CHANNELS = ['email', 'sms', 'push'] as const;
const TRANSPORTS: Record<string, string[]> = {
  email: ['smtp', 'ses', 'sendgrid', 'brevo', 'mailgun', 'postmark', 'resend', 'smtp2go'],
  sms: ['twilio', 'vonage', 'messagebird', 'sinch', 'plivo'],
  push: ['fcm', 'apns', 'onesignal'],
};
interface ReceiverMeta {
  provider: string;
  channel: 'email' | 'sms';
  verification: 'signature' | 'signature_or_token' | 'token';
  secret: string | null;
  events: string;
}
const RECEIVERS: ReceiverMeta[] = [
  { provider: 'ses', channel: 'email', verification: 'token', secret: 'Optional: comma-separated SNS topic ARNs to accept (any other topic is refused). Amazon SNS signatures are always verified.', events: 'Bounce, Complaint and Delivery notifications through an SNS topic subscribed over HTTPS.' },
  { provider: 'brevo', channel: 'email', verification: 'token', secret: null, events: 'Transactional webhook: request, delivered, hard_bounce, soft_bounce, blocked, spam, invalid_email, unsubscribed, error. Send the token as a bearer header.' },
  { provider: 'mailgun', channel: 'email', verification: 'signature', secret: 'Your Mailgun HTTP webhook signing key.', events: 'accepted, delivered, failed (temporary and permanent), complained, unsubscribed.' },
  { provider: 'smtp2go', channel: 'email', verification: 'token', secret: null, events: 'processed, delivered, bounce, reject, spam, unsubscribe.' },
  { provider: 'postmark', channel: 'email', verification: 'token', secret: null, events: 'Delivery, Bounce, SpamComplaint, SubscriptionChange. Use HTTP basic auth with the token as the password.' },
  { provider: 'sendgrid', channel: 'email', verification: 'signature_or_token', secret: 'The public key of your SendGrid signed event webhook (base64).', events: 'processed, delivered, bounce, blocked, dropped, spamreport, unsubscribe.' },
  { provider: 'resend', channel: 'email', verification: 'signature', secret: 'The signing secret (whsec_...) of your Resend webhook. Managed email on Resend registers its own and needs none.', events: 'email.sent, email.delivered, email.bounced, email.complained, email.failed.' },
  { provider: 'twilio', channel: 'sms', verification: 'signature', secret: null, events: 'Message status callbacks. Verified with the auth token of your Twilio SMS provider.' },
  { provider: 'vonage', channel: 'sms', verification: 'signature_or_token', secret: 'Your Vonage signature secret, as `sha256:<secret>` (or md5hash, md5, sha1, sha512 as the prefix).', events: 'SMS delivery receipts.' },
  { provider: 'messagebird', channel: 'sms', verification: 'signature_or_token', secret: 'Your MessageBird request-signing key.', events: 'SMS status reports.' },
];
/** Signature-only providers: with no stored secret the sign helper uses the test secret, so a callback can be built before anything is stored. */
const SIGNED_ONLY = new Set(['mailgun', 'resend', 'twilio']);
const GET_RECEIVERS = ['vonage', 'messagebird'];
const EMAIL_TRANSPORTS = ['resend', 'ses', 'smtp', 'brevo', 'mailgun', 'smtp2go', 'hermetica', 'webhook'];
const SMS_TRANSPORTS = ['twilio', 'vonage', 'messagebird', 'plivo', 'telnyx', 'sinch', 'infobip', 'clicksend', 'bandwidth', 'aws_sns', 'webhook'];
const PUSH_TRANSPORTS = ['apns_fcm', 'expo'];
const PROVIDER_TRANSPORTS: Record<string, string[]> = { email: EMAIL_TRANSPORTS, sms: SMS_TRANSPORTS, push: PUSH_TRANSPORTS };
/** shortcut: one write-only key list for every transport and a required-key table for the common ones, where the real API validates each transport's full schema; widen when a transport's own keys matter. */
const SECRET_KEYS = new Set(['api_key', 'api_secret', 'private_key', 'access_key', 'api_token', 'auth_token', 'secret_access_key', 'access_key_id', 'session_token', 'password', 'signing_secret', 'apns_auth_key', 'fcm_service_account', 'secret', 'token']);
const REQUIRED_KEYS: Record<string, string[]> = { resend: ['api_key'], brevo: ['api_key'], mailgun: ['api_key', 'domain'], smtp2go: ['api_key'], hermetica: ['api_key'], ses: ['region', 'access_key_id', 'secret_access_key'], smtp: ['host'], webhook: ['url', 'signing_secret'], twilio: ['account_sid', 'auth_token'], vonage: ['api_key', 'api_secret'], messagebird: ['access_key'], plivo: ['auth_id', 'auth_token'], telnyx: ['api_key'], sinch: ['service_plan_id', 'api_token'], infobip: ['base_url', 'api_key'], clicksend: ['username', 'api_key'] };
const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, failed: 3, bounced: 4, complained: 5, suppressed: 6, blocked: 6 };
const EVENT_NAMES: Record<string, (c: string) => string | null> = {
  delivered: (c) => (c === 'email' ? 'email.delivered' : 'sms.delivered'),
  bounced: (c) => (c === 'email' ? 'email.bounced' : null),
  complained: (c) => (c === 'email' ? 'email.complained' : null),
  failed: (c) => (c === 'email' ? 'email.failed' : 'sms.failed'),
  sent: () => null,
};
const TEST_CHANNELS = ['email', 'sms', 'push', 'whatsapp', 'voice'];
const RAW_RECEIVER = /^\/v1\/webhooks\/[a-z0-9]+\/[^/]+\/?$/;
const rawBodies = new WeakMap<Request, { raw: string; contentType: string }>();
const CALLING_CODES: Record<string, string> = { '1': 'US', '44': 'GB', '49': 'DE', '33': 'FR', '34': 'ES', '39': 'IT', '31': 'NL', '61': 'AU', '91': 'IN', '81': 'JP', '55': 'BR', '52': 'MX', '353': 'IE', '46': 'SE', '47': 'NO', '45': 'DK', '41': 'CH', '43': 'AT', '32': 'BE', '48': 'PL', '351': 'PT', '65': 'SG', '64': 'NZ', '27': 'ZA', '234': 'NG', '971': 'AE' };
const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FALLBACKS = 5;
const MAX_BATCH = 1000;

interface Fault {
  provider_id?: string;
  /** The transport name (resend, twilio ...); with no provider_id the fault hits whichever slot uses that transport. */
  provider?: string;
  channel?: string;
  times: number;
}
interface ReceiverRow {
  secret: string | null;
  last_event_at: number | null;
  last_error: string | null;
}
interface MsgState {
  ledger: Table;
  suppressions: Table;
  fallbacks: Table;
  routes: Map<string, Obj>;
  providers: Table;
  receivers: Map<string, ReceiverRow>;
  /** Callbacks already applied, by provider and provider event id: a redelivery changes nothing. */
  seen: Set<string>;
  testSends: Map<string, number[]>;
  requireProviders: boolean;
  settings: { auto_suppress: boolean; failover_enabled: boolean; ledger_retention_days: number; updated_at: number | null };
  faults: Fault[];
}
const st = engineState((e: Engine): MsgState => ({
  ledger: new Table('message_ledger', e.clock.now, 'msg'),
  suppressions: new Table('message_suppressions', e.clock.now, 'msup'),
  fallbacks: new Table('messaging_fallbacks', e.clock.now, 'mfb'),
  routes: new Map(),
  providers: new Table('messaging_providers_config', e.clock.now, 'mprov'),
  receivers: new Map(),
  seen: new Set(),
  testSends: new Map(),
  requireProviders: false,
  settings: { auto_suppress: true, failover_enabled: true, ledger_retention_days: 90, updated_at: null },
  faults: [],
}));
export const keyStore = engineState((): TestKeys => testKeys());

const mask = (channel: string, to: string): string => {
  if (channel === 'email' || to.includes('@')) {
    const [l = '', d = ''] = to.split('@');
    return `${l.slice(0, 1)}${'*'.repeat(Math.max(l.length - 1, 1))}@${d}`;
  }
  return `${to.slice(0, 3)}${'*'.repeat(Math.max(to.length - 5, 1))}${to.slice(-2)}`;
};
const normalAddress = (channel: string, a: string): string => (channel === 'email' ? a.trim().toLowerCase() : a.trim());
const countryOf = (to: string): string | null => {
  if (!to.startsWith('+')) return null;
  for (const len of [3, 2, 1]) {
    const c = CALLING_CODES[to.slice(1, 1 + len)];
    if (c) return c;
  }
  return null;
};

function takeFault(s: MsgState, providerId: string, transport: string, channel: string): boolean {
  const f = s.faults.find((x) => (!x.provider_id || x.provider_id === providerId) && (!x.provider || x.provider === transport) && (!x.channel || x.channel === channel) && x.times > 0);
  if (!f) return false;
  f.times--;
  return true;
}

const PHONE_CHANNELS = ['whatsapp', 'voice'];
const providerChannel = (channel: string): string => (PHONE_CHANNELS.includes(channel) ? 'sms' : channel);
const activeFallbacks = (s: MsgState, channel: string): Obj[] => s.fallbacks.all().filter((f) => f.channel === channel && f.status === 'active').sort((a, b) => a.position - b.position);

/** The providers a message on `channel` is tried through, in order: the channel's own provider, then its fallbacks. WhatsApp and voice use the SMS provider's Twilio account only. */
function slotsFor(s: MsgState, channel: string): Array<{ id: string; transport: string }> {
  const base = providerChannel(channel);
  const cfg = s.providers.find((r) => r.channel === base);
  if (!cfg && s.requireProviders) return [];
  const all = [{ id: 'primary', transport: cfg ? cfg.transport : 'emulator' }, ...activeFallbacks(s, base).map((f) => ({ id: f.id, transport: f.transport }))];
  return PHONE_CHANNELS.includes(channel) && cfg ? all.filter((p) => p.transport === 'twilio') : all;
}

/** Install suppression, failover and the ledger on the engine's message sink, and the raw-body hook of the provider callback routes. Called once by the engine. */
export function installMessaging(e: Engine): void {
  // Callback signatures cover the exact bytes, and some providers post arrays or forms: hand those routes the raw body.
  const handle = e.handle.bind(e);
  e.handle = async (request: Request) => {
    if (request.method !== 'POST' || !RAW_RECEIVER.test(new URL(request.url).pathname)) return handle(request);
    const raw = await request.text();
    const headers = new Headers(request.headers);
    const contentType = headers.get('content-type') ?? '';
    headers.set('content-type', 'application/json');
    const next = new Request(request.url, { method: 'POST', headers, body: '{}' });
    rawBodies.set(next, { raw, contentType });
    return handle(next);
  };
  e.messages.route = (m) => {
    const s = st(e);
    const now = e.clock.now();
    const channel = (CHANNELS as readonly string[]).includes(m.channel) ? m.channel : 'email';
    const to = normalAddress(channel, m.to);
    let order = slotsFor(s, channel);
    const row = s.ledger.insert({
      channel,
      template: typeof m.meta?.template === 'string' ? m.meta.template : 'custom',
      recipient: to,
      country: channel === 'sms' ? countryOf(to) : null,
      status: 'queued',
      status_detail: null,
      provider: order[0]?.transport ?? null,
      provider_message_id: null,
      attempts: [],
      timeline: [{ status: 'queued', at: now }],
      created_at: now,
      updated_at: now,
    });
    const hit = s.suppressions.find((x) => x.channel === channel && x.address === to);
    if (hit) {
      Object.assign(row, { status: 'suppressed', status_detail: `suppressed: ${hit.reason}`, updated_at: now });
      row.timeline.push({ status: 'suppressed', at: now, detail: hit.reason });
      return { deliver: false };
    }
    // The country's route for SMS goes first, then the rest in order; with failover off only the first is tried.
    const routed = row.country ? s.routes.get(row.country)?.provider_id : undefined;
    if (routed) order = [...order.filter((p) => p.id === routed), ...order.filter((p) => p.id !== routed)];
    if (!s.settings.failover_enabled) order = order.slice(0, 1);
    if (!order.length) {
      const detail = `no ${channel} provider is configured`;
      Object.assign(row, { status: 'failed', status_detail: detail, updated_at: now });
      row.timeline.push({ status: 'failed', at: now, detail });
      return { deliver: false };
    }
    for (const p of order) {
      if (takeFault(s, p.id, p.transport, channel)) {
        row.attempts.push({ provider: p.transport, provider_id: p.id, channel, status: 'failed', error: 'injected provider failure', at: e.clock.now() });
        continue;
      }
      row.attempts.push({ provider: p.transport, provider_id: p.id, channel, status: 'sent', at: e.clock.now() });
      return {
        deliver: true,
        done: () => {
          Object.assign(row, { status: 'delivered', provider: p.transport, provider_message_id: `pm_${row.id.slice(-10)}`, updated_at: e.clock.now() });
          row.timeline.push({ status: 'sent', at: e.clock.now() }, { status: 'delivered', at: e.clock.now() });
        },
      };
    }
    Object.assign(row, { status: 'failed', status_detail: 'every provider failed', updated_at: e.clock.now() });
    row.timeline.push({ status: 'failed', at: e.clock.now(), detail: 'every provider failed' });
    return { deliver: false };
  };
}

const view = async (r: Obj): Promise<Obj> => ({
  object: 'message',
  id: r.id,
  channel: r.channel,
  template: r.template,
  recipient_masked: mask(r.channel, r.recipient),
  recipient_hash: bytesToB64url(await sha256(`${r.channel}:${r.recipient}`)),
  country: r.country,
  status: r.status,
  status_detail: r.status_detail,
  provider: r.provider,
  provider_message_id: r.provider_message_id,
  attempts: r.attempts,
  timeline: r.timeline,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const suppressionView = (r: Obj): Obj => ({ object: 'message_suppression', id: r.id, channel: r.channel, address: r.address, address_masked: mask(r.channel, r.address), reason: r.reason, source: r.source, detail: r.detail, message_id: r.message_id, created_at: r.created_at });

function addSuppression(e: Engine, channel: string, address: string, reason: string, source: string, detail: string | null, messageId: string | null): { row: Obj; created: boolean } {
  const s = st(e);
  const existing = s.suppressions.find((x) => x.channel === channel && x.address === address);
  if (existing) return { row: Object.assign(existing, { reason, detail }), created: false };
  const row = s.suppressions.insert({ channel, address, reason, source, detail, message_id: messageId, created_at: e.clock.now() });
  e.webhooks.emit('message_suppression.created', { object: 'message_suppression', id: row.id, channel, recipient: address, reason, source, message_id: messageId, at: e.clock.now() });
  return { row, created: true };
}

function checkAddress(channel: string, raw: unknown, param: string): string {
  if (typeof raw !== 'string') throw new EmulatorError('VALIDATION_FAILED', `${param} must be a string.`, param);
  const a = normalAddress(channel, raw);
  if (channel === 'email' ? !EMAIL.test(a) : channel === 'push' ? !a : !E164.test(a)) throw new EmulatorError('VALIDATION_FAILED', `${param} is not a valid ${channel === 'email' ? 'email address' : channel === 'push' ? 'device id' : 'E.164 number'}.`, param);
  return a;
}

const fallbackView = (f: Obj): Obj => ({ object: 'messaging_fallback_provider', id: f.id, channel: f.channel, position: f.position, transport: f.transport, from_address: f.from_address, status: f.status, config: f.config, secrets_set: false, updated_at: f.updated_at });
const channelParam = (v: string | undefined): string => {
  if (!(FALLBACK_CHANNELS as readonly string[]).includes(v ?? '')) throw notFound('Messaging channel (use email, sms or push)');
  return v!;
};
const failoverOrder = (e: Engine, channel: string): string[] => ['primary', ...st(e).fallbacks.all().filter((f) => f.channel === channel && f.status === 'active').sort((a, b) => a.position - b.position).map((f) => f.id)];

const providerView = (r?: Obj): Obj | null =>
  r
    ? {
        object: 'messaging_provider',
        configured: true,
        id: r.id,
        channel: r.channel,
        transport: r.transport,
        mode: r.mode,
        from_address: r.from_address,
        status: r.status,
        config: Object.fromEntries(Object.entries(r.config).filter(([k]) => !SECRET_KEYS.has(k))),
        secrets_set: Object.fromEntries(Object.entries(r.config).filter(([k]) => SECRET_KEYS.has(k)).map(([k]) => [k, true])),
        updated_at: r.updated_at,
      }
    : null;

const receiverRow = (e: Engine, provider: string): ReceiverRow => {
  const m = st(e).receivers;
  if (!m.has(provider)) m.set(provider, { secret: null, last_event_at: null, last_error: null });
  return m.get(provider)!;
};

async function receiverView(e: Engine, r: ReceiverMeta, reveal: boolean): Promise<Obj> {
  const row = st(e).receivers.get(r.provider);
  const secretSet = Boolean(row?.secret);
  const usesToken = r.verification === 'token' || (r.verification === 'signature_or_token' && !secretSet);
  const base = `${e.issuer}/v1/webhooks/${r.provider}/${e.instanceId}`;
  const token = usesToken && reveal ? await receiverToken(e.instanceId, r.provider) : undefined;
  return {
    object: 'message_receiver',
    provider: r.provider,
    channel: r.channel,
    verification: r.verification,
    url: token && r.provider !== 'brevo' && r.provider !== 'postmark' ? `${base}?t=${token}` : base,
    token_required: usesToken,
    ...(token ? { token } : {}),
    secret_set: secretSet,
    secret_help: r.secret,
    events: r.events,
    last_event_at: row?.last_event_at ?? null,
    last_error: row?.last_error ?? null,
  };
}

async function checkSecret(provider: string, secret: string): Promise<string> {
  const v = secret.trim();
  if (!v || v.length > 4096) throw new EmulatorError('VALIDATION_FAILED', 'secret must be a non-empty string of at most 4096 characters.', 'secret');
  if (provider === 'sendgrid') {
    try {
      await crypto.subtle.importKey('spki', Uint8Array.from(atob(v.replace(/\s+/g, '')), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch {
      throw new EmulatorError('VALIDATION_FAILED', 'secret must be the base64 public key of your SendGrid signed event webhook.', 'secret');
    }
  }
  if (provider === 'ses' && !v.split(',').every((t) => /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/.test(t.trim()))) throw new EmulatorError('VALIDATION_FAILED', 'secret must be a comma-separated list of SNS topic ARNs.', 'secret');
  if (provider === 'resend' && !/^whsec_/.test(v)) throw new EmulatorError('VALIDATION_FAILED', 'secret must be the Resend webhook signing secret (whsec_...).', 'secret');
  return v;
}

/** What a verified callback does, whichever provider sent it: moves the ledger row (a later report never moves it back), suppresses on a hard bounce or complaint, emits the delivery event once per real change. */
function applyEvents(e: Engine, events: DeliveryEvent[]): void {
  const s = st(e);
  for (const ev of events) {
    const soft = ev.status === 'bounced' && ev.bounceType === 'soft';
    const status = soft ? 'failed' : ev.status;
    const detail = soft ? `soft bounce${ev.detail ? `: ${ev.detail}` : ''}` : ev.detail;
    let row: Obj | undefined;
    for (const id of ev.messageIds) {
      row = s.ledger.find((r) => r.provider === ev.provider && r.provider_message_id === id);
      if (row) break;
    }
    let changed = true;
    if (row) {
      const last = row.timeline[row.timeline.length - 1];
      changed = !(last && last.status === status && last.detail === detail?.slice(0, 300));
      if (changed) row.timeline.push({ status, at: ev.at, ...(detail ? { detail: detail.slice(0, 300) } : {}) });
      if ((RANK[status] ?? 0) >= (RANK[row.status] ?? 0)) Object.assign(row, { status, status_detail: detail ?? null });
      row.updated_at = e.clock.now();
    }
    if (ev.suppress && ev.recipient && s.settings.auto_suppress) {
      const address = normalAddress(ev.channel, ev.recipient);
      if (!s.suppressions.find((x) => x.address === address && (ev.channel !== 'email' || x.channel === 'email'))) addSuppression(e, ev.channel, address, ev.suppress, ev.provider, ev.detail ?? null, row?.id ?? null);
    }
    const name = changed ? EVENT_NAMES[ev.status]?.(ev.channel) : null;
    if (name) e.webhooks.emit(name, { object: 'message_delivery', message_id: row?.id ?? ev.messageIds[0] ?? '', channel: ev.channel, recipient: ev.recipient ?? null, ...(ev.status === 'bounced' && ev.bounceType ? { bounce_type: ev.bounceType } : {}), ...(ev.status === 'failed' || ev.status === 'bounced' ? { reason: (detail ?? ev.status).slice(0, 120) } : {}), provider: ev.provider, provider_message_id: ev.messageIds[0] ?? null, ledger_id: row?.id ?? null, at: ev.at });
  }
}

/** A provider callback: verified with the provider's own scheme first; anything that does not verify is a 401 that changes nothing, the same answer whether the instance exists or not. */
async function receive(c: RouteContext, provider: string): Promise<Reply> {
  const e = c.engine;
  const s = st(e);
  const refuse = (message = 'Invalid webhook signature.') => new EmulatorError('UNAUTHENTICATED', message);
  if (c.params.instanceId !== e.instanceId) throw refuse(provider === 'brevo' ? 'Invalid webhook token.' : undefined);
  const stash = rawBodies.get(c.request);
  const row = receiverRow(e, provider);
  const u = new URL(c.request.url);
  const path = `${u.pathname}${u.search}`;
  const twilioTokens = [s.providers.find((r) => r.channel === 'sms' && r.transport === 'twilio')?.config.auth_token, ...activeFallbacks(s, 'sms').filter((f) => f.transport === 'twilio').map((f) => f.config?.auth_token)].filter((t): t is string => typeof t === 'string' && !!t);
  const out = await verifyCallback({
    provider,
    raw: stash?.raw ?? '',
    contentType: stash?.contentType ?? c.request.headers.get('content-type') ?? '',
    headers: c.request.headers,
    query: Object.fromEntries(c.query),
    urls: [`${e.issuer}${path}`, `${u.origin}${path}`, `https://${u.host}${path}`],
    secret: row.secret,
    token: await receiverToken(e.instanceId, provider),
    twilioTokens,
    snsCertificate: async (url) => snsCertificateFor(e, url, (await keyStore(e).rsa()).certPem),
    now: Math.floor(e.clock.now() / 1000),
  });
  if (!out.ok) {
    if (out.malformed) return { status: 400, body: { errors: [{ code: 'VALIDATION_FAILED', message: out.message ?? 'Request body is not valid.' }] } };
    row.last_error = out.why;
    throw refuse(out.message);
  }
  // A provider redelivers what it thinks was not acknowledged: an event id already applied changes nothing.
  const key = `${provider}:${out.id}`;
  if (!s.seen.has(key)) {
    s.seen.add(key);
    applyEvents(e, out.events);
    row.last_event_at = e.clock.now();
    row.last_error = null;
  }
  // The real receiver visits the SNS confirmation URL; the emulator makes no request and records it instead (GET /__emulator/messaging/sns).
  if (out.subscribeUrl) snsState(e).confirmations.push({ subscribe_url: out.subscribeUrl, at: e.clock.now() });
  return { body: { received: true, ...(out.confirmed ? { confirmed: true } : {}) } };
}

const SCHEMES: Record<string, string> = {
  ses: 'Amazon SNS message signature (the emulator signs with its own key) plus the URL token',
  brevo: 'bearer token',
  mailgun: 'HMAC-SHA256 of timestamp+token in the body signature object, with the webhook signing key',
  smtp2go: 'URL token (bearer, basic-auth password or ?t=)',
  postmark: 'URL token (basic-auth password, bearer or ?t=)',
  sendgrid: 'ECDSA P-256 signature over timestamp+body (X-Twilio-Email-Event-Webhook-Signature) with the stored public key; the URL token when no key is stored',
  resend: 'Svix signature (svix-id, svix-timestamp, svix-signature) with the whsec_ secret, 5 minute tolerance',
  twilio: 'X-Twilio-Signature: base64 HMAC-SHA1 over the URL and the sorted form fields, with the auth token of the SMS provider',
  vonage: 'sig over the sorted parameters with the signature secret; the URL token when no secret is stored',
  messagebird: 'MessageBird-Signature: base64 HMAC-SHA256 over timestamp, query and body hash, with the signing key; the URL token when no key is stored',
};

export function messagingHandlers(): RouteDef[] {
  const list = (e: Engine, channel: string) => ({ object: 'list', data: st(e).fallbacks.all().filter((f) => f.channel === channel).sort((a, b) => a.position - b.position).map(fallbackView), has_more: false, failover_order: failoverOrder(e, channel) });
  const saveFallback = (e: Engine, channel: string, b: Obj, existing?: Obj): Obj => {
    const transport = b.transport ?? existing?.transport;
    if (typeof transport !== 'string' || !TRANSPORTS[channel]!.includes(transport)) throw new EmulatorError('VALIDATION_FAILED', `transport must be one of: ${TRANSPORTS[channel]!.join(', ')}.`, 'transport');
    if (b.config !== undefined && (!b.config || typeof b.config !== 'object' || Array.isArray(b.config))) throw new EmulatorError('VALIDATION_FAILED', 'config must be an object.', 'config');
    const status = oneOf(b, 'status', ['active', 'disabled'], existing?.status ?? 'active');
    const mine = st(e).fallbacks.all().filter((f) => f.channel === channel && f.id !== existing?.id);
    const position = b.position === undefined ? (existing?.position ?? mine.length) : intIn(b.position, 'position', 0, MAX_FALLBACKS - 1);
    return { channel, transport, status, position, from_address: typeof b.from_address === 'string' && b.from_address.trim() ? b.from_address.trim() : (existing?.from_address ?? null), config: b.config ?? existing?.config ?? {}, updated_at: e.clock.now() };
  };

  return [
    // ── ledger ──
    {
      method: 'GET',
      pattern: '/v1/messages',
      scope: 'messaging:read',
      handler: async (c) => {
        const e = c.engine;
        const q = (k: string) => c.query.get(k) ?? undefined;
        if (q('channel') && !(CHANNELS as readonly string[]).includes(q('channel')!)) throw new EmulatorError('VALIDATION_FAILED', `channel must be one of: ${CHANNELS.join(', ')}.`, 'channel');
        if (q('status') && !(STATUSES as readonly string[]).includes(q('status')!)) throw new EmulatorError('VALIDATION_FAILED', `status must be one of: ${STATUSES.join(', ')}.`, 'status');
        const time = (k: string): number | undefined => {
          const v = q(k);
          if (!v) return undefined;
          const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
          if (Number.isNaN(n)) throw new EmulatorError('VALIDATION_FAILED', `${k} must be epoch milliseconds or an ISO 8601 time.`, k);
          return n;
        };
        const [since, until] = [time('since'), time('until')];
        const rec = q('recipient')?.trim().toLowerCase();
        const rows = st(e).ledger.all().filter((r) => (!q('channel') || r.channel === q('channel')) && (!q('status') || r.status === q('status')) && (!q('template') || r.template === q('template')) && (!q('provider') || r.provider === q('provider')) && (!rec || r.recipient.toLowerCase() === rec) && (since === undefined || r.created_at >= since) && (until === undefined || r.created_at <= until));
        const limit = intIn(q('limit'), 'limit', 1, 100, 25);
        const page = paginate(rows, { limit, startingAfter: q('starting_after') });
        return { body: { object: 'list', data: await Promise.all(page.data.map(view)), has_more: page.has_more, next_cursor: page.next_cursor } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/messages/summary',
      scope: 'messaging:read',
      handler: (c) => {
        const hours = intIn(c.query.get('hours') ?? undefined, 'hours', 1, 720, 24);
        const since = c.engine.clock.now() - hours * 3_600_000;
        const rows = st(c.engine).ledger.all().filter((r) => r.created_at >= since);
        return { body: { object: 'message_summary', since_hours: hours, total: rows.length, by_status: Object.fromEntries(STATUSES.map((x) => [x, rows.filter((r) => r.status === x).length])) } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/messages/:id',
      scope: 'messaging:read',
      handler: async (c) => {
        const r = st(c.engine).ledger.get(c.params.id);
        if (!r) throw notFound('Message');
        return { body: await view(r) };
      },
    },
    // ── suppressions ──
    {
      method: 'GET',
      pattern: '/v1/suppressions',
      scope: 'messaging:read',
      handler: (c) => {
        const q = (k: string) => c.query.get(k) ?? undefined;
        const rows = st(c.engine).suppressions.all().filter((r) => (!q('channel') || r.channel === q('channel')) && (!q('reason') || r.reason === q('reason')) && (!q('address') || r.address === normalAddress(r.channel, q('address')!)));
        const page = paginate(rows, pageOf(c));
        return { body: { object: 'list', data: page.data.map(suppressionView), has_more: page.has_more, next_cursor: page.next_cursor } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/suppressions',
      scope: 'messaging:write',
      handler: (c) => {
        const e = c.engine;
        const channel = oneOf(c.body, 'channel', CHANNELS, 'email');
        const reason = oneOf(c.body, 'reason', REASONS, 'manual');
        const detail = c.body.detail ?? null;
        if (detail !== null && (typeof detail !== 'string' || detail.length > 300)) throw new EmulatorError('VALIDATION_FAILED', 'detail must be text up to 300 characters.', 'detail');
        const raw = c.body.addresses !== undefined ? c.body.addresses : c.body.address !== undefined ? [c.body.address] : undefined;
        if (!Array.isArray(raw) || !raw.length || raw.length > MAX_BATCH) throw new EmulatorError('VALIDATION_FAILED', `Send address, or addresses (1 to ${MAX_BATCH}).`, 'address');
        const addresses = [...new Set(raw.map((a, i) => checkAddress(channel, a, `addresses[${i}]`)))];
        let created = 0;
        const out = addresses.map((a) => {
          const r = addSuppression(e, channel, a, reason, 'api', detail, null);
          if (r.created) created++;
          return r.row;
        });
        return { status: 201, body: { object: 'list', data: out.map(suppressionView), has_more: false, next_cursor: null, created } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/suppressions/:id',
      scope: 'messaging:read',
      handler: (c) => {
        const r = st(c.engine).suppressions.get(c.params.id);
        if (!r) throw notFound('Suppression');
        return { body: suppressionView(r) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/suppressions/:id',
      scope: 'messaging:write',
      handler: (c) => {
        if (!st(c.engine).suppressions.delete(c.params.id ?? '')) throw notFound('Suppression');
        return { body: { object: 'message_suppression', id: c.params.id, deleted: true } };
      },
    },
    // ── failover providers ──
    { method: 'GET', pattern: '/v1/messaging_providers/:channel/fallbacks', scope: 'messaging:read', handler: (c) => ({ body: list(c.engine, channelParam(c.params.channel)) }) },
    {
      method: 'POST',
      pattern: '/v1/messaging_providers/:channel/fallbacks',
      scope: 'messaging:write',
      handler: (c) => {
        const e = c.engine;
        const channel = channelParam(c.params.channel);
        if (st(e).fallbacks.filter((f) => f.channel === channel).length >= MAX_FALLBACKS) throw new EmulatorError('CONFLICT', `At most ${MAX_FALLBACKS} fallback providers per channel.`);
        return { status: 201, body: fallbackView(st(e).fallbacks.insert(saveFallback(e, channel, c.body) as any)) };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/messaging_providers/:channel/fallbacks/order',
      scope: 'messaging:write',
      handler: (c) => {
        const e = c.engine;
        const channel = channelParam(c.params.channel);
        const mine = st(e).fallbacks.filter((f) => f.channel === channel);
        const ids = c.body.ids;
        if (!Array.isArray(ids) || ids.length !== mine.length || new Set(ids).size !== ids.length || ids.some((i: string) => !mine.find((f) => f.id === i))) throw new EmulatorError('VALIDATION_FAILED', 'ids must list every fallback provider of the channel exactly once.', 'ids');
        ids.forEach((id: string, i: number) => Object.assign(st(e).fallbacks.get(id)!, { position: i }));
        return { body: list(e, channel) };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/messaging_providers/:channel/fallbacks/:id',
      scope: 'messaging:write',
      handler: (c) => {
        const e = c.engine;
        const channel = channelParam(c.params.channel);
        const f = st(e).fallbacks.get(c.params.id);
        if (!f || f.channel !== channel) throw notFound('Fallback provider');
        return { body: fallbackView(Object.assign(f, saveFallback(e, channel, c.body, f))) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/messaging_providers/:channel/fallbacks/:id',
      scope: 'messaging:write',
      handler: (c) => {
        const channel = channelParam(c.params.channel);
        const f = st(c.engine).fallbacks.get(c.params.id);
        if (!f || f.channel !== channel) throw notFound('Fallback provider');
        st(c.engine).fallbacks.delete(f.id);
        for (const [country, r] of st(c.engine).routes) if (r.provider_id === f.id) st(c.engine).routes.delete(country);
        return { body: { object: 'messaging_fallback_provider', id: f.id, deleted: true } };
      },
    },
    // ── per-country SMS routes ──
    {
      method: 'GET',
      pattern: '/v1/messaging/country_routes',
      scope: 'messaging:read',
      handler: (c) => ({ body: { object: 'list', data: [...st(c.engine).routes.values()], has_more: false } }),
    },
    {
      method: 'PUT',
      pattern: '/v1/messaging/country_routes',
      scope: 'messaging:write',
      handler: (c) => {
        const e = c.engine;
        const country = typeof c.body.country === 'string' ? c.body.country.toUpperCase() : '';
        if (!/^[A-Z]{2}$/.test(country)) throw new EmulatorError('VALIDATION_FAILED', 'country must be a two-letter ISO 3166 country code, e.g. DE.', 'country');
        const pid = c.body.provider_id;
        if (typeof pid !== 'string' || !failoverOrder(e, 'sms').includes(pid)) throw new EmulatorError('VALIDATION_FAILED', "provider_id is not one of this instance's active SMS providers (primary or an active fallback).", 'provider_id');
        const row = { object: 'sms_country_route', id: `scr_${country}`, channel: 'sms', country, provider_id: pid, updated_at: e.clock.now() };
        st(e).routes.set(country, row);
        return { body: row };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/messaging/country_routes/:country',
      scope: 'messaging:write',
      handler: (c) => {
        const country = (c.params.country ?? '').toUpperCase();
        if (!st(c.engine).routes.delete(country)) throw notFound('Route for that country');
        return { body: { object: 'sms_country_route', country, deleted: true } };
      },
    },
    // ── settings ──
    { method: 'GET', pattern: '/v1/messaging/settings', scope: 'messaging:read', handler: (c) => ({ body: { object: 'messaging_settings', ...st(c.engine).settings } }) },
    {
      method: 'PUT',
      pattern: '/v1/messaging/settings',
      scope: 'messaging:write',
      handler: (c) => {
        const s = st(c.engine).settings;
        for (const k of ['auto_suppress', 'failover_enabled'] as const) {
          if (c.body[k] === undefined) continue;
          if (typeof c.body[k] !== 'boolean') throw new EmulatorError('VALIDATION_FAILED', `${k} must be true or false.`, k);
          s[k] = c.body[k];
        }
        if (c.body.ledger_retention_days !== undefined) s.ledger_retention_days = intIn(c.body.ledger_retention_days, 'ledger_retention_days', 7, 730);
        s.updated_at = c.engine.clock.now();
        return { body: { object: 'messaging_settings', ...s } };
      },
    },
    // ── per-channel providers ──
    {
      method: 'GET',
      pattern: '/v1/messaging_providers',
      scope: 'messaging:read',
      handler: (c) => {
        const view = (ch: string) => providerView(st(c.engine).providers.find((r) => r.channel === ch));
        return { body: { object: 'messaging_providers', email: view('email'), sms: view('sms'), push: view('push'), managed_email: null, development_email: null } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/messaging_providers/:channel',
      scope: 'messaging:read',
      handler: (c) => {
        const channel = c.params.channel!;
        if (!PROVIDER_TRANSPORTS[channel]) throw notFound('Messaging channel (use email, sms or push)');
        const row = st(c.engine).providers.find((r) => r.channel === channel);
        return { body: row ? providerView(row) : { object: 'messaging_provider', configured: false, channel, message: `No ${channel} provider is configured. PUT /v1/messaging_providers/${channel} to add one.` } };
      },
    },
    ...(['email', 'sms', 'push'] as const).map(
      (channel): RouteDef => ({
        method: 'PUT',
        pattern: `/v1/messaging_providers/${channel}`,
        scope: 'messaging:write',
        handler: (c) => {
          const e = c.engine;
          const s = st(e);
          const allowed = PROVIDER_TRANSPORTS[channel]!;
          const transport = c.body.transport === 'hermeticor' ? 'hermetica' : c.body.transport;
          if (typeof transport !== 'string' || !allowed.includes(transport)) throw new EmulatorError('VALIDATION_FAILED', `transport must be one of: ${allowed.join(', ')}.`, 'transport');
          if (c.body.mode !== undefined && (channel !== 'email' || (c.body.mode !== 'standard' && c.body.mode !== 'development'))) throw new EmulatorError('VALIDATION_FAILED', channel === 'email' ? 'mode must be "standard" or "development".' : 'mode applies to the email provider only.', 'mode');
          if (c.body.config !== undefined && (!c.body.config || typeof c.body.config !== 'object' || Array.isArray(c.body.config))) throw new EmulatorError('VALIDATION_FAILED', 'config must be an object of provider settings.', 'config');
          const existing = s.providers.find((r) => r.channel === channel);
          // A secret the body leaves out (or sends empty) keeps the stored one, when the transport is unchanged.
          const merged: Record<string, string> = { ...(existing && existing.transport === transport ? existing.config : {}) };
          for (const [k, v] of Object.entries((c.body.config ?? {}) as Obj)) if (v !== '' && v !== null && v !== undefined) merged[k] = String(v);
          const fromAddress = typeof c.body.from_address === 'string' && c.body.from_address.trim() ? c.body.from_address.trim() : null;
          for (const k of REQUIRED_KEYS[transport] ?? []) if (!merged[k]) throw new EmulatorError('VALIDATION_FAILED', `config.${k} is required for ${transport}.`, `config.${k}`);
          if (transport === 'twilio' && !merged.messaging_service_sid && !merged.from && !fromAddress) throw new EmulatorError('VALIDATION_FAILED', 'twilio needs a sender: set from_address (or config.from) or config.messaging_service_sid.', 'config.messaging_service_sid');
          if (transport === 'apns_fcm' && !merged.apns_auth_key && !merged.fcm_service_account) throw new EmulatorError('VALIDATION_FAILED', 'apns_fcm needs config.apns_auth_key (with key id, team id and topic) or config.fcm_service_account (with project id).', 'config.apns_auth_key');
          const mode = channel === 'email' ? (c.body.mode ?? (existing && existing.transport === transport ? existing.mode : 'standard')) : 'standard';
          const fields = { channel, transport, from_address: fromAddress, config: merged, mode, status: 'active', updated_at: e.clock.now() };
          return { body: providerView(existing ? Object.assign(existing, fields) : s.providers.insert(fields as any)) };
        },
      }),
    ),
    {
      method: 'DELETE',
      pattern: '/v1/messaging_providers/:channel',
      scope: 'messaging:write',
      handler: (c) => {
        const channel = c.params.channel!;
        if (!PROVIDER_TRANSPORTS[channel]) throw new EmulatorError('VALIDATION_FAILED', 'channel must be email, sms or push.', 'channel');
        const row = st(c.engine).providers.find((r) => r.channel === channel);
        if (!row) throw notFound('A provider for that channel');
        st(c.engine).providers.delete(row.id);
        return { body: { object: 'messaging_provider', channel, deleted: true } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/messaging_providers/:channel/test',
      scope: 'messaging:write',
      handler: (c) => {
        const e = c.engine;
        const s = st(e);
        const channel = c.params.channel!;
        if (!TEST_CHANNELS.includes(channel)) throw new EmulatorError('VALIDATION_FAILED', 'channel must be email, sms, push, whatsapp or voice.', 'channel');
        const to = typeof c.body.to === 'string' ? c.body.to.trim() : '';
        if (!to) throw new EmulatorError('VALIDATION_FAILED', 'A destination is required.', 'to');
        // Throttled per key, like the real route: one test every 15 seconds, ten an hour.
        const now = e.clock.now();
        const hits = (s.testSends.get(c.key?.key ?? '') ?? []).filter((t) => now - t < 3_600_000);
        if (hits.some((t) => now - t < 15_000)) throw new EmulatorError('RATE_LIMITED', 'Wait a moment before sending another test message.');
        if (hits.length >= 10) throw new EmulatorError('RATE_LIMITED', 'You have sent a lot of test messages in the last hour. Try again shortly.');
        if (channel === 'push' ? to.length > 4096 || /\s/.test(to) : channel === 'email' ? !EMAIL.test(to) : !E164.test(to)) throw new EmulatorError('VALIDATION_FAILED', channel === 'push' ? 'Paste the device token to send to.' : channel === 'email' ? 'Enter a valid email address.' : 'Enter a phone number in E.164 form, e.g. +15550001111.', 'to');
        // A test proves YOUR provider: with none configured for the channel it refuses, whatever the require_providers switch says.
        const base = providerChannel(channel);
        const cfg = s.providers.find((r) => r.channel === base);
        if (!cfg || (PHONE_CHANNELS.includes(channel) && !slotsFor(s, channel).length)) throw new EmulatorError('VALIDATION_FAILED', `No ${channel} provider is configured for this instance. Add one before sending a test.`);
        s.testSends.set(c.key?.key ?? '', [...hits, now]);
        const address = normalAddress(channel, to);
        e.messages.send({ channel, to: address, subject: channel === 'email' ? 'Atlas provider test' : undefined, body: 'This is a test message from Atlas. No action is needed.', meta: { template: 'provider_test' } });
        const row = s.ledger.find((r) => r.template === 'provider_test' && r.channel === channel && r.recipient === address)!;
        const shown = channel === 'push' ? `${to.slice(0, 6)}...${to.slice(-4)}` : to;
        if (row.status === 'suppressed') throw new EmulatorError('CONFLICT', 'That recipient is on the suppression list.');
        if (row.status === 'failed') return { status: 502, body: { errors: [{ code: 'INTERNAL_ERROR', message: 'The provider rejected the test message.', meta: { ok: false, accepted: false, failure: 'provider_unreachable', provider: row.provider, provider_message_id: null, provider_status: null, provider_reason: row.status_detail } }] } };
        return { body: { object: 'messaging_test', channel, sent_to: shown, ok: true, accepted: true, provider: row.provider, provider_message_id: row.provider_message_id } };
      },
    },
    // ── status receivers: where each provider reports delivery ──
    {
      method: 'GET',
      pattern: '/v1/message_receivers',
      scope: 'messaging:read',
      handler: async (c) => {
        const k = c.key?.scopes;
        const reveal = !k || k.includes('*') || k.includes('messaging:write');
        return { body: { object: 'list', has_more: false, data: await Promise.all(RECEIVERS.map((r) => receiverView(c.engine, r, reveal))) } };
      },
    },
    ...['/v1/message_receivers/:provider', '/v1/message_receivers/:provider/secret'].flatMap((pattern): RouteDef[] => [
      {
        method: 'PUT',
        pattern,
        scope: 'messaging:write',
        handler: async (c) => {
          const r = RECEIVERS.find((x) => x.provider === c.params.provider);
          if (!r) throw notFound(`Provider (use one of: ${RECEIVERS.map((x) => x.provider).join(', ')})`);
          if (r.secret === null) throw new EmulatorError('VALIDATION_FAILED', `${r.provider} needs no verification secret.`, 'secret');
          if (typeof c.body.secret !== 'string') throw new EmulatorError('VALIDATION_FAILED', 'secret must be a string.', 'secret');
          const secret = await checkSecret(r.provider, c.body.secret);
          const row = receiverRow(c.engine, r.provider);
          row.secret = secret;
          return { body: await receiverView(c.engine, r, true) };
        },
      },
      {
        method: 'DELETE',
        pattern,
        scope: 'messaging:write',
        handler: (c) => {
          const row = st(c.engine).receivers.get(c.params.provider ?? '');
          if (!row?.secret) throw notFound('Verification secret for that provider');
          row.secret = null;
          return { body: { object: 'message_receiver', provider: c.params.provider, deleted: true } };
        },
      },
    ]),
    // ── provider callbacks: public, and refused unless the provider's own signature (or URL token) verifies ──
    ...RECEIVERS.flatMap((r): RouteDef[] =>
      (['POST', ...(GET_RECEIVERS.includes(r.provider) ? ['GET'] : [])] as const).map((method) => ({
        method,
        pattern: `/v1/webhooks/${r.provider}/:instanceId`,
        public: true,
        handler: (c: RouteContext) => receive(c, r.provider),
      })),
    ),
    // ── emulator controls: make a provider fail, play a delivery callback ──
    {
      method: 'POST',
      pattern: '/__emulator/messaging/faults',
      public: true,
      handler: (c) => {
        const times = intIn(c.body.times, 'times', 1, 1000, 1);
        if (c.body.channel !== undefined && !(CHANNELS as readonly string[]).includes(c.body.channel)) throw new EmulatorError('VALIDATION_FAILED', `channel must be one of: ${CHANNELS.join(', ')}.`, 'channel');
        if (c.body.provider !== undefined && typeof c.body.provider !== 'string') throw new EmulatorError('VALIDATION_FAILED', 'provider must be a transport name such as resend or twilio.', 'provider');
        // Name a slot (provider_id: primary or a fallback id), a transport (provider: resend, twilio ...), a channel, or any mix; naming neither slot nor transport means the primary.
        const slot = c.body.provider_id !== undefined ? String(c.body.provider_id) : c.body.provider === undefined ? 'primary' : undefined;
        st(c.engine).faults.push({ provider_id: slot, provider: c.body.provider, channel: c.body.channel, times });
        return { status: 201, body: { ok: true } };
      },
    },
    {
      method: 'POST',
      pattern: '/__emulator/messaging/feedback',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const s = st(e);
        const row = s.ledger.get(String(c.body.message_id ?? ''));
        if (!row) throw notFound('Message');
        const event = oneOf(c.body, 'event', ['delivered', 'bounced', 'complained']);
        const now = e.clock.now();
        const status = event;
        Object.assign(row, { status, updated_at: now, status_detail: c.body.detail ?? null });
        row.timeline.push({ status, at: now, ...(c.body.detail ? { detail: c.body.detail } : {}) });
        // A hard bounce or a complaint suppresses the address, unless auto-suppression is off.
        if (event !== 'delivered' && s.settings.auto_suppress) addSuppression(e, row.channel, row.recipient, event === 'bounced' ? 'hard_bounce' : 'complaint', 'provider', c.body.detail ?? null, row.id);
        return { body: { ok: true, status } };
      },
    },
    {
      method: 'POST',
      pattern: '/__emulator/messaging/require_providers',
      public: true,
      handler: (c) => {
        if (typeof c.body.enabled !== 'boolean') throw new EmulatorError('VALIDATION_FAILED', 'enabled must be true or false.', 'enabled');
        st(c.engine).requireProviders = c.body.enabled;
        return { body: { ok: true, require_providers: c.body.enabled } };
      },
    },
    {
      method: 'GET',
      pattern: '/__emulator/messaging/signing_keys',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const keys = keyStore(e);
        const data = await Promise.all(
          RECEIVERS.map(async (r) => ({
            object: 'messaging_signing_key',
            provider: r.provider,
            channel: r.channel,
            verification: r.verification,
            scheme: SCHEMES[r.provider],
            // What to store with PUT /v1/message_receivers/{provider} (SendGrid: the public key; Twilio: put it on the SMS provider as config.auth_token).
            secret: r.provider === 'sendgrid' ? (await keys.ec()).publicB64 : r.secret === null && r.provider !== 'twilio' ? null : r.provider === 'ses' ? null : await testSecret(e.instanceId, r.provider),
            token: r.verification === 'signature' ? null : await receiverToken(e.instanceId, r.provider),
            ...(r.provider === 'ses' ? { signing_cert_url: SNS_CERT_URL, public_key: (await keys.rsa()).publicB64, certificate_pem: (await keys.rsa()).certPem } : {}),
            url: `${e.issuer}/v1/webhooks/${r.provider}/${e.instanceId}`,
          })),
        );
        return { body: { object: 'list', data, has_more: false } };
      },
    },
    {
      method: 'POST',
      pattern: '/__emulator/messaging/sign',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const s = st(e);
        const provider = oneOf(c.body, 'provider', RECEIVERS.map((r) => r.provider));
        const event = oneOf(c.body, 'event', ['sent', 'delivered', 'bounced', 'complained', 'failed'], 'delivered') as EventStatus;
        const bounce = oneOf(c.body, 'bounce', ['hard', 'soft'], 'hard') as 'hard' | 'soft';
        const tamper = c.body.tamper === undefined ? undefined : oneOf(c.body, 'tamper', ['signature', 'stale']);
        const row = c.body.message_id === undefined ? undefined : s.ledger.get(String(c.body.message_id));
        if (c.body.message_id !== undefined && !row) throw notFound('Message');
        const messageId = typeof c.body.provider_message_id === 'string' && c.body.provider_message_id ? c.body.provider_message_id : row?.provider_message_id;
        const recipient = typeof c.body.recipient === 'string' && c.body.recipient ? c.body.recipient : row?.recipient;
        if (!messageId || !recipient) throw new EmulatorError('VALIDATION_FAILED', 'Send message_id of a delivered message, or provider_message_id and recipient.', 'message_id');
        const stored = s.receivers.get(provider)?.secret ?? null;
        const twilioToken = s.providers.find((r) => r.channel === 'sms' && r.transport === 'twilio')?.config.auth_token;
        const secret = provider === 'twilio' ? (twilioToken ?? (await testSecret(e.instanceId, provider))) : (stored ?? (SIGNED_ONLY.has(provider) ? await testSecret(e.instanceId, provider) : null));
        const url = `${e.issuer}/v1/webhooks/${provider}/${e.instanceId}`;
        let prepared;
        try {
          prepared = await prepareCallback({ provider, event, bounce, messageId, recipient, detail: typeof c.body.detail === 'string' ? c.body.detail : undefined, secret, token: await receiverToken(e.instanceId, provider), url, now: Math.floor(e.clock.now() / 1000) - (tamper === 'stale' ? 3600 : 0), salt: tamper === 'signature' ? 'tampered' : '', topic: stored?.split(',')[0]?.trim() || 'arn:aws:sns:us-east-1:123456789012:atlas-emulator', keys: keyStore(e) });
        } catch {
          throw new EmulatorError('VALIDATION_FAILED', `The stored ${provider} secret cannot sign a callback. Store the secret from GET /__emulator/messaging/signing_keys.`, 'provider');
        }
        const query = new URLSearchParams(prepared.query).toString();
        return { body: { object: 'messaging_callback', provider, method: 'POST', url: query ? `${url}?${query}` : url, headers: { 'content-type': prepared.content_type, ...prepared.headers }, body: prepared.body, signed_with: secret === null && provider !== 'ses' ? 'url token' : 'signature' } };
      },
    },
  ];
}
