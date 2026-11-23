/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { EmulatorError, errorBody, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, paginate } from '../store';
import { assertNotOnHold, engineState, sessionFromBearer } from './support';
import { pageOf } from './util';
import { revokeSession } from './round2';
import { actionRuns, runActionCode } from './emu4-actions-sandbox';

/**
 * Round-three odds and ends that share state: Action bindings and the `pre_token` trigger applied to machine tokens, the
 * machine-token `rl` (rate limit) claim, data-subject requests (create, poll, fulfil, reject, cancel, extend, signed deletion
 * receipt) with the per-user data export, and the organization policy with its per-member session cap.
 */
const bad = (message: string, param?: string) => new EmulatorError('VALIDATION_FAILED', message, param);
const DAY = 86_400_000;

// ── Actions: bindings and the pre_token trigger ──────────────────────

export const ACTION_TRIGGERS = ['post_login', 'pre_user_registration', 'post_user_registration', 'pre_organization_create', 'pre_member_add', 'pre_invitation_create', 'pre_authentication', 'pre_token', 'post_token_exchange', 'custom_token_exchange', 'pre_user_update', 'pre_user_deletion', 'pre_user_merge', 'mfa_verification_attempt', 'password_verification_attempt', 'account_link_decision', 'billing_plan_selected', 'pre_message_send', 'post_change_password', 'post_password_reset', 'post_user_update', 'post_email_verified', 'post_mfa_enroll', 'post_mfa_remove', 'post_logout', 'org_membership_changed', 'custom_challenge_create', 'custom_challenge_verify', 'workflow_step'] as const;
const MAX_ACTIONS_PER_FLOW = 20;
const MAX_ACTION_CLAIMS_BYTES = 2048;
const bindingsOf = engineState(() => new Map<string, string[]>());

/** Claims Atlas owns: an Action can never set them (the real list, plus the grant claims a machine token carries). */
const RESERVED = new Set(['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti', 'sid', 'azp', 'sv', 'mfa', 'mfa_satisfied', 'org_mfa_required', 'org_mfa_ok', 'last_active_at', 'anon', 'token_use', 'act', 'auth_time', 'amr', 'acr', 'email_verified', 'org', 'orgs', 'team_id', 'eu_orgs', 'groups', 'sso_connection_id', 'sso_organization_id', 'sso_connection_type', 'sso_tenant_id', 'sso_issuer', 'sso_domain', 'pla', 'fea', 'ent', 'referral_code', 'pol', 'risk', 'scope', 'grant_id', 'grant_type', 'grants', 'constraints', 'cnf', 'rl', '__proto__', 'prototype', 'constructor']);
const reserved = (k: string): boolean => RESERVED.has(k) || k.startsWith('org_') || k.startsWith('app_');

/** The size cap the real service puts on an Action's claims: reserved names are dropped, then the largest claims until it fits. */
function capClaims(claims: Obj): Obj {
  const kept: Obj = {};
  for (const [k, v] of Object.entries(claims)) if (!reserved(k)) kept[k] = v;
  const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v) ?? '').length;
  if (size(kept) <= MAX_ACTION_CLAIMS_BYTES) return kept;
  for (const [k] of Object.entries(claims).sort((a, b) => size(b[1]) - size(a[1]))) {
    delete kept[k];
    if (size(kept) <= MAX_ACTION_CLAIMS_BYTES) break;
  }
  return kept;
}

/** Top-level statements of a script: text outside every bracket, split at `;` and newlines. */
function statementsOf(code: string): string[] {
  const src = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += src[++i] ?? '';
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if ((ch === ';' || ch === '\n') && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += s[++i] ?? '';
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A literal (string, number, boolean, null, JSON) or an `event.context.*` / `event.user.*` read; anything else is unsupported. */
function evalArg(src: string, event: Obj): unknown {
  const s = src.trim();
  const str = /^(['"`])([\s\S]*)\1$/.exec(s);
  if (str) {
    if (str[1] === '`' && str[2]!.includes('${')) throw new Error('template literal');
    return str[2]!.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (s === 'null' || s === 'undefined') return null;
  const ref = /^event((?:\.[A-Za-z_$][\w$]*)+)$/.exec(s);
  if (ref) return ref[1]!.slice(1).split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), event) ?? null;
  return JSON.parse(s.replace(/'/g, '"'));
}

/** Triggers that run after the change happened: an error is logged and the flow carries on, and a deny means nothing (the real list). */
const SIDE_EFFECT_TRIGGERS = new Set(['post_user_registration', 'post_change_password', 'post_password_reset', 'post_user_update', 'post_email_verified', 'post_mfa_enroll', 'post_mfa_remove', 'post_logout', 'org_membership_changed']);
/** Wall-clock budget of one flow (every bound Action of a trigger), as in the real service. */
const FLOW_BUDGET_MS = 10_000;

/** What the bound Actions of a trigger produced, folded the way the real flow folds it (later Action wins per key). */
export interface ActionTriggerResult {
  claims: Obj;
  suppressed: string[];
  idClaims: Obj;
  suppressedId: string[];
  appMetadata: Obj;
  sessionData: Obj;
  lockReason: string | null;
  pauseReason: string | null;
  userEdits: Obj;
  httpRequests: Obj[];
}

/**
 * Run the Actions bound to a trigger. Code in the runtime's form runs in the sandbox (emu4-actions-sandbox: the real `api`
 * object, no host globals, CPU timeout); code written as a handler module, or any code when node:vm is unavailable, is read
 * declaratively: only top-level `api.accessToken.setCustomClaim`, `suppressClaim` and `api.access.deny` statements with literal
 * arguments or `event.*` reads, and a statement it cannot read fails the run. Every gate trigger fails closed (a deny or a failed
 * run refuses with 403 ACTION_BLOCKED and stops the rest); side-effect triggers fail open and ignore a deny. Actions of runtime
 * `http` are not called.
 */
export function runActionTrigger(e: Engine, trigger: string, context: Obj = {}): ActionTriggerResult {
  const ids = bindingsOf(e).get(trigger) ?? [];
  const event = { user: { id: context.userId ?? null, email: null, emailVerified: false, metadata: {} }, connection: { strategy: null }, request: { ip: null, userAgent: null, country: null }, context: { trigger, ...context }, secrets: {} };
  const claims: Obj = {};
  const out: ActionTriggerResult = { claims: {}, suppressed: [], idClaims: {}, suppressedId: [], appMetadata: {}, sessionData: {}, lockReason: null, pauseReason: null, userEdits: {}, httpRequests: [] };
  const failClosed = !SIDE_EFFECT_TRIGGERS.has(trigger);
  const blocked = (message: string) => new EmulatorError('ACTION_BLOCKED', message, undefined, { meta: { trigger } });
  const started = Date.now();
  for (const id of ids) {
    const a = e.generic.get('actions')?.get(id);
    if (!a || a.enabled === false || a.trigger !== trigger || a.runtime === 'http') continue;
    if (Date.now() - started >= FLOW_BUDGET_MS) {
      if (failClosed) throw blocked('Sign-in extensions exceeded their time budget and were blocked for safety.');
      break;
    }
    const t0 = Date.now();
    const code = String(a.code ?? '');
    const run = runActionCode(event, code);
    if (run) {
      const outcome = run.error ? 'error' : run.denied && failClosed ? 'denied' : 'ok';
      actionRuns(e).insert({ action_id: id, trigger, outcome, error: run.error, deny_reason: run.denied ? run.denyReason : null, duration_ms: Date.now() - t0, logs: run.logs, http_requests: run.httpRequests, connector_calls: run.connectorCalls, ran_at: e.clock.now() });
      if (run.error) {
        if (failClosed) throw blocked('A sign-in extension failed to run and was blocked for safety.');
        continue;
      }
      Object.assign(claims, run.accessTokenClaims);
      Object.assign(out.idClaims, run.idTokenClaims);
      Object.assign(out.appMetadata, run.appMetadata);
      Object.assign(out.sessionData, run.sessionData);
      Object.assign(out.userEdits, run.userEdits);
      out.lockReason = run.lockReason ?? out.lockReason;
      out.pauseReason = out.pauseReason ?? run.pauseReason;
      out.suppressed.push(...run.suppressedAccessClaims);
      out.suppressedId.push(...run.suppressedIdClaims);
      out.httpRequests.push(...run.httpRequests);
      if (run.denied && failClosed) throw blocked(run.denyReason ?? 'Access denied.');
      continue;
    }
    let denied: string | null = null;
    try {
      for (const st of statementsOf(code)) {
        const m = /^api\.(accessToken|access)\.(setCustomClaim|suppressClaim|deny)\(([\s\S]*)\)$/.exec(st);
        if (!m) continue;
        const args = splitArgs(m[3]!).map((x) => evalArg(x, event));
        if (m[1] === 'accessToken' && m[2] === 'setCustomClaim') claims[String(args[0]).slice(0, 256)] = args[1];
        else if (m[1] === 'accessToken' && m[2] === 'suppressClaim' && out.suppressed.length < 50) out.suppressed.push(String(args[0]).slice(0, 256));
        else if (m[1] === 'access' && m[2] === 'deny') {
          denied = (args[0] == null ? 'Access denied.' : String(args[0])).slice(0, 512);
          break;
        }
      }
    } catch {
      actionRuns(e).insert({ action_id: id, trigger, outcome: 'error', error: 'unreadable statement', deny_reason: null, duration_ms: Date.now() - t0, logs: [], http_requests: [], connector_calls: [], ran_at: e.clock.now() });
      if (failClosed) throw blocked('A sign-in extension failed to run and was blocked for safety.');
      continue;
    }
    actionRuns(e).insert({ action_id: id, trigger, outcome: denied !== null && failClosed ? 'denied' : 'ok', error: null, deny_reason: denied, duration_ms: Date.now() - t0, logs: [], http_requests: [], connector_calls: [], ran_at: e.clock.now() });
    if (denied !== null && failClosed) throw blocked(denied);
  }
  out.claims = capClaims(claims);
  return out;
}

// ── rate-limit policies, overrides and the machine token's rl claim ──

const RL_SUBJECTS = ['key', 'user', 'org', 'machine', 'ip'] as const;
const RL_MAX_LIMIT = 10_000_000;
const RL_MAX_POLICIES = 100;
const RL_MAX_PLANS = 50;
const SLUG = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PLAN_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
interface RateLimits {
  policies: Table;
  overrides: Table;
}
const rl = engineState((e: Engine): RateLimits => ({ policies: new Table('rate_limit_policies', e.clock.now, 'rlp'), overrides: new Table('rate_limit_overrides', e.clock.now, 'rlo') }));
const rlInt = (v: unknown, param: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${param} must be an integer from ${min} to ${max}.`, param);
  return v;
};
const rlBurst = (v: unknown): number | null => (v === null ? null : rlInt(v, 'burst', 0, RL_MAX_LIMIT));
const rlBool = (v: unknown, param: string): boolean => {
  if (typeof v !== 'boolean') throw bad(`${param} must be true or false.`, param);
  return v;
};
const rlSubject = (v: unknown, param = 'subject'): string => {
  if (typeof v !== 'string' || !(RL_SUBJECTS as readonly string[]).includes(v)) throw bad(`${param} must be one of ${RL_SUBJECTS.join(', ')}.`, param);
  return v;
};
function planOverridesOf(raw: unknown): Obj {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('plan_overrides must be an object keyed by billing plan slug.', 'plan_overrides');
  const entries = Object.entries(raw as Obj);
  if (entries.length > RL_MAX_PLANS) throw bad(`plan_overrides holds at most ${RL_MAX_PLANS} plans.`, 'plan_overrides');
  const out: Obj = {};
  for (const [slug, v] of entries) {
    const at = `plan_overrides.${slug}`;
    if (!PLAN_SLUG.test(slug)) throw bad('A plan slug is 1-64 letters, digits, dot, dash, underscore or colon.', at);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Each plan entry is an object with a limit.', at);
    const unknown = Object.keys(v).find((k) => !['limit', 'window_seconds', 'burst'].includes(k));
    if (unknown) throw bad(`Unknown field ${unknown}; a plan entry takes limit, window_seconds and burst.`, `${at}.${unknown}`);
    out[slug] = { limit: rlInt((v as Obj).limit, `${at}.limit`, 1, RL_MAX_LIMIT), ...((v as Obj).window_seconds !== undefined ? { window_seconds: rlInt((v as Obj).window_seconds, `${at}.window_seconds`, 1, 86_400) } : {}), ...((v as Obj).burst !== undefined ? { burst: rlBurst((v as Obj).burst) } : {}) };
  }
  return out;
}
const policyView = (p: Obj): Obj => ({ object: 'api_rate_limit_policy', id: p.id, name: p.name, subject: p.subject, limit: p.limit, window_seconds: p.window_seconds, burst: p.burst, plan_overrides: p.plan_overrides, is_default: p.is_default, enabled: p.enabled, version: p.version, created_at: p.created_at, updated_at: p.updated_at });
const overrideView = (o: Obj): Obj => ({ object: 'api_rate_limit_override', id: o.id, subject_type: o.subject_type, subject_id: o.subject_id, policy_id: o.policy_id, limit: o.limit, window_seconds: o.window_seconds, burst: o.burst, reason: o.reason, expires_at: o.expires_at, created_at: o.created_at, updated_at: o.updated_at });
const rlChanged = (e: Engine, policy: string, previous: Obj | null, current: Obj | null): void => void e.webhooks.emit('rate_limit_policy.updated', { object: 'rate_limit_policy', policy, previous, current, at: e.clock.now() });

const h16 = (s: string): string => {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (const ch of s) {
    a = Math.imul(a ^ ch.charCodeAt(0), 16777619) >>> 0;
    b = Math.imul(b + ch.charCodeAt(0), 2654435761) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
};

/**
 * The limit that applies to one subject: its live override (a policy it points at, which must be enabled, or its own numbers), else
 * the enabled default policy for the subject kind. shortcut: the per-plan entries of a policy and a key's own `rate_limit` are not
 * applied (no billing plan or key limit is resolved here), so `plan` is always null and a key resolves by override or default only.
 */
function resolveRateLimit(e: Engine, subject: string, id: string): Obj | null {
  const { policies, overrides } = rl(e);
  const now = e.clock.now();
  const make = (source: string, limit: number, window: number, burst: number | null, p: Obj | null, extra: unknown[]): Obj => ({ limit, window_seconds: window, burst, source, policy_id: p?.id ?? null, policy_name: p?.name ?? null, plan: null, version: h16(JSON.stringify([source, limit, window, burst, p?.id ?? null, p?.version ?? null, null, ...extra])) });
  const o = overrides.find((x) => x.subject_type === subject && x.subject_id === id);
  if (o && !(o.expires_at && o.expires_at <= now)) {
    if (o.policy_id) {
      const p = policies.get(o.policy_id);
      if (p && p.enabled) return make('override', p.limit, p.window_seconds, o.burst ?? p.burst, p, [o.updated_at]);
    } else if (o.limit !== null && o.window_seconds !== null) return make('override', o.limit, o.window_seconds, o.burst, null, [o.updated_at]);
  }
  const d = policies.find((p) => p.subject === subject && p.is_default && p.enabled);
  return d ? make('default', d.limit, d.window_seconds, d.burst, d, []) : null;
}

/** The compact `rl` claim of a machine token, `{ limit, window, burst?, v }`; null when no policy or override covers the machine. */
export function machineRateLimitClaim(e: Engine, machineId: string): Obj | null {
  const r = resolveRateLimit(e, 'machine', machineId);
  return r ? { limit: r.limit, window: r.window_seconds, ...(r.burst !== null ? { burst: r.burst } : {}), v: r.version } : null;
}

function rateLimitHandlers(): RouteDef[] {
  const READ = 'rate_limit:read';
  const WRITE = 'rate_limit:write';
  const policyOf = (e: Engine, id: string | undefined): Obj => {
    const p = rl(e).policies.get(id);
    if (!p) throw notFound('Rate-limit policy');
    return p;
  };
  const refOf = (c: RouteContext): { type: string; id: string } => {
    const type = rlSubject(c.params.subject_type, 'subject_type');
    const id = c.params.subject_id ?? '';
    if (id.length === 0 || id.length > 200) throw bad('subject_id must be a non-empty string of at most 200 characters.', 'subject_id');
    return { type, id: type === 'ip' ? id.toLowerCase() : id };
  };
  const conflict = (message: string, param?: string) => new EmulatorError('CONFLICT', message, param);
  const subjectExists = (e: Engine, type: string, id: string): void => {
    if (type === 'ip') {
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(id) && !/^[0-9a-f:]+$/.test(id.replace(/\.\d+/g, '')) && !id.includes(':')) throw bad('An ip subject must be one IPv4 or IPv6 address.', 'subject_id');
      return;
    }
    const found = type === 'key' ? e.db.apiKeys.get(id) : type === 'user' ? e.db.users.get(id) : type === 'org' ? e.db.organizations.get(id) : e.db.machines.get(id);
    if (!found || found.deleted) throw notFound(type === 'key' ? 'Key' : type === 'org' ? 'Organization' : type === 'user' ? 'User' : 'Machine');
  };
  return [
    {
      method: 'GET',
      pattern: '/v1/rate_limit_policies',
      scope: READ,
      handler: (c) => {
        const subject = c.query.get('subject');
        if (subject !== null) rlSubject(subject);
        return { body: { object: 'list', data: rl(c.engine).policies.filter((p) => !subject || p.subject === subject).map(policyView), has_more: false } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/rate_limit_policies',
      scope: WRITE,
      handler: (c) => {
        const e = c.engine;
        const b = c.body;
        const name = typeof b.name === 'string' && SLUG.test(b.name) ? b.name : null;
        if (name === null) throw bad('name is 1-64 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.', 'name');
        const subject = rlSubject(b.subject);
        const limit = rlInt(b.limit, 'limit', 1, RL_MAX_LIMIT);
        const window = rlInt(b.window_seconds, 'window_seconds', 1, 86_400);
        const burst = b.burst === undefined ? null : rlBurst(b.burst);
        const planOverrides = b.plan_overrides === undefined ? {} : planOverridesOf(b.plan_overrides);
        const isDefault = b.is_default === undefined ? false : rlBool(b.is_default, 'is_default');
        const enabled = b.enabled === undefined ? true : rlBool(b.enabled, 'enabled');
        const { policies } = rl(e);
        if (policies.size >= RL_MAX_POLICIES) throw bad(`An instance holds at most ${RL_MAX_POLICIES} rate-limit policies.`, 'name');
        if (policies.find((p) => p.name === name)) throw conflict(`A rate-limit policy named ${name} already exists.`, 'name');
        if (isDefault && policies.find((p) => p.subject === subject && p.is_default)) throw conflict(`A default policy for ${subject} already exists. Unset it first, or create this one without is_default.`, 'is_default');
        const now = e.clock.now();
        const row = policies.insert({ name, subject, limit, window_seconds: window, burst, plan_overrides: planOverrides, is_default: isDefault, enabled, version: 1, created_at: now, updated_at: now });
        rlChanged(e, row.id, null, policyView(row));
        return { status: 201, body: policyView(row) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/rate_limit_policies/resolve',
      scope: READ,
      handler: (c) => {
        const e = c.engine;
        const given = (['key_id', 'user_id', 'org_id', 'machine_id', 'ip'] as const).filter((k) => c.query.get(k) !== null && c.query.get(k) !== '');
        if (given.length !== 1) throw bad('Send exactly one of key_id, user_id, org_id, machine_id or ip.', 'key_id');
        const which = given[0]!;
        const subject = which === 'key_id' ? 'key' : which === 'user_id' ? 'user' : which === 'org_id' ? 'org' : which === 'machine_id' ? 'machine' : 'ip';
        const id = c.query.get(which)!;
        if (subject === 'key' && !e.db.apiKeys.get(id)) throw notFound('Key');
        return { body: { object: 'api_rate_limit_resolution', subject_type: subject, subject_id: id, rate_limit: resolveRateLimit(e, subject, subject === 'ip' ? id.toLowerCase() : id) } };
      },
    },
    { method: 'GET', pattern: '/v1/rate_limit_policies/:id', scope: READ, handler: (c) => ({ body: policyView(policyOf(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/rate_limit_policies/:id',
      scope: WRITE,
      handler: (c) => {
        const e = c.engine;
        const p = policyOf(e, c.params.id);
        const b = c.body;
        if (b.subject !== undefined && rlSubject(b.subject) !== p.subject) throw bad('subject cannot change. Create a new policy for the other subject kind.', 'subject');
        const patch: Obj = {};
        if (b.name !== undefined) {
          if (typeof b.name !== 'string' || !SLUG.test(b.name)) throw bad('name is 1-64 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.', 'name');
          patch.name = b.name;
        }
        if (b.limit !== undefined) patch.limit = rlInt(b.limit, 'limit', 1, RL_MAX_LIMIT);
        if (b.window_seconds !== undefined) patch.window_seconds = rlInt(b.window_seconds, 'window_seconds', 1, 86_400);
        if (b.burst !== undefined) patch.burst = rlBurst(b.burst);
        if (b.plan_overrides !== undefined) patch.plan_overrides = planOverridesOf(b.plan_overrides);
        if (b.is_default !== undefined) patch.is_default = rlBool(b.is_default, 'is_default');
        if (b.enabled !== undefined) patch.enabled = rlBool(b.enabled, 'enabled');
        const before = policyView(p);
        // The same content again is a no-op, so a retried PATCH never bumps the version.
        if (Object.entries(patch).every(([k, v]) => JSON.stringify(v) === JSON.stringify(p[k]))) return { body: before };
        const { policies } = rl(e);
        if (patch.name !== undefined && patch.name !== p.name && policies.find((x) => x.name === patch.name)) throw conflict(`A rate-limit policy named ${patch.name} already exists.`, 'name');
        if (patch.is_default === true && !p.is_default && policies.find((x) => x.subject === p.subject && x.is_default)) throw conflict('That name, or the default slot for this subject, is already taken.');
        Object.assign(p, patch, { version: p.version + 1, updated_at: e.clock.now() });
        rlChanged(e, p.id, before, policyView(p));
        return { body: policyView(p) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/rate_limit_policies/:id',
      scope: WRITE,
      handler: (c) => {
        const e = c.engine;
        const p = policyOf(e, c.params.id);
        const using = rl(e).overrides.filter((o) => o.policy_id === p.id).length;
        if (using > 0) throw conflict(`${using} per-subject override(s) use this policy. Remove or repoint them first.`);
        const before = policyView(p);
        rl(e).policies.delete(p.id);
        rlChanged(e, p.id, before, null);
        return { body: { object: 'api_rate_limit_policy', id: p.id, deleted: true } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/rate_limit_overrides',
      scope: READ,
      handler: (c) => {
        const type = c.query.get('subject_type');
        if (type !== null) rlSubject(type, 'subject_type');
        const limit = c.query.get('limit') === null ? 50 : Number(c.query.get('limit'));
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('limit must be an integer from 1 to 200.', 'limit');
        const page = paginate(rl(c.engine).overrides.filter((o) => !type || o.subject_type === type), { limit, startingAfter: c.query.get('starting_after') ?? undefined });
        return { body: { object: 'list', data: page.data.map(overrideView), has_more: page.has_more, next_cursor: page.next_cursor } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/rate_limit_overrides/:subject_type/:subject_id',
      scope: READ,
      handler: (c) => {
        const ref = refOf(c);
        const o = rl(c.engine).overrides.find((x) => x.subject_type === ref.type && x.subject_id === ref.id);
        if (!o) throw notFound('Override for that subject');
        return { body: overrideView(o) };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/rate_limit_overrides/:subject_type/:subject_id',
      scope: WRITE,
      handler: (c) => {
        const e = c.engine;
        const ref = refOf(c);
        const b = c.body;
        const known = ['policy_id', 'limit', 'window_seconds', 'burst', 'reason', 'expires_at'];
        const stray = Object.keys(b).find((k) => !known.includes(k));
        if (stray) throw bad(`Unknown field ${stray}.`, stray);
        subjectExists(e, ref.type, ref.id);
        const hasPolicy = b.policy_id !== undefined && b.policy_id !== null;
        const hasInline = b.limit !== undefined || b.window_seconds !== undefined || b.burst !== undefined;
        if (hasPolicy === hasInline) throw bad('Send policy_id, or limit with window_seconds (and optionally burst), not both and not neither.', 'policy_id');
        let policyId: string | null = null;
        if (hasPolicy) {
          if (typeof b.policy_id !== 'string') throw bad('policy_id must be a policy id.', 'policy_id');
          const p = rl(e).policies.get(b.policy_id);
          if (!p) throw bad('Unknown policy_id.', 'policy_id');
          if (p.subject !== ref.type) throw bad(`That policy is for ${p.subject} subjects, not ${ref.type}.`, 'policy_id');
          policyId = p.id;
        }
        let expiresAt: number | null = null;
        if (b.expires_at !== undefined && b.expires_at !== null) {
          const t = typeof b.expires_at === 'number' || typeof b.expires_at === 'string' ? new Date(b.expires_at).getTime() : NaN;
          if (Number.isNaN(t) || t <= e.clock.now()) throw bad('expires_at must be a future time (epoch milliseconds or ISO 8601).', 'expires_at');
          expiresAt = t;
        }
        if (b.reason !== undefined && b.reason !== null && (typeof b.reason !== 'string' || b.reason.length > 500)) throw bad('reason must be a string of at most 500 characters.', 'reason');
        const next = { policy_id: policyId, limit: hasInline ? rlInt(b.limit, 'limit', 1, RL_MAX_LIMIT) : null, window_seconds: hasInline ? rlInt(b.window_seconds, 'window_seconds', 1, 86_400) : null, burst: hasInline && b.burst !== undefined ? rlBurst(b.burst) : null, reason: b.reason ?? null, expires_at: expiresAt };
        const prior = rl(e).overrides.find((x) => x.subject_type === ref.type && x.subject_id === ref.id);
        const before = prior ? overrideView(prior) : null;
        // The same content again is a no-op, so a retried PUT leaves the resolved version alone.
        if (prior && Object.entries(next).every(([k, v]) => prior[k] === v)) return { body: before! };
        const now = e.clock.now();
        const row = prior ? Object.assign(prior, next, { updated_at: now }) : rl(e).overrides.insert({ subject_type: ref.type, subject_id: ref.id, ...next, created_at: now, updated_at: now });
        rlChanged(e, `override:${ref.type}:${ref.id}`, before, overrideView(row));
        return { body: overrideView(row) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/rate_limit_overrides/:subject_type/:subject_id',
      scope: WRITE,
      handler: (c) => {
        const e = c.engine;
        const ref = refOf(c);
        const o = rl(e).overrides.find((x) => x.subject_type === ref.type && x.subject_id === ref.id);
        if (!o) throw notFound('Override for that subject');
        rl(e).overrides.delete(o.id);
        rlChanged(e, `override:${ref.type}:${ref.id}`, overrideView(o), null);
        return { body: { object: 'api_rate_limit_override', id: o.id, deleted: true } };
      },
    },
  ];
}

// ── organization policy and the per-member session cap ───────────────

const MIN_AGE = 300;
const MAX_AGE = 7_776_000;

/** After a session is created: past an organization's `maxSessions`, the member's least recently active sessions end. */
export function enforceOrgSessionCap(e: Engine, session: Obj): void {
  let cap: number | undefined;
  for (const m of e.db.memberships.filter((x) => x.user_id === session.user_id)) {
    const n = e.db.organizations.get(m.organization_id)?.policy?.maxSessions;
    if (Number.isInteger(n)) cap = Math.min(cap ?? Infinity, n);
  }
  if (cap === undefined) return;
  const now = e.clock.now();
  const others = e.db.sessions.filter((s) => s.user_id === session.user_id && s.id !== session.id && s.status === 'active' && s.expires_at > now).sort((a, b) => b.last_active_at - a.last_active_at);
  // The new session is never evicted: keep cap - 1 others, end the rest.
  for (const stale of others.slice(cap - 1)) revokeSession(e, stale, 'org_max_sessions_exceeded');
}

function policyProblems(p: Obj): Array<{ param: string; message: string }> {
  const out: Array<{ param: string; message: string }> = [];
  const intOrNull = (k: string) => p[k] !== undefined && p[k] !== null && (typeof p[k] !== 'number' || !Number.isInteger(p[k]));
  if (intOrNull('maxSessions')) out.push({ param: 'maxSessions', message: 'Expected a whole number of sessions.' });
  else if (typeof p.maxSessions === 'number' && (p.maxSessions < 1 || p.maxSessions > 100)) out.push({ param: 'maxSessions', message: 'maxSessions must be from 1 to 100.' });
  if (intOrNull('maxSessionAgeSeconds')) out.push({ param: 'maxSessionAgeSeconds', message: 'Expected a whole number of seconds.' });
  else if (typeof p.maxSessionAgeSeconds === 'number' && p.maxSessionAgeSeconds < MIN_AGE) out.push({ param: 'maxSessionAgeSeconds', message: 'A maximum session age under five minutes signs members out almost immediately.' });
  else if (typeof p.maxSessionAgeSeconds === 'number' && p.maxSessionAgeSeconds > MAX_AGE) out.push({ param: 'maxSessionAgeSeconds', message: 'A session may not outlive 90 days.' });
  for (const k of ['ssoMultiConnection', 'ssoRequired', 'requireMfa']) if (p[k] !== undefined && p[k] !== null && typeof p[k] !== 'boolean') out.push({ param: k, message: 'Expected true or false.' });
  for (const k of ['allowedSignInMethods', 'ipAllowlist']) if (p[k] !== undefined && p[k] !== null && (!Array.isArray(p[k]) || !p[k].every((x: unknown) => typeof x === 'string'))) out.push({ param: k, message: 'Expected an array of strings.' });
  for (const k of ['entitlementPlan', 'entitlementOverrides']) if (p[k] !== undefined && p[k] !== null) out.push({ param: k, message: `${k} is not supported on the organization policy. Send null to clear a stored value.` });
  return out;
}

// ── data-subject requests and the per-user export ────────────────────

const TYPES: Record<string, { kind: string; canonical: string }> = {
  access: { kind: 'export', canonical: 'access' },
  export: { kind: 'export', canonical: 'access' },
  deletion: { kind: 'erasure', canonical: 'deletion' },
  erasure: { kind: 'erasure', canonical: 'deletion' },
  erase: { kind: 'erasure', canonical: 'deletion' },
  closure: { kind: 'erasure', canonical: 'closure' },
  restriction: { kind: 'restriction', canonical: 'restriction' },
  rectification: { kind: 'rectification', canonical: 'rectification' },
};
const TYPE_ERROR = `type must be one of ${[...Object.keys(TYPES)].map((t) => `'${t}'`).join(', ')}.`;
const ERASURE_GRACE_MS = 7 * DAY;
const DEFAULT_DUE_MS = 30 * DAY;
const SCRUB_DAYS = 30;
export const EXPORT_COOLDOWN_MS = 60 * 60_000;
const terminal = (s: string): boolean => s === 'completed' || s === 'rejected' || s === 'cancelled';

interface Privacy {
  dsr: Table;
  receipts: Map<string, Obj>;
  audit: Obj[];
}
const st = engineState((e: Engine): Privacy => ({ dsr: new Table('data_subject_requests', e.clock.now, 'dsr'), receipts: new Map(), audit: [] }));
/** Round-four compliance: the request table and presenter, and hooks that run before an erasure removes the user. */
export const dsrRows = (e: Engine): Table => st(e).dsr;
export const erasureHooks: Array<(e: Engine, request: Obj) => void> = [];
const note = (e: Engine, action: string, targetType: string, targetId: string, actor: [string, string | null]): void => {
  st(e).audit.push({ id: e.db.newId('audit'), action, actor_type: actor[0], actor_id: actor[1], target_type: targetType, target_id: targetId, ip: null, created_at: e.clock.now() });
};

const dueAt = (r: Obj): number | null => r.due_at ?? (r.canonical_type === 'closure' ? null : r.requested_at + DEFAULT_DUE_MS);
export function view(e: Engine, r: Obj, includeResult = false): Obj {
  const due = dueAt(r);
  const now = e.clock.now();
  const waiting = r.type === 'erasure' && !!r.scheduled_for && r.scheduled_for > now;
  return {
    object: 'data_subject_request',
    id: r.id,
    type: r.type,
    canonical_type: r.canonical_type,
    canonicalType: r.canonical_type,
    status: r.status,
    user_id: r.user_id,
    source: r.source,
    requested_by_type: r.requested_by_type,
    requested_by_id: r.requested_by_id ?? null,
    reason: r.reason ?? null,
    detail: r.detail ?? null,
    case_id: null,
    external_case: null,
    trace_id: null,
    steps: r.steps ?? [],
    retention: [],
    scheduled_for: r.scheduled_for ?? null,
    eta: r.scheduled_for ?? null,
    deletion_effective_at: r.type === 'erasure' ? (r.scheduled_for ?? null) : null,
    requested_at: r.requested_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at ?? null,
    due_at: due,
    overdue: due !== null && !terminal(r.status) && !waiting && due < now,
    due_extended_reason: r.due_extended_reason ?? null,
    assignee: r.assignee ?? null,
    priority: r.priority ?? 'normal',
    labels: r.labels ?? [],
    ...(includeResult ? { result: r.result ?? null } : {}),
  };
}
const clientView = (r: Obj, includeResult = false): Obj => ({ object: 'data_subject_request', id: r.id, type: r.type, canonical_type: r.canonical_type, status: r.status, reason: r.reason ?? null, requested_at: r.requested_at, scheduled_for: r.scheduled_for ?? null, completed_at: r.completed_at ?? null, ...(includeResult ? { result: r.result ?? null } : {}), detail: r.detail ?? null });

/** The Article 15 / 20 package: written field by field, so a secret or private metadata cannot ride along by accident. */
export function exportBundle(e: Engine, userId: string): Obj {
  const u = e.db.users.get(userId);
  if (!u) throw notFound('User');
  const mail = (u.emails as Obj[]) ?? [];
  return {
    object: 'data_export',
    format_version: 1,
    generated_at: e.clock.now(),
    user: { object: 'user', id: u.id, username: u.username ?? null, first_name: u.first_name ?? null, last_name: u.last_name ?? null, image_url: u.image_url ?? null, locale: u.locale ?? null, public_metadata: u.public_metadata ?? {}, unsafe_metadata: u.unsafe_metadata ?? {}, has_password: u.has_password === true, mfa_enabled: false, external_id: u.external_id ?? null, created_at: u.created_at, updated_at: u.updated_at },
    email_addresses: mail.map((m) => ({ object: 'email_address', id: m.id, email_address: m.email_address, verified: m.verified === true, primary: m.id === u.primary_email_address_id, created_at: u.created_at })),
    phone_numbers: [],
    external_accounts: [],
    passkeys: e.db.passkeys.filter((p) => p.user_id === userId).map((p) => ({ object: 'passkey', id: p.id, name: p.name ?? null })),
    mfa_factors: [],
    sessions: e.db.sessions.filter((s) => s.user_id === userId).map((s) => ({ object: 'session', id: s.id, status: s.status, device: null, ip_first: null, ip_last: null, created_at: s.created_at, last_active_at: s.last_active_at, expires_at: s.expires_at, custom_data: null })),
    ens_names: [],
    organization_memberships: e.db.memberships.filter((m) => m.user_id === userId).flatMap((m) => {
      const o = e.db.organizations.get(m.organization_id);
      return o ? [{ object: 'organization_membership', role: m.role, organization: { object: 'organization', id: o.id, name: o.name, slug: o.slug } }] : [];
    }),
    organization_invitations: [],
    audit_log: st(e).audit.filter((a) => a.actor_id === userId || a.target_id === userId).slice(-1000).map((a) => ({ object: 'audit_log_entry', id: a.id, action: a.action, actor_type: a.actor_type, target_type: a.target_type, ip: a.ip, created_at: a.created_at })),
    consents: [],
    // Provider connections the user owns: never a token.
    connections: (e.generic.get('connections')?.all() ?? []).filter((c) => c.owner?.type === 'user' && c.owner?.id === userId).map((c) => ({ object: 'connection', id: c.id, provider: c.provider, external_account_id: c.external_id ?? null, environment: c.environment ?? 'production', status: c.status, scopes: c.scopes ?? [], connected_at: c.connected_at ?? null, last_refreshed_at: c.last_refreshed_at ?? null, created_at: c.created_at })),
    app_roles: [],
    groups: [],
    entitlements: [],
    identity_verifications: [],
    api_keys: [],
    sign_in_history: [],
    billing: [],
  };
}

function fulfil(e: Engine, r: Obj, actor: [string, string | null]): void {
  const now = e.clock.now();
  if (r.type === 'export') r.result = exportBundle(e, r.user_id);
  else if (r.type === 'erasure') {
    assertNotOnHold(e, r.user_id);
    for (const hook of erasureHooks) hook(e, r);
    const u = e.db.users.get(r.user_id);
    if (u && !u.deleted) {
      u.deleted = true;
      u.deleted_at = now;
      e.db.sessions.filter((s) => s.user_id === u.id).forEach((s) => revokeSession(e, s, 'user_deleted'));
      e.changed({ type: 'user.deleted', data: { id: u.id, object: 'user', deleted: true }, resource: 'user', id: u.id, op: 'delete' });
    }
    r.steps = r.steps ?? [];
    r.result = { erased_at: new Date(now).toISOString(), personal_data_scrubbed_at: new Date(now + SCRUB_DAYS * DAY).toISOString() };
  } else {
    r.detail = `An operator recorded the ${r.type} as done.`;
    r.result = { completed_by: actor[0], completed_at: new Date(now).toISOString() };
  }
  Object.assign(r, { status: 'completed', completed_at: now, updated_at: now });
  e.webhooks.emit('data_subject_request.fulfilled', { object: 'data_subject_request', id: r.id, user_id: r.user_id, type: r.type, status: r.status, reason: r.reason ?? null });
  note(e, `data_subject_request.${r.type}.fulfilled`, 'data_subject_request', r.id, actor);
}

/** The worker pass: an export builds on the next pass, an erasure runs when its cancellation window closes (a held user stays scheduled). */
function settle(e: Engine): void {
  const now = e.clock.now();
  for (const r of st(e).dsr.all()) {
    try {
      if (r.type === 'export' && r.status === 'pending') fulfil(e, r, ['system', null]);
      else if (r.type === 'erasure' && r.status === 'scheduled' && r.scheduled_for <= now) fulfil(e, r, ['system', null]);
    } catch {
      /* legal hold: the request waits */
    }
  }
}

const forbidden409 = (message: string): Reply => ({ status: 409, body: errorBody([{ code: 'FORBIDDEN', message }]) });
const dsrOf = (e: Engine, id: string | undefined): Obj => {
  const r = st(e).dsr.get(id);
  if (!r) throw notFound('Data subject request');
  return r;
};


const subjectOf = (e: Engine, body: Obj): Obj => {
  const id = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const email = typeof body.subject_email === 'string' ? body.subject_email.trim().toLowerCase() : '';
  if (!id && !email) throw bad('Provide user_id or subject_email.', 'user_id');
  if (id) {
    const u = e.db.users.get(id);
    if (!u || u.deleted) throw notFound('User');
    return u;
  }
  const has = (u: Obj, verified: boolean) => !u.deleted && (u.emails as Obj[]).some((m) => m.email_address.toLowerCase() === email && (m.verified === true) === verified);
  const u = e.db.users.all().find((x) => has(x, true)) ?? e.db.users.all().find((x) => has(x, false));
  if (!u) throw notFound('User');
  return u;
};

const jwtKid = (jws: string): string | null => {
  try {
    return JSON.parse(atob(jws.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'))).kid ?? null;
  } catch {
    return null;
  }
};

function privacyHandlers(): RouteDef[] {
  const READ = 'data_subject_requests:read';
  const WRITE = 'data_subject_requests:write';
  const actor: [string, string | null] = ['api_key', null];
  const decide = (kind: 'reject' | 'cancel') => (c: RouteContext): Reply => {
    const e = c.engine;
    const r = dsrOf(e, c.params.id);
    if (kind === 'cancel' && r.type === 'export') return forbidden409('Only a scheduled erasure, or a restriction or rectification still waiting, can be cancelled.');
    const allowed = kind === 'reject' ? ['scheduled', 'pending', 'processing'] : ['scheduled', 'pending'];
    if (!allowed.includes(r.status)) return forbidden409(kind === 'reject' ? `This request is already ${r.status} and cannot be rejected.` : `This erasure is already ${r.status} and can no longer be cancelled.`);
    const now = e.clock.now();
    Object.assign(r, { status: kind === 'reject' ? 'rejected' : 'cancelled', updated_at: now, completed_at: now, ...(kind === 'reject' && typeof c.body.reason === 'string' ? { reason: c.body.reason } : {}) });
    note(e, `data_subject_request.${r.type}.${kind === 'reject' ? 'rejected' : 'cancelled'}`, 'data_subject_request', r.id, actor);
    if (kind === 'reject') e.webhooks.emit('data_subject_request.rejected', { object: 'data_subject_request', id: r.id, user_id: r.user_id, type: r.type, status: r.status });
    else if (r.type === 'erasure') e.webhooks.emit('user.deletion_canceled', { object: 'user', id: r.user_id, primary_email_address_id: null, deletion_scheduled_at: null, deletion_effective_at: null, deletion_canceled_at: now, data_subject_request_id: r.id });
    return { body: view(e, r) };
  };

  return [
    {
      method: 'POST',
      pattern: '/v1/data_subject_requests',
      scope: WRITE,
      handler: (c) => {
        const e = c.engine;
        const resolved = typeof c.body.type === 'string' ? TYPES[c.body.type.trim().toLowerCase()] : undefined;
        if (!resolved) throw bad(TYPE_ERROR, 'type');
        const reason = typeof c.body.reason === 'string' ? c.body.reason : undefined;
        const user = subjectOf(e, c.body);
        const latest = st(e).dsr.filter((r) => r.user_id === user.id && r.type === resolved.kind)[0];
        if (latest && (latest.status === 'pending' || (resolved.kind === 'erasure' && latest.status === 'scheduled') || (resolved.kind !== 'erasure' && latest.status === 'processing'))) return { status: 202, body: view(e, latest) };
        // A pre_user_deletion Action may refuse (403 ACTION_BLOCKED, nothing created).
        if (resolved.kind === 'erasure') runActionTrigger(e, 'pre_user_deletion', { userId: user.id, source: 'data_subject_request' });
        const now = e.clock.now();
        const erasure = resolved.kind === 'erasure';
        const row = st(e).dsr.insert({
          user_id: user.id,
          type: resolved.kind,
          canonical_type: resolved.canonical,
          status: erasure ? 'scheduled' : 'pending',
          source: 'api',
          requested_by_type: 'api_key',
          requested_by_id: null,
          reason: reason ?? null,
          detail: resolved.kind === 'restriction' || resolved.kind === 'rectification' ? `Waiting for an operator: carry out the ${resolved.canonical}, then fulfil this request.` : null,
          steps: [],
          scheduled_for: erasure ? now + ERASURE_GRACE_MS : null,
          requested_at: now,
          updated_at: now,
        });
        note(e, `data_subject_request.${resolved.kind}.requested`, 'user', user.id, actor);
        const requested = { object: 'data_subject_request', id: row.id, user_id: user.id, type: resolved.kind, status: row.status, reason: reason ?? null, ...(erasure ? { scheduled_for: row.scheduled_for } : {}) };
        if (resolved.kind === 'export') e.webhooks.emit('user.data_export_requested', requested);
        if (erasure) {
          e.webhooks.emit('user.deletion_requested', requested);
          e.webhooks.emit('data_subject_request.scheduled', { ...requested, canonical_type: resolved.canonical, deletion_effective_at: row.scheduled_for });
          e.webhooks.emit('user.deletion_scheduled', { object: 'user', id: user.id, primary_email_address_id: user.primary_email_address_id ?? null, deletion_scheduled_at: now, deletion_effective_at: row.scheduled_for, data_subject_request_id: row.id });
        }
        return { status: 202, body: view(e, row) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/data_subject_requests',
      scope: READ,
      handler: (c) => {
        const e = c.engine;
        settle(e);
        const q = (k: string) => c.query.get(k);
        const type = q('type') ? (TYPES[q('type')!.toLowerCase()]?.kind ?? q('type')) : null;
        const rows = st(e).dsr.filter((r) => (!type || r.type === type) && (!q('status') || r.status === q('status')) && (!q('user_id') || r.user_id === q('user_id')) && (q('overdue') !== 'true' || view(e, r).overdue === true));
        const page = paginate(rows, pageOf(c));
        return { body: { data: page.data.map((r) => view(e, r)), has_more: page.has_more, next_cursor: page.next_cursor } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/data_subject_requests/:id',
      scope: READ,
      handler: (c) => {
        settle(c.engine);
        return { body: view(c.engine, dsrOf(c.engine, c.params.id), true) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/data_subject_requests/:id/fulfill',
      scope: WRITE,
      handler: (c) => {
        const e = c.engine;
        const r = dsrOf(e, c.params.id);
        if (terminal(r.status)) return forbidden409(`This request is already ${r.status} and cannot be actioned again.`);
        fulfil(e, r, actor);
        return { body: view(e, r, true) };
      },
    },
    { method: 'POST', pattern: '/v1/data_subject_requests/:id/reject', scope: WRITE, handler: decide('reject') },
    { method: 'POST', pattern: '/v1/data_subject_requests/:id/cancel', scope: WRITE, handler: decide('cancel') },
    {
      method: 'POST',
      pattern: '/v1/data_subject_requests/:id/extend',
      scope: WRITE,
      handler: (c) => {
        const e = c.engine;
        const reason = typeof c.body.reason === 'string' ? c.body.reason.trim() : '';
        if (!reason || reason.length > 1000) throw bad('reason is required (max 1000 characters): the deadline moves for a stated reason.', 'reason');
        const raw = c.body.due_at;
        const ms = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN;
        if (!Number.isFinite(ms)) throw bad('due_at is a time (Unix milliseconds or ISO 8601).', 'due_at');
        const r = dsrOf(e, c.params.id);
        if (terminal(r.status)) throw new EmulatorError('CONFLICT', `This request is already ${r.status}.`);
        const current = dueAt(r);
        if (current !== null && ms <= current) throw bad('due_at must be later than the current deadline.', 'due_at');
        // The cap keeps a typo from parking a request for years.
        if (ms > r.requested_at + 3 * 365 * DAY) throw bad('due_at is more than three years after the request.', 'due_at');
        Object.assign(r, { due_at: ms, due_extended_reason: reason, updated_at: e.clock.now() });
        note(e, 'data_subject_request.due_extended', 'data_subject_request', r.id, actor);
        return { body: view(e, r) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/data_subject_requests/:id/receipt',
      scope: READ,
      handler: async (c) => {
        const e = c.engine;
        settle(e);
        const r = dsrOf(e, c.params.id);
        if (r.type !== 'erasure' || r.status !== 'completed' || !r.completed_at) throw new EmulatorError('CONFLICT', 'A deletion receipt exists only for an erasure request that has completed.');
        let rec = st(e).receipts.get(r.id);
        if (!rec) {
          const result = r.result ?? {};
          const issued = e.clock.now();
          const payload = {
            type: 'deletion_receipt',
            version: 1,
            instance_id: e.instanceId,
            request_id: r.id,
            request_type: r.canonical_type,
            subject_id: r.user_id,
            requested_at: new Date(r.requested_at).toISOString(),
            erased_at: result.erased_at,
            personal_data_scrubbed_at: result.personal_data_scrubbed_at,
            steps: (r.steps ?? []).map((s: Obj) => ({ name: s.name, status: s.status })),
            retention: [],
            issued_at: new Date(issued).toISOString(),
          };
          // shortcut: signed as a JWT with the engine's key (not a typ "atlas-deletion-receipt+jwt" JWS); it verifies against the engine JWKS, and never expires.
          const jws = await e.tokens.signClaims(payload, 10 * 365 * 86_400);
          rec = { id: e.db.newId('delrec'), request_id: r.id, subject_id: r.user_id, issued_at: issued, jws, kid: jwtKid(jws), payload };
          st(e).receipts.set(r.id, rec);
          note(e, 'data_subject_request.receipt_issued', 'data_subject_request', r.id, actor);
        }
        return { body: { object: 'deletion_receipt', id: rec.id, request_id: rec.request_id, subject_id: rec.subject_id, issued_at: rec.issued_at, receipt: rec.jws, claims: rec.payload, kid: rec.kid, jwks_uri: `${e.issuer}/.well-known/jwks.json` } };
      },
    },
    // ── the user's own export (session bearer): one in flight, one per hour ──
    {
      method: 'POST',
      pattern: '/v1/client/me/data_export',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const { userId } = await sessionFromBearer(c);
        const latest = st(e).dsr.filter((r) => r.user_id === userId && r.type === 'export')[0];
        if (latest && (latest.status === 'pending' || latest.status === 'processing')) throw new EmulatorError('RATE_LIMITED', 'A data export is already being prepared. Wait for it to finish.');
        if (latest && e.clock.now() - latest.requested_at < EXPORT_COOLDOWN_MS) throw new EmulatorError('RATE_LIMITED', 'You recently requested a data export. Try again later.');
        const now = e.clock.now();
        const row = st(e).dsr.insert({ user_id: userId, type: 'export', canonical_type: 'access', status: 'pending', source: 'user', requested_by_type: 'user', requested_by_id: userId, reason: null, detail: null, steps: [], scheduled_for: null, requested_at: now, updated_at: now });
        note(e, 'data_subject_request.export.requested', 'user', userId, ['user', userId]);
        e.webhooks.emit('user.data_export_requested', { object: 'data_subject_request', id: row.id, user_id: userId, type: 'export', status: row.status });
        return { status: 202, body: clientView(row) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/client/me/data_export',
      public: true,
      handler: async (c) => {
        const { userId } = await sessionFromBearer(c);
        settle(c.engine);
        return { body: { object: 'list', data: st(c.engine).dsr.filter((r) => r.user_id === userId && r.type === 'export').map((r) => clientView(r)) } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/client/me/data_export/:id',
      public: true,
      handler: async (c) => {
        const { userId } = await sessionFromBearer(c);
        settle(c.engine);
        // Another user's request id is a 404, never a 403.
        const r = st(c.engine).dsr.get(c.params.id);
        if (!r || r.user_id !== userId || r.type !== 'export') throw notFound('Data export');
        return { body: clientView(r, true) };
      },
    },
  ];
}

// ── routes ───────────────────────────────────────────────────────────

export function emu3MiscHandlers(): RouteDef[] {
  const triggerOf = (raw: string | undefined): string => {
    if (!raw || !(ACTION_TRIGGERS as readonly string[]).includes(raw)) throw bad(`A trigger of ${ACTION_TRIGGERS.join(', ')} is required.`, 'trigger');
    return raw;
  };
  const orgOf = (e: Engine, id: string | undefined): Obj => {
    const o = e.db.organizations.get(id);
    if (!o) throw notFound('Organization');
    return o;
  };
  return [
    {
      method: 'GET',
      pattern: '/v1/actions/bindings/:trigger',
      scope: 'actions:read',
      handler: (c) => {
        const trigger = triggerOf(c.params.trigger);
        const live = (bindingsOf(c.engine).get(trigger) ?? []).filter((id) => c.engine.generic.get('actions')?.get(id));
        return { body: { object: 'action_binding_list', trigger, action_ids: live } };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/actions/bindings/:trigger',
      scope: 'actions:write',
      handler: (c) => {
        const e = c.engine;
        const trigger = triggerOf(c.params.trigger);
        const ids = c.body.action_ids;
        if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw bad('action_ids must be an array of action ids.', 'action_ids');
        if (new Set(ids).size !== ids.length) throw bad('action_ids must not repeat an action.', 'action_ids');
        if (ids.length > MAX_ACTIONS_PER_FLOW) throw bad(`A flow may bind at most ${MAX_ACTIONS_PER_FLOW} actions.`, 'action_ids');
        // Every id must be an action of this instance that declares this trigger.
        for (const id of ids as string[]) {
          const a = e.generic.get('actions')?.get(id);
          if (!a) throw bad(`Unknown action: ${id}.`, 'action_ids');
          if (a.trigger !== trigger) throw new EmulatorError('CONFLICT', `Action ${id} is a ${a.trigger} action and cannot bind to ${trigger}.`);
        }
        bindingsOf(e).set(trigger, [...(ids as string[])]);
        return { body: { object: 'action_binding_list', trigger, action_ids: ids } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/organizations/:id/policy',
      scope: 'organizations:read',
      handler: (c) => {
        const o = orgOf(c.engine, c.params.id);
        return { body: { object: 'organization_policy', organization_id: o.id, policy: o.policy ?? {} } };
      },
    },
    {
      method: 'PATCH',
      pattern: '/v1/organizations/:id/policy',
      scope: 'organizations:write',
      handler: (c) => {
        const e = c.engine;
        const o = orgOf(e, c.params.id);
        const problems = policyProblems(c.body);
        if (problems.length) return { status: 422, body: errorBody(problems.map((p) => ({ code: 'VALIDATION_FAILED', message: p.message, param: p.param }))) };
        const next: Obj = { ...(o.policy ?? {}) };
        // null clears an override; the retired keys only ever accept null.
        for (const [k, v] of Object.entries(c.body)) {
          if (v === null) delete next[k];
          else next[k] = v;
        }
        o.policy = next;
        o.updated_at = e.clock.now();
        return { body: { object: 'organization_policy', organization_id: o.id, policy: o.policy } };
      },
    },
    ...rateLimitHandlers(),
    ...privacyHandlers(),
  ];
}
