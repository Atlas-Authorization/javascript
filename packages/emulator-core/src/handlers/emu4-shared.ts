/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { sha256 } from '../crypto-util';
import { engineState } from './support';

/**
 * Shared by the round-four compliance and federation modules: the instance configuration the emulator keeps for the
 * compliance settings (the part a config snapshot captures), the audit trail those routes write, and small helpers.
 */
export const bad = (message: string, param?: string) => new EmulatorError('VALIDATION_FAILED', message, param);
export const conflict = (message: string) => new EmulatorError('CONFLICT', message);
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export const hex = async (data: string): Promise<string> => [...(await sha256(data))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const DAY = 86_400_000;
export const listOf = (data: Obj[], extra: Obj = {}): Obj => ({ object: 'list', data, has_more: false, next_cursor: null, ...extra });
export const needObj = (v: unknown, param: string): Obj => {
  if (!isObj(v)) throw bad(`${param} must be an object.`, param);
  return v;
};

/** Canonical JSON (sorted keys), the form digests and diffs compare. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

// ── instance configuration the compliance settings live in ──

export const MINOR_DEFAULTS: Obj = { enabled: false, birthdateTrait: 'birthdate', countryTrait: null, defaultConsentAge: 13, consentAges: {}, minimumAge: null, restriction: 'hold', consentTtlHours: 72, consentMethods: ['email_link', 'admin'], minAssuranceLevel: 'low', trustedAgeMethods: [] };
export const COOKIE_DEFAULTS: Obj = { enabled: false, categories: ['necessary', 'functional', 'analytics', 'marketing'], policyVersion: null, honorGpc: true, honorDnt: false, repromptDays: 365, retentionDays: 0 };
export const DATA_POLICY_DEFAULTS: Obj = { controller: { name: null, contactEmail: null, dpoEmail: null }, activities: [] };
export const INACTIVE_DEFAULTS: Obj = { enabled: false, afterDays: 730, warnDays: 30, action: 'notify' };

const defaults = (): Obj => ({
  compliance: { minors: structuredClone(MINOR_DEFAULTS), cookieConsent: structuredClone(COOKIE_DEFAULTS), dataPolicy: structuredClone(DATA_POLICY_DEFAULTS), inactiveUsers: structuredClone(INACTIVE_DEFAULTS), dataRegion: null, consents: [], retention: { dsrDueDays: 30, erasureGraceDays: 7, deletedUserGraceDays: 30, anonymousRetentionDays: 30, ownershipTransfer: 'off' } },
  localization: { requireReview: false, requireFourEyes: false },
  approvals: {},
});
export const instanceConfig = engineState((): Obj => defaults());
export const resetInstanceConfig = (e: Engine): void => {
  const cfg = instanceConfig(e);
  for (const k of Object.keys(cfg)) delete cfg[k];
  Object.assign(cfg, defaults());
};
export const minorsCfg = (e: Engine): Obj => instanceConfig(e).compliance.minors;
export const cookieCfg = (e: Engine): Obj => instanceConfig(e).compliance.cookieConsent;

// ── audit trail ──

export interface AuditRow {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  target_type: string;
  target_id: string;
  metadata: Obj;
  created_at: number;
}
export const auditLog = engineState((): AuditRow[] => []);
export const actorOf = (c: RouteContext | null): { type: string; id: string | null } => (c?.key ? { type: 'api_key', id: `apikey_${c.key.key.slice(-8)}` } : { type: 'system', id: null });
export function audit(e: Engine, c: RouteContext | null, action: string, targetType: string, targetId: string, metadata: Obj = {}): void {
  const a = actorOf(c);
  auditLog(e).push({ id: e.db.newId('audit'), action, actor_type: a.type, actor_id: a.id, target_type: targetType, target_id: targetId, metadata, created_at: e.clock.now() });
}

export const liveUser = (e: Engine, id: string | undefined): Obj => {
  const u = e.db.users.get(id);
  if (!u || u.deleted) throw notFound('User');
  return u;
};

export const iso = (ms: number): string => new Date(ms).toISOString();

/** Pagination over a newest-first array with the real `limit` / `starting_after` query. */
export function pageReply(c: RouteContext, items: Obj[]): Obj {
  const limit = Math.min(Math.max(Number(c.query.get('limit') ?? 20) || 20, 1), 100);
  const after = c.query.get('starting_after');
  let start = 0;
  if (after) {
    const at = items.findIndex((i) => i.id === after);
    start = at < 0 ? items.length : at + 1;
  }
  const data = items.slice(start, start + limit);
  const more = start + limit < items.length;
  return { object: 'list', data, has_more: more, next_cursor: more ? (data[data.length - 1]?.id ?? null) : null };
}
