/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { randomToken } from '../store';
import { authenticateClient, fail, issueCode, issueTokens, splitScope, st as oauthSt, type Grant } from './oauth';
import { engineState, sessionFromBearer } from './support';

/**
 * The OAuth provider's interactive and out-of-band flows, on top of the core in `oauth.ts`: the consent screen (built-in
 * `/oauth2/authorize/consent` and the delegated `/v1/oauth_consent_requests` challenge), pushed authorization requests
 * (RFC 9126), the device authorization grant (RFC 8628) and OpenID CIBA (poll and ping). The emulator is its own user agent:
 * the person who consents, enters the device code or answers a CIBA prompt is simulated by calling the same routes a
 * browser or phone would.
 */
const PAR_TTL_MS = 60_000;
const CONSENT_TTL_MS = 10 * 60_000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';
const DEVICE_TTL_S = 600;
const POLL_INTERVAL_S = 5;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

interface Consent {
  id: string;
  clientId: string;
  userId: string;
  scope: string[];
  redirectUri: string;
  challenge: string | null;
  nonce: string | null;
  state?: string;
  expiresAt: number;
  status: 'pending' | 'accepted' | 'rejected';
}
interface DeviceRec {
  deviceCode: string;
  userCode: string;
  clientId: string;
  scope: string[];
  expiresAt: number;
  interval: number;
  lastPoll: number;
  status: 'pending' | 'approved' | 'denied' | 'used';
  userId?: string;
}
interface CibaRec {
  id: string;
  clientId: string;
  userId: string;
  scope: string[];
  bindingMessage: string | null;
  expiresAt: number;
  interval: number;
  lastPoll: number;
  status: 'pending' | 'approved' | 'denied' | 'used';
  notificationToken: string | null;
  createdAt: number;
}
interface Flows {
  par: Map<string, { clientId: string; params: Record<string, string>; expiresAt: number; used: boolean }>;
  consents: Map<string, Consent>;
  remembered: Map<string, Set<string>>;
  devices: Map<string, DeviceRec>;
  ciba: Map<string, CibaRec>;
  dpopSeen: Map<string, number>;
}
const flows = engineState((): Flows => ({ par: new Map(), consents: new Map(), remembered: new Map(), devices: new Map(), ciba: new Map(), dpopSeen: new Map() }));
export const resetOAuthFlows = (_e: Engine): void => undefined; // state lives in engineState, which engine.reset clears

/** Claim a DPoP proof's jti once inside its window; false when it was already used. */
export function claimDpopJti(e: Engine, jkt: string, jti: string, ttlMs: number): boolean {
  const seen = flows(e).dpopSeen;
  const now = e.clock.now();
  for (const [k, until] of seen) if (until <= now) seen.delete(k);
  const key = `${jkt}:${jti}`;
  if (seen.has(key)) return false;
  seen.set(key, now + ttlMs);
  return true;
}

const redirectTo = (uri: string, params: Record<string, string | undefined>): string => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
};
const found = (location: string): Reply => ({ status: 302, headers: { location, 'cache-control': 'no-store' } });

/** The user a flow acts for: an explicit id or email, else the one the emulator signs in, else the only user. */
function resolveUser(e: Engine, hint: string | null | undefined, allowSole = true): Obj | undefined {
  const live = e.db.users.filter((u) => !u.deleted);
  if (hint) return live.find((u) => u.id === hint || (u.emails as Obj[]).some((m) => m.email_address.toLowerCase() === hint.toLowerCase()));
  const auto = oauthSt(e).autoUser;
  return (auto ? live.find((u) => u.id === auto) : undefined) ?? (allowSole && live.length === 1 ? live[0] : undefined);
}

// ── PAR ──────────────────────────────────────────────────────────────

/** An /authorize request carrying `request_uri`: swap in the pushed parameters (single use, bound to the client). */
export function resolveRequestUri(e: Engine, query: URLSearchParams): { query: URLSearchParams } | { error: { code: string; description: string } } {
  const uri = query.get('request_uri');
  if (!uri) return { query };
  const rec = flows(e).par.get(uri);
  if (!rec || rec.used || rec.expiresAt <= e.clock.now()) return { error: { code: 'invalid_request_uri', description: 'The request_uri is unknown, expired or already used.' } };
  if (query.get('client_id') !== rec.clientId) return { error: { code: 'invalid_request', description: 'client_id does not match the client that pushed this request.' } };
  rec.used = true;
  return { query: new URLSearchParams({ ...rec.params, client_id: rec.clientId }) };
}

// ── consent ──────────────────────────────────────────────────────────

const rememberKey = (userId: string, clientId: string) => `${userId}|${clientId}`;

/** Where an authorize request must stop for the user's consent, or null when it can proceed (first-party client, consent not required, or already remembered). */
export function consentGate(e: Engine, a: { client: Obj; user: Obj; scope: string[]; redirectUri: string; challenge: string | null; nonce: string | null; state?: string; prompt: string | null }): Reply | null {
  const { client, user, scope, prompt } = a;
  const forced = prompt === 'consent';
  if (client.first_party === true || !(client.require_consent === true || forced)) return null;
  const held = flows(e).remembered.get(rememberKey(user.id, client.id));
  if (!forced && held && scope.every((s) => held.has(s))) return null;
  if (prompt === 'none') return found(redirectTo(a.redirectUri, { error: 'consent_required', error_description: 'The user has not consented to these scopes.', state: a.state, iss: e.issuer }));
  const id = `consent_${randomToken(24)}`;
  flows(e).consents.set(id, { id, clientId: client.id, userId: user.id, scope, redirectUri: a.redirectUri, challenge: a.challenge, nonce: a.nonce, state: a.state, expiresAt: e.clock.now() + CONSENT_TTL_MS, status: 'pending' });
  return found(`${e.issuer}/oauth2/authorize/consent?consent_token=${id}`);
}

function liveConsent(e: Engine, id: string | null | undefined): Consent {
  const c = id ? flows(e).consents.get(id) : undefined;
  if (!c || c.status !== 'pending' || c.expiresAt <= e.clock.now()) throw new EmulatorError('NOT_FOUND', 'This consent request has expired or was already answered.');
  return c;
}

/** Answer a consent request; returns the URL to send the browser to. The scopes granted are always a subset of what was asked. */
function settleConsent(e: Engine, c: Consent, d: { approve: boolean; grant?: string[]; remember?: boolean; error?: string; description?: string }): string {
  const back = (p: Record<string, string | undefined>) => redirectTo(c.redirectUri, { ...p, state: c.state, iss: e.issuer });
  const client = e.db.oauthClients.get(c.clientId);
  if (!client || client.deleted) {
    c.status = 'rejected';
    return back({ error: 'unauthorized_client' });
  }
  if (!d.approve) {
    c.status = 'rejected';
    return back({ error: d.error ?? 'access_denied', error_description: d.description ?? 'The user denied the request.' });
  }
  const grant = d.grant ?? c.scope;
  if (grant.some((s) => !c.scope.includes(s))) throw new EmulatorError('VALIDATION_FAILED', 'grant_scope can only narrow the requested scopes.', 'grant_scope');
  if (c.scope.includes('openid') && !grant.includes('openid')) throw new EmulatorError('VALIDATION_FAILED', 'grant_scope must include openid.', 'grant_scope');
  c.status = 'accepted';
  if (d.remember !== false) {
    const key = rememberKey(c.userId, c.clientId);
    flows(e).remembered.set(key, new Set([...(flows(e).remembered.get(key) ?? []), ...grant]));
  }
  return back({ code: issueCode(e, { client, userId: c.userId, scope: grant, redirectUri: c.redirectUri, challenge: c.challenge, nonce: c.nonce }) });
}

// ── extension grants on /oauth2/token ────────────────────────────────

const pendingErr = (error: string, description: string): Reply => fail(400, error, description);

/** `device_code` and `ciba` grants. Returns undefined for any other grant type. */
export async function extensionGrant(c: RouteContext, client: Obj, type: string, cnf: Obj | undefined): Promise<Reply | undefined> {
  const e = c.engine;
  const now = e.clock.now();
  if (type !== DEVICE_GRANT && type !== CIBA_GRANT) return undefined;
  const isDevice = type === DEVICE_GRANT;
  const rec: DeviceRec | CibaRec | undefined = isDevice ? flows(e).devices.get(String(c.body.device_code ?? '')) : flows(e).ciba.get(String(c.body.auth_req_id ?? ''));
  if (!rec || rec.clientId !== client.id || rec.status === 'used') return fail(400, 'invalid_grant', isDevice ? 'The device_code is invalid.' : 'The auth_req_id is invalid.');
  if (rec.expiresAt <= now) return pendingErr('expired_token', 'The request expired.');
  if (rec.status === 'denied') {
    rec.status = 'used';
    return pendingErr('access_denied', 'The user denied the request.');
  }
  // Polling faster than the interval earns slow_down and a longer interval (RFC 8628 section 3.5).
  if (rec.status === 'pending') {
    if (now - rec.lastPoll < rec.interval * 1000) {
      rec.interval += 5;
      rec.lastPoll = now;
      return pendingErr('slow_down', 'Polling too fast: wait at least the new interval.');
    }
    rec.lastPoll = now;
    return pendingErr('authorization_pending', isDevice ? 'The user has not finished authorizing this device yet.' : 'The user has not answered yet.');
  }
  rec.status = 'used';
  const userId = (rec as any).userId as string;
  const grant: Grant = { id: e.db.newId('oag'), clientId: client.id, userId, scope: rec.scope, revoked: false, jtis: new Set() };
  oauthSt(e).grants.set(grant.id, grant);
  return { body: await issueTokens(e, client, grant, null, now, undefined, cnf), headers: { 'cache-control': 'no-store', pragma: 'no-cache' } };
}

const userCodeOf = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const s = [...bytes].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};
const normaliseUserCode = (s: unknown): string => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '');

function scopeFor(client: Obj, asked: string | undefined): string[] | { error: Reply } {
  const allowed: string[] = client.allowed_scopes ?? [];
  const requested = splitScope(asked);
  if (!requested.length) return allowed;
  const outside = requested.filter((s) => !allowed.includes(s));
  return outside.length ? { error: fail(400, 'invalid_scope', `Scope not allowed for this client: ${outside.join(' ')}.`) } : requested;
}

export function oauthFlowHandlers(): RouteDef[] {
  const cibaView = (r: CibaRec): Obj => ({ id: r.id, scope: r.scope, binding_message: r.bindingMessage, created_at: r.createdAt, expires_at: r.expiresAt });
  const requireClient = (e: Engine, c: RouteContext, needGrant?: string): { client: Obj } | { error: Reply } => {
    const auth = authenticateClient(e, c);
    if ('error' in auth) return auth;
    if (needGrant && !(auth.client.grant_types as string[]).includes(needGrant)) return { error: fail(400, 'unauthorized_client', `This client is not permitted the ${needGrant} grant.`) };
    return auth;
  };

  return [
    // ── PAR ──
    {
      method: 'POST',
      pattern: '/oauth2/par',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const auth = requireClient(e, c);
        if ('error' in auth) return auth.error;
        const client = auth.client;
        const b = c.body;
        if (b.request_uri) return fail(400, 'invalid_request', 'request_uri is not allowed here.');
        if (b.client_id && b.client_id !== client.id) return fail(400, 'invalid_request', 'client_id does not match the authenticated client.');
        const redirectUri = typeof b.redirect_uri === 'string' ? b.redirect_uri : undefined;
        if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return fail(400, 'invalid_request', 'The redirect_uri does not match a registered URI.');
        if (b.response_type !== 'code') return fail(400, 'unsupported_response_type', 'Only response_type=code is supported.');
        const asked = splitScope(b.scope ?? 'openid');
        const outside = asked.filter((s) => !client.allowed_scopes.includes(s) && !['openid', 'profile', 'email', 'offline_access'].includes(s));
        if (outside.length) return fail(400, 'invalid_scope', `Scope not allowed: ${outside.join(' ')}.`);
        if (b.code_challenge && (b.code_challenge_method ?? 'plain') !== 'S256') return fail(400, 'invalid_request', 'code_challenge_method must be S256.');
        if (!b.code_challenge && client.auth_method === 'none') return fail(400, 'invalid_request', 'A public client must use PKCE (code_challenge).');
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(b)) if (typeof v === 'string' && !['client_secret', 'client_id'].includes(k)) params[k] = v;
        const uri = `urn:ietf:params:oauth:request_uri:${randomToken(24)}`;
        flows(e).par.set(uri, { clientId: client.id, params, expiresAt: e.clock.now() + PAR_TTL_MS, used: false });
        return { status: 201, body: { request_uri: uri, expires_in: PAR_TTL_MS / 1000 }, headers: { 'cache-control': 'no-store' } };
      },
    },
    // ── consent: the built-in screen ──
    {
      method: 'GET',
      pattern: '/oauth2/authorize/consent',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const r = liveConsent(e, c.query.get('consent_token'));
        const client = e.db.oauthClients.get(r.clientId)!;
        return { body: { object: 'oauth_consent_screen', consent_token: r.id, client: { id: client.id, name: client.name }, user_id: r.userId, requested_scope: r.scope, expires_at: r.expiresAt } };
      },
    },
    {
      method: 'POST',
      pattern: '/oauth2/authorize/consent',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const r = liveConsent(e, typeof c.body.consent_token === 'string' ? c.body.consent_token : null);
        const approve = c.body.decision === 'approve';
        if (!approve && c.body.decision !== 'deny') throw new EmulatorError('VALIDATION_FAILED', 'decision must be approve or deny.', 'decision');
        return found(settleConsent(e, r, { approve }));
      },
    },
    // ── consent: the delegated challenge (a customer's own consent page) ──
    {
      method: 'GET',
      pattern: '/v1/oauth_consent_requests',
      handler: (c) => {
        const e = c.engine;
        const r = liveConsent(e, c.query.get('consent_challenge'));
        const client = e.db.oauthClients.get(r.clientId)!;
        return { body: { object: 'oauth_consent_request', subject: r.userId, client: { id: client.id, client_id: client.id, name: client.name }, requested_scope: r.scope, expires_at: r.expiresAt } };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/oauth_consent_requests/accept',
      handler: (c) => {
        const e = c.engine;
        const r = liveConsent(e, c.query.get('consent_challenge'));
        if (c.body.grant_scope !== undefined && (!Array.isArray(c.body.grant_scope) || c.body.grant_scope.some((s: unknown) => typeof s !== 'string'))) throw new EmulatorError('VALIDATION_FAILED', 'grant_scope must be a list of scopes.', 'grant_scope');
        return { body: { object: 'oauth_consent_redirect', redirect_to: settleConsent(e, r, { approve: true, grant: c.body.grant_scope, remember: c.body.remember }) } };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/oauth_consent_requests/reject',
      handler: (c) => {
        const e = c.engine;
        const r = liveConsent(e, c.query.get('consent_challenge'));
        return { body: { object: 'oauth_consent_redirect', redirect_to: settleConsent(e, r, { approve: false, error: c.body.error, description: c.body.error_description }) } };
      },
    },
    // ── device authorization ──
    {
      method: 'POST',
      pattern: '/oauth2/device_authorization',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const auth = requireClient(e, c, DEVICE_GRANT);
        if ('error' in auth) return auth.error;
        const scope = scopeFor(auth.client, c.body.scope);
        if ('error' in scope) return scope.error;
        const rec: DeviceRec = { deviceCode: randomToken(32), userCode: userCodeOf(), clientId: auth.client.id, scope, expiresAt: e.clock.now() + DEVICE_TTL_S * 1000, interval: POLL_INTERVAL_S, lastPoll: 0, status: 'pending' };
        flows(e).devices.set(rec.deviceCode, rec);
        const uri = `${e.issuer}/oauth2/device`;
        return { body: { device_code: rec.deviceCode, user_code: rec.userCode, verification_uri: uri, verification_uri_complete: `${uri}?user_code=${rec.userCode}`, expires_in: DEVICE_TTL_S, interval: POLL_INTERVAL_S }, headers: { 'cache-control': 'no-store', pragma: 'no-cache' } };
      },
    },
    {
      method: 'GET',
      pattern: '/oauth2/device',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const code = normaliseUserCode(c.query.get('user_code'));
        const rec = [...flows(e).devices.values()].find((d) => normaliseUserCode(d.userCode) === code && d.status === 'pending' && d.expiresAt > e.clock.now());
        if (!rec) throw new EmulatorError('NOT_FOUND', 'That code is not valid or has expired.');
        const client = e.db.oauthClients.get(rec.clientId)!;
        return { body: { object: 'oauth_device_verification', user_code: rec.userCode, client: { id: client.id, name: client.name }, scope: rec.scope, expires_at: rec.expiresAt } };
      },
    },
    {
      method: 'POST',
      pattern: '/oauth2/device/verify',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const code = normaliseUserCode(c.body.user_code);
        const rec = [...flows(e).devices.values()].find((d) => normaliseUserCode(d.userCode) === code && d.status === 'pending' && d.expiresAt > e.clock.now());
        if (!rec) throw new EmulatorError('NOT_FOUND', 'That code is not valid or has expired.');
        if (c.body.decision !== 'approve' && c.body.decision !== 'deny') throw new EmulatorError('VALIDATION_FAILED', 'decision must be approve or deny.', 'decision');
        if (c.body.decision === 'deny') rec.status = 'denied';
        else {
          const user = resolveUser(e, typeof c.body.user_id === 'string' ? c.body.user_id : typeof c.body.login_hint === 'string' ? c.body.login_hint : null);
          if (!user) throw new EmulatorError('VALIDATION_FAILED', 'No user to sign in. Pass user_id or POST /__emulator/oauth/login.', 'user_id');
          if (user.banned) throw new EmulatorError('FORBIDDEN', 'The user is banned.');
          rec.userId = user.id;
          rec.status = 'approved';
        }
        return { body: { object: 'oauth_device_verification', status: rec.status } };
      },
    },
    // ── CIBA ──
    {
      method: 'POST',
      pattern: '/oauth2/backchannel_authentication',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const auth = requireClient(e, c, CIBA_GRANT);
        if ('error' in auth) return auth.error;
        const client = auth.client;
        if (client.auth_method === 'none') return fail(400, 'invalid_client', 'CIBA requires a confidential client.');
        const scope = scopeFor(client, c.body.scope);
        if ('error' in scope) return scope.error;
        const hint = typeof c.body.login_hint === 'string' ? c.body.login_hint : '';
        if (!hint) return fail(400, 'invalid_request', 'login_hint is required.');
        const user = resolveUser(e, hint, false);
        if (!user) return fail(400, 'unknown_user_id', 'No user matches the login_hint.');
        if (user.banned) return fail(400, 'access_denied', 'The user is banned.');
        const binding = c.body.binding_message;
        if (binding !== undefined && (typeof binding !== 'string' || binding.length > 64 || !/^[\x20-\x7e]*$/.test(binding))) return fail(400, 'invalid_binding_message', 'binding_message is up to 64 printable characters.');
        const expiry = c.body.requested_expiry === undefined ? 120 : Number(c.body.requested_expiry);
        if (!Number.isInteger(expiry) || expiry < 1 || expiry > 3600) return fail(400, 'invalid_request', 'requested_expiry is a whole number of seconds from 1 to 3600.');
        const mode = client.backchannel_token_delivery_mode ?? 'poll';
        let token: string | null = null;
        if (mode === 'ping') {
          const t = c.body.client_notification_token;
          if (typeof t !== 'string' || t.length < 22 || t.length > 1024 || !/^[\x21-\x7e]+$/.test(t)) return fail(400, 'invalid_request', 'client_notification_token is required (22 to 1024 printable characters) for ping.');
          if (!client.backchannel_client_notification_endpoint) return fail(400, 'invalid_request', 'This client has no notification endpoint registered.');
          token = t;
        }
        const now = e.clock.now();
        const rec: CibaRec = { id: `ciba_${randomToken(24)}`, clientId: client.id, userId: user.id, scope, bindingMessage: binding ?? null, expiresAt: now + expiry * 1000, interval: POLL_INTERVAL_S, lastPoll: 0, status: 'pending', notificationToken: token, createdAt: now };
        flows(e).ciba.set(rec.id, rec);
        return { body: { auth_req_id: rec.id, expires_in: expiry, ...(mode === 'poll' ? { interval: POLL_INTERVAL_S } : {}) }, headers: { 'cache-control': 'no-store' } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/client/me/backchannel_requests',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const { userId } = await sessionFromBearer(c);
        const now = e.clock.now();
        const rows = [...flows(e).ciba.values()].filter((r) => r.userId === userId && r.status === 'pending' && r.expiresAt > now);
        return { body: { object: 'list', data: rows.map((r) => ({ ...cibaView(r), client_name: e.db.oauthClients.get(r.clientId)?.name ?? 'An application' })) } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/client/me/backchannel_requests/:id',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const { userId } = await sessionFromBearer(c);
        const rec = flows(e).ciba.get(c.params.id ?? '');
        // 404 for someone else's or an unknown request: never confirm one exists.
        if (!rec || rec.userId !== userId) throw new EmulatorError('NOT_FOUND', 'Unknown request.');
        if (rec.status !== 'pending' || rec.expiresAt <= e.clock.now()) throw new EmulatorError('VERIFICATION_FAILED', 'This request is no longer pending.');
        const approve = c.body.decision === 'approve';
        rec.status = approve ? 'approved' : 'denied';
        const client = e.db.oauthClients.get(rec.clientId);
        if (client?.backchannel_token_delivery_mode === 'ping' && client.backchannel_client_notification_endpoint && rec.notificationToken) {
          try {
            await (e.options.fetch ?? fetch)(client.backchannel_client_notification_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rec.notificationToken}` }, body: JSON.stringify({ auth_req_id: rec.id }) });
          } catch {
            /* a failed ping leaves the request pollable */
          }
        }
        return { body: { object: 'backchannel_request', id: rec.id, status: rec.status } };
      },
    },
  ];
}
