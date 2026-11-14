/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { pkceChallenge } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import { synthesize, type Obj } from '../openapi';
import { randomToken } from '../store';
import { DPOP_IAT_WINDOW_S, forwardedCertThumbprint, verifyDpopProof } from '../jws';
import { claimDpopJti, consentGate, extensionGrant, resolveRequestUri, resetOAuthFlows } from './oauth-flows';
import { listReply, need } from './util';

/**
 * The OAuth 2.0 / OpenID Connect provider: client registry (`/v1/oauth_clients`), discovery, authorize (code + PKCE
 * S256), token (authorization_code, refresh_token with rotation and reuse detection, client_credentials, token
 * exchange RFC 8693), revoke (RFC 7009), introspect (RFC 7662), userinfo and the JWKS. Tokens are real signed JWTs
 * (access and ID tokens) verifiable against `/.well-known/jwks.json`. Errors follow RFC 6749 section 5.2.
 */

const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TTL_S = 3600;
const GRACE_MS = 30_000;
const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const SCOPES = ['openid', 'profile', 'email', 'offline_access'];

export interface Grant {
  id: string;
  clientId: string;
  userId: string | null;
  scope: string[];
  revoked: boolean;
  /** Access token jtis minted from this grant, so reuse of a code can revoke them. */
  jtis: Set<string>;
  /** The DPoP key the grant's refresh tokens are bound to (RFC 9449 section 8). */
  jkt?: string;
}
export interface OAuthState {
  codes: Map<string, { grantId: string; redirectUri: string; challenge: string | null; nonce: string | null; authTime: number; expiresAt: number; used: boolean }>;
  grants: Map<string, Grant>;
  refresh: Map<string, { grantId: string; rotatedAt?: number; successor?: string }>;
  /** jti -> access token record (client_credentials and exchanged tokens have no grant). */
  access: Map<string, { clientId: string; userId: string | null; scope: string[]; exp: number; revoked: boolean; grantId: string | null; cnf?: Obj }>;
  autoUser: string | null;
}
const states = new WeakMap<Engine, OAuthState>();
export const st = (e: Engine): OAuthState => {
  let s = states.get(e);
  if (!s) states.set(e, (s = { codes: new Map(), grants: new Map(), refresh: new Map(), access: new Map(), autoUser: null }));
  return s;
};
export const resetOAuth = (e: Engine): void => {
  states.delete(e);
  resetOAuthFlows(e);
};

export const fail = (status: number, error: string, description: string, extra: Obj = {}): Reply => ({ status, body: { error, error_description: description, ...extra }, headers: { 'cache-control': 'no-store', pragma: 'no-cache' } });

export function discoveryDocument(e: Engine): Obj {
  const iss = e.issuer;
  return {
    issuer: iss,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    authorization_endpoint: `${iss}/oauth2/authorize`,
    token_endpoint: `${iss}/oauth2/token`,
    userinfo_endpoint: `${iss}/oauth2/userinfo`,
    revocation_endpoint: `${iss}/oauth2/revoke`,
    introspection_endpoint: `${iss}/oauth2/introspect`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials', EXCHANGE, 'urn:ietf:params:oauth:grant-type:device_code', 'urn:openid:params:grant-type:ciba'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256', 'ES256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256'],
    dpop_signing_alg_values_supported: ['ES256', 'ES384', 'RS256', 'PS256', 'EdDSA'],
    tls_client_certificate_bound_access_tokens: true,
    pushed_authorization_request_endpoint: `${iss}/oauth2/par`,
    device_authorization_endpoint: `${iss}/oauth2/device_authorization`,
    backchannel_authentication_endpoint: `${iss}/oauth2/backchannel_authentication`,
    backchannel_token_delivery_modes_supported: ['poll', 'ping'],
    scopes_supported: SCOPES,
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'email', 'email_verified', 'name', 'picture'],
    authorization_response_iss_parameter_supported: true,
    atlas_emulator: true,
  };
}

const FLOW_FLAGS = ['require_consent', 'dpop_bound_access_tokens', 'tls_client_certificate_bound_access_tokens', 'require_pushed_authorization_requests'] as const;
/** The client settings the consent, binding, PAR and CIBA flows read; validated here so a bad value never reaches a flow. */
function pickFlowFields(body: Obj): Obj {
  const out: Obj = {};
  for (const k of FLOW_FLAGS) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') throw new EmulatorError('VALIDATION_FAILED', `${k} must be true or false.`, k);
    out[k] = body[k];
  }
  if (body.backchannel_token_delivery_mode !== undefined) {
    if (!['poll', 'ping'].includes(body.backchannel_token_delivery_mode)) throw new EmulatorError('VALIDATION_FAILED', 'backchannel_token_delivery_mode must be poll or ping.', 'backchannel_token_delivery_mode');
    out.backchannel_token_delivery_mode = body.backchannel_token_delivery_mode;
  }
  if (body.backchannel_client_notification_endpoint !== undefined) out.backchannel_client_notification_endpoint = body.backchannel_client_notification_endpoint;
  return out;
}

const clientShape = (e: Engine, c: Obj, secret?: string): Obj => {
  const op = e.index.ops.find((o) => o.method === 'POST' && o.path === '/v1/oauth_clients');
  const base = op?.successSchema ? synthesize(e.index, op.successSchema) : {};
  return {
    ...(base && typeof base === 'object' ? base : {}),
    object: 'oauth_client',
    id: c.id,
    client_id: c.id,
    name: c.name,
    redirect_uris: c.redirect_uris,
    allowed_scopes: c.allowed_scopes,
    grant_types: c.grant_types,
    token_endpoint_auth_method: c.auth_method,
    first_party: c.first_party === true,
    post_logout_redirect_uris: c.post_logout_redirect_uris ?? [],
    require_consent: c.require_consent === true,
    dpop_bound_access_tokens: c.dpop_bound_access_tokens === true,
    tls_client_certificate_bound_access_tokens: c.tls_client_certificate_bound_access_tokens === true,
    require_pushed_authorization_requests: c.require_pushed_authorization_requests === true,
    backchannel_token_delivery_mode: c.backchannel_token_delivery_mode ?? 'poll',
    backchannel_client_notification_endpoint: c.backchannel_client_notification_endpoint ?? null,
    created_at: c.created_at,
    updated_at: c.updated_at,
    ...(secret ? { client_secret: secret } : {}),
  };
};

const liveClient = (e: Engine, id: string | undefined): Obj => {
  const c = e.db.oauthClients.get(id);
  if (!c || c.deleted) throw notFound('OAuth client');
  return c;
};

/** Client authentication: Basic, or client_id (+ client_secret) in the body. `none` clients are identified only. */
export function authenticateClient(e: Engine, c: RouteContext): { client: Obj } | { error: Reply } {
  let id = typeof c.body.client_id === 'string' ? c.body.client_id : undefined;
  let secret = typeof c.body.client_secret === 'string' ? c.body.client_secret : undefined;
  const basic = /^Basic\s+(.+)$/i.exec(c.request.headers.get('authorization') ?? '')?.[1];
  if (basic) {
    const [i, ...rest] = atob(basic).split(':');
    id = decodeURIComponent(i ?? '');
    secret = decodeURIComponent(rest.join(':'));
  }
  const client = e.db.oauthClients.get(id);
  if (!client || client.deleted) return { error: fail(401, 'invalid_client', 'Unknown client.') };
  const previousOk = client.previous_secret !== undefined && client.previous_secret === secret && e.clock.now() < client.previous_until;
  if (client.auth_method !== 'none' && client.secret !== secret && !previousOk) return { error: fail(401, 'invalid_client', 'Client authentication failed.') };
  return { client };
}

export const splitScope = (s: unknown): string[] => (typeof s === 'string' ? s.split(/\s+/).filter(Boolean) : []);

export async function mintAccess(e: Engine, input: { client: Obj; userId: string | null; scope: string[]; grant: Grant | null; audience?: string; extra?: Obj; cnf?: Obj }): Promise<{ token: string; jti: string }> {
  const jti = e.db.newId('oat');
  const token = await e.tokens.signClaims(
    {
      sub: input.userId ?? input.client.id,
      aud: input.audience ?? input.client.id,
      client_id: input.client.id,
      scope: input.scope.join(' '),
      jti,
      token_use: 'access_token',
      ...(input.cnf ? { cnf: input.cnf } : {}),
      ...(input.extra ?? {}),
    },
    ACCESS_TTL_S,
  );
  const s = st(e);
  s.access.set(jti, { clientId: input.client.id, userId: input.userId, scope: input.scope, exp: e.clock.now() + ACCESS_TTL_S * 1000, revoked: false, grantId: input.grant?.id ?? null, cnf: input.cnf });
  input.grant?.jtis.add(jti);
  return { token, jti };
}

const userClaims = (e: Engine, userId: string, scope: string[]): Obj => {
  const u = e.db.users.get(userId);
  if (!u) return {};
  const primary = (u.emails as Obj[]).find((m) => m.id === u.primary_email_address_id);
  return {
    ...(scope.includes('email') && primary ? { email: primary.email_address, email_verified: primary.verified === true } : {}),
    ...(scope.includes('profile') ? { name: [u.first_name, u.last_name].filter(Boolean).join(' ') || undefined, picture: u.image_url ?? undefined, given_name: u.first_name ?? undefined, family_name: u.last_name ?? undefined } : {}),
  };
};

export async function issueTokens(e: Engine, client: Obj, grant: Grant, nonce: string | null, authTime: number, refreshRec?: string, cnf?: Obj): Promise<Obj> {
  const access = await mintAccess(e, { client, userId: grant.userId, scope: grant.scope, grant, cnf });
  const out: Obj = { access_token: access.token, token_type: cnf?.jkt ? 'DPoP' : 'Bearer', expires_in: ACCESS_TTL_S, scope: grant.scope.join(' ') };
  if (grant.scope.includes('offline_access') || client.grant_types.includes('refresh_token')) {
    const rt = refreshRec ?? `ort_${randomToken(32)}`;
    if (!st(e).refresh.has(rt)) st(e).refresh.set(rt, { grantId: grant.id });
    out.refresh_token = rt;
  }
  if (grant.scope.includes('openid') && grant.userId) {
    out.id_token = await e.tokens.signClaims({ sub: grant.userId, aud: client.id, azp: client.id, auth_time: Math.floor(authTime / 1000), ...(nonce ? { nonce } : {}), token_use: 'id_token', ...userClaims(e, grant.userId, grant.scope) }, ACCESS_TTL_S);
  }
  return out;
}

/** Create the grant and the single-use authorization code for an approved request (after login and, when needed, consent). */
export function issueCode(e: Engine, a: { client: Obj; userId: string; scope: string[]; redirectUri: string; challenge: string | null; nonce: string | null }): string {
  const grant: Grant = { id: e.db.newId('oag'), clientId: a.client.id, userId: a.userId, scope: a.scope, revoked: false, jtis: new Set() };
  st(e).grants.set(grant.id, grant);
  const code = `oc_${randomToken(24)}`;
  const now = e.clock.now();
  st(e).codes.set(code, { grantId: grant.id, redirectUri: a.redirectUri, challenge: a.challenge, nonce: a.nonce, authTime: now, expiresAt: now + CODE_TTL_MS, used: false });
  return code;
}

/** What one token request proved: a DPoP key (single-use proof) and, for clients that ask for it, a client certificate. */
async function provedOf(c: RouteContext, client: Obj): Promise<{ proved: { jkt?: string; x5t?: string } } | { error: Reply }> {
  const e = c.engine;
  const proved: { jkt?: string; x5t?: string } = {};
  const header = c.request.headers.get('dpop');
  if (header !== null) {
    try {
      const r = await verifyDpopProof({ proof: header, htm: 'POST', htu: c.request.url, nowMs: e.clock.now() });
      if (!claimDpopJti(e, r.jkt, r.jti, (DPOP_IAT_WINDOW_S + 5) * 1000)) return { error: fail(400, 'invalid_dpop_proof', 'The DPoP proof has already been used.') };
      proved.jkt = r.jkt;
    } catch (err) {
      return { error: fail(400, 'invalid_dpop_proof', (err as Error).message) };
    }
  }
  const x5t = await forwardedCertThumbprint(c.request.headers);
  if (x5t === null) return { error: fail(400, 'invalid_request', 'The forwarded client certificate could not be read.') };
  if (x5t && client.tls_client_certificate_bound_access_tokens === true) proved.x5t = x5t;
  if (client.dpop_bound_access_tokens === true && !proved.jkt) return { error: fail(400, 'invalid_dpop_proof', 'This client must send a DPoP proof with every token request.') };
  if (client.tls_client_certificate_bound_access_tokens === true && !proved.x5t) return { error: fail(401, 'invalid_client', 'This client must present its client certificate (mutual TLS).') };
  return { proved };
}
const cnfFor = (p: { jkt?: string; x5t?: string }): Obj | undefined => (p.jkt || p.x5t ? { ...(p.jkt ? { jkt: p.jkt } : {}), ...(p.x5t ? { 'x5t#S256': p.x5t } : {}) } : undefined);

export function oauthHandlers(): RouteDef[] {
  const redirect = (uri: string, params: Record<string, string | undefined>): Reply => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } };
  };

  return [
    // ── client registry ──
    {
      method: 'POST',
      pattern: '/v1/oauth_clients',
      handler: (c) => {
        const e = c.engine;
        const name = String(need(c.body, 'name'));
        const uris = c.body.redirect_uris;
        if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string')) throw new EmulatorError('VALIDATION_FAILED', 'redirect_uris needs at least one URI.', 'redirect_uris');
        const method = c.body.token_endpoint_auth_method ?? 'client_secret_basic';
        const now = e.clock.now();
        const secret = method === 'none' ? undefined : `oacs_${randomToken(32)}`;
        const row = e.db.oauthClients.insert({
          name,
          redirect_uris: uris,
          allowed_scopes: c.body.allowed_scopes ?? SCOPES,
          grant_types: c.body.grant_types ?? ['authorization_code', 'refresh_token'],
          auth_method: method,
          first_party: c.body.first_party === true,
          post_logout_redirect_uris: c.body.post_logout_redirect_uris ?? [],
          ...pickFlowFields(c.body),
          secret,
          created_at: now,
          updated_at: now,
        });
        e.changed({ type: 'oauth_client.created', data: clientShape(e, row) });
        return { status: 201, body: clientShape(e, row, secret) };
      },
    },
    { method: 'GET', pattern: '/v1/oauth_clients', handler: (c) => listReply(c, c.engine.db.oauthClients.filter((x) => !x.deleted), (x) => clientShape(c.engine, x)) },
    { method: 'GET', pattern: '/v1/oauth_clients/:id', handler: (c) => ({ body: clientShape(c.engine, liveClient(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/oauth_clients/:id',
      handler: (c) => {
        const e = c.engine;
        const row = liveClient(e, c.params.id);
        for (const [k, to] of [['name', 'name'], ['redirect_uris', 'redirect_uris'], ['allowed_scopes', 'allowed_scopes'], ['grant_types', 'grant_types'], ['first_party', 'first_party'], ['post_logout_redirect_uris', 'post_logout_redirect_uris']] as const) if (k in c.body) row[to] = c.body[k];
        Object.assign(row, pickFlowFields(c.body));
        row.updated_at = e.clock.now();
        e.changed({ type: 'oauth_client.updated', data: clientShape(e, row) });
        return { body: clientShape(e, row) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/oauth_clients/:id',
      handler: (c) => {
        const e = c.engine;
        const row = liveClient(e, c.params.id);
        row.deleted = true;
        // Deleting a client ends everything it was issued.
        for (const g of st(e).grants.values()) if (g.clientId === row.id) g.revoked = true;
        for (const a of st(e).access.values()) if (a.clientId === row.id) a.revoked = true;
        e.changed({ type: 'oauth_client.deleted', data: { object: 'oauth_client', id: row.id, deleted: true } });
        return { body: { object: 'oauth_client', id: row.id, deleted: true } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/oauth_clients/:id/rotate_secret',
      handler: (c) => {
        const e = c.engine;
        const row = liveClient(e, c.params.id);
        if (row.auth_method === 'none') throw new EmulatorError('VALIDATION_FAILED', 'A public client has no secret.');
        // The previous secret keeps working for overlap_seconds (default 24 h, 0 revokes it now), like the real API.
        const overlap = typeof c.body.overlap_seconds === 'number' ? c.body.overlap_seconds : 86_400;
        row.previous_secret = overlap > 0 ? row.secret : undefined;
        row.previous_until = e.clock.now() + overlap * 1000;
        row.secret = `oacs_${randomToken(32)}`;
        row.updated_at = e.clock.now();
        e.changed({ type: 'oauth_client.secret_rotated', data: clientShape(e, row) });
        return { body: clientShape(e, row, row.secret) };
      },
    },
    // ── discovery ──
    { method: 'GET', pattern: '/.well-known/oauth-authorization-server', public: true, handler: (c) => ({ body: discoveryDocument(c.engine) }) },
    // ── authorize ──
    {
      // The emulator is its own user agent: it signs in the `login_hint` user (id or email), else the user set at
      // `POST /__emulator/oauth/login`, else the only user, and approves without a consent screen. `emulator_decision=deny`
      // answers access_denied, `prompt=none` with nobody to sign in answers login_required.
      method: 'GET',
      pattern: '/oauth2/authorize',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const resolved = resolveRequestUri(e, c.query);
        if ('error' in resolved) return fail(400, resolved.error.code, resolved.error.description);
        const q = resolved.query;
        const client = e.db.oauthClients.get(q.get('client_id') ?? undefined);
        if (!client || client.deleted) return fail(400, 'invalid_request', 'Unknown client_id.');
        const redirectUri = q.get('redirect_uri') ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
        if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return fail(400, 'invalid_request', 'redirect_uri is not registered for this client.');
        if (client.require_pushed_authorization_requests && !c.query.get('request_uri')) return fail(400, 'invalid_request', 'This client must push its authorization request (POST /oauth2/par) and send the request_uri.');
        const state = q.get('state') ?? undefined;
        const back = (params: Record<string, string | undefined>): Reply => redirect(redirectUri, { ...params, state, iss: e.issuer });
        if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported.' });
        const scope = splitScope(q.get('scope') ?? 'openid');
        const outside = scope.filter((s) => !client.allowed_scopes.includes(s) && !SCOPES.includes(s));
        if (outside.length) return back({ error: 'invalid_scope', error_description: `Scope not allowed: ${outside.join(' ')}.` });
        const challenge = q.get('code_challenge');
        if (challenge && (q.get('code_challenge_method') ?? 'plain') !== 'S256') return back({ error: 'invalid_request', error_description: 'code_challenge_method must be S256.' });
        if (!challenge && client.auth_method === 'none') return back({ error: 'invalid_request', error_description: 'A public client must use PKCE (code_challenge).' });
        if (q.get('emulator_decision') === 'deny') return back({ error: 'access_denied', error_description: 'The user denied the request.' });
        const hint = q.get('login_hint');
        const live = e.db.users.filter((u) => !u.deleted);
        const user =
          (hint && live.find((u) => u.id === hint || (u.emails as Obj[]).some((m) => m.email_address.toLowerCase() === hint.toLowerCase()))) ||
          // A hint that names nobody never falls back to another user.
          (hint ? undefined : st(e).autoUser ? live.find((u) => u.id === st(e).autoUser) : undefined) ||
          (!hint && live.length === 1 ? live[0] : undefined);
        if (!user) return back({ error: 'login_required', error_description: 'No user to sign in. Pass login_hint or POST /__emulator/oauth/login.' });
        if (user.banned) return back({ error: 'access_denied', error_description: 'The user is banned.' });
        const gate = consentGate(e, { client, user, scope, redirectUri, challenge, nonce: q.get('nonce'), state, prompt: q.get('prompt') });
        if (gate) return gate;
        return back({ code: issueCode(e, { client, userId: user.id, scope, redirectUri, challenge, nonce: q.get('nonce') }) });
      },
    },
    { method: 'POST', pattern: '/__emulator/oauth/login', public: true, handler: (c) => ((st(c.engine).autoUser = typeof c.body.user_id === 'string' ? c.body.user_id : null), { body: { ok: true } }) },
    // ── token ──
    {
      method: 'POST',
      pattern: '/oauth2/token',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const auth = authenticateClient(e, c);
        if ('error' in auth) return auth.error;
        const client = auth.client;
        const type = String(c.body.grant_type ?? '');
        if (!type) return fail(400, 'invalid_request', 'grant_type is required.');
        if (type !== EXCHANGE && !client.grant_types.includes(type) && !(type === 'refresh_token')) return fail(400, 'unauthorized_client', `This client may not use ${type}.`);
        const s = st(e);
        const now = e.clock.now();
        const pr = await provedOf(c, client);
        if ('error' in pr) return pr.error;
        const cnf = cnfFor(pr.proved);

        const ext = await extensionGrant(c, client, type, cnf);
        if (ext) return ext;

        if (type === 'authorization_code') {
          const rec = s.codes.get(String(c.body.code ?? ''));
          if (!rec) return fail(400, 'invalid_grant', 'The authorization code is invalid.');
          const grant = s.grants.get(rec.grantId)!;
          if (rec.used) {
            // RFC 6749 section 4.1.2: a replayed code revokes what it already produced.
            grant.revoked = true;
            for (const j of grant.jtis) {
              const a = s.access.get(j);
              if (a) a.revoked = true;
            }
            return fail(400, 'invalid_grant', 'The authorization code was already used.');
          }
          if (grant.clientId !== client.id) return fail(400, 'invalid_grant', 'The code was issued to another client.');
          if (rec.expiresAt <= now) return fail(400, 'invalid_grant', 'The authorization code has expired.');
          if (rec.redirectUri !== (c.body.redirect_uri ?? rec.redirectUri)) return fail(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
          if (rec.challenge) {
            const verifier = String(c.body.code_verifier ?? '');
            if (!verifier || (await pkceChallenge(verifier)) !== rec.challenge) return fail(400, 'invalid_grant', 'PKCE verification failed.');
          }
          rec.used = true;
          if (pr.proved.jkt) grant.jkt = pr.proved.jkt;
          return { body: await issueTokens(e, client, grant, rec.nonce, rec.authTime, undefined, cnf), headers: { 'cache-control': 'no-store', pragma: 'no-cache' } };
        }

        if (type === 'refresh_token') {
          const token = String(c.body.refresh_token ?? '');
          const rec = s.refresh.get(token);
          const grant = rec ? s.grants.get(rec.grantId) : undefined;
          if (!rec || !grant || grant.clientId !== client.id) return fail(400, 'invalid_grant', 'The refresh token is invalid.');
          if (grant.revoked) return fail(400, 'invalid_grant', 'The grant was revoked.');
          // A DPoP-bound refresh token is usable only with the key it was bound to (RFC 9449 section 8).
          if (grant.jkt && pr.proved.jkt !== grant.jkt) return fail(400, 'invalid_dpop_proof', 'This refresh token is bound to a DPoP key: send a proof signed with it.');
          if (rec.rotatedAt !== undefined) {
            if (now - rec.rotatedAt <= GRACE_MS && rec.successor) return { body: await issueTokens(e, client, grant, null, now, rec.successor, cnf), headers: { 'cache-control': 'no-store' } };
            grant.revoked = true; // reuse: end the whole family
            for (const j of grant.jtis) {
              const a = s.access.get(j);
              if (a) a.revoked = true;
            }
            return fail(400, 'invalid_grant', 'The refresh token was already used; the grant was revoked.');
          }
          const asked = splitScope(c.body.scope);
          if (asked.some((x) => !grant.scope.includes(x))) return fail(400, 'invalid_scope', 'A refresh cannot widen the granted scope.');
          const narrowed: Grant = asked.length ? { ...grant, scope: asked } : grant;
          const next = `ort_${randomToken(32)}`;
          rec.rotatedAt = now;
          rec.successor = next;
          s.refresh.set(next, { grantId: grant.id });
          return { body: await issueTokens(e, client, narrowed, null, now, next, cnf), headers: { 'cache-control': 'no-store' } };
        }

        if (type === 'client_credentials') {
          if (client.auth_method === 'none') return fail(401, 'invalid_client', 'A public client cannot use client_credentials.');
          const asked = splitScope(c.body.scope);
          const scope = asked.length ? asked : (client.allowed_scopes as string[]).filter((x) => !SCOPES.includes(x));
          if (asked.some((x) => !client.allowed_scopes.includes(x))) return fail(400, 'invalid_scope', 'Scope not allowed for this client.');
          const a = await mintAccess(e, { client, userId: null, scope, grant: null, audience: typeof c.body.audience === 'string' ? c.body.audience : undefined, cnf });
          return { body: { access_token: a.token, token_type: cnf?.jkt ? 'DPoP' : 'Bearer', expires_in: ACCESS_TTL_S, scope: scope.join(' ') }, headers: { 'cache-control': 'no-store' } };
        }

        if (type === EXCHANGE) {
          const subject = String(c.body.subject_token ?? '');
          if (!subject) return fail(400, 'invalid_request', 'subject_token is required.');
          const verified = await e.tokens.verifyAny(subject);
          if (!verified.ok) return fail(400, 'invalid_grant', 'The subject token is not valid.');
          const claims = verified.claims;
          const rec = typeof claims.jti === 'string' ? s.access.get(claims.jti) : undefined;
          if (rec?.revoked || (rec && s.grants.get(rec.grantId ?? '')?.revoked)) return fail(400, 'invalid_grant', 'The subject token was revoked.');
          // A session token may be exchanged too: its subject is the user, its scope the client's allowed set.
          const held: string[] = typeof claims.scope === 'string' ? splitScope(claims.scope) : (client.allowed_scopes as string[]);
          const asked = splitScope(c.body.scope);
          if (asked.some((x) => !held.includes(x))) return fail(400, 'invalid_scope', 'Token exchange can only narrow scope.');
          let actor: Obj | undefined;
          if (c.body.actor_token) {
            const a = await e.tokens.verifyAny(String(c.body.actor_token));
            if (!a.ok) return fail(400, 'invalid_grant', 'The actor token is not valid.');
            actor = { sub: a.claims.sub, ...(a.claims.act ? { act: a.claims.act } : {}) };
          }
          const scope = asked.length ? asked : held;
          const out = await mintAccess(e, { client, userId: typeof claims.sub === 'string' && !String(claims.sub).startsWith('oac_') ? claims.sub : null, scope, grant: null, audience: typeof c.body.audience === 'string' ? c.body.audience : undefined, extra: actor ? { act: actor } : undefined, cnf });
          return { body: { access_token: out.token, issued_token_type: ACCESS_TYPE, token_type: cnf?.jkt ? 'DPoP' : 'Bearer', expires_in: ACCESS_TTL_S, scope: scope.join(' ') }, headers: { 'cache-control': 'no-store' } };
        }
        return fail(400, 'unsupported_grant_type', `Unsupported grant_type ${type}.`);
      },
    },
    // ── revoke / introspect / userinfo ──
    {
      method: 'POST',
      pattern: '/oauth2/revoke',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const auth = authenticateClient(e, c);
        if ('error' in auth) return auth.error;
        const token = String(c.body.token ?? '');
        if (!token) return fail(400, 'invalid_request', 'token is required.');
        const s = st(e);
        // RFC 7009: always 200, whatever the token was; only the owning client's tokens are touched.
        const rt = s.refresh.get(token);
        const grantOf = rt ? s.grants.get(rt.grantId) : undefined;
        if (grantOf && grantOf.clientId === auth.client.id) {
          grantOf.revoked = true;
          for (const j of grantOf.jtis) {
            const a = s.access.get(j);
            if (a) a.revoked = true;
          }
        } else {
          try {
            const claims = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
            const a = s.access.get(claims.jti);
            if (a && a.clientId === auth.client.id) a.revoked = true;
          } catch {
            /* not a token we issued: nothing to revoke */
          }
        }
        return { status: 200, headers: { 'cache-control': 'no-store' } };
      },
    },
    {
      method: 'POST',
      pattern: '/oauth2/introspect',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const auth = authenticateClient(e, c);
        if ('error' in auth) return auth.error;
        const token = String(c.body.token ?? '');
        const s = st(e);
        const inactive = { body: { active: false }, headers: { 'cache-control': 'no-store' } };
        const rt = s.refresh.get(token);
        if (rt) {
          const g = s.grants.get(rt.grantId);
          if (!g || g.revoked || rt.rotatedAt !== undefined || g.clientId !== auth.client.id) return inactive;
          return { body: { active: true, token_use: 'refresh_token', client_id: g.clientId, sub: g.userId, scope: g.scope.join(' ') }, headers: { 'cache-control': 'no-store' } };
        }
        const v = await e.tokens.verifyAny(token);
        if (!v.ok || v.claims.token_use !== 'access_token') return inactive;
        const rec = s.access.get(String(v.claims.jti));
        if (!rec || rec.revoked || (rec.grantId && s.grants.get(rec.grantId)?.revoked)) return inactive;
        if (rec.clientId !== auth.client.id) return inactive; // another client's token: do not leak
        return { body: { active: true, token_type: rec.cnf?.jkt ? 'DPoP' : 'Bearer', ...(rec.cnf ? { cnf: rec.cnf } : {}), token_use: 'access_token', client_id: rec.clientId, sub: v.claims.sub, aud: v.claims.aud, iss: v.claims.iss, scope: rec.scope.join(' '), exp: v.claims.exp, iat: v.claims.iat, jti: v.claims.jti, ...(v.claims.act ? { act: v.claims.act } : {}) }, headers: { 'cache-control': 'no-store' } };
      },
    },
    ...(['GET', 'POST'] as const).map(
      (method): RouteDef => ({
        method,
        pattern: '/oauth2/userinfo',
        public: true,
        handler: async (c) => {
          const e = c.engine;
          const m = /^(Bearer|DPoP)\s+(.+)$/i.exec(c.request.headers.get('authorization') ?? '');
          const bearer = m?.[2];
          if (!bearer) return { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' }, body: { error: 'invalid_token', error_description: 'A bearer access token is required.' } };
          const v = await e.tokens.verifyAny(bearer);
          const rec = v.ok ? st(e).access.get(String(v.claims.jti)) : undefined;
          if (!v.ok || v.claims.token_use !== 'access_token' || !rec || rec.revoked || (rec.grantId && st(e).grants.get(rec.grantId)?.revoked) || !rec.userId) {
            return { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' }, body: { error: 'invalid_token', error_description: 'The access token is not valid.' } };
          }
          if (rec.cnf?.jkt) {
            // A DPoP-bound token is presented with the DPoP scheme and a proof bound to this request and this token (RFC 9449 section 7).
            const proof = c.request.headers.get('dpop');
            const bad = { status: 401, headers: { 'www-authenticate': 'DPoP error="invalid_dpop_proof", algs="ES256 ES384 RS256 PS256 EdDSA"' }, body: { error: 'invalid_dpop_proof', error_description: 'A DPoP proof bound to this access token is required.' } };
            if (m?.[1]?.toLowerCase() !== 'dpop' || !proof) return bad;
            try {
              const r = await verifyDpopProof({ proof, htm: c.request.method, htu: c.request.url, nowMs: e.clock.now(), accessToken: bearer });
              if (r.jkt !== rec.cnf.jkt || !claimDpopJti(e, r.jkt, r.jti, (DPOP_IAT_WINDOW_S + 5) * 1000)) return bad;
            } catch {
              return bad;
            }
          } else if (rec.cnf?.['x5t#S256'] && (await forwardedCertThumbprint(c.request.headers)) !== rec.cnf['x5t#S256']) {
            return { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' }, body: { error: 'invalid_token', error_description: 'The token is bound to a client certificate that was not presented.' } };
          }
          if (!rec.scope.includes('openid')) return { status: 403, headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="openid"' }, body: { error: 'insufficient_scope', error_description: 'The openid scope is required.' } };
          return { body: { sub: rec.userId, ...userClaims(e, rec.userId, rec.scope) } };
        },
      }),
    ),
  ];
}
