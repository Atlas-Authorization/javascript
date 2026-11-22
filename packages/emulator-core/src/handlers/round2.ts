/* eslint-disable @typescript-eslint/no-explicit-any */
import { signOutEverywhere } from './revocations';
import type { Engine, RouteDef } from '../engine';
import { bytesToB64url, sha256 } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { presentKey } from './keys';
import { activeHold } from './support';
import { need } from './util';
import { presentUser } from './users';

/**
 * Routes added by the second depth round for resources the engine models: API key rotation with overlap, key posture and
 * caller analytics, the session revocation feed and signed status list, bulk revocation by filter, the session timeline,
 * bulk user actions (run inline, so the job is already finished when it answers) and the deleted-address list.
 */
const DAY = 86_400_000;
const MAX_BACK_MS = 86_400_000;

interface R2State {
  jobs: Map<string, Obj>;
  bulk: Map<string, Obj>;
  callers: Map<string, Obj[]>;
  deletedAddresses: Set<string>;
}
const states = new WeakMap<Engine, R2State>();
const st = (e: Engine): R2State => {
  let s = states.get(e);
  if (!s) states.set(e, (s = { jobs: new Map(), bulk: new Map(), callers: new Map(), deletedAddresses: new Set() }));
  return s;
};
export const resetRound2Handlers = (e: Engine): void => void states.delete(e);

/** Record who verified a key; the verify handler calls this so `callers` has something to show. */
export function recordCaller(e: Engine, keyId: string, ip: string | null, userAgent: string | null): void {
  const list = st(e).callers.get(keyId) ?? [];
  list.push({ ip, user_agent: userAgent, route: 'verify', at: e.clock.now() });
  st(e).callers.set(keyId, list);
}

const isWildcard = (s: string): boolean => s === '*' || s.endsWith(':*');
const postureIssues = (k: Obj, now: number, staleDays: number, graceDays: number, maxScopes: number): string[] => {
  const out: string[] = [];
  if (k.last_used_at == null) {
    if (now - k.created_at > graceDays * DAY) out.push('never_used');
  } else if (now - k.last_used_at > staleDays * DAY) out.push('stale');
  const scopes: string[] = k.scopes ?? [];
  if (scopes.some(isWildcard) || scopes.length > maxScopes) out.push('over_scoped');
  if (k.expires_at == null) out.push('no_expiry');
  if (!k.allowed_ips?.length) out.push('no_ip_allowlist');
  return out;
};
const liveKey = (k: Obj, now: number): boolean => !k.revoked_at && (k.expires_at == null || k.expires_at > now);

export const sessionMatches = (e: Engine, s: Obj, q: (k: string) => string | null): boolean => {
  const org = q('organization_id');
  const user = q('user_id');
  const active = q('active');
  const after = q('created_after');
  const before = q('created_before');
  const country = q('country');
  const ip = q('ip');
  if (user && s.user_id !== user) return false;
  if (org && s.organization_id !== org) return false;
  if (active !== null && (s.status === 'active') !== (active === 'true')) return false;
  if (after && s.created_at < Date.parse(after)) return false;
  if (before && s.created_at > Date.parse(before)) return false;
  if (country && s.country !== country) return false;
  if (ip && s.ip !== ip) return false;
  void e;
  return true;
};

export function revokeSession(e: Engine, s: Obj, reason: string): void {
  if (s.status === 'revoked') return;
  s.status = 'revoked';
  s.revoked_at = e.clock.now();
  s.revoked_reason = reason;
  e.webhooks.emit('session.revoked', { object: 'session', id: s.id, user_id: s.user_id, reason });
}

export function round2Handlers(): RouteDef[] {
  return [
    // ── API keys ──
    {
      method: 'POST',
      pattern: '/v1/api_keys/:id/rotate',
      handler: (c) => {
        const e = c.engine;
        const old = e.db.apiKeys.get(c.params.id);
        if (!old || old.revoked_at) throw notFound('API key');
        const overlap = c.body.overlap_seconds === undefined ? 86_400 : c.body.overlap_seconds;
        if (!Number.isInteger(overlap) || overlap < 0 || overlap > 604_800) throw new EmulatorError('VALIDATION_FAILED', 'overlap_seconds must be an integer from 0 to 604800.', 'overlap_seconds');
        const now = e.clock.now();
        const prefix = String(old.prefix).split('_')[0] ?? 'ak';
        const secret = e.tokens.secret(prefix);
        const next = e.db.apiKeys.insert({ ...old, id: undefined, secret, prefix: secret.slice(0, prefix.length + 5), rotated_from_id: old.id, rotated_to_id: null, last_used_at: null, revoked_at: null, created_at: now } as any);
        old.rotated_to_id = next.id;
        if (overlap === 0) old.revoked_at = now;
        else old.expires_at = Math.min(old.expires_at ?? Infinity, now + overlap * 1000);
        e.changed({ type: 'api_key.created', data: presentKey(e, next), resource: 'api_key', id: next.id, op: 'create' });
        e.changed({ type: 'api_key.updated', data: presentKey(e, old), resource: 'api_key', id: old.id, op: 'update' });
        e.webhooks.emit('api_key.rotated', { object: 'api_key_rotation', previous_key_id: old.id, key_id: next.id, overlap_seconds: overlap, previous_expires_at: old.revoked_at ? null : old.expires_at });
        return { status: 201, body: { ...presentKey(e, next), secret, previous_key: { id: old.id, prefix: old.prefix, expires_at: old.revoked_at ? null : old.expires_at, revoked: !!old.revoked_at } } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/api_keys/posture',
      handler: (c) => {
        const e = c.engine;
        const now = e.clock.now();
        const num = (k: string, d: number) => Number(c.query.get(k) ?? d) || d;
        const [stale, grace, maxScopes] = [num('stale_days', 90), num('never_used_days', 7), num('max_scopes', 20)];
        const live = e.db.apiKeys.filter((k) => liveKey(k, now));
        const issue = c.query.get('issue');
        const summary: Record<string, number> = { never_used: 0, stale: 0, over_scoped: 0, no_expiry: 0, no_ip_allowlist: 0 };
        let findings = live
          .map((k) => ({ k, issues: postureIssues(k, now, stale, grace, maxScopes) }))
          .filter((f) => f.issues.length)
          .sort((a, b) => b.issues.length - a.issues.length || a.k.created_at - b.k.created_at);
        for (const f of findings) for (const i of f.issues) summary[i] = (summary[i] ?? 0) + 1;
        const totalFlagged = findings.length;
        if (issue) findings = findings.filter((f) => f.issues.includes(issue));
        const limit = Math.min(Math.max(num('limit', 50), 1), 200);
        const page = findings.slice(0, limit);
        return {
          body: {
            object: 'api_key_posture',
            generated_at: now,
            thresholds: { stale_days: stale, never_used_days: grace, max_scopes: maxScopes },
            totals: { live_keys: live.length, flagged_keys: totalFlagged },
            summary,
            truncated: false,
            data: page.map(({ k, issues }) => ({ object: 'api_key_posture_finding', key_id: k.id, prefix: k.prefix, name: k.name ?? null, subject_type: k.subject_type, subject_id: k.subject_id, organization_id: k.organization_id ?? null, issues, last_used_at: k.last_used_at ?? null, expires_at: k.expires_at ?? null, created_at: k.created_at })),
            has_more: findings.length > limit,
            next_cursor: findings.length > limit ? page[page.length - 1]!.k.id : null,
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/api_keys/:id/callers',
      handler: (c) => {
        const e = c.engine;
        const k = e.db.apiKeys.get(c.params.id);
        if (!k) throw notFound('API key');
        const windowDays = Number(c.query.get('window_days') ?? 7) || 7;
        const limit = Number(c.query.get('limit') ?? 10) || 10;
        if (windowDays < 1 || windowDays > 35) throw new EmulatorError('VALIDATION_FAILED', 'window_days must be an integer from 1 to 35.', 'window_days');
        const since = e.clock.now() - windowDays * DAY;
        const rows = (st(e).callers.get(k.id) ?? []).filter((r) => r.at >= since);
        const top = (field: string) => {
          const counts = new Map<string, number>();
          for (const r of rows) counts.set(String(r[field] ?? '(unknown)'), (counts.get(String(r[field] ?? '(unknown)')) ?? 0) + 1);
          return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
        };
        return { body: { object: 'api_key_callers', key_id: k.id, window_days: windowDays, since_day: new Date(since).toISOString().slice(0, 10), live: liveKey(k, e.clock.now()), ip: top('ip'), user_agent: top('user_agent'), route: top('route') } };
      },
    },
    // ── sessions ──
    {
      method: 'GET',
      pattern: '/v1/sessions/revocations',
      handler: (c) => {
        const e = c.engine;
        const now = e.clock.now();
        const raw = c.query.get('after');
        let from = now - 3_600_000;
        let afterId: string | null = null;
        if (raw) {
          if (/^\d+$/.test(raw)) from = Number(raw);
          else {
            const [at, ...id] = raw.split(':');
            if (!/^\d+$/.test(at ?? '') || !id.length) throw new EmulatorError('VALIDATION_FAILED', 'after must be epoch milliseconds or a next_after from a previous page.', 'after');
            from = Number(at);
            afterId = id.join(':');
          }
        }
        from = Math.max(from, now - MAX_BACK_MS);
        const limit = Math.min(Math.max(Math.trunc(Number(c.query.get('limit') ?? 1000)) || 1000, 1), 5000);
        const rows = e.db.sessions
          .all()
          .filter((s) => s.revoked_at && s.revoked_at >= from)
          .filter((s) => (!c.query.get('user_id') || s.user_id === c.query.get('user_id')) && (!c.query.get('organization_id') || s.organization_id === c.query.get('organization_id')) && (!c.query.get('reason') || s.revoked_reason === c.query.get('reason')))
          .sort((a, b) => a.revoked_at - b.revoked_at || (a.id < b.id ? -1 : 1))
          .filter((s) => afterId === null || s.revoked_at > from || s.id > afterId);
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return { headers: { 'cache-control': 'no-store' }, body: { object: 'list', data: page.map((s) => ({ sid: s.id, sub: s.user_id, revoked_at: s.revoked_at, reason: s.revoked_reason ?? null })), has_more: rows.length > limit, next_after: last ? `${last.revoked_at}:${last.id}` : null, server_time: now, window_start: from } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/sessions/revocations/status-list',
      handler: async (c) => {
        const e = c.engine;
        const windowSeconds = c.query.get('window_seconds') === null ? 3600 : Number(c.query.get('window_seconds'));
        if (!Number.isInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > MAX_BACK_MS / 1000) throw new EmulatorError('VALIDATION_FAILED', 'window_seconds must be a whole number from 60 to 86400.', 'window_seconds');
        const now = e.clock.now();
        const since = now - windowSeconds * 1000;
        // 8-byte truncated SHA-256 of each revoked sid, sorted so a verifier can binary-search.
        const hashes = await Promise.all(e.db.sessions.all().filter((s) => s.revoked_at && s.revoked_at >= since).map(async (s) => (await sha256(s.id)).slice(0, 8)));
        hashes.sort((a, b) => bytesToB64url(a).localeCompare(bytesToB64url(b)));
        const flat = new Uint8Array(hashes.length * 8);
        hashes.forEach((h, i) => flat.set(h, i * 8));
        const token = await e.tokens.signClaims({ sub: 'session-status-list', aud: 'atlas:session-status-list', token_use: 'session_status_list', since, window_seconds: windowSeconds, hash_bytes: 8, count: hashes.length, truncated: false, h: bytesToB64url(flat) }, 120);
        return { headers: { 'cache-control': 'private, max-age=30' }, body: { object: 'session_status_list', token, issued_at: now, expires_at: now + 120_000, window_seconds: windowSeconds, count: hashes.length, truncated: false } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/sessions/:id/events',
      handler: (c) => {
        const s = c.engine.db.sessions.get(c.params.id);
        if (!s) throw notFound('Session');
        const data: Obj[] = [{ id: `synth_created_${s.id}`, type: 'created', at: s.created_at, ip: s.ip ?? null, actor_type: null, actor_id: null, detail: { synthesized: true } }];
        if (s.revoked_at) data.push({ id: `synth_revoked_${s.id}`, type: 'revoked', at: s.revoked_at, ip: null, actor_type: null, actor_id: null, detail: { reason: s.revoked_reason ?? null, synthesized: true } });
        return { body: { object: 'list', data, has_more: false, next_after: null } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/sessions/revoke_by_filter',
      handler: (c) => {
        const e = c.engine;
        const keys = ['user_id', 'organization_id', 'ip', 'country', 'device', 'risk_level', 'min_risk_score', 'created_after', 'created_before'];
        const filter = Object.fromEntries(keys.filter((k) => c.body[k] !== undefined).map((k) => [k, c.body[k]]));
        if (!Object.keys(filter).length) throw new EmulatorError('VALIDATION_FAILED', 'Give at least one filter (user_id, organization_id, ip, country, device, risk_level, min_risk_score, created_after or created_before).');
        const q = (k: string): string | null => (filter[k] === undefined ? null : String(filter[k]));
        const hit = e.db.sessions.filter((s) => s.status === 'active' && sessionMatches(e, s, q));
        if (c.body.dry_run === true) return { body: { object: 'session_revoke_preview', dry_run: true, matched: hit.length, filter } };
        for (const s of hit) revokeSession(e, s, 'revoke_by_filter');
        const now = e.clock.now();
        const job = { object: 'session_revoke_job', id: e.db.newId('srjob'), status: 'completed', matched: hit.length, revoked: hit.length, filter, created_at: now, completed_at: now };
        st(e).jobs.set(job.id, job);
        return { status: 202, body: job };
      },
    },
    { method: 'GET', pattern: '/v1/sessions/revoke_jobs', handler: (c) => ({ body: { object: 'list', data: [...st(c.engine).jobs.values()].reverse(), has_more: false } }) },
    {
      method: 'GET',
      pattern: '/v1/sessions/revoke_jobs/:id',
      handler: (c) => {
        const j = st(c.engine).jobs.get(c.params.id ?? '');
        if (!j) throw notFound('Job');
        return { body: j };
      },
    },
    // ── users ──
    {
      method: 'POST',
      pattern: '/v1/users/bulk_actions',
      handler: (c) => {
        const e = c.engine;
        const action = String(need(c.body, 'action'));
        const allowed = ['ban', 'unban', 'revoke_sessions', 'add_to_org', 'set_metadata', 'delete', 'require_action'];
        if (!allowed.includes(action)) throw new EmulatorError('VALIDATION_FAILED', `action must be one of ${allowed.join(', ')}.`, 'action');
        const ids: string[] | undefined = Array.isArray(c.body.user_ids) ? c.body.user_ids : undefined;
        const params: Obj = c.body.params ?? {};
        // A user on legal hold is never selected for deletion.
        const targets = e.db.users.filter((u) => !u.deleted && (!ids || ids.includes(u.id)) && !(action === 'delete' && activeHold(e, u.id)));
        if (action === 'delete' && c.body.dry_run !== true && typeof c.body.expected_count !== 'number') throw new EmulatorError('VALIDATION_FAILED', 'A bulk delete needs expected_count: the matched count a dry run reported.', 'expected_count');
        if (!targets.length) throw new EmulatorError('VALIDATION_FAILED', 'No users match this selection.', 'filter');
        if (action === 'delete' && typeof c.body.expected_count === 'number' && c.body.expected_count !== targets.length) throw new EmulatorError('CONFLICT', `expected_count ${c.body.expected_count} does not match the ${targets.length} users selected.`, 'expected_count');
        if (c.body.dry_run === true) return { body: { object: 'bulk_user_action_preview', dry_run: true, action, matched: targets.length } };
        let ok = 0;
        for (const u of targets) {
          if (action === 'ban') u.banned = true;
          else if (action === 'unban') u.banned = false;
          else if (action === 'revoke_sessions') signOutEverywhere(e, u.id, 'bulk_action');
          else if (action === 'set_metadata') u.public_metadata = { ...(u.public_metadata ?? {}), ...(params.public_metadata ?? {}) };
          else if (action === 'delete') u.deleted = true;
          else if (action === 'add_to_org' && params.organization_id) {
            if (!e.db.memberships.find((m) => m.user_id === u.id && m.organization_id === params.organization_id)) e.db.memberships.insert({ organization_id: params.organization_id, user_id: u.id, role: params.role ?? 'org:member', role_source: 'direct', created_at: e.clock.now() });
          }
          u.updated_at = e.clock.now();
          u.version = (u.version ?? 0) + 1;
          e.changed({ type: action === 'delete' ? 'user.deleted' : 'user.updated', data: action === 'delete' ? { id: u.id, object: 'user', deleted: true } : presentUser(e, u), resource: 'user', id: u.id, op: action === 'delete' ? 'delete' : 'update' });
          ok++;
        }
        const now = e.clock.now();
        const job = { object: 'bulk_user_action', id: e.db.newId('bua'), action, status: 'completed', total: targets.length, processed: ok, succeeded: ok, failed: 0, skipped: 0, progress: 1, errors: [], cancel_requested: false, created_by: { type: 'api_key', id: null }, created_at: now, updated_at: now, completed_at: now };
        st(e).bulk.set(job.id, job);
        e.webhooks.emit('bulk_user_action.completed', job);
        return { status: 202, body: job };
      },
    },
    { method: 'GET', pattern: '/v1/users/bulk_actions', handler: (c) => ({ body: { object: 'list', data: [...st(c.engine).bulk.values()].reverse(), has_more: false, next_cursor: null } }) },
    {
      method: 'POST',
      pattern: '/v1/users/bulk_actions/:id/cancel',
      handler: (c) => {
        const j = st(c.engine).bulk.get(c.params.id ?? '');
        if (!j) throw notFound('Bulk action');
        return { body: j }; // jobs run inline, so by the time you can cancel one it is already finished
      },
    },
    {
      method: 'GET',
      pattern: '/v1/users/bulk_actions/:id',
      handler: (c) => {
        const j = st(c.engine).bulk.get(c.params.id ?? '');
        if (!j) throw notFound('Job');
        return { body: j };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/users/deleted_addresses',
      handler: (c) => {
        const addrs: unknown[] = Array.isArray(c.body.addresses) ? c.body.addresses : [];
        if (!addrs.length || addrs.length > 5000) throw new EmulatorError('VALIDATION_FAILED', 'addresses is a list of 1 to 5000 email addresses or E.164 phone numbers.', 'addresses');
        const valid = addrs.filter((a): a is string => typeof a === 'string' && (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a) || /^\+[1-9]\d{6,14}$/.test(a)));
        const before = st(c.engine).deletedAddresses.size;
        for (const a of valid) st(c.engine).deletedAddresses.add(a.toLowerCase());
        return { body: { object: 'deleted_address_import', received: addrs.length, added: st(c.engine).deletedAddresses.size - before, invalid: addrs.length - valid.length } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/users/deleted_addresses/check',
      handler: (c) => {
        if (typeof c.body.address !== 'string') throw new EmulatorError('VALIDATION_FAILED', 'address is an email address or an E.164 phone number.', 'address');
        return { body: { object: 'deleted_address_check', remembered: st(c.engine).deletedAddresses.has(c.body.address.toLowerCase()) } };
      },
    },
  ];
}
