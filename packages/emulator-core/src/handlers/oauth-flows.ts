/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { randomToken } from '../store';
import { authenticateClient, fail, issueTokens, splitScope, st as oauthSt, type Grant } from './oauth';
import { CODE_EXT, adv, authUrl, completeAuth, loadRequestObject, parseGrantManagement, parseResponseType, REQUEST_OBJECT_PARAMS, clientResponseTypes, validateAuthorizationDetails, type AuthExt } from './oauth-adv';
import { engineState, sessionFromBearer } from './support';
import { authReply } from './emu4-oauth-auth';
import { publisherDecision } from './emu4-oauth-pub';
import { enqueueCiba } from './emu4-oauth-delivery';

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
  ext: AuthExt;
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
export interface CibaRec {
  id: string;
  clientId: string;
  userId: string;
  scope: string[];
  bindingMessage: string | null;
  expiresAt: number;
  interval: number;
  lastPoll: number;
  status: 'pending' | 'approved' | 'denied' | 'used';
  /** The client's delivery mode when the request was made. */
  mode: 'poll' | 'ping' | 'push';
  /** A push request that expired undecided was announced to the client (`expired_token`). */
  expiredNotified?: boolean;
  notificationToken: string | null;
  createdAt: number;
}
interface Flows {
  par: Map<string, { clientId: string; params: Record<string, string>; expiresAt: number; used: boolean }>;
  consents: Map<string, Consent>;
  remembered: Map<string, Set<string>>;
  /** When each remembered consent was first given. */
  rememberedAt: Map<string, number>;
  devices: Map<string, DeviceRec>;
  ciba: Map<string, CibaRec>;
  dpopSeen: Map<string, number>;
}
const flows = engineState((): Flows => ({ par: new Map(), consents: new Map(), remembered: new Map(), rememberedAt: new Map(), devices: new Map(), ciba: new Map(), dpopSeen: new Map() }));
/** The CIBA requests of this engine (the delivery sweep announces expired push requests). */
export const cibaRecords = (e: Engine): Map<string, CibaRec> => flows(e).ciba;
/** The scopes a user holds a remembered consent for at a client, if any. */
/** Every consent a user remembered for a client, for the Backend API grants list. */
export const consentGrants = (e: Engine): Array<{ userId: string; clientId: string; scopes: string[]; at: number }> =>
  [...flows(e).remembered.entries()].map(([key, scopes]) => {
    const [userId = '', clientId = ''] = key.split('|');
    return { userId, clientId, scopes: [...scopes], at: flows(e).rememberedAt.get(key) ?? 0 };
  });
export const heldConsent = (e: Engine, userId: string, clientId: string): Set<string> | undefined => flows(e).remembered.get(`${userId}|${clientId}`);
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
export async function consentGate(e: Engine, a: { client: Obj; user: Obj; scope: string[]; redirectUri: string; challenge: string | null; nonce: string | null; state?: string; prompt: string | null; ext?: AuthExt; force?: boolean }): Promise<Reply | null> {
  const { client, user, scope, prompt } = a;
  const forced = prompt === 'consent' || a.force === true;
  const ext = a.ext ?? CODE_EXT;
  if (client.first_party === true || !(client.require_consent === true || forced)) return null;
  const held = flows(e).remembered.get(rememberKey(user.id, client.id));
  if (!forced && held && scope.every((s) => held.has(s))) return null;
  // One consent for a verified publisher's other apps (openid, email and profile only).
  if (!forced && publisherDecision(e, client, user.id, scope).skipConsent) return null;
  if (prompt === 'none') return authReply(e, client, a.redirectUri, authUrl(e, a.redirectUri, { error: 'consent_required', error_description: 'The user has not consented to these scopes.', state: a.state, iss: e.issuer }, !!parseResponseType(ext.rt)?.frontChannelTokens, ext.mode), ext.mode);
  const id = `consent_${randomToken(24)}`;
  flows(e).consents.set(id, { id, clientId: client.id, userId: user.id, scope, redirectUri: a.redirectUri, challenge: a.challenge, nonce: a.nonce, state: a.state, ext, expiresAt: e.clock.now() + CONSENT_TTL_MS, status: 'pending' });
  return found(`${e.issuer}/oauth2/authorize/consent?consent_token=${id}`);
}

function liveConsent(e: Engine, id: string | null | undefined): Consent {
  const c = id ? flows(e).consents.get(id) : undefined;
  if (!c || c.status !== 'pending' || c.expiresAt <= e.clock.now()) throw new EmulatorError('NOT_FOUND', 'This consent request has expired or was already answered.');
  return c;
}

/** A pending, unexpired device request named by its user code (the device challenge). */
function liveDevice(e: Engine, challenge: string | null | undefined): DeviceRec {
  const code = normaliseUserCode(challenge);
  const rec = [...flows(e).devices.values()].find((d) => normaliseUserCode(d.userCode) === code && d.status === 'pending' && d.expiresAt > e.clock.now());
  if (!rec) throw new EmulatorError('NOT_FOUND', 'This device request has expired or was already answered.');
  return rec;
}

/** Answer a consent request; returns the URL to send the browser to. The scopes granted are always a subset of what was asked. */
async function settleConsent(e: Engine, c: Consent, d: { approve: boolean; grant?: string[]; remember?: boolean; error?: string; description?: string }): Promise<string> {
  const back = (p: Record<string, string | undefined>) => authUrl(e, c.redirectUri, { ...p, state: c.state, iss: e.issuer }, !!parseResponseType(c.ext.rt)?.frontChannelTokens, c.ext.mode);
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
    if (!flows(e).rememberedAt.has(key)) flows(e).rememberedAt.set(key, e.clock.now());
  }
  return completeAuth(e, { client, userId: c.userId, scope: grant, redirectUri: c.redirectUri, challenge: c.challenge, nonce: c.nonce, state: c.state, ext: c.ext });
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
  // CIBA 10.3: a push-mode client is sent the tokens and never polls.
  if (!isDevice && (rec as CibaRec).mode === 'push') return fail(400, 'invalid_request', 'This request uses push delivery; the tokens are sent to the client notification endpoint.');
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
  const requireClient = async (e: Engine, c: RouteContext, needGrant?: string): Promise<{ client: Obj } | { error: Reply }> => {
    const auth = await authenticateClient(e, c);
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
      handler: async (c) => {
        const e = c.engine;
        const auth = await requireClient(e, c);
        if ('error' in auth) return auth.error;
        const client = auth.client;
        const b: Obj = { ...c.body };
        let rarRaw: unknown = b.authorization_details;
        // A signed request object supersedes the body parameters (RFC 9101).
        if (b.request) {
          const loaded = await loadRequestObject(e, client, { request: String(b.request) });
          if (!loaded.ok) return fail(400, loaded.error === 'invalid_request' ? 'invalid_request' : 'invalid_request_object', loaded.description);
          for (const k of REQUEST_OBJECT_PARAMS) if (typeof loaded.claims[k] === 'string') b[k] = loaded.claims[k];
          if (loaded.claims.authorization_details !== undefined) rarRaw = loaded.claims.authorization_details;
          delete b.request;
        } else if (client.require_signed_request_object === true) return fail(400, 'invalid_request', 'This client must send a signed request object.');
        if (b.request_uri) return fail(400, 'invalid_request', 'request_uri is not allowed here.');
        if (b.client_id && b.client_id !== client.id) return fail(400, 'invalid_request', 'client_id does not match the authenticated client.');
        const redirectUri = typeof b.redirect_uri === 'string' ? b.redirect_uri : undefined;
        if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return fail(400, 'invalid_request', 'The redirect_uri does not match a registered URI.');
        const rt = parseResponseType(b.response_type);
        if (!rt) return fail(400, 'unsupported_response_type', 'The response_type is not supported.');
        if (!clientResponseTypes(client).includes(rt.canonical)) return fail(400, 'unauthorized_client', 'This client is not registered for this response_type.');
        const asked = splitScope(b.scope ?? 'openid');
        const outside = asked.filter((s) => !client.allowed_scopes.includes(s) && !['openid', 'profile', 'email', 'offline_access'].includes(s));
        if (outside.length) return fail(400, 'invalid_scope', `Scope not allowed: ${outside.join(' ')}.`);
        if (b.code_challenge && (b.code_challenge_method ?? 'plain') !== 'S256') return fail(400, 'invalid_request', 'code_challenge_method must be S256.');
        if (!b.code_challenge && rt.code && client.auth_method === 'none') return fail(400, 'invalid_request', 'A public client must use PKCE (code_challenge).');
        const rar = validateAuthorizationDetails(rarRaw, adv(e).cfg.authorization_details_types);
        if (!rar.ok) return fail(400, 'invalid_authorization_details', rar.message);
        const gm = parseGrantManagement(b.grant_management_action, b.grant_id);
        if (!gm.ok) return fail(400, 'invalid_request', gm.message);
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(b)) if (typeof v === 'string' && !['client_secret', 'client_id'].includes(k)) params[k] = v;
        if (rar.value) params.authorization_details = JSON.stringify(rar.value);
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
        const pub = publisherDecision(e, client, r.userId, r.scope);
        return { body: { object: 'oauth_consent_screen', consent_token: r.id, client: { id: client.id, name: client.name, ...(pub.publisherName ? { published_by: pub.publisherName } : {}) }, user_id: r.userId, requested_scope: r.scope, expires_at: r.expiresAt } };
      },
    },
    {
      method: 'POST',
      pattern: '/oauth2/authorize/consent',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const r = liveConsent(e, typeof c.body.consent_token === 'string' ? c.body.consent_token : null);
        const approve = c.body.decision === 'approve';
        if (!approve && c.body.decision !== 'deny') throw new EmulatorError('VALIDATION_FAILED', 'decision must be approve or deny.', 'decision');
        return authReply(e, e.db.oauthClients.get(r.clientId), r.redirectUri, await settleConsent(e, r, { approve }), r.ext.mode);
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
      handler: async (c) => {
        const e = c.engine;
        const r = liveConsent(e, c.query.get('consent_challenge'));
        if (c.body.grant_scope !== undefined && (!Array.isArray(c.body.grant_scope) || c.body.grant_scope.some((s: unknown) => typeof s !== 'string'))) throw new EmulatorError('VALIDATION_FAILED', 'grant_scope must be a list of scopes.', 'grant_scope');
        return { body: { object: 'oauth_consent_redirect', redirect_to: await settleConsent(e, r, { approve: true, grant: c.body.grant_scope, remember: c.body.remember }) } };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/oauth_consent_requests/reject',
      handler: async (c) => {
        const e = c.engine;
        const r = liveConsent(e, c.query.get('consent_challenge'));
        return { body: { object: 'oauth_consent_redirect', redirect_to: await settleConsent(e, r, { approve: false, error: c.body.error, description: c.body.error_description }) } };
      },
    },
    {
      // The signed-in user is not who should consent: restart the application's authorization request at login (prompt=login).
      method: 'PUT',
      pattern: '/v1/oauth_consent_requests/switch_account',
      handler: (c) => {
        const e = c.engine;
        const r = liveConsent(e, c.query.get('consent_challenge'));
        const client = e.db.oauthClients.get(r.clientId);
        if (!client || client.deleted) throw new EmulatorError('NOT_FOUND', 'The application is gone.');
        const u = new URL(`${e.issuer}/oauth2/authorize`);
        const set: Record<string, string | null | undefined> = { client_id: client.id, redirect_uri: r.redirectUri, response_type: parseResponseType(r.ext.rt) ? r.ext.rt : 'code', scope: r.scope.join(' '), state: r.state, nonce: r.nonce, code_challenge: r.challenge, code_challenge_method: r.challenge ? 'S256' : undefined, prompt: 'login' };
        for (const [k, v] of Object.entries(set)) if (v) u.searchParams.set(k, v);
        r.status = 'rejected'; // this challenge is spent: a fresh one follows the new sign-in
        return { body: { object: 'oauth_consent_redirect', redirect_to: u.toString() } };
      },
    },
    // ── device approval: the customer's own device page (delegated challenge) ──
    {
      method: 'GET',
      pattern: '/v1/oauth_device_requests',
      handler: (c) => {
        const e = c.engine;
        const rec = liveDevice(e, c.query.get('device_challenge'));
        const client = e.db.oauthClients.get(rec.clientId)!;
        const user = resolveUser(e, null);
        return { body: { object: 'oauth_device_request', subject: user?.id ?? null, user_code: rec.userCode, client: { id: client.id, client_id: client.id, name: client.name }, requested_scope: rec.scope, audience: null, expires_at: rec.expiresAt } };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/oauth_device_requests/accept',
      handler: (c) => {
        const e = c.engine;
        const rec = liveDevice(e, c.query.get('device_challenge'));
        const user = resolveUser(e, typeof c.body.user_id === 'string' ? c.body.user_id : null);
        if (!user) throw new EmulatorError('VALIDATION_FAILED', 'No user to sign in. Pass user_id or POST /__emulator/oauth/login.', 'user_id');
        if (user.banned) throw new EmulatorError('FORBIDDEN', 'The user is banned.');
        // The emulator follows the redirect itself: the code is bound to the user now.
        rec.userId = user.id;
        rec.status = 'approved';
        return { body: { object: 'oauth_device_redirect', redirect_to: `${e.issuer}/oauth2/device/done?status=approved` } };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/oauth_device_requests/reject',
      handler: (c) => {
        const e = c.engine;
        liveDevice(e, c.query.get('device_challenge')).status = 'denied';
        return { body: { object: 'oauth_device_redirect', redirect_to: `${e.issuer}/oauth2/device/done?status=denied` } };
      },
    },
    // ── device authorization ──
    {
      method: 'POST',
      pattern: '/oauth2/device_authorization',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const auth = await requireClient(e, c, DEVICE_GRANT);
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
      handler: async (c) => {
        const e = c.engine;
        const auth = await requireClient(e, c, CIBA_GRANT);
        if ('error' in auth) return auth.error;
        const client = auth.client;
        if (client.auth_method === 'none') return fail(400, 'invalid_client', 'CIBA requires a confidential client.');
        // A signed authentication request carries the parameters in a JWT (OpenID CIBA 7.1.1).
        let body: Obj = { ...c.body };
        if (body.request) {
          const loaded = await loadRequestObject(e, client, { request: String(body.request) });
          if (!loaded.ok) return fail(400, 'invalid_request_object', loaded.description);
          for (const k of ['scope', 'login_hint', 'id_token_hint', 'binding_message', 'user_code', 'client_notification_token', 'acr_values']) if (typeof loaded.claims[k] === 'string') body[k] = loaded.claims[k];
          if (loaded.claims.requested_expiry !== undefined) body.requested_expiry = String(loaded.claims.requested_expiry);
          delete body.request;
        } else if (client.require_signed_request_object === true) return fail(400, 'invalid_request', 'This client must send a signed authentication request.');
        const scope = scopeFor(client, body.scope);
        if ('error' in scope) return scope.error;
        const hint = typeof body.login_hint === 'string' ? body.login_hint : '';
        if (!hint) return fail(400, 'invalid_request', 'login_hint is required.');
        const user = resolveUser(e, hint, false);
        if (!user) return fail(400, 'unknown_user_id', 'No user matches the login_hint.');
        if (user.banned) return fail(400, 'access_denied', 'The user is banned.');
        const binding = body.binding_message;
        if (binding !== undefined && (typeof binding !== 'string' || binding.length > 64 || !/^[\x20-\x7e]*$/.test(binding))) return fail(400, 'invalid_binding_message', 'binding_message is up to 64 printable characters.');
        const expiry = body.requested_expiry === undefined ? 120 : Number(body.requested_expiry);
        if (!Number.isInteger(expiry) || expiry < 1 || expiry > 3600) return fail(400, 'invalid_request', 'requested_expiry is a whole number of seconds from 1 to 3600.');
        const mode: 'poll' | 'ping' | 'push' = client.backchannel_token_delivery_mode ?? 'poll';
        let token: string | null = null;
        if (mode !== 'poll') {
          const t = body.client_notification_token;
          // The notification token is the bearer secret of the client's callback: at least 128 bits (22 base64url characters).
          if (typeof t !== 'string' || t.length < 22 || t.length > 1024 || !/^[\x21-\x7e]+$/.test(t)) return fail(400, 'invalid_request', 'client_notification_token is required (22 to 1024 printable characters) for ping and push.');
          if (!client.backchannel_client_notification_endpoint) return fail(400, 'invalid_request', 'This client has no notification endpoint registered.');
          token = t;
        }
        const now = e.clock.now();
        const rec: CibaRec = { id: `ciba_${randomToken(24)}`, clientId: client.id, userId: user.id, scope, bindingMessage: binding ?? null, expiresAt: now + expiry * 1000, interval: POLL_INTERVAL_S, lastPoll: 0, status: 'pending', mode, notificationToken: token, createdAt: now };
        flows(e).ciba.set(rec.id, rec);
        return { body: { auth_req_id: rec.id, expires_in: expiry, ...(mode === 'push' ? {} : { interval: POLL_INTERVAL_S }) }, headers: { 'cache-control': 'no-store' } };
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
        if (rec.mode !== 'poll' && client?.backchannel_client_notification_endpoint && rec.notificationToken) {
          // Ping carries only the auth_req_id; push carries the token response (or the refusal) itself and is spent by it (CIBA 10.2, 10.3).
          let payload: Obj = { auth_req_id: rec.id };
          if (rec.mode === 'push') {
            if (!approve) payload = { auth_req_id: rec.id, error: 'access_denied', error_description: 'The user denied the request.' };
            else {
              rec.status = 'used';
              const grant: Grant = { id: e.db.newId('oag'), clientId: client.id, userId: rec.userId, scope: rec.scope, revoked: false, jtis: new Set() };
              oauthSt(e).grants.set(grant.id, grant);
              payload = { auth_req_id: rec.id, ...(await issueTokens(e, client, grant, null, e.clock.now())) };
            }
          }
          // Queued with the real retry schedule: a failing endpoint is retried as the clock advances; a failed ping leaves the request pollable.
          await enqueueCiba(e, { kind: rec.mode === 'push' ? 'ciba_push' : 'ciba_ping', clientId: client.id, requestId: rec.id, endpoint: client.backchannel_client_notification_endpoint, token: rec.notificationToken, payload });
        }
        return { body: { object: 'backchannel_request', id: rec.id, status: approve ? 'approved' : 'denied' } };
      },
    },
  ];
}
