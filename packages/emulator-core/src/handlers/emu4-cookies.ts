/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState, sessionFromBearer } from './support';
import { audit, bad, cookieCfg, DAY, isObj, pageReply } from './emu4-shared';

/**
 * The cookie consent store: an append-only ledger of each visitor's choice, honoring Global Privacy Control (and Do Not Track when
 * the instance says so), asking again when the policy version changed, the choice expired or a category was added. The visitor id
 * is the credential for its own records. Settings: `compliance.cookieConsent`. The emulator does not check the publishable key.
 */
const SUBJECT_RE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_CHOICES_PER_HOUR = 30;
const FIELDS = ['subject', 'categories', 'gpc', 'dnt', 'source', 'region', 'locale', 'policy_version'];

const ledger = engineState((e: Engine) => new Table('cookie_consent_records', e.clock.now, 'cc'));

const readSubject = (v: unknown): string => {
  if (typeof v !== 'string' || !SUBJECT_RE.test(v)) throw bad('subject is an opaque visitor id of 16 to 128 characters (letters, digits, - and _). Generate a random one in the browser.', 'subject');
  return v;
};
const requireEnabled = (cfg: Obj): void => {
  if (!cfg.enabled) throw bad('The cookie consent store is off for this application (compliance.cookieConsent.enabled).', 'compliance.cookieConsent.enabled');
};
const anonymizeIp = (ip: string | null): string | null => {
  if (!ip) return null;
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.0`;
  return ip.includes(':') ? `${ip.split(':').slice(0, 3).join(':')}::` : null;
};

/** `necessary` is always on; a signal the instance honors forces every other category off. */
function effective(cfg: Obj, sent: Record<string, boolean>, s: { gpc: boolean; dnt: boolean }): { categories: Record<string, boolean>; signal: 'gpc' | 'dnt' | null } {
  const signal = s.gpc && cfg.honorGpc ? 'gpc' : s.dnt && cfg.honorDnt ? 'dnt' : null;
  const categories: Record<string, boolean> = {};
  for (const c of cfg.categories as string[]) categories[c] = c === 'necessary' ? true : signal ? false : sent[c] === true;
  return { categories, signal };
}

function stale(e: Engine, cfg: Obj, rec: Obj | undefined): 'none' | 'no_choice' | 'policy_changed' | 'expired' | 'categories_changed' {
  if (!rec) return 'no_choice';
  if (cfg.policyVersion !== null && rec.policy_version !== cfg.policyVersion) return 'policy_changed';
  if (cfg.repromptDays > 0 && e.clock.now() - rec.created_at > cfg.repromptDays * DAY) return 'expired';
  if ((cfg.categories as string[]).some((c) => !(c in rec.categories))) return 'categories_changed';
  return 'none';
}

const present = (r: Obj, includeSubject = true): Obj => ({
  object: 'cookie_consent_record',
  id: r.id,
  ...(includeSubject ? { subject: r.subject } : {}),
  user_id: r.user_id ?? null,
  categories: r.categories,
  policy_version: r.policy_version ?? null,
  source: r.source,
  gpc: r.gpc,
  dnt: r.dnt,
  signal_applied: r.signal_applied ?? null,
  region: r.region ?? null,
  locale: r.locale ?? null,
  created_at: r.created_at,
});

const latestOf = (e: Engine, subject: string): Obj | undefined => ledger(e).filter((r) => r.subject === subject)[0];
const signals = (c: RouteContext) => ({ gpc: c.request.headers.get('sec-gpc') === '1', dnt: c.request.headers.get('dnt') === '1' });

export function cookieHandlers(): RouteDef[] {
  const READ = 'data_subject_requests:read';
  const WRITE = 'data_subject_requests:write';
  const erase = (e: Engine, by: { subject?: string; userId?: string }): number => {
    let n = 0;
    for (const r of ledger(e).all()) if ((by.subject && r.subject === by.subject) || (by.userId && r.user_id === by.userId)) n += ledger(e).delete(r.id) ? 1 : 0;
    return n;
  };

  return [
    // ── the application's own site (publishable key) ──
    { method: 'GET', pattern: '/v1/client/cookie_consent', public: true, handler: (c) => {
      const e = c.engine;
      const cfg = cookieCfg(e);
      requireEnabled(cfg);
      const subject = readSubject(c.query.get('subject'));
      const latest = latestOf(e, subject);
      const reason = stale(e, cfg, latest);
      const fallback = effective(cfg, {}, signals(c));
      return { headers: { 'cache-control': 'no-store' }, body: {
        object: 'cookie_consent_state', enabled: cfg.enabled, subject, categories: latest?.categories ?? fallback.categories, decided: !!latest,
        reprompt: reason !== 'none', reprompt_reason: reason === 'none' ? null : reason, policy_version: cfg.policyVersion,
        config: { categories: cfg.categories, honor_gpc: cfg.honorGpc, honor_dnt: cfg.honorDnt, reprompt_days: cfg.repromptDays },
        signal_applied: fallback.signal, recorded_at: latest?.created_at ?? null,
      } };
    } },
    { method: 'POST', pattern: '/v1/client/cookie_consent', public: true, handler: (c) => {
      const e = c.engine;
      const b = c.body;
      const unknown = Object.keys(b).find((k) => !FIELDS.includes(k));
      if (unknown) throw bad(`Unrecognised field ${unknown}. Expected any of ${FIELDS.join(', ')}.`, unknown);
      const cfg = cookieCfg(e);
      requireEnabled(cfg);
      const subject = readSubject(b.subject);
      if (!isObj(b.categories)) throw bad('categories is an object of category name to true or false.', 'categories');
      const sent: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(b.categories)) {
        if (!(cfg.categories as string[]).includes(k)) throw bad(`Unknown category "${k}". This application asks about: ${(cfg.categories as string[]).join(', ')}.`, `categories.${k}`);
        if (typeof v !== 'boolean') throw bad('Each category is true or false.', `categories.${k}`);
        sent[k] = v;
      }
      for (const k of ['gpc', 'dnt'] as const) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw bad(`${k} is a boolean.`, k);
      const source = b.source === undefined ? 'banner' : b.source;
      if (source !== 'banner' && source !== 'api' && source !== 'signal') throw bad('source is banner, api or signal.', 'source');
      for (const k of ['region', 'locale'] as const) if (b[k] !== undefined && (typeof b[k] !== 'string' || (b[k] as string).length > 35)) throw bad(`${k} is text of at most 35 characters.`, k);
      if (b.policy_version !== undefined && cfg.policyVersion !== null && b.policy_version !== cfg.policyVersion) {
        throw new EmulatorError('CONFLICT', `The banner showed policy version "${String(b.policy_version)}"; the current one is "${cfg.policyVersion}". Show it again and record the new choice.`, undefined, { meta: { policy_version: cfg.policyVersion } });
      }
      const s = signals(c);
      const gpc = s.gpc || b.gpc === true;
      const dnt = s.dnt || b.dnt === true;
      const idem = c.request.headers.get('idempotency-key')?.slice(0, 128) || null;
      const prior = idem ? ledger(e).find((r) => r.subject === subject && r.idempotency_key === idem) : undefined;
      if (prior) return { status: 200, headers: { 'cache-control': 'no-store' }, body: { ...present(prior), reprompt: false } };
      if (ledger(e).filter((r) => r.subject === subject && r.created_at >= e.clock.now() - 3_600_000).length >= MAX_CHOICES_PER_HOUR) throw new EmulatorError('RATE_LIMITED', 'Too many choices recorded for this visitor. Try again later.');
      const out = effective(cfg, sent, { gpc, dnt });
      const row = ledger(e).insert({ subject, user_id: null, categories: out.categories, policy_version: cfg.policyVersion, source, gpc, dnt, signal_applied: out.signal, region: b.region ?? null, locale: b.locale ?? null, ip_anon: anonymizeIp(c.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null), idempotency_key: idem, created_at: e.clock.now() } as any);
      e.webhooks.emit('cookie_consent.recorded', { object: 'cookie_consent', subject, categories: out.categories, policy_version: row.policy_version, signal_applied: out.signal, user_id: null, recorded_at: row.created_at });
      return { status: 201, headers: { 'cache-control': 'no-store' }, body: { ...present(row), reprompt: false } };
    } },
    { method: 'DELETE', pattern: '/v1/client/cookie_consent', public: true, handler: (c) => {
      const subject = readSubject(c.query.get('subject'));
      return { headers: { 'cache-control': 'no-store' }, body: { object: 'cookie_consent_erasure', subject, removed: erase(c.engine, { subject }) } };
    } },
    { method: 'POST', pattern: '/v1/client/me/cookie_consent/link', public: true, handler: async (c) => {
      const e = c.engine;
      const me = await sessionFromBearer(c);
      const unknown = Object.keys(c.body).find((k) => k !== 'subject');
      if (unknown) throw bad(`Unrecognised field ${unknown}. Expected any of subject.`, unknown);
      const subject = readSubject(c.body.subject);
      let linked = 0;
      for (const r of ledger(e).all()) if (r.subject === subject && !r.user_id) {
        r.user_id = me.userId;
        linked += 1;
      }
      return { headers: { 'cache-control': 'no-store' }, body: { object: 'cookie_consent_link', linked } };
    } },

    // ── the operator ──
    { method: 'GET', pattern: '/v1/cookie_consents', scope: READ, handler: (c) => {
      const e = c.engine;
      const rows = ledger(e).filter((r) => (!c.query.get('user_id') || r.user_id === c.query.get('user_id')) && (!c.query.get('subject') || r.subject === c.query.get('subject')));
      return { body: pageReply(c, rows.map((r) => present(r))) };
    } },
    { method: 'GET', pattern: '/v1/cookie_consents/summary', scope: READ, handler: (c) => {
      const e = c.engine;
      const days = c.query.get('days') === null ? 30 : Number(c.query.get('days'));
      if (!Number.isInteger(days) || days < 1 || days > 365) throw bad('days is a whole number from 1 to 365.', 'days');
      const cfg = cookieCfg(e);
      const since = e.clock.now() - days * DAY;
      const rows = ledger(e).filter((r) => r.created_at >= since);
      const latest = new Map<string, Obj>();
      for (const r of [...rows].reverse()) latest.set(r.subject, r);
      return { body: {
        object: 'cookie_consent_summary', enabled: cfg.enabled, days, policy_version: cfg.policyVersion, choices_recorded: rows.length, visitors: latest.size,
        global_privacy_control: rows.filter((r) => r.gpc).length,
        opted_in: Object.fromEntries((cfg.categories as string[]).map((k) => [k, [...latest.values()].filter((r) => r.categories[k] === true).length])),
      } };
    } },
    { method: 'GET', pattern: '/v1/cookie_consents/subjects/:subject', scope: READ, handler: (c) => {
      const subject = readSubject(c.params.subject);
      const history = ledger(c.engine).filter((r) => r.subject === subject);
      if (history.length === 0) throw notFound('No choices recorded for this visitor.');
      return { body: { object: 'cookie_consent_subject', subject, current: present(history[0]!), history: history.map((r) => present(r, false)) } };
    } },
    { method: 'DELETE', pattern: '/v1/cookie_consents/subjects/:subject', scope: WRITE, handler: (c) => {
      const subject = readSubject(c.params.subject);
      const removed = erase(c.engine, { subject });
      audit(c.engine, c, 'cookie_consent.erased', 'cookie_consent', subject.slice(0, 8), { removed, by: 'subject' });
      return { body: { object: 'cookie_consent_erasure', removed } };
    } },
    { method: 'DELETE', pattern: '/v1/users/:id/cookie_consents', scope: WRITE, handler: (c) => {
      const removed = erase(c.engine, { userId: c.params.id });
      audit(c.engine, c, 'cookie_consent.erased', 'cookie_consent', c.params.id!, { removed, by: 'user' });
      return { body: { object: 'cookie_consent_erasure', removed } };
    } },

    // ── emulator helper: the worker's retention pass (compliance.cookieConsent.retentionDays) ──
    { method: 'POST', pattern: '/__emulator/compliance/cookie_consent/sweep', public: true, handler: (c) => {
      const e = c.engine;
      const days = cookieCfg(e).retentionDays as number;
      let removed = 0;
      if (days > 0) for (const r of ledger(e).all()) if (e.clock.now() - r.created_at > days * DAY) removed += ledger(e).delete(r.id) ? 1 : 0;
      return { body: { object: 'cookie_consent_sweep', retention_days: days, removed } };
    } },
  ];
}

/** Erasing a user deletes the cookie choices linked to them (called from the erasure hook). */
export const eraseCookieRecordsOfUser = (e: Engine, userId: string): number => {
  let n = 0;
  for (const r of ledger(e).all()) if (r.user_id === userId) n += ledger(e).delete(r.id) ? 1 : 0;
  return n;
};

export function validateCookieConsent(raw: unknown): Array<{ param: string; message: string }> {
  const p = 'compliance.cookieConsent';
  if (!isObj(raw)) return [{ param: p, message: 'Expected an object.' }];
  const out: Array<{ param: string; message: string }> = [];
  const known = ['enabled', 'categories', 'policyVersion', 'honorGpc', 'honorDnt', 'repromptDays', 'retentionDays'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) out.push({ param: `${p}.${k}`, message: `Unknown field. Expected ${known.join(', ')}.` });
  for (const k of ['enabled', 'honorGpc', 'honorDnt'] as const) if (raw[k] !== undefined && typeof raw[k] !== 'boolean') out.push({ param: `${p}.${k}`, message: 'Expected a boolean.' });
  if (raw.categories !== undefined && (!Array.isArray(raw.categories) || raw.categories.length > 20 || raw.categories.some((x) => typeof x !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(x)))) out.push({ param: `${p}.categories`, message: 'Up to 20 lowercase names (letters, digits, _).' });
  if (raw.policyVersion != null && !(typeof raw.policyVersion === 'string' && raw.policyVersion.trim() && raw.policyVersion.length <= 64)) out.push({ param: `${p}.policyVersion`, message: 'Text of at most 64 characters, or null.' });
  if (raw.repromptDays !== undefined && !(typeof raw.repromptDays === 'number' && Number.isInteger(raw.repromptDays) && raw.repromptDays >= 0 && raw.repromptDays <= 3650)) out.push({ param: `${p}.repromptDays`, message: 'Whole days from 0 to 3650.' });
  if (raw.retentionDays !== undefined && !(typeof raw.retentionDays === 'number' && Number.isInteger(raw.retentionDays) && raw.retentionDays >= 0 && raw.retentionDays <= 36500)) out.push({ param: `${p}.retentionDays`, message: 'Whole days from 0 to 36500.' });
  return out;
}
