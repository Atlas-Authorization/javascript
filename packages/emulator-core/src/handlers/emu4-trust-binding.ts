/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { bytesToB64url } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import { DPOP_IAT_WINDOW_S, decodeJwt, verifyDpopProof, verifyJws } from '../jws';
import type { Obj } from '../openapi';
import { randomToken } from '../store';
import { claimDpopJti } from './oauth-flows';
import { sessionIdOfRefresh } from './sessions';
import { engineState } from './support';
import { recordAudit } from './emu4-trust';

/**
 * Sender-constrained sessions (a DPoP key per session) and device-bound sessions (the browser DBSC protocol).
 * Both are opt-in through the trust config (`/__emulator/trust/config`); an engine left alone behaves as before.
 */
export interface TrustConfig {
  session_binding: { mode: 'off' | 'optional' | 'required'; require_attestation: boolean };
  device_bound_sessions: boolean;
  /** Whether native app attestation is on for the instance (the real instance verifies Apple and Google evidence). */
  app_attestation: boolean;
}

interface Binding {
  session_id: string;
  jkt: string;
  alg: string;
  attested: boolean;
  attestation_provider: string | null;
  bound_at: number;
  last_proof_at: number | null;
}
interface DeviceBinding {
  session_id: string;
  device_id: string;
  jwk: Obj;
  alg: string;
  challenge: string | null;
  challenge_expires_at: number | null;
}

const state = engineState((_e: Engine) => ({
  config: { session_binding: { mode: 'off', require_attestation: false }, device_bound_sessions: false, app_attestation: false } as TrustConfig,
  bindings: new Map<string, Binding>(),
  devices: new Map<string, DeviceBinding>(),
  /** Random per engine, so a bound cookie from another engine never verifies. */
  hmac: crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
}));

export const trustConfig = (e: Engine): TrustConfig => state(e).config;
const bindingMode = (e: Engine) => state(e).config.session_binding.mode;

const refused = (message: string, reason: string): EmulatorError => new EmulatorError('UNAUTHENTICATED', message, undefined, { meta: { reason } });
const readCookie = (c: RouteContext, name: string): string | undefined => {
  for (const part of (c.request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
};
const refreshOf = (c: RouteContext): string | undefined => {
  const cookie = readCookie(c, '__atlas_rt');
  return cookie ? decodeURIComponent(cookie) : (c.request.headers.get('x-refresh-token') ?? undefined);
};

/** `cnf.jkt` for the session JWT of a bound session; nothing for an unbound one. */
export const sessionBindingClaims = (e: Engine, sessionId: string): Obj => {
  const b = state(e).bindings.get(sessionId);
  return b ? { cnf: { jkt: b.jkt } } : {};
};

/** A proof from the request: `null` when there is no DPoP header, a refusal (401 `dpop_proof_invalid`) when it does not verify or was used before. */
async function proofOf(c: RouteContext): Promise<{ jkt: string; alg: string } | null> {
  const raw = c.request.headers.get('dpop');
  if (raw === null) return null;
  try {
    const r = await verifyDpopProof({ proof: raw, htm: c.request.method, htu: c.request.url, nowMs: c.engine.clock.now() });
    if (!claimDpopJti(c.engine, r.jkt, r.jti, (DPOP_IAT_WINDOW_S + 5) * 1000)) throw new Error('That DPoP proof was already used.');
    return { jkt: r.jkt, alg: String(decodeJwt(raw)?.header.alg ?? '') };
  } catch (err) {
    throw refused(err instanceof Error && err.message === 'That DPoP proof was already used.' ? err.message : 'The DPoP proof is not valid.', 'dpop_proof_invalid');
  }
}

const hmac = async (e: Engine, msg: string): Promise<string> => bytesToB64url(new Uint8Array(await crypto.subtle.sign('HMAC', await state(e).hmac, new TextEncoder().encode(msg))));
/** `<session id>.<exp seconds>.<mac>`: stateless, bound to the session, the kind and the expiry. */
const signBound = async (e: Engine, kind: 'reg' | 'cookie', sid: string, exp: number): Promise<string> => `${sid}.${exp}.${await hmac(e, `${kind}.${sid}.${exp}`)}`;
async function verifyBound(e: Engine, kind: 'reg' | 'cookie', token: string | undefined): Promise<string | null> {
  const parts = (token ?? '').split('.');
  if (parts.length < 3) return null;
  const sig = parts.pop()!;
  const exp = Number(parts.pop());
  const sid = parts.join('.');
  if (!sid || !Number.isFinite(exp) || exp * 1000 <= e.clock.now()) return null;
  // shortcut: plain string comparison, not constant time (an in-process test double has no timing channel to protect).
  return (await hmac(e, `${kind}.${sid}.${exp}`)) === sig ? sid : null;
}
const BOUND_COOKIE = '__atlas_dbsc';
const BOUND_TTL_S = 600;
const CHALLENGE_TTL_S = 300;

async function boundCookie(e: Engine, sid: string): Promise<{ header: string; attributes: string }> {
  const attributes = 'Secure; HttpOnly; SameSite=Lax; Path=/';
  const value = await signBound(e, 'cookie', sid, Math.floor(e.clock.now() / 1000) + BOUND_TTL_S);
  return { header: `${BOUND_COOKIE}=${value}; ${attributes}; Max-Age=${BOUND_TTL_S}`, attributes };
}
const provenDevice = async (c: RouteContext): Promise<string | undefined> => {
  const sid = await verifyBound(c.engine, 'cookie', readCookie(c, BOUND_COOKIE));
  return sid ? state(c.engine).devices.get(sid)?.device_id : undefined;
};

/**
 * The gate on the refresh route: a session bound to a key refreshes only with a fresh single-use proof from that key
 * (401 `dpop_binding_required`); with mode `required` an unbound session cannot refresh (401 `session_binding_required`);
 * a session bound to a device needs that device's bound cookie (401 `device_binding_required`).
 */
export async function enforceSessionBinding(c: RouteContext, sessionId: string): Promise<void> {
  const e = c.engine;
  const s = e.db.sessions.get(sessionId);
  if (!s || s.status !== 'active') return;
  const mode = bindingMode(e);
  if (mode !== 'off') {
    const binding = state(e).bindings.get(sessionId);
    if (!binding) {
      if (mode === 'required') throw refused('This instance requires sessions to be bound to a key. Bind the session (POST /v1/client/session_binding) and retry.', 'session_binding_required');
    } else {
      const proof = await proofOf(c);
      if (!proof || proof.jkt !== binding.jkt) throw refused('This session is bound to a key. Send a DPoP proof signed by that key.', 'dpop_binding_required');
      binding.last_proof_at = e.clock.now();
    }
  }
  if (state(e).config.device_bound_sessions) {
    const device = state(e).devices.get(sessionId);
    if (device && (await provenDevice(c)) !== device.device_id) throw refused('This session is bound to a device. Renew the device credential and try again.', 'device_binding_required');
  }
}

/** `Secure-Session-Registration` for a session handed out with a refresh cookie that is not bound to a device yet. */
export async function dbscRegistrationHeaders(e: Engine, sessionId: string): Promise<Record<string, string>> {
  if (!state(e).config.device_bound_sessions || state(e).devices.has(sessionId)) return {};
  const challenge = await signBound(e, 'reg', sessionId, Math.floor(e.clock.now() / 1000) + CHALLENGE_TTL_S);
  return { 'secure-session-registration': `(ES256 RS256);path="/v1/client/dbsc/start";challenge="${challenge}"` };
}

/** Native app attestation evidence: base64url JSON `{ p: 'ios' | 'ios_dc' | 'android' }`; anything else is refused (the emulator does not run Apple or Google verifiers). */
function attestationProvider(c: RouteContext): string {
  const raw = c.request.headers.get('atlas-attestation');
  const bad = new EmulatorError('APP_ATTESTATION_REQUIRED', raw ? 'The app attestation evidence is not valid.' : 'This request needs app attestation evidence.');
  if (!raw) throw bad;
  try {
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (x) => x.charCodeAt(0)))).p;
    if (p === 'ios' || p === 'ios_dc' || p === 'android') return p;
  } catch {
    /* falls through */
  }
  throw bad;
}

const bindingView = (b: Binding): Obj => ({ object: 'session_binding', session_id: b.session_id, jkt: b.jkt, attested: b.attested, bound_at: b.bound_at });

export function emu4TrustBindingHandlers(): RouteDef[] {
  return [
    // ── the trust switches (the real instance keeps these in its auth config) ──
    { method: 'GET', pattern: '/__emulator/trust/config', public: true, handler: (c) => ({ body: { object: 'trust_config', ...state(c.engine).config } }) },
    {
      method: 'PUT',
      pattern: '/__emulator/trust/config',
      public: true,
      handler: (c) => {
        const cfg = state(c.engine).config;
        const b = c.body;
        const sb = b.session_binding;
        if (sb !== undefined) {
          if (sb === null || typeof sb !== 'object' || Array.isArray(sb)) throw new EmulatorError('VALIDATION_FAILED', 'session_binding must be an object.', 'session_binding');
          if (sb.mode !== undefined && !['off', 'optional', 'required'].includes(sb.mode)) throw new EmulatorError('VALIDATION_FAILED', 'session_binding.mode must be one of off, optional, required.', 'session_binding.mode');
          if (sb.require_attestation !== undefined && typeof sb.require_attestation !== 'boolean') throw new EmulatorError('VALIDATION_FAILED', 'session_binding.require_attestation must be true or false.', 'session_binding.require_attestation');
        }
        for (const f of ['device_bound_sessions', 'app_attestation'] as const) if (b[f] !== undefined && typeof b[f] !== 'boolean') throw new EmulatorError('VALIDATION_FAILED', `${f} must be true or false.`, f);
        if (sb) cfg.session_binding = { ...cfg.session_binding, ...(sb.mode ? { mode: sb.mode } : {}), ...(sb.require_attestation !== undefined ? { require_attestation: sb.require_attestation } : {}) };
        if (b.device_bound_sessions !== undefined) cfg.device_bound_sessions = b.device_bound_sessions;
        if (b.app_attestation !== undefined) cfg.app_attestation = b.app_attestation;
        return { body: { object: 'trust_config', ...cfg } };
      },
    },

    // ── bind a session to a DPoP key (Frontend API) ──
    {
      method: 'POST',
      pattern: '/v1/client/session_binding',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const policy = state(e).config.session_binding;
        if (policy.mode === 'off') throw new EmulatorError('NOT_FOUND', 'Session binding is not enabled.');
        const rt = refreshOf(c);
        const sid = rt ? sessionIdOfRefresh(e, rt, true) : undefined;
        const session = sid ? e.db.sessions.get(sid) : undefined;
        if (!session || session.status !== 'active') throw new EmulatorError('UNAUTHENTICATED', 'No active session to bind.');
        const proof = await proofOf(c);
        if (!proof) throw new EmulatorError('VALIDATION_FAILED', 'Send a DPoP proof signed by the key to bind the session to.', 'dpop');
        const sent = c.request.headers.get('atlas-attestation') !== null;
        let provider: string | null = null;
        if (policy.require_attestation || sent) {
          if (!state(e).config.app_attestation) throw Object.assign(new EmulatorError('STRATEGY_DISABLED', 'App attestation is not enabled for this instance.'), { status: 422 });
          provider = attestationProvider(c);
        }
        const existing = state(e).bindings.get(session.id);
        if (existing) {
          if (existing.jkt !== proof.jkt) throw new EmulatorError('CONFLICT', 'This session is already bound to a different key.', undefined, { meta: { reason: 'already_bound' } });
          existing.last_proof_at = e.clock.now();
          return { status: 200, body: bindingView(existing) };
        }
        const b: Binding = { session_id: session.id, jkt: proof.jkt, alg: proof.alg, attested: provider !== null, attestation_provider: provider, bound_at: e.clock.now(), last_proof_at: null };
        state(e).bindings.set(session.id, b);
        recordAudit(e, { actor_type: 'user', actor_id: session.user_id, action: 'session.bound', target_type: 'session', target_id: session.id, metadata: { jkt: b.jkt, alg: b.alg, attested: b.attested } });
        e.webhooks.emit('session.bound', { object: 'session_binding', session_id: session.id, user_id: session.user_id, jkt: b.jkt, attested: b.attested });
        return { status: 201, body: bindingView(b) };
      },
    },

    // ── the binding of one session, from the backend key ──
    {
      method: 'GET',
      pattern: '/v1/sessions/:id/binding',
      scope: 'sessions:read',
      handler: (c) => {
        const e = c.engine;
        if (!e.db.sessions.get(c.params.id!)) throw notFound('Session');
        const b = state(e).bindings.get(c.params.id!);
        if (!b) return { body: { object: 'session_binding', session_id: c.params.id, bound: false, jkt: null, alg: null, attested: false, attestation_provider: null, bound_at: null, last_proof_at: null } };
        // The key itself is never returned, only its thumbprint.
        return { body: { object: 'session_binding', session_id: b.session_id, bound: true, jkt: b.jkt, alg: b.alg, attested: b.attested, attestation_provider: b.attestation_provider, bound_at: b.bound_at, last_proof_at: b.last_proof_at } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/sessions/:id/binding',
      scope: 'sessions:write',
      handler: (c) => {
        const e = c.engine;
        if (!e.db.sessions.get(c.params.id!)) throw notFound('Session');
        if (!state(e).bindings.delete(c.params.id!)) throw new EmulatorError('NOT_FOUND', 'This session is not bound.');
        recordAudit(e, { actor_type: 'api_key', actor_id: null, action: 'session.binding_removed', target_type: 'session', target_id: c.params.id!, metadata: {} });
        return { body: { object: 'session_binding', session_id: c.params.id, bound: false, deleted: true } };
      },
    },

    // ── device-bound sessions (the browser DBSC protocol) ──
    {
      // The registration challenge a browser would read from `Secure-Session-Registration`: a test helper for clients that do not parse the header.
      method: 'POST',
      pattern: '/__emulator/dbsc/registration',
      public: true,
      handler: async (c) => {
        const sid = String(c.body.session_id ?? '');
        if (!c.engine.db.sessions.get(sid)) throw notFound('Session');
        const challenge = await signBound(c.engine, 'reg', sid, Math.floor(c.engine.clock.now() / 1000) + CHALLENGE_TTL_S);
        return { body: { object: 'dbsc_registration', session_id: sid, challenge, path: '/v1/client/dbsc/start' } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/client/dbsc/start',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        if (!state(e).config.device_bound_sessions) throw new EmulatorError('NOT_FOUND', 'Device bound sessions are not enabled.');
        const fail = (m: string) => new EmulatorError('UNAUTHENTICATED', m);
        const proof = await dbscProof(c, c.request.headers.get('secure-session-response'), '/dbsc/start');
        const sid = proof && (await verifyBound(e, 'reg', proof.jti));
        if (!proof || !sid) throw fail('The registration proof is not valid.');
        const rt = readCookie(c, '__atlas_rt');
        const rtSid = rt ? sessionIdOfRefresh(e, decodeURIComponent(rt), true) : undefined;
        const session = rtSid ? e.db.sessions.get(rtSid) : undefined;
        if (!session || session.id !== sid || session.status !== 'active') throw fail('No active session for this registration.');
        // A browser that already proves a device (another account it holds) registers into that device.
        const deviceId = (await provenDevice(c)) ?? crypto.randomUUID();
        if (state(e).devices.has(sid)) throw fail('This session is already bound to a device.');
        state(e).devices.set(sid, { session_id: sid, device_id: deviceId, jwk: proof.jwk, alg: proof.alg, challenge: null, challenge_expires_at: null });
        const cookie = await boundCookie(e, sid);
        return {
          status: 200,
          headers: { 'set-cookie': cookie.header },
          body: {
            session_identifier: sid,
            refresh_url: '/v1/client/dbsc/refresh',
            scope: { origin: new URL(c.request.url).origin, include_site: false, scope_specification: [] },
            credentials: [{ type: 'cookie', name: BOUND_COOKIE, attributes: cookie.attributes }],
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/client/dbsc/refresh',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        if (!state(e).config.device_bound_sessions) throw new EmulatorError('NOT_FOUND', 'Device bound sessions are not enabled.');
        const fail = (m: string) => new EmulatorError('UNAUTHENTICATED', m);
        const sid = c.request.headers.get('sec-secure-session-id');
        const binding = sid ? state(e).devices.get(sid) : undefined;
        if (!sid || !binding) throw fail('Unknown device bound session.');
        const session = e.db.sessions.get(sid);
        if (!session || session.status !== 'active' || session.expires_at <= e.clock.now()) throw fail('That session is no longer active.');
        const jwt = c.request.headers.get('secure-session-response');
        if (!jwt) {
          binding.challenge = randomToken(24);
          binding.challenge_expires_at = e.clock.now() + CHALLENGE_TTL_S * 1000;
          return { status: 403, headers: { 'secure-session-challenge': `"${binding.challenge}";id="${sid}"` } as Record<string, string> };
        }
        const proof = await dbscProof(c, jwt, '/dbsc/refresh', binding.jwk);
        if (!proof || !binding.challenge || proof.jti !== binding.challenge || !binding.challenge_expires_at || binding.challenge_expires_at <= e.clock.now()) throw fail('The refresh proof is not valid.');
        // Each challenge works once.
        binding.challenge = null;
        binding.challenge_expires_at = null;
        return { status: 200, headers: { 'set-cookie': (await boundCookie(e, sid)).header } as Record<string, string>, body: { session_identifier: sid } };
      },
    },
  ];
}

/** Verify a `dbsc+jwt` proof: type, algorithm (ES256 or RS256), signature (the payload `key` at registration, the stored key at refresh), age of at most 5 minutes, audience suffix and a jti. */
async function dbscProof(c: RouteContext, jwt: string | null, audSuffix: string, jwk?: Obj): Promise<{ jwk: Obj; alg: string; jti: string } | null> {
  const d = jwt ? decodeJwt(jwt) : null;
  if (!d || d.header.typ !== 'dbsc+jwt' || !['ES256', 'RS256'].includes(d.header.alg)) return null;
  const key: Obj | undefined = jwk ?? d.payload.key;
  if (!key || typeof key !== 'object' || 'd' in key || !(await verifyJws(d, key))) return null;
  const now = c.engine.clock.now() / 1000;
  if (typeof d.payload.iat !== 'number' || now - d.payload.iat > 300) return null;
  if (typeof d.payload.exp === 'number' && d.payload.exp <= now) return null;
  const aud = Array.isArray(d.payload.aud) ? d.payload.aud[0] : d.payload.aud;
  if (typeof aud !== 'string' || !aud.split('?')[0]!.endsWith(audSuffix)) return null;
  if (typeof d.payload.jti !== 'string' || !d.payload.jti) return null;
  return { jwk: key, alg: d.header.alg, jti: d.payload.jti };
}
