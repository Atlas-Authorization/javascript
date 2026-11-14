/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { bytesToB64url, sha256 } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, paginate } from '../store';
import { engineState, intIn, oneOf } from './support';
import { pageOf } from './util';

/**
 * The messaging layer behind every email, SMS, WhatsApp, voice and push message the engine sends: the message ledger
 * (`GET /v1/messages`, one row per message with attempts and a delivery timeline), the suppression list (a suppressed
 * recipient is never sent to, and bounces and complaints add entries automatically), provider failover (an ordered list of
 * fallback providers tried when the primary fails) and per-country SMS routes. Nothing leaves the process: delivery
 * means the message reached `engine.messages`. To exercise failover, make a provider fail with
 * `POST /__emulator/messaging/faults`; to play a provider's delivery callback, `POST /__emulator/messaging/feedback`.
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
const RECEIVERS: Array<{ provider: string; channel: string; verification: string; events: string[]; secret: string | null }> = [
  { provider: 'ses', channel: 'email', verification: 'signature', events: ['delivery', 'bounce', 'complaint'], secret: 'SNS topic ARNs' },
  { provider: 'sendgrid', channel: 'email', verification: 'signature', events: ['delivered', 'bounce', 'spamreport'], secret: 'signed event webhook public key' },
  { provider: 'brevo', channel: 'email', verification: 'token', events: ['delivered', 'hard_bounce', 'spam'], secret: null },
  { provider: 'mailgun', channel: 'email', verification: 'signature', events: ['delivered', 'failed', 'complained'], secret: 'HTTP webhook signing key' },
  { provider: 'postmark', channel: 'email', verification: 'token', events: ['Delivery', 'Bounce', 'SpamComplaint'], secret: null },
  { provider: 'resend', channel: 'email', verification: 'signature', events: ['email.delivered', 'email.bounced', 'email.complained'], secret: 'whsec_ signing secret' },
  { provider: 'smtp2go', channel: 'email', verification: 'token', events: ['delivered', 'bounce', 'spam'], secret: null },
  { provider: 'twilio', channel: 'sms', verification: 'signature', events: ['delivered', 'undelivered', 'failed'], secret: null },
  { provider: 'vonage', channel: 'sms', verification: 'signature_or_token', events: ['delivered', 'failed'], secret: 'signature secret' },
  { provider: 'messagebird', channel: 'sms', verification: 'signature', events: ['delivered', 'delivery_failed'], secret: 'signing key' },
];
const CALLING_CODES: Record<string, string> = { '1': 'US', '44': 'GB', '49': 'DE', '33': 'FR', '34': 'ES', '39': 'IT', '31': 'NL', '61': 'AU', '91': 'IN', '81': 'JP', '55': 'BR', '52': 'MX', '353': 'IE', '46': 'SE', '47': 'NO', '45': 'DK', '41': 'CH', '43': 'AT', '32': 'BE', '48': 'PL', '351': 'PT', '65': 'SG', '64': 'NZ', '27': 'ZA', '234': 'NG', '971': 'AE' };
const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FALLBACKS = 5;
const MAX_BATCH = 1000;

interface Fault {
  provider_id: string;
  channel?: string;
  times: number;
}
interface MsgState {
  ledger: Table;
  suppressions: Table;
  fallbacks: Table;
  routes: Map<string, Obj>;
  secrets: Map<string, number>;
  settings: { auto_suppress: boolean; failover_enabled: boolean; ledger_retention_days: number; updated_at: number | null };
  faults: Fault[];
}
const st = engineState((e: Engine): MsgState => ({
  ledger: new Table('message_ledger', e.clock.now, 'msg'),
  suppressions: new Table('message_suppressions', e.clock.now, 'msup'),
  fallbacks: new Table('messaging_fallbacks', e.clock.now, 'mfb'),
  routes: new Map(),
  secrets: new Map(),
  settings: { auto_suppress: true, failover_enabled: true, ledger_retention_days: 90, updated_at: null },
  faults: [],
}));

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

function takeFault(s: MsgState, providerId: string, channel: string): boolean {
  const f = s.faults.find((x) => x.provider_id === providerId && (!x.channel || x.channel === channel) && x.times > 0);
  if (!f) return false;
  f.times--;
  return true;
}

/** Install suppression, failover and the ledger on the engine's message sink. Called once by the engine. */
export function installMessaging(e: Engine): void {
  e.messages.route = (m) => {
    const s = st(e);
    const now = e.clock.now();
    const channel = (CHANNELS as readonly string[]).includes(m.channel) ? m.channel : 'email';
    const to = normalAddress(channel, m.to);
    const row = s.ledger.insert({
      channel,
      template: typeof m.meta?.template === 'string' ? m.meta.template : 'custom',
      recipient: to,
      country: channel === 'sms' ? countryOf(to) : null,
      status: 'queued',
      status_detail: null,
      provider: null,
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
    // Primary first (or the country's route for SMS), then active fallbacks in order, when failover is on.
    const fb = s.fallbacks.all().filter((f) => f.channel === channel && f.status === 'active').sort((a, b) => a.position - b.position);
    let order: Array<{ id: string; transport: string }> = [{ id: 'primary', transport: 'emulator' }, ...fb.map((f) => ({ id: f.id, transport: f.transport }))];
    const routed = row.country ? s.routes.get(row.country)?.provider_id : undefined;
    if (routed) order = [...order.filter((p) => p.id === routed), ...order.filter((p) => p.id !== routed)];
    if (!s.settings.failover_enabled) order = order.slice(0, 1);
    for (const p of order) {
      if (takeFault(s, p.id, channel)) {
        row.attempts.push({ provider: p.transport, provider_id: p.id, status: 'failed', error: 'injected provider failure', at: e.clock.now() });
        continue;
      }
      row.attempts.push({ provider: p.transport, provider_id: p.id, status: 'sent', at: e.clock.now() });
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
    // ── status receivers ──
    {
      method: 'GET',
      pattern: '/v1/message_receivers',
      scope: 'messaging:read',
      handler: (c) => ({
        body: {
          object: 'list',
          has_more: false,
          data: RECEIVERS.map((r) => ({ object: 'message_receiver', provider: r.provider, channel: r.channel, verification: r.verification, url: `${c.engine.issuer}/v1/message_receivers/${r.provider}/${c.engine.instanceId}`, token_required: r.verification === 'token', secret_set: st(c.engine).secrets.has(r.provider), secret_help: r.secret, events: r.events, last_event_at: st(c.engine).secrets.get(r.provider) ?? null, last_error: null })),
        },
      }),
    },
    {
      method: 'PUT',
      pattern: '/v1/message_receivers/:provider/secret',
      scope: 'messaging:write',
      handler: (c) => {
        const r = RECEIVERS.find((x) => x.provider === c.params.provider);
        if (!r) throw notFound(`Provider (use one of: ${RECEIVERS.map((x) => x.provider).join(', ')})`);
        if (r.secret === null) throw new EmulatorError('VALIDATION_FAILED', `${r.provider} needs no verification secret.`, 'secret');
        if (typeof c.body.secret !== 'string' || !c.body.secret.trim() || c.body.secret.length > 4096) throw new EmulatorError('VALIDATION_FAILED', 'secret must be a non-empty string of at most 4096 characters.', 'secret');
        if (r.provider === 'resend' && !c.body.secret.startsWith('whsec_')) throw new EmulatorError('VALIDATION_FAILED', 'secret must be the Resend webhook signing secret (whsec_...).', 'secret');
        st(c.engine).secrets.set(r.provider, c.engine.clock.now());
        return { body: { object: 'message_receiver', provider: r.provider, secret_set: true } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/message_receivers/:provider/secret',
      scope: 'messaging:write',
      handler: (c) => {
        if (!st(c.engine).secrets.delete(c.params.provider ?? '')) throw notFound('Verification secret for that provider');
        return { body: { object: 'message_receiver', provider: c.params.provider, deleted: true } };
      },
    },
    // ── emulator controls: make a provider fail, play a delivery callback ──
    {
      method: 'POST',
      pattern: '/__emulator/messaging/faults',
      public: true,
      handler: (c) => {
        const times = intIn(c.body.times, 'times', 1, 1000, 1);
        st(c.engine).faults.push({ provider_id: String(c.body.provider_id ?? 'primary'), channel: typeof c.body.channel === 'string' ? c.body.channel : undefined, times });
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
  ];
}
