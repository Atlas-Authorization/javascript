/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState } from './support';
import { audit, bad, conflict, isObj, liveUser, listOf, minorsCfg } from './emu4-shared';

/**
 * Family accounts: age assurance records, guardian consent with several methods and an assurance floor, and the minor profile
 * they settle. Config lives in `compliance.minors` (see the `/__emulator/compliance/config` route). shortcut: no session is held
 * for a minor without consent (the emulator issues sessions without this gate); read `minor_status` instead.
 */
const LEVELS = ['low', 'medium', 'high'] as const;
const CONSENT_METHODS = ['email_link', 'admin', 'signed_form', 'payment_card', 'video_call', 'id_document', 'third_party'] as const;
const AGE_METHODS = ['self_declared', 'id_document', 'payment_card', 'estimation', 'credential', 'third_party', 'admin'] as const;
const CONSENT_LEVEL: Record<string, string> = { email_link: 'low', admin: 'medium', signed_form: 'medium', payment_card: 'medium', video_call: 'high', id_document: 'high' };
const AGE_LEVEL: Record<string, string> = { self_declared: 'low', estimation: 'medium', payment_card: 'medium', admin: 'medium', credential: 'high', id_document: 'high' };
const rank = (l: string) => LEVELS.indexOf(l as any);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Minors {
  profiles: Map<string, Obj>;
  links: Table;
  assurances: Table;
  verifications: Table;
}
const st = engineState((e: Engine): Minors => ({
  profiles: new Map(),
  links: new Table('guardian_links', e.clock.now, 'gl'),
  assurances: new Table('age_assurances', e.clock.now, 'aa'),
  verifications: new Table('identity_verifications', e.clock.now, 'idv'),
}));

/** The identity checks recorded for users (the id_document methods rest on them). */
export const verificationRows = (e: Engine): Table => st(e).verifications;

const consentLevel = (method: string, stated?: string | null): string => (method === 'third_party' ? (stated ?? 'low') : CONSENT_LEVEL[method]!);
const ageLevel = (method: string, stated?: string | null): string => (method === 'third_party' ? (stated ?? 'low') : AGE_LEVEL[method]!);

function consentAllowed(cfg: Obj, method: string, stated?: string | null): { ok: true; level: string } | { ok: false; reason: 'method_not_accepted' | 'level_too_low'; level: string } {
  const level = consentLevel(method, stated);
  if (!(cfg.consentMethods as string[]).includes(method)) return { ok: false, reason: 'method_not_accepted', level };
  if (rank(level) < rank(cfg.minAssuranceLevel)) return { ok: false, reason: 'level_too_low', level };
  return { ok: true, level };
}

const ageOn = (birth: string, now: number): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth);
  if (!m) return null;
  const n = new Date(now);
  let age = n.getUTCFullYear() - Number(m[1]);
  if (n.getUTCMonth() + 1 < Number(m[2]) || (n.getUTCMonth() + 1 === Number(m[2]) && n.getUTCDate() < Number(m[3]))) age -= 1;
  return age;
};

function assess(e: Engine, u: Obj): { status: 'adult' | 'unknown' | 'below_minimum' | 'consent_required'; age?: number; consentAge?: number; jurisdiction?: string | null; birthdate?: string } {
  const cfg = minorsCfg(e);
  const meta = (u.public_metadata ?? {}) as Obj;
  const birthdate = meta[cfg.birthdateTrait];
  const age = typeof birthdate === 'string' ? ageOn(birthdate, e.clock.now()) : null;
  if (age === null) return { status: 'unknown' };
  const country = cfg.countryTrait && typeof meta[cfg.countryTrait] === 'string' ? String(meta[cfg.countryTrait]).toUpperCase() : null;
  const byCountry = country ? (cfg.consentAges as Obj)[country] : undefined;
  const consentAge: number = typeof byCountry === 'number' ? byCountry : cfg.defaultConsentAge;
  if (cfg.minimumAge !== null && age < cfg.minimumAge) return { status: 'below_minimum', age, consentAge, birthdate: birthdate as string };
  if (age >= consentAge) return { status: 'adult', age, consentAge, birthdate: birthdate as string };
  return { status: 'consent_required', age, consentAge, jurisdiction: typeof byCountry === 'number' ? country : null, birthdate: birthdate as string };
}

const validAssurances = (e: Engine, userId: string): Obj[] => st(e).assurances.filter((r) => r.user_id === userId && r.status === 'valid' && !(r.expires_at && r.expires_at <= e.clock.now()));

/** Recompute a user's minor profile. A recorded age assurance by a trusted method settles the question without a date of birth. */
function refresh(e: Engine, u: Obj): Obj | null {
  const cfg = minorsCfg(e);
  if (!cfg.enabled) return null;
  const s = st(e);
  const a = assess(e, u);
  const existing = s.profiles.get(u.id);
  if (a.status === 'consent_required' && (cfg.trustedAgeMethods as string[]).length > 0) {
    const proven = validAssurances(e, u.id).some((r) => (cfg.trustedAgeMethods as string[]).includes(r.method) && r.over_age >= a.consentAge!);
    if (proven) {
      s.profiles.delete(u.id);
      return null;
    }
  }
  if (a.status === 'adult' || a.status === 'unknown') {
    if (a.status === 'adult') s.profiles.delete(u.id);
    return a.status === 'unknown' ? (existing ?? null) : null;
  }
  const profile: Obj = { birthdate: a.birthdate, age_at_assessment: a.age, consent_age: a.status === 'consent_required' ? a.consentAge : cfg.defaultConsentAge, jurisdiction: a.status === 'consent_required' ? (a.jurisdiction ?? null) : null, status: existing?.status ?? 'consent_required', consented_at: existing?.consented_at ?? null };
  s.profiles.set(u.id, profile);
  if (!existing) e.webhooks.emit('user.parental_consent_required', { object: 'minor_status', user_id: u.id, status: 'consent_required', consent_age: profile.consent_age });
  return profile;
}

const presentMinor = (p: Obj | null | undefined): Obj => (!p ? { object: 'minor_status', status: 'not_required' } : { object: 'minor_status', status: p.status, birthdate: p.birthdate, age_at_assessment: p.age_at_assessment, consent_age: p.consent_age, jurisdiction: p.jurisdiction, consented_at: p.consented_at });

const presentGuardian = (e: Engine, l: Obj, extra: Obj = {}): Obj => ({
  object: 'guardian_link',
  id: l.id,
  child_user_id: l.child_user_id,
  guardian_user_id: l.guardian_user_id,
  guardian_email: l.guardian_email,
  relationship: l.relationship,
  status: l.status === 'pending' && l.expires_at && l.expires_at <= e.clock.now() ? 'expired' : l.status,
  expires_at: l.expires_at,
  consent_method: l.consent_method ?? null,
  assurance_level: l.assurance_level ?? null,
  consent_reference: l.consent_reference ?? null,
  verification_id: l.verification_id ?? null,
  consented_at: l.consented_at ?? null,
  created_at: l.created_at,
  ...extra,
});

const presentAssurance = (e: Engine, r: Obj): Obj => ({
  object: 'age_assurance',
  id: r.id,
  user_id: r.user_id,
  method: r.method,
  level: r.level,
  over_age: r.over_age,
  provider: r.provider ?? null,
  reference: r.reference ?? null,
  verification_id: r.verification_id ?? null,
  status: r.status === 'valid' && r.expires_at && r.expires_at <= e.clock.now() ? 'expired' : r.status,
  trusted: (minorsCfg(e).trustedAgeMethods as string[]).includes(r.method),
  expires_at: r.expires_at ?? null,
  revoked_at: r.revoked_at ?? null,
  revoked_reason: r.revoked_reason ?? null,
  created_at: r.created_at,
});

/** Mark the child consented / back to required, from the set of active links. */
function syncChild(e: Engine, childId: string, declined = false): string | null {
  const s = st(e);
  const profile = s.profiles.get(childId);
  if (!profile) return null;
  const active = s.links.filter((l) => l.child_user_id === childId).some((l) => l.status === 'active');
  const next = active ? 'consented' : declined ? 'declined' : 'consent_required';
  if (next !== profile.status) {
    profile.status = next;
    profile.consented_at = active ? e.clock.now() : null;
    e.webhooks.emit(next === 'consented' ? 'user.parental_consent_granted' : next === 'declined' ? 'user.parental_consent_declined' : 'user.parental_consent_required', { object: 'minor_status', user_id: childId, status: next, consent_age: profile.consent_age });
  }
  return next;
}

/** An approved identity verification the guardian (or the user) holds; the id_document methods rest on it. */
function approvedVerification(e: Engine, id: string, userId: string): boolean {
  const own = st(e).verifications.get(id);
  if (own) return own.user_id === userId && own.status === 'approved';
  for (const [name, t] of e.generic) {
    if (!name.includes('identity_verification')) continue;
    const r = t.get(id);
    if (r && (r._parent === userId || r.user_id === userId) && r.status === 'approved') return true;
  }
  return false;
}

const unknownField = (b: Obj, allowed: string[]) => {
  const k = Object.keys(b).find((x) => !allowed.includes(x));
  if (k) throw bad(`Unrecognised field ${k}. Expected any of ${allowed.join(', ')}.`, k);
};

const displayName = (u: Obj) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'A user';

export function minorsHandlers(): RouteDef[] {
  const linkOf = (e: Engine, childId: string, linkId: string | undefined): Obj => {
    const l = st(e).links.get(linkId);
    if (!l || l.child_user_id !== childId) throw notFound('Guardian link');
    return l;
  };
  const byToken = (e: Engine, token: string): Obj => {
    const l = st(e).links.find((x) => x.token === token);
    if (!l || l.status !== 'pending' || !l.expires_at || l.expires_at <= e.clock.now() || !e.db.users.get(l.child_user_id)) throw notFound('This consent link');
    return l;
  };
  const statusBody = (e: Engine, userId: string): Obj => {
    const top = validAssurances(e, userId)[0];
    return { ...presentMinor(st(e).profiles.get(userId)), age_assurance: top ? { over_age: top.over_age, method: top.method, level: top.level, expires_at: top.expires_at ?? null } : null, guardians: st(e).links.filter((l) => l.child_user_id === userId).map((l) => presentGuardian(e, l)) };
  };

  return [
    { method: 'GET', pattern: '/v1/users/:id/minor_status', scope: 'users:read', handler: (c) => {
      liveUser(c.engine, c.params.id);
      return { body: statusBody(c.engine, c.params.id!) };
    } },
    { method: 'POST', pattern: '/v1/users/:id/minor_status/assess', scope: 'users:write', handler: (c) => {
      const e = c.engine;
      const u = liveUser(e, c.params.id);
      if (!minorsCfg(e).enabled) throw bad('Age gating is off for this application (compliance.minors.enabled).', 'compliance.minors.enabled');
      refresh(e, u);
      return { body: statusBody(e, u.id) };
    } },
    { method: 'POST', pattern: '/v1/users/:id/guardians', scope: 'users:write', handler: (c) => {
      const e = c.engine;
      const child = liveUser(e, c.params.id);
      const b = c.body;
      unknownField(b, ['email', 'guardian_user_id', 'relationship', 'send_email']);
      let guardianEmail: string | null = null;
      let guardianUserId: string | null = null;
      if (typeof b.guardian_user_id === 'string' && b.guardian_user_id) {
        const g = liveUser(e, b.guardian_user_id);
        if (g.id === child.id) throw bad('A user cannot be their own guardian.', 'guardian_user_id');
        guardianUserId = g.id;
      }
      if (b.email !== undefined) {
        if (typeof b.email !== 'string' || !EMAIL_RE.test(b.email.trim()) || b.email.length > 320) throw bad('email must be an email address.', 'email');
        guardianEmail = b.email.trim().toLowerCase();
      }
      if (!guardianEmail && !guardianUserId) throw bad('Name the guardian: email or guardian_user_id.', 'email');
      if (guardianUserId && !guardianEmail) {
        const emails = (e.db.users.get(guardianUserId)!.emails as Obj[]) ?? [];
        guardianEmail = (emails.find((m) => m.verified) ?? emails[0])?.email_address ?? null;
      }
      const relationship = typeof b.relationship === 'string' ? b.relationship.trim().slice(0, 40) || null : null;
      if (b.send_email !== undefined && typeof b.send_email !== 'boolean') throw bad('send_email must be a boolean.', 'send_email');
      const cfg = minorsCfg(e);
      const emailOk = consentAllowed(cfg, 'email_link').ok;
      if (!emailOk && b.send_email === true) throw bad('Consent by email link is not accepted here (compliance.minors.consentMethods, minAssuranceLevel), so there is nothing to email. Record consent with the approve route.', 'send_email');
      const now = e.clock.now();
      const token = emailOk ? `gct_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}` : null;
      const link = st(e).links.insert({ child_user_id: child.id, guardian_user_id: guardianUserId, guardian_email: guardianEmail, relationship, status: 'pending', token, expires_at: emailOk ? now + cfg.consentTtlHours * 3_600_000 : null, created_at: now } as any);
      const consentUrl = token ? `${e.issuer}/hosted/parental-consent?token=${encodeURIComponent(token)}` : null;
      let emailed = false;
      if (b.send_email === true) {
        if (!guardianEmail) throw bad('There is no address to send the request to.', 'email');
        e.messages.send({ channel: 'email', to: guardianEmail, subject: `Parental consent for ${displayName(child)}`, body: `Approve or decline: ${consentUrl}`, link: consentUrl ?? undefined });
        emailed = true;
      }
      audit(e, c, 'user.guardian_consent_requested', 'user', child.id, { guardian_link_id: link.id, emailed });
      return { status: 201, body: presentGuardian(e, link, { consent_url: consentUrl, emailed }) };
    } },
    { method: 'POST', pattern: '/v1/users/:id/guardians/:linkId/approve', scope: 'users:write', handler: (c) => {
      const e = c.engine;
      liveUser(e, c.params.id);
      const link = linkOf(e, c.params.id!, c.params.linkId);
      if (link.status === 'active') return { body: presentGuardian(e, link) };
      if (link.status === 'revoked') throw conflict('This guardian link was revoked; request consent again.');
      const b = c.body;
      unknownField(b, ['note', 'method', 'assurance_level', 'reference', 'verification_id']);
      const method = (b.method ?? 'admin') as string;
      if (!(CONSENT_METHODS as readonly string[]).includes(method)) throw bad(`method must be one of ${CONSENT_METHODS.join(', ')}.`, 'method');
      if (method === 'email_link') throw bad('email_link is recorded by the guardian opening their consent link, not by an admin.', 'method');
      if (b.assurance_level !== undefined && !(LEVELS as readonly unknown[]).includes(b.assurance_level)) throw bad(`assurance_level must be one of ${LEVELS.join(', ')}.`, 'assurance_level');
      if (b.assurance_level !== undefined && method !== 'third_party') throw bad('assurance_level is stated only for third_party.', 'assurance_level');
      if (b.reference !== undefined && (typeof b.reference !== 'string' || b.reference.length > 200)) throw bad('reference is text of at most 200 characters.', 'reference');
      const decision = consentAllowed(minorsCfg(e), method, b.assurance_level);
      if (!decision.ok) throw bad(decision.reason === 'level_too_low' ? `${method} reaches ${decision.level}, below compliance.minors.minAssuranceLevel.` : `${method} is not in compliance.minors.consentMethods.`, 'method');
      let verificationId: string | null = null;
      if (method === 'id_document') {
        if (typeof b.verification_id !== 'string' || !b.verification_id) throw bad("id_document needs the guardian's approved identity verification: verification_id.", 'verification_id');
        if (!link.guardian_user_id) throw bad('id_document needs a guardian who has an account (guardian_user_id on the link).', 'method');
        if (!approvedVerification(e, b.verification_id, link.guardian_user_id)) throw bad('verification_id is not an approved identity verification of this guardian.', 'verification_id');
        verificationId = b.verification_id;
      } else if (b.verification_id !== undefined) throw bad('verification_id applies only to id_document.', 'verification_id');
      Object.assign(link, { status: 'active', consent_method: method, consented_at: e.clock.now(), token: null, note: typeof b.note === 'string' ? b.note.slice(0, 500) : null, assurance_level: decision.level, consent_reference: typeof b.reference === 'string' ? b.reference : null, verification_id: verificationId });
      audit(e, c, 'user.guardian_consent_recorded', 'user', c.params.id!, { guardian_link_id: link.id, method, assurance_level: decision.level });
      syncChild(e, c.params.id!);
      return { body: presentGuardian(e, link) };
    } },
    { method: 'DELETE', pattern: '/v1/users/:id/guardians/:linkId', scope: 'users:write', handler: (c) => {
      const e = c.engine;
      liveUser(e, c.params.id);
      const link = linkOf(e, c.params.id!, c.params.linkId);
      Object.assign(link, { status: 'revoked', token: null });
      audit(e, c, 'user.guardian_consent_revoked', 'user', c.params.id!, { guardian_link_id: link.id });
      syncChild(e, c.params.id!);
      return { body: presentGuardian(e, link) };
    } },
    // The guardian's own page (an unguessable one-time token is the credential).
    { method: 'GET', pattern: '/v1/parental_consent/:token', public: true, handler: (c) => {
      const l = byToken(c.engine, c.params.token!);
      return { headers: { 'cache-control': 'no-store' }, body: { object: 'parental_consent_request', child_name: displayName(c.engine.db.users.get(l.child_user_id)!), guardian_email: l.guardian_email, relationship: l.relationship, expires_at: l.expires_at } };
    } },
    { method: 'POST', pattern: '/v1/parental_consent/:token', public: true, handler: (c) => {
      const e = c.engine;
      const decision = c.body.decision;
      if (decision !== 'approve' && decision !== 'decline') throw bad('decision must be approve or decline.', 'decision');
      const l = byToken(e, c.params.token!);
      if (decision === 'approve' && !consentAllowed(minorsCfg(e), 'email_link').ok) throw conflict('Consent by email link is no longer accepted here. Ask the application for another way to give consent.');
      Object.assign(l, { status: decision === 'approve' ? 'active' : 'declined', consent_method: 'email_link', assurance_level: decision === 'approve' ? 'low' : null, consented_at: decision === 'approve' ? e.clock.now() : null, token: null });
      audit(e, null, decision === 'approve' ? 'user.guardian_consent_granted' : 'user.guardian_consent_declined', 'user', l.child_user_id, { guardian_link_id: l.id, guardian_email: l.guardian_email });
      const status = syncChild(e, l.child_user_id, decision === 'decline');
      return { headers: { 'cache-control': 'no-store' }, body: { object: 'parental_consent', decision, status: status ?? 'not_required', guardian_link: presentGuardian(e, l) } };
    } },

    // ── age assurance ──
    { method: 'GET', pattern: '/v1/users/:id/age_assurance', scope: 'users:read', handler: (c) => {
      liveUser(c.engine, c.params.id);
      return { body: listOf(st(c.engine).assurances.filter((r) => r.user_id === c.params.id).map((r) => presentAssurance(c.engine, r))) };
    } },
    { method: 'POST', pattern: '/v1/users/:id/age_assurance', scope: 'users:write', handler: (c) => {
      const e = c.engine;
      const u = liveUser(e, c.params.id);
      const b = c.body;
      unknownField(b, ['method', 'over_age', 'assurance_level', 'provider', 'reference', 'verification_id', 'expires_at']);
      const method = b.method as string;
      if (!(AGE_METHODS as readonly unknown[]).includes(method)) throw bad(`method must be one of ${AGE_METHODS.join(', ')}.`, 'method');
      const overAge = b.over_age;
      if (typeof overAge !== 'number' || !Number.isInteger(overAge) || overAge < 1 || overAge > 99) throw bad('over_age is a whole number of years from 1 to 99.', 'over_age');
      if (b.assurance_level !== undefined && !(LEVELS as readonly unknown[]).includes(b.assurance_level)) throw bad(`assurance_level must be one of ${LEVELS.join(', ')}.`, 'assurance_level');
      if (b.assurance_level !== undefined && method !== 'third_party') throw bad('assurance_level is stated only for third_party.', 'assurance_level');
      for (const k of ['provider', 'reference'] as const) if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== 'string' || (b[k] as string).length > 200)) throw bad(`${k} is text of at most 200 characters.`, k);
      let expiresAt: number | null = null;
      if (b.expires_at !== undefined && b.expires_at !== null) {
        if (typeof b.expires_at !== 'number' || !Number.isFinite(b.expires_at) || b.expires_at <= e.clock.now()) throw bad('expires_at is a future time in epoch milliseconds.', 'expires_at');
        expiresAt = b.expires_at;
      }
      let verificationId: string | null = null;
      if (method === 'id_document') {
        if (typeof b.verification_id !== 'string' || !b.verification_id) throw bad("id_document needs the user's approved identity verification: verification_id.", 'verification_id');
        if (!approvedVerification(e, b.verification_id, u.id)) throw bad('verification_id is not an approved identity verification of this user.', 'verification_id');
        verificationId = b.verification_id;
      } else if (b.verification_id !== undefined) throw bad('verification_id applies only to id_document.', 'verification_id');
      const level = ageLevel(method, b.assurance_level);
      const row = st(e).assurances.insert({ user_id: u.id, method, level, over_age: overAge, provider: b.provider ?? null, reference: b.reference ?? null, verification_id: verificationId, status: 'valid', expires_at: expiresAt, created_at: e.clock.now() } as any);
      audit(e, c, 'user.age_assurance_recorded', 'user', u.id, { assurance_id: row.id, method, level, over_age: overAge });
      e.webhooks.emit('user.age_assurance_recorded', { object: 'age_assurance', id: row.id, user_id: u.id, method, level, over_age: overAge, provider: row.provider, trusted: (minorsCfg(e).trustedAgeMethods as string[]).includes(method), expires_at: expiresAt });
      refresh(e, u);
      return { status: 201, body: presentAssurance(e, row) };
    } },
    { method: 'POST', pattern: '/v1/users/:id/age_assurance/:assuranceId/revoke', scope: 'users:write', handler: (c) => {
      const e = c.engine;
      const u = liveUser(e, c.params.id);
      unknownField(c.body, ['reason']);
      const reason = c.body.reason;
      if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 500)) throw bad('reason is text of at most 500 characters.', 'reason');
      const r = st(e).assurances.get(c.params.assuranceId);
      if (!r || r.user_id !== u.id) throw notFound('Age assurance');
      if (r.status !== 'revoked') {
        Object.assign(r, { status: 'revoked', revoked_at: e.clock.now(), revoked_reason: reason ?? null });
        audit(e, c, 'user.age_assurance_revoked', 'user', u.id, { assurance_id: r.id });
        e.webhooks.emit('user.age_assurance_revoked', { object: 'age_assurance', id: r.id, user_id: u.id, status: 'revoked', revoked_at: r.revoked_at });
        refresh(e, u);
      }
      return { body: presentAssurance(e, r) };
    } },

    // ── emulator helper: an identity verification the id_document methods rest on ──
    { method: 'POST', pattern: '/__emulator/compliance/identity_verifications', public: true, handler: (c) => {
      const e = c.engine;
      liveUser(e, c.body.user_id);
      const status = (c.body.status ?? 'approved') as string;
      if (!['approved', 'pending', 'rejected'].includes(status)) throw bad('status is approved, pending or rejected.', 'status');
      const row = st(e).verifications.insert({ user_id: c.body.user_id, status, created_at: e.clock.now() } as any);
      return { status: 201, body: { object: 'identity_verification', id: row.id, user_id: row.user_id, status } };
    } },
  ];
}

/** Validate a `compliance.minors` patch like the real settings validator (used by the config route). */
export function validateMinors(raw: unknown): Array<{ param: string; message: string }> {
  const p = 'compliance.minors';
  if (!isObj(raw)) return [{ param: p, message: 'Expected an object.' }];
  const out: Array<{ param: string; message: string }> = [];
  const known = ['enabled', 'birthdateTrait', 'countryTrait', 'defaultConsentAge', 'consentAges', 'minimumAge', 'restriction', 'consentTtlHours', 'consentMethods', 'minAssuranceLevel', 'trustedAgeMethods'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) out.push({ param: `${p}.${k}`, message: `Unknown field. Expected ${known.join(', ')}.` });
  const age = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 21;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') out.push({ param: `${p}.enabled`, message: 'Expected a boolean.' });
  if (raw.defaultConsentAge !== undefined && !age(raw.defaultConsentAge)) out.push({ param: `${p}.defaultConsentAge`, message: 'A whole number of years from 1 to 21.' });
  if (raw.minimumAge !== undefined && raw.minimumAge !== null && !age(raw.minimumAge)) out.push({ param: `${p}.minimumAge`, message: 'A whole number of years from 1 to 21, or null.' });
  if (raw.restriction !== undefined && raw.restriction !== 'hold' && raw.restriction !== 'flag') out.push({ param: `${p}.restriction`, message: 'One of hold, flag.' });
  if (raw.consentTtlHours !== undefined && !(typeof raw.consentTtlHours === 'number' && Number.isInteger(raw.consentTtlHours) && raw.consentTtlHours >= 1 && raw.consentTtlHours <= 720)) out.push({ param: `${p}.consentTtlHours`, message: 'A whole number of hours from 1 to 720.' });
  if (raw.consentMethods !== undefined && (!Array.isArray(raw.consentMethods) || raw.consentMethods.length === 0 || raw.consentMethods.some((m) => !(CONSENT_METHODS as readonly unknown[]).includes(m)))) out.push({ param: `${p}.consentMethods`, message: `A non-empty list of ${CONSENT_METHODS.join(', ')}.` });
  if (raw.minAssuranceLevel !== undefined && !(LEVELS as readonly unknown[]).includes(raw.minAssuranceLevel)) out.push({ param: `${p}.minAssuranceLevel`, message: `One of ${LEVELS.join(', ')}.` });
  if (raw.trustedAgeMethods !== undefined && (!Array.isArray(raw.trustedAgeMethods) || raw.trustedAgeMethods.some((m) => !(AGE_METHODS as readonly unknown[]).includes(m)))) out.push({ param: `${p}.trustedAgeMethods`, message: `A list of ${AGE_METHODS.join(', ')}.` });
  return out;
}
