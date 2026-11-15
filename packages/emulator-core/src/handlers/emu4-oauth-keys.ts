/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { SIGNING_ALGS, isSigningAlg, type SigningAlg } from '../tokens';
import { recordAudit } from './emu4-oauth-audit';
import { engineState } from './support';

/**
 * Signing algorithm choice, staged rotation and the rotation schedule of the instance key, with the real routes and
 * rules: `GET /v1/instance/signing_keys`, `POST .../rotate`, `DELETE .../next`, `GET|PATCH .../signing_key_policy` and
 * `GET|PUT|DELETE /v1/instance/signing_key_schedule`. The JWKS reflects every change; the engine clock drives staging,
 * activation, retirement and the schedule (`runSigningSchedule` runs on every clock advance and on every schedule read).
 */
const DAY_MS = 86_400_000;
const MIN_STAGE_LEAD_MS = 3_600_000;
const MAX_STAGE_LEAD_MS = 90 * DAY_MS;
const DEFAULT_STAGE_DAYS = 14;
const MAX_GRACE_S = 30 * 86_400;
const DEFAULT_SCHEDULE_GRACE_S = 86_400;
/** Verifiers cache a key set for up to an hour; it is added to the longest token lifetime. */
const JWKS_CACHE_MARGIN_S = 3600;
/** The longest token the emulator signs lives an hour (access and ID tokens). */
const LONGEST_TOKEN_S = 3600;
const ALGS_LABEL = 'RS256, ES256, ES384, PS256 or EdDSA';

interface Schedule {
  enabled: boolean;
  interval_days: number;
  alg: SigningAlg | null;
  grace_period_seconds: number | null;
  prepublish_hours: number;
  next_rotation_at: number;
  last_rotated_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
}
interface KeyState {
  policyDays: number | null;
  schedule: Schedule | null;
}
const ks = engineState((): KeyState => ({ policyDays: null, schedule: null }));

const bad = (message: string, param?: string): EmulatorError => new EmulatorError('VALIDATION_FAILED', message, param);
const conflict = (message: string): EmulatorError => new EmulatorError('CONFLICT', message);

/** The shortest the previous key may stay published: the longest token lifetime plus the key set cache. */
export const minimumGraceSeconds = (): number => LONGEST_TOKEN_S + JWKS_CACHE_MARGIN_S;

function scheduleView(e: Engine, s: Schedule | null): Obj {
  return {
    object: 'signing_key_schedule',
    enabled: s?.enabled ?? false,
    interval_days: s?.interval_days ?? null,
    alg: s?.alg ?? null,
    grace_period_seconds: s?.grace_period_seconds ?? null,
    prepublish_hours: s?.prepublish_hours ?? null,
    effective_grace_seconds: Math.max(s?.grace_period_seconds ?? 0, minimumGraceSeconds(), DEFAULT_SCHEDULE_GRACE_S),
    next_rotation_at: s?.next_rotation_at ?? null,
    last_rotated_at: s?.last_rotated_at ?? null,
    last_error: s?.last_error ?? null,
    last_error_at: s?.last_error_at ?? null,
  };
}

function parseSchedule(body: Obj): Omit<Schedule, 'next_rotation_at' | 'last_rotated_at' | 'last_error' | 'last_error_at'> {
  const days = body.interval_days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) throw bad('interval_days must be a whole number of days from 1 to 365.', 'interval_days');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw bad('enabled must be true or false.', 'enabled');
  let alg: SigningAlg | null = null;
  if (body.alg !== undefined && body.alg !== null) {
    if (!isSigningAlg(body.alg)) throw bad(`alg must be ${ALGS_LABEL}.`, 'alg');
    alg = body.alg;
  }
  const g = body.grace_period_seconds;
  let grace: number | null = null;
  if (g !== undefined && g !== null) {
    if (typeof g !== 'number' || !Number.isInteger(g) || g < 0 || g > MAX_GRACE_S) throw bad('grace_period_seconds must be a whole number of seconds from 0 to 2592000.', 'grace_period_seconds');
    if (g < minimumGraceSeconds()) throw bad(`grace_period_seconds must be at least ${minimumGraceSeconds()}: the longest token this instance signs lives that long (plus the key set cache), and the previous key must stay published until it has expired.`, 'grace_period_seconds');
    grace = g;
  }
  const p = body.prepublish_hours;
  if (p !== undefined && (typeof p !== 'number' || !Number.isInteger(p) || p < 2 || p > 720)) throw bad('prepublish_hours must be a whole number of hours from 2 to 720.', 'prepublish_hours');
  const prepublish = (p as number | undefined) ?? 24;
  const effective = Math.max(grace ?? 0, minimumGraceSeconds(), DEFAULT_SCHEDULE_GRACE_S);
  if (days * 86_400 <= prepublish * 3600 + effective) throw bad('interval_days is too short: one rotation (the new key published prepublish_hours before it signs, the old key kept for the grace period) must finish before the next starts.', 'interval_days');
  return { enabled: body.enabled !== false, interval_days: days, alg, grace_period_seconds: grace, prepublish_hours: prepublish };
}

/**
 * The worker's rotation sweep, on the engine clock: when the schedule is due it STAGES a new key (published
 * `prepublish_hours` before it signs); it waits while a previous key is still published or another key is staged.
 */
export async function runSigningSchedule(e: Engine): Promise<'idle' | 'staged' | 'waiting' | 'failed'> {
  const s = ks(e).schedule;
  // No key is made just to look at the clock: an engine that never signed has nothing to activate or retire.
  if (!s) return (await e.tokens.settleIfStarted(), 'idle');
  await e.tokens.ready();
  const now = e.clock.now();
  if (!s.enabled || now < s.next_rotation_at) return 'idle';
  const st = await e.tokens.keyState();
  const blockedUntil = Math.max(st.previousRetiresAt !== null && st.previousRetiresAt > now ? st.previousRetiresAt : 0, st.staged ? st.staged.activatesAt + 60_000 : 0);
  if (blockedUntil > now) {
    s.next_rotation_at = blockedUntil + 60_000;
    return 'waiting';
  }
  const grace = Math.max(s.grace_period_seconds ?? 0, minimumGraceSeconds(), DEFAULT_SCHEDULE_GRACE_S);
  try {
    const r = await e.tokens.rotate(s.alg ?? undefined, { staged: true, activatesAt: now + s.prepublish_hours * 3_600_000, graceSeconds: grace, trigger: 'schedule' });
    const data = { object: 'signing_key', kid: r.kid, alg: r.alg, activates_at: r.activates_at, trigger: 'schedule' };
    e.webhooks.emit('signing_key.staged', data);
    recordAudit(e, 'signing_key.staged', 'system', 'instance', e.instanceId, { ...data, grace_period_seconds: grace });
    s.last_rotated_at = now;
    s.next_rotation_at = now + s.interval_days * DAY_MS;
    s.last_error = null;
    s.last_error_at = null;
    return 'staged';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.last_error = message.slice(0, 300);
    s.last_error_at = now;
    s.next_rotation_at = now + 3_600_000;
    e.webhooks.emit('signing_key.rotation_failed', { object: 'signing_key_schedule', error: message.slice(0, 300), retry_at: s.next_rotation_at });
    recordAudit(e, 'signing_key.rotation_failed', 'system', 'instance', e.instanceId, { error: message.slice(0, 300) });
    return 'failed';
  }
}

function parseStaging(body: Obj, now: number): { staged?: boolean; activatesAt?: number } {
  if (body.staged !== undefined && typeof body.staged !== 'boolean') throw bad('staged must be true or false.', 'staged');
  let activatesAt: number | undefined;
  if (body.activates_at !== undefined) {
    const raw = body.activates_at;
    const at = typeof raw === 'number' && Number.isFinite(raw) ? raw : typeof raw === 'string' && raw.trim() ? Date.parse(raw) : NaN;
    if (Number.isNaN(at)) throw bad('activates_at must be an ISO 8601 date-time or epoch milliseconds.', 'activates_at');
    const lead = at - now;
    if (lead < MIN_STAGE_LEAD_MS || lead > MAX_STAGE_LEAD_MS) throw bad('activates_at must be at least 1 hour and at most 90 days from now.', 'activates_at');
    if (body.staged === false) throw bad('activates_at applies to a staged rotation (staged: true).', 'activates_at');
    activatesAt = at;
  }
  return { ...(body.staged !== undefined ? { staged: body.staged } : {}), ...(activatesAt !== undefined ? { activatesAt } : {}) };
}

export function signingKeyHandlers(): RouteDef[] {
  return [
    { method: 'GET', pattern: '/v1/instance/signing_keys', scope: 'instance:read', handler: async (c) => ({ body: { object: 'list', data: await c.engine.tokens.signingKeys() } }) },
    {
      method: 'POST',
      pattern: '/v1/instance/signing_keys/rotate',
      scope: 'instance:write',
      handler: async (c) => {
        const e = c.engine;
        const b = c.body;
        if (b.key !== undefined && b.key !== 'main' && b.key !== 'secondary') throw bad('key must be "main" or "secondary".', 'key');
        if (b.alg !== undefined && !isSigningAlg(b.alg)) throw bad(`alg must be ${ALGS_LABEL}.`, 'alg');
        if (b.emergency !== undefined && typeof b.emergency !== 'boolean') throw bad('emergency must be true or false.', 'emergency');
        let grace = 86_400;
        if (b.grace_period_seconds !== undefined) {
          const g = b.grace_period_seconds;
          if (typeof g !== 'number' || !Number.isInteger(g) || g < 0 || g > MAX_GRACE_S) throw bad(`grace_period_seconds must be a whole number of seconds from 0 to ${MAX_GRACE_S}.`, 'grace_period_seconds');
          grace = g;
        }
        // The emulator holds its keys locally: `key` only applies to keys in a key management service.
        if (b.key !== undefined) throw bad('key applies to keys held in a key management service.', 'key');
        const emergency = b.emergency === true;
        const now = e.clock.now();
        const staging = parseStaging(b, now);
        if (staging.staged === true && emergency) throw bad('An emergency rotation cannot be staged: it replaces the key now.', 'staged');
        const st = await e.tokens.keyState();
        const staged = !emergency && (staging.staged ?? Boolean(ks(e).policyDays));
        if (!staged) {
          if (!emergency && st.staged) throw conflict(`Key ${st.staged.kid} is staged to start signing at ${new Date(st.staged.activatesAt).toISOString()}. Only one key can be staged: cancel it first (DELETE /v1/instance/signing_keys/next), or pass emergency: true to discard it and rotate now.`);
          if (!emergency && st.previousRetiresAt !== null && st.previousRetiresAt > now) throw conflict(`The previous key is still published until ${new Date(st.previousRetiresAt).toISOString()}. Rotate again after that, or pass emergency: true to revoke it now.`);
        }
        if (staged) {
          if (b.grace_period_seconds !== undefined) throw bad('grace_period_seconds does not apply to a staged rotation: the previous key stays published for 24 hours after the new key activates.', 'grace_period_seconds');
          if (st.staged) throw conflict(`Key ${st.staged.kid} is already staged to start signing at ${new Date(st.staged.activatesAt).toISOString()}. Only one key can be staged: cancel it first (DELETE /v1/instance/signing_keys/next).`);
          const at = staging.activatesAt ?? now + (ks(e).policyDays || DEFAULT_STAGE_DAYS) * DAY_MS;
          if (st.previousRetiresAt !== null && st.previousRetiresAt > now && st.previousRetiresAt > at) throw conflict(`The previous key is still published until ${new Date(st.previousRetiresAt).toISOString()}. Stage the next key to activate after that (activates_at), or rotate again once it is retired.`);
          const r = await e.tokens.rotate(b.alg as SigningAlg | undefined, { staged: true, activatesAt: at, trigger: 'request' });
          const data = { object: 'signing_key', kid: r.kid, alg: r.alg, activates_at: r.activates_at };
          e.webhooks.emit('signing_key.staged', data);
          recordAudit(e, 'signing_key.staged', 'api_key', 'instance', e.instanceId, { kid: r.kid, alg: r.alg, current_kid: st.currentKid, activates_at: r.activates_at, staged: true, provider: 'local' });
          return { status: 201, body: { object: 'signing_key_rotation', kid: r.kid, alg: r.alg, previous_kid: r.previous_kid, previous_retires_at: r.previous_retires_at, emergency: false, provider: 'local', staged: true, activates_at: r.activates_at } };
        }
        const discarded = emergency ? (st.staged?.kid ?? null) : null;
        const r = await e.tokens.rotate(b.alg as SigningAlg | undefined, { graceSeconds: grace, emergency });
        e.webhooks.emit('signing_key.rotated', { object: 'signing_key', kid: r.kid, alg: r.alg, previous_kid: r.previous_kid, emergency, retires_at: emergency ? null : r.previous_retires_at, provider: 'local' });
        recordAudit(e, 'signing_key.rotated', 'api_key', 'instance', e.instanceId, { kid: r.kid, alg: r.alg, previous_kid: r.previous_kid, grace_period_seconds: emergency ? 0 : grace, emergency, provider: 'local', ...(discarded ? { discarded_staged_kid: discarded } : {}) });
        return { status: 201, body: { object: 'signing_key_rotation', kid: r.kid, alg: r.alg, previous_kid: r.previous_kid, previous_retires_at: r.previous_retires_at, emergency, provider: 'local' } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/instance/signing_keys/next',
      scope: 'instance:write',
      handler: async (c) => {
        const kid = await c.engine.tokens.cancelStaged();
        if (!kid) throw new EmulatorError('NOT_FOUND', 'No signing key is staged.');
        recordAudit(c.engine, 'signing_key.staged_canceled', 'api_key', 'instance', c.engine.instanceId, { kid });
        return { body: { object: 'signing_key', kid, status: 'next', deleted: true } };
      },
    },
    { method: 'GET', pattern: '/v1/instance/signing_key_policy', scope: 'instance:read', handler: (c) => ({ body: { object: 'signing_key_policy', prepublish_days: ks(c.engine).policyDays || null } }) },
    {
      method: 'PATCH',
      pattern: '/v1/instance/signing_key_policy',
      scope: 'instance:write',
      handler: (c) => {
        const d = c.body.prepublish_days;
        if (d === undefined) throw bad('prepublish_days is required (null or 0 turns it off).', 'prepublish_days');
        if (d !== null && (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 90)) throw bad('prepublish_days must be a whole number of days from 1 to 90, or null / 0 to turn it off.', 'prepublish_days');
        const state = ks(c.engine);
        const before = state.policyDays || null;
        state.policyDays = d ? (d as number) : null;
        recordAudit(c.engine, 'signing_key.policy_updated', 'api_key', 'instance', c.engine.instanceId, { before, after: state.policyDays });
        return { body: { object: 'signing_key_policy', prepublish_days: state.policyDays } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/instance/signing_key_schedule',
      scope: 'instance:read',
      handler: async (c) => {
        await runSigningSchedule(c.engine);
        return { body: scheduleView(c.engine, ks(c.engine).schedule) };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/instance/signing_key_schedule',
      scope: 'instance:write',
      handler: (c) => {
        const e = c.engine;
        // The real route also asks for a recent MFA check; the emulator has no step-up state for the key.
        const p = parseSchedule(c.body);
        const state = ks(e);
        const before = state.schedule;
        state.schedule = { ...p, next_rotation_at: e.clock.now() + p.interval_days * DAY_MS, last_rotated_at: before?.last_rotated_at ?? null, last_error: null, last_error_at: null };
        recordAudit(e, 'signing_key_schedule.set', 'api_key', 'instance', e.instanceId, { interval_days: p.interval_days, alg: p.alg, grace_period_seconds: p.grace_period_seconds, prepublish_hours: p.prepublish_hours, enabled: p.enabled, previous_interval_days: before?.interval_days ?? null });
        return { body: scheduleView(e, state.schedule) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/instance/signing_key_schedule',
      scope: 'instance:write',
      handler: (c) => {
        const state = ks(c.engine);
        if (!state.schedule) throw new EmulatorError('NOT_FOUND', 'No rotation schedule is set.');
        state.schedule = null;
        recordAudit(c.engine, 'signing_key_schedule.removed', 'api_key', 'instance', c.engine.instanceId);
        return { body: { object: 'signing_key_schedule', enabled: false, deleted: true } };
      },
    },
    { method: 'POST', pattern: '/__emulator/oauth/signing/run', public: true, handler: async (c) => ({ body: { object: 'signing_key_sweep', result: await runSigningSchedule(c.engine) } }) },
  ];
}

export { SIGNING_ALGS };
