/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { sha256 } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, randomToken } from '../store';
import { adoptMembership, adoptOrganization, adoptUser } from '../adopt';
import { authzHandlers } from './authz';
import { sessionMatches } from './round2';
import { activeHold, engineState, intIn, legalHolds, oneOf } from './support';
import { listReply } from './util';

/**
 * Governance routes: named step-up policies and the assertion a resource server calls before a sensitive action (with a
 * signed receipt), legal holds, instance export and import (the exit and copy path) and the session export. The
 * authorization routes (explain, what-if, FGA sync, the event feed) live in `authz.ts` and are registered from here.
 */
const STEP_UP_METHODS = ['password', 'email_code', 'sms_code', 'totp', 'backup_code', 'passkey', 'push', 'duo', 'yubikey'] as const;
const PHISHING_RESISTANT = ['passkey'];
const AMR_OF: Record<string, string> = { password: 'pwd', email_code: 'email', sms_code: 'sms', totp: 'otp', backup_code: 'otp', passkey: 'hwk', push: 'push', duo: 'duo', yubikey: 'hwk' };
const NAME_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const AMR_RE = /^[a-z0-9_:.-]{1,40}$/;
const MAX_LIST = 20;

const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);

interface Gov {
  policies: Table;
  exports: Table;
  secret: string;
}
const st = engineState((e: Engine): Gov => ({ policies: new Table('step_up_policies', e.clock.now, 'sup'), exports: new Table('instance_exports', e.clock.now, 'iexp'), secret: randomToken(24) }));

function strList(v: unknown, field: string, each: (s: string) => boolean, what: string): string[] {
  if (!Array.isArray(v) || v.length > MAX_LIST || v.some((x) => typeof x !== 'string' || !each(x))) throw bad(`${field} must be a list of up to ${MAX_LIST} ${what}.`, field);
  return [...new Set(v as string[])];
}

function parsePolicy(b: Obj, existing?: Obj): Obj {
  const out: Obj = {};
  if (!existing || b.name !== undefined) {
    if (typeof b.name !== 'string' || !NAME_RE.test(b.name)) throw bad('name must be 1-64 characters: lowercase letters, digits and _ . : -, starting with a letter or digit.', 'name');
    out.name = b.name;
  }
  if (b.description !== undefined) {
    if (b.description !== null && (typeof b.description !== 'string' || b.description.length > 500)) throw bad('description must be text up to 500 characters.', 'description');
    out.description = b.description;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw bad('enabled must be true or false.', 'enabled');
    out.enabled = b.enabled;
  }
  if (b.max_age_seconds !== undefined) out.max_age_seconds = intIn(b.max_age_seconds, 'max_age_seconds', 1, 30 * 86_400);
  if (b.receipt_ttl_seconds !== undefined) out.receipt_ttl_seconds = intIn(b.receipt_ttl_seconds, 'receipt_ttl_seconds', 10, 300);
  if (b.required_acr !== undefined) out.required_acr = strList(b.required_acr, 'required_acr', (s) => s.length > 0 && s.length <= 200, 'acr values');
  if (b.required_amr !== undefined) out.required_amr = strList(b.required_amr, 'required_amr', (s) => AMR_RE.test(s), 'amr values');
  if (b.required_amr_any !== undefined) out.required_amr_any = strList(b.required_amr_any, 'required_amr_any', (s) => AMR_RE.test(s), 'amr values');
  if (b.phishing_resistant !== undefined) {
    if (typeof b.phishing_resistant !== 'boolean') throw bad('phishing_resistant must be true or false.', 'phishing_resistant');
    out.phishing_resistant = b.phishing_resistant;
  }
  if (b.allowed_methods !== undefined) out.allowed_methods = strList(b.allowed_methods, 'allowed_methods', (s) => (STEP_UP_METHODS as readonly string[]).includes(s), `of: ${STEP_UP_METHODS.join(', ')}`);
  const merged = { phishing_resistant: false, allowed_methods: [], ...(existing ?? {}), ...out };
  // A policy no method could satisfy is refused when written, not discovered when users are locked out.
  if (merged.phishing_resistant && merged.allowed_methods.length && !merged.allowed_methods.some((m: string) => PHISHING_RESISTANT.includes(m))) throw bad('phishing_resistant needs passkey among allowed_methods (or no allowed_methods).', 'allowed_methods');
  return out;
}

const policyView = (p: Obj): Obj => ({
  object: 'step_up_policy',
  id: p.id,
  name: p.name,
  description: p.description ?? null,
  enabled: p.enabled,
  max_age_seconds: p.max_age_seconds,
  required_acr: p.required_acr,
  required_amr: p.required_amr,
  required_amr_any: p.required_amr_any,
  phishing_resistant: p.phishing_resistant,
  allowed_methods: p.allowed_methods,
  receipt_ttl_seconds: p.receipt_ttl_seconds,
  created_at: p.created_at,
  updated_at: p.updated_at,
});

const holdView = (h: Obj): Obj => ({ object: 'legal_hold', id: h.id, user_id: h.user_id, reason: h.reason, case_ref: h.case_ref ?? null, placed_at: h.placed_at, released_at: h.released_at ?? null, release_reason: h.release_reason ?? null, active: !h.released_at });

const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v as Obj).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Obj)[k])}`).join(',')}}` : JSON.stringify(v ?? null));
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const exportView = (j: Obj): Obj => ({ object: j.kind === 'export' ? 'instance_export' : 'instance_import', id: j.id, status: j.status, counts: j.counts, bundle_sha256: j.bundle_sha256 ?? null, signature: j.signature ?? null, dry_run: j.dry_run ?? false, errors: j.errors ?? [], created_at: j.created_at, completed_at: j.completed_at ?? null });

export function governanceHandlers(): RouteDef[] {
  const policyOf = (e: Engine, id: string | undefined): Obj => {
    const p = st(e).policies.get(id);
    if (!p) throw notFound('Step-up policy');
    return p;
  };
  const exportOf = (e: Engine, id: string | undefined, kind: string): Obj => {
    const j = st(e).exports.get(id);
    if (!j || j.kind !== kind) throw notFound(`Instance ${kind}`);
    return j;
  };
  const completed = (j: Obj): Obj => {
    if (j.status !== 'completed' || !j.bundle) throw new EmulatorError('CONFLICT', 'The export is not ready.');
    return j;
  };
  const signLink = async (e: Engine, j: Obj, exp: number): Promise<string> => hex(await sha256(`${j.id}.${j.nonce}.${exp}.${st(e).secret}`));
  const listJobs = (kind: string): RouteDef['handler'] => (c) => listReply(c, st(c.engine).exports.filter((j) => j.kind === kind), exportView);

  return [
    // ── step-up policies ──
    { method: 'GET', pattern: '/v1/step_up/policies', scope: 'step_up:read', handler: (c) => ({ body: { object: 'list', data: st(c.engine).policies.all().map(policyView), has_more: false, next_cursor: null } }) },
    {
      method: 'POST',
      pattern: '/v1/step_up/policies',
      scope: 'step_up:write',
      handler: (c) => {
        const e = c.engine;
        const fields = parsePolicy(c.body);
        if (st(e).policies.find((p) => p.name === fields.name)) throw bad(`A step-up policy named "${fields.name}" already exists.`, 'name');
        const now = e.clock.now();
        const row = st(e).policies.insert({ description: null, enabled: true, max_age_seconds: 300, required_acr: [], required_amr: [], required_amr_any: [], phishing_resistant: false, allowed_methods: [], receipt_ttl_seconds: 60, ...fields, created_at: now, updated_at: now } as any);
        return { status: 201, body: policyView(row) };
      },
    },
    { method: 'GET', pattern: '/v1/step_up/policies/:id', scope: 'step_up:read', handler: (c) => ({ body: policyView(policyOf(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/step_up/policies/:id',
      scope: 'step_up:write',
      handler: (c) => {
        const e = c.engine;
        const p = policyOf(e, c.params.id);
        const patch = parsePolicy(c.body, p);
        if (patch.name && patch.name !== p.name && st(e).policies.find((x) => x.name === patch.name)) throw bad(`A step-up policy named "${patch.name}" already exists.`, 'name');
        Object.assign(p, patch, { updated_at: e.clock.now() });
        return { body: policyView(p) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/step_up/policies/:id',
      scope: 'step_up:write',
      handler: (c) => {
        const p = policyOf(c.engine, c.params.id);
        st(c.engine).policies.delete(p.id);
        return { body: { object: 'step_up_policy', id: p.id, name: p.name, deleted: true } };
      },
    },
    {
      // Always 200 with `allowed`: a denial is an answer, not an error. Fails closed: unknown policy 404, disabled 409.
      method: 'POST',
      pattern: '/v1/step_up/assert',
      scope: 'step_up:assert',
      handler: async (c) => {
        const e = c.engine;
        if (typeof c.body.token !== 'string' || !c.body.token) throw bad('A session token is required.', 'token');
        if (c.body.authorized_parties !== undefined && (!Array.isArray(c.body.authorized_parties) || c.body.authorized_parties.some((x: unknown) => typeof x !== 'string'))) throw bad('authorized_parties must be a list of strings.', 'authorized_parties');
        const ttlOverride = c.body.receipt_ttl_seconds === undefined ? undefined : intIn(c.body.receipt_ttl_seconds, 'receipt_ttl_seconds', 10, 300);
        if (c.body.audience !== undefined && (typeof c.body.audience !== 'string' || !c.body.audience || c.body.audience.length > 200)) throw bad('audience must be a non-empty string up to 200 characters.', 'audience');
        const policy = st(e).policies.find((p) => p.name === c.body.policy);
        if (!policy) throw notFound('Step-up policy');
        if (!policy.enabled) throw new EmulatorError('CONFLICT', `The step-up policy "${policy.name}" is disabled.`);
        const verified = await e.tokens.verify(c.body.token);
        const session = verified.ok ? e.db.sessions.get(String(verified.claims.sid)) : undefined;
        const deny = (reason: string, extra: Obj = {}): { body: Obj } => ({ body: { object: 'step_up_assertion', allowed: false, reason, policy: policy.name, user_id: session?.user_id ?? null, session_id: session?.id ?? null, seconds_since_authentication: extra.age ?? null, step_up: { policy: policy.name, reason, max_age_seconds: policy.max_age_seconds, ...(policy.allowed_methods.length ? { allowed_methods: policy.allowed_methods } : {}), phishing_resistant: policy.phishing_resistant } } });
        if (!verified.ok || !session || session.status !== 'active') return deny('invalid_session');
        const parties: string[] | undefined = c.body.authorized_parties;
        if (parties?.length && verified.claims.azp && !parties.includes(String(verified.claims.azp))) return deny('unauthorized_party');
        const authTime = session.auth_time ?? session.created_at;
        const age = Math.max(0, Math.floor((e.clock.now() - authTime) / 1000));
        const amr: string[] = session.amr ?? ['pwd'];
        const method: string | null = session.step_up_method ?? null;
        if (age > policy.max_age_seconds) return deny('max_age_exceeded', { age });
        if (policy.required_acr.length && !policy.required_acr.includes(session.acr)) return deny('acr_insufficient', { age });
        if (policy.required_amr.some((m: string) => !amr.includes(m))) return deny('amr_insufficient', { age });
        if (policy.required_amr_any.length && !policy.required_amr_any.some((m: string) => amr.includes(m))) return deny('amr_insufficient', { age });
        if (policy.phishing_resistant && !(method && PHISHING_RESISTANT.includes(method))) return deny('phishing_resistant_required', { age });
        if (policy.allowed_methods.length && !(method && policy.allowed_methods.includes(method))) return deny('method_not_allowed', { age });
        const ttl = ttlOverride ?? policy.receipt_ttl_seconds;
        const jti = e.db.newId('sureceipt');
        const receipt = await e.tokens.signClaims({ sub: session.user_id, sid: session.id, jti, token_use: 'step_up_receipt', policy: policy.name, auth_time: Math.floor(authTime / 1000), amr, acr: session.acr ?? null, ...(c.body.audience ? { aud: c.body.audience } : {}) }, ttl);
        return { body: { object: 'step_up_assertion', allowed: true, reason: null, policy: policy.name, user_id: session.user_id, session_id: session.id, auth_time: Math.floor(authTime / 1000), amr, acr: session.acr ?? null, seconds_since_authentication: age, receipt, receipt_id: jti, receipt_expires_at: e.clock.now() + ttl * 1000 } };
      },
    },
    {
      // Emulator control: the user completes a step-up with `method`, which stamps the session like the real sign-in does.
      method: 'POST',
      pattern: '/__emulator/sessions/:id/authenticate',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const s = e.db.sessions.get(c.params.id);
        if (!s) throw notFound('Session');
        const method = oneOf(c.body, 'method', STEP_UP_METHODS);
        s.auth_time = e.clock.now();
        s.step_up_method = method;
        s.amr = Array.isArray(c.body.amr) ? c.body.amr : [...new Set([...(s.amr ?? ['pwd']), AMR_OF[method]!])];
        if (typeof c.body.acr === 'string') s.acr = c.body.acr;
        e.webhooks.emit('step_up.completed', { object: 'step_up', session_id: s.id, user_id: s.user_id, method, at: s.auth_time });
        return { body: { object: 'session', id: s.id, auth_time: s.auth_time, step_up_method: method, amr: s.amr, acr: s.acr ?? null } };
      },
    },
    // ── legal holds ──
    {
      method: 'GET',
      pattern: '/v1/users/:id/legal_hold',
      scope: 'data_subject_requests:read',
      handler: (c) => {
        const e = c.engine;
        if (!e.db.users.get(c.params.id)) throw notFound('User');
        const active = activeHold(e, c.params.id ?? '');
        return { body: { object: 'legal_hold_status', user_id: c.params.id, on_hold: !!active, active: active ? holdView(active) : null, history: legalHolds(e).filter((h) => h.user_id === c.params.id).map(holdView) } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/users/:id/legal_hold',
      scope: 'data_subject_requests:write',
      handler: (c) => {
        const e = c.engine;
        const u = e.db.users.get(c.params.id);
        if (!u || u.deleted) throw notFound('User');
        const reason = typeof c.body.reason === 'string' ? c.body.reason.trim() : '';
        if (!reason || reason.length > 1000) throw bad('reason is required (max 1000 characters).', 'reason');
        if (c.body.case_ref !== undefined && c.body.case_ref !== null && (typeof c.body.case_ref !== 'string' || c.body.case_ref.length > 200)) throw bad('case_ref is text of at most 200 characters.', 'case_ref');
        const have = activeHold(e, u.id);
        if (have) return { status: 200, body: holdView(have) };
        const hold = legalHolds(e).insert({ user_id: u.id, reason, case_ref: c.body.case_ref ?? null, placed_at: e.clock.now() });
        e.webhooks.emit('user.legal_hold_placed', { object: 'legal_hold', id: hold.id, user_id: u.id, case_ref: hold.case_ref, placed_at: hold.placed_at });
        return { status: 201, body: holdView(hold) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/users/:id/legal_hold/release',
      scope: 'data_subject_requests:write',
      handler: (c) => {
        const e = c.engine;
        if (c.body.reason !== undefined && c.body.reason !== null && (typeof c.body.reason !== 'string' || c.body.reason.length > 1000)) throw bad('reason is text of at most 1000 characters.', 'reason');
        const hold = activeHold(e, c.params.id ?? '');
        if (!hold) throw new EmulatorError('CONFLICT', 'This user has no active legal hold.');
        Object.assign(hold, { released_at: e.clock.now(), release_reason: c.body.reason ?? null });
        e.webhooks.emit('user.legal_hold_released', { object: 'legal_hold', id: hold.id, user_id: hold.user_id, released_at: hold.released_at });
        return { body: holdView(hold) };
      },
    },
    { method: 'GET', pattern: '/v1/legal_holds', scope: 'data_subject_requests:read', handler: (c) => listReply(c, legalHolds(c.engine).filter((h) => !h.released_at), holdView) },
    // ── instance export and import ──
    {
      method: 'POST',
      pattern: '/v1/instance/exports',
      scope: 'instance:write',
      handler: async (c) => {
        const e = c.engine;
        const include = c.body.include === undefined ? ['users', 'organizations', 'memberships'] : c.body.include;
        if (!Array.isArray(include) || include.some((x: unknown) => !['users', 'organizations', 'memberships'].includes(x as string))) throw bad('include is a list of users, organizations, memberships.', 'include');
        const now = e.clock.now();
        const users = include.includes('users') ? e.db.users.filter((u) => !u.deleted).reverse().map((u) => ({ id: u.id, username: u.username ?? null, first_name: u.first_name ?? null, last_name: u.last_name ?? null, external_id: u.external_id ?? null, email_addresses: (u.emails as Obj[]).map((m) => ({ email_address: m.email_address, verified: m.verified === true, primary: m.id === u.primary_email_address_id })), public_metadata: u.public_metadata ?? {}, unsafe_metadata: u.unsafe_metadata ?? {}, banned: u.banned === true, created_at: u.created_at })) : [];
        const organizations = include.includes('organizations') ? e.db.organizations.all().reverse().map((o) => ({ id: o.id, name: o.name, slug: o.slug, public_metadata: o.public_metadata ?? {}, created_at: o.created_at })) : [];
        const memberships = include.includes('memberships') ? e.db.memberships.all().reverse().map((m) => ({ organization_id: m.organization_id, user_id: m.user_id, role: m.role })) : [];
        // Private metadata and password material never enter a bundle.
        const bundle = JSON.stringify({ version: 1, instance_id: e.instanceId, exported_at: now, users, organizations, memberships });
        const digest = hex(await sha256(bundle));
        const signature = await e.tokens.signClaims({ token_use: 'instance_export', sha256: digest, sub: e.instanceId }, 365 * 86_400);
        const job = st(e).exports.insert({ kind: 'export', status: 'completed', bundle, bundle_sha256: digest, signature, nonce: randomToken(12), counts: { users: users.length, organizations: organizations.length, memberships: memberships.length }, created_at: now, completed_at: now });
        e.webhooks.emit('instance_export.completed', { object: 'instance_export', id: job.id, counts: job.counts });
        return { status: 202, body: exportView(job) };
      },
    },
    { method: 'GET', pattern: '/v1/instance/exports', scope: 'instance:read', handler: listJobs('export') },
    { method: 'GET', pattern: '/v1/instance/imports', scope: 'instance:read', handler: listJobs('import') },
    { method: 'GET', pattern: '/v1/instance/exports/:id', scope: 'instance:read', handler: (c) => ({ body: exportView(exportOf(c.engine, c.params.id, 'export')) }) },
    { method: 'GET', pattern: '/v1/instance/imports/:id', scope: 'instance:read', handler: (c) => ({ body: exportView(exportOf(c.engine, c.params.id, 'import')) }) },
    {
      method: 'GET',
      pattern: '/v1/instance/exports/:id/bundle',
      scope: 'instance:read',
      handler: (c) => {
        const j = completed(exportOf(c.engine, c.params.id, 'export'));
        return { raw: j.bundle, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-atlas-bundle-sha256': j.bundle_sha256, 'x-atlas-bundle-signature': j.signature } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/instance/exports/:id/download_url',
      scope: 'instance:read',
      handler: async (c) => {
        const e = c.engine;
        const j = completed(exportOf(e, c.params.id, 'export'));
        const exp = e.clock.now() + 15 * 60_000;
        const sig = await signLink(e, j, exp);
        return { body: { object: 'instance_export_download', url: `${e.issuer}/v1/instance/exports/${j.id}/download?i=${j.nonce}&exp=${exp}&sig=${sig}`, expires_at: exp } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/instance/exports/:id/revoke_links',
      scope: 'instance:write',
      handler: (c) => {
        const j = exportOf(c.engine, c.params.id, 'export');
        j.nonce = randomToken(12);
        return { body: exportView(j) };
      },
    },
    {
      // The signed link: no key, the signature is the credential. Every refusal is the same 404.
      method: 'GET',
      pattern: '/v1/instance/exports/:id/download',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const j = st(e).exports.get(c.params.id);
        const exp = Number(c.query.get('exp'));
        const same = (a: string, b: string) => a.length === b.length && [...a].every((ch, i) => ch === b[i]);
        if (!j || j.kind !== 'export' || !j.bundle || c.query.get('i') !== j.nonce || !Number.isFinite(exp) || exp <= e.clock.now() || !same(c.query.get('sig') ?? '', await signLink(e, j, exp))) throw notFound('Export');
        return { raw: j.bundle, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-atlas-bundle-sha256': j.bundle_sha256, 'x-atlas-bundle-signature': j.signature } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/instance/imports',
      scope: 'instance:write',
      handler: async (c) => {
        const e = c.engine;
        let text: string;
        if (typeof c.body.bundle === 'string') text = c.body.bundle;
        else if (c.body.bundle && typeof c.body.bundle === 'object') text = JSON.stringify(c.body.bundle);
        else throw bad('bundle is required: the object or the exact string an export returned.', 'bundle');
        // A digest or signature that was sent must match: a tampered bundle never loads.
        const wantSha = c.body.sha256 ?? c.body.bundle_sha256;
        if (wantSha !== undefined && wantSha !== hex(await sha256(text))) throw bad('sha256 does not match the bundle.', c.body.sha256 !== undefined ? 'sha256' : 'bundle_sha256');
        if (c.body.signature !== undefined) {
          const v = await e.tokens.verifyAny(String(c.body.signature));
          if (!v.ok || v.claims.token_use !== 'instance_export' || v.claims.sha256 !== hex(await sha256(text))) throw bad('signature does not verify for this bundle.', 'signature');
        }
        let bundle: Obj;
        try {
          bundle = JSON.parse(text);
        } catch {
          throw bad('bundle is not valid JSON.', 'bundle');
        }
        if (bundle.version !== 1 || !Array.isArray(bundle.users ?? []) || !Array.isArray(bundle.organizations ?? []) || !Array.isArray(bundle.memberships ?? [])) throw bad('bundle is not a version 1 instance export.', 'bundle');
        const dry = c.body.dry_run === true;
        const counts = { users: { created: 0, skipped: 0, failed: 0 }, organizations: { created: 0, skipped: 0, failed: 0 }, memberships: { created: 0, skipped: 0, failed: 0 } };
        const errors: Obj[] = [];
        const now = e.clock.now();
        for (const o of bundle.organizations ?? []) {
          if (typeof o?.id !== 'string' || typeof o.name !== 'string') { counts.organizations.failed++; errors.push({ kind: 'organization', id: o?.id ?? null, error: 'id and name are required' }); continue; }
          if (e.db.organizations.get(o.id)) { counts.organizations.skipped++; continue; }
          if (!dry) adoptOrganization(e, { id: o.id, name: o.name, slug: o.slug ?? null, public_metadata: o.public_metadata, created_at: o.created_at ?? now, updated_at: now });
          counts.organizations.created++;
        }
        for (const u of bundle.users ?? []) {
          const emails: Obj[] = Array.isArray(u?.email_addresses) ? u.email_addresses : [];
          if (typeof u?.id !== 'string') { counts.users.failed++; errors.push({ kind: 'user', id: null, error: 'id is required' }); continue; }
          const taken = e.db.users.get(u.id) || emails.some((m) => e.db.users.all().some((x) => !x.deleted && (x.emails as Obj[]).some((y) => y.email_address.toLowerCase() === String(m.email_address).toLowerCase())));
          if (taken) { counts.users.skipped++; continue; }
          if (!dry) {
            const rows = emails.map((m) => ({ id: e.db.newId('idn'), email_address: String(m.email_address), verified: m.verified === true }));
            const primary = emails.findIndex((m) => m.primary === true);
            adoptUser(e, { id: u.id, emails: rows, primary_email_address_id: rows[primary >= 0 ? primary : 0]?.id ?? null, first_name: u.first_name, last_name: u.last_name, username: u.username, external_id: u.external_id, public_metadata: u.public_metadata, unsafe_metadata: u.unsafe_metadata, banned: u.banned, created_at: u.created_at ?? now, updated_at: now });
          }
          counts.users.created++;
        }
        for (const m of bundle.memberships ?? []) {
          const known = (id: string, table: 'users' | 'organizations') => !!e.db[table].get(id) || (dry && (bundle[table] ?? []).some((x: Obj) => x.id === id));
          if (!known(m?.organization_id, 'organizations') || !known(m?.user_id, 'users')) { counts.memberships.failed++; errors.push({ kind: 'membership', id: `${m?.organization_id}:${m?.user_id}`, error: 'organization or user not found' }); continue; }
          if (e.db.memberships.find((x) => x.organization_id === m.organization_id && x.user_id === m.user_id)) { counts.memberships.skipped++; continue; }
          if (!dry) adoptMembership(e, m.organization_id, m.user_id, m.role ?? 'org:member');
          counts.memberships.created++;
        }
        const failed = counts.users.failed + counts.organizations.failed + counts.memberships.failed;
        const job = st(e).exports.insert({ kind: 'import', status: 'completed', counts, dry_run: dry, errors: errors.slice(0, 100), created_at: now, completed_at: now });
        e.webhooks.emit(failed && !dry ? 'import_job.failed' : 'import_job.completed', { object: 'instance_import', id: job.id, counts, dry_run: dry });
        return { status: 202, body: exportView(job) };
      },
    },
    // ── sessions export ──
    {
      method: 'GET',
      pattern: '/v1/sessions/export',
      scope: 'sessions:read',
      handler: (c) => {
        const e = c.engine;
        const format = c.query.get('format') ?? 'csv';
        if (format !== 'csv') throw bad('format must be csv.', 'format');
        const rows = e.db.sessions.all().reverse().filter((s) => sessionMatches(e, s, (k) => c.query.get(k)));
        const cols = ['id', 'user_id', 'organization_id', 'status', 'created_at', 'last_active_at', 'expires_at', 'revoked_at', 'revoked_reason', 'ip', 'country'];
        // A cell that starts with = + - @ would run as a formula in a spreadsheet: prefix it.
        const cell = (v: unknown): string => {
          let s = v === null || v === undefined ? '' : String(v);
          if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const lines = [cols.join(','), ...rows.map((s) => cols.map((k) => cell(s[k])).join(','))];
        return { raw: `${lines.join('\n')}\n`, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="sessions.csv"', 'cache-control': 'no-store' } };
      },
    },
    ...authzHandlers(),
  ];
}

