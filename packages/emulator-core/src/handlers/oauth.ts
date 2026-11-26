/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { pkceChallenge } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import { synthesize, type Obj } from '../openapi';
import { randomToken } from '../store';
import { DPOP_IAT_WINDOW_S, forwardedCertThumbprint, verifyDpopProof } from '../jws';
import { claimDpopJti, consentGate, consentGrants, grantEvent, memberOrg, removeConsentHold, extensionGrant, resolveRequestUri, resetOAuthFlows } from './oauth-flows';
import { GRANT_MANAGEMENT_SCOPES, REQUEST_OBJECT_ALGS, REQUEST_OBJECT_PARAMS, RESPONSE_TYPES_SUPPORTED, UMA_GRANT_TYPE, adv, applyGrantManagement, authUrl, clientResponseTypes, completeAuth, gmValid, gmWidens, loadRequestObject, managedFor, parseClientMeta, parseGrantManagement, parseResponseType, recordRp, responseModeAllowed, responseTypeProblem, sidFor, umaEnabled, umaProtectionToken, umaTicketGrant, validateAuthorizationDetails, type AuthExt } from './oauth-adv';
import { listReply, need } from './util';
import { signDelivery } from '../webhooks';
import { AUTH_METHODS, EXT_RESPONSE_MODES, OP_SIGNING_ALGS, assertionClientId, authReply, clientExtras, keyedClientProblem, resolveSubject, subjectFor, verifyClientAssertion } from './emu4-oauth-auth';
import { GOOGLE_ACCESS_TOKEN_TYPE, googleTokenExchange, publisherSectorOf } from './emu4-oauth-pub';

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
  /** The OP session (browser session) the grant's ID tokens name in `sid`. */
  sid?: string;
  /** The granted authorization_details (RFC 9396). */
  details?: unknown[] | null;
  /** The OpenID grant-management grant these tokens belong to. */
  managedId?: string;
  /** The organization this authorization was made in. */
  organizationId?: string | null;
}
export interface OAuthState {
  codes: Map<string, { grantId: string; redirectUri: string; challenge: string | null; nonce: string | null; authTime: number; expiresAt: number; used: boolean; ext?: AuthExt }>;
  grants: Map<string, Grant>;
  refresh: Map<string, { grantId: string; rotatedAt?: number; successor?: string }>;
  /** jti -> access token record (client_credentials and exchanged tokens have no grant). */
  access: Map<string, { clientId: string; userId: string | null; scope: string[]; exp: number; revoked: boolean; grantId: string | null; cnf?: Obj }>;
  autoUser: string | null;
  /** Clients deleted: every token of the client issued at or before `at` is revoked (the feed's `kind: client` rows). */
  clientRevocations: Array<{ clientId: string; at: number }>;
}
const states = new WeakMap<Engine, OAuthState>();
export const st = (e: Engine): OAuthState => {
  let s = states.get(e);
  if (!s) states.set(e, (s = { codes: new Map(), grants: new Map(), refresh: new Map(), access: new Map(), autoUser: null, clientRevocations: [] }));
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
    end_session_endpoint: `${iss}/oauth2/logout`,
    backchannel_logout_supported: true,
    backchannel_logout_session_supported: true,
    frontchannel_logout_supported: true,
    frontchannel_logout_session_supported: true,
    grant_management_endpoint: `${iss}/oauth2/grants`,
    grant_management_actions_supported: ['create', 'merge', 'replace'],
    grant_management_action_required: false,
    ...(adv(e).cfg.dynamic_registration ? { registration_endpoint: `${iss}/oauth2/register` } : {}),
    response_types_supported: [...RESPONSE_TYPES_SUPPORTED],
    response_modes_supported: ['query', 'fragment', ...EXT_RESPONSE_MODES],
    authorization_signing_alg_values_supported: [...OP_SIGNING_ALGS],
    request_object_encryption_alg_values_supported: ['RSA-OAEP-256', 'ECDH-ES'],
    request_object_encryption_enc_values_supported: ['A128GCM', 'A256GCM', 'A128CBC-HS256', 'A256CBC-HS512'],
    request_parameter_supported: true,
    request_uri_parameter_supported: true,
    require_request_uri_registration: true,
    request_object_signing_alg_values_supported: [...REQUEST_OBJECT_ALGS],
    authorization_details_types_supported: adv(e).cfg.authorization_details_types,
    grant_types_supported: ['authorization_code', 'implicit', 'refresh_token', 'client_credentials', EXCHANGE, 'urn:ietf:params:oauth:grant-type:device_code', 'urn:openid:params:grant-type:ciba', ...(umaEnabled(e) ? [UMA_GRANT_TYPE] : [])],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [...OP_SIGNING_ALGS],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'private_key_jwt', 'none'],
    token_endpoint_auth_signing_alg_values_supported: [...REQUEST_OBJECT_ALGS],
    code_challenge_methods_supported: ['S256'],
    dpop_signing_alg_values_supported: ['ES256', 'ES384', 'RS256', 'PS256', 'EdDSA'],
    tls_client_certificate_bound_access_tokens: true,
    pushed_authorization_request_endpoint: `${iss}/oauth2/par`,
    device_authorization_endpoint: `${iss}/oauth2/device_authorization`,
    backchannel_authentication_endpoint: `${iss}/oauth2/backchannel_authentication`,
    backchannel_token_delivery_modes_supported: ['poll', 'ping', 'push'],
    backchannel_user_code_parameter_supported: false,
    scopes_supported: [...SCOPES, ...GRANT_MANAGEMENT_SCOPES],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'email', 'email_verified', 'name', 'picture'],
    authorization_response_iss_parameter_supported: true,
    atlas_emulator: true,
  };
}

/** `consent_per_organization`: true, false or null (the default: per organization whenever the request names one). */
function pickConsentPerOrg(body: Obj): Obj {
  const v = body.consent_per_organization;
  if (v === undefined) return {};
  if (v !== null && typeof v !== 'boolean') throw new EmulatorError('VALIDATION_FAILED', 'consent_per_organization must be true, false or null.', 'consent_per_organization');
  return { consent_per_organization: v };
}
const FLOW_FLAGS = ['require_consent', 'dpop_bound_access_tokens', 'tls_client_certificate_bound_access_tokens', 'require_pushed_authorization_requests'] as const;
/** The client settings the consent, binding, PAR and CIBA flows read; validated here so a bad value never reaches a flow. */
function pickFlowFields(body: Obj, existing?: Obj): Obj {
  const out: Obj = { ...pickConsentPerOrg(body) };
  for (const k of FLOW_FLAGS) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') throw new EmulatorError('VALIDATION_FAILED', `${k} must be true or false.`, k);
    out[k] = body[k];
  }
  if (body.backchannel_token_delivery_mode !== undefined) {
    if (!['poll', 'ping', 'push'].includes(body.backchannel_token_delivery_mode)) throw new EmulatorError('VALIDATION_FAILED', 'backchannel_token_delivery_mode must be poll, ping or push.', 'backchannel_token_delivery_mode');
    out.backchannel_token_delivery_mode = body.backchannel_token_delivery_mode;
  }
  if (body.backchannel_client_notification_endpoint !== undefined) out.backchannel_client_notification_endpoint = body.backchannel_client_notification_endpoint;
  if ((out.backchannel_token_delivery_mode ?? existing?.backchannel_token_delivery_mode) !== undefined && ['ping', 'push'].includes(out.backchannel_token_delivery_mode ?? existing?.backchannel_token_delivery_mode) && !(out.backchannel_client_notification_endpoint ?? existing?.backchannel_client_notification_endpoint)) {
    throw new EmulatorError('VALIDATION_FAILED', 'ping and push delivery need backchannel_client_notification_endpoint.', 'backchannel_client_notification_endpoint');
  }
  // Key, request-object and response-type metadata, validated like the real registry.
  const meta = parseClientMeta(body);
  if (!meta.ok) throw new EmulatorError('VALIDATION_FAILED', meta.message);
  Object.assign(out, meta.value);
  for (const k of ['backchannel_logout_uri', 'frontchannel_logout_uri'] as const) if (body[k] !== undefined) out[k] = body[k];
  if (body.claims_redirect_uris !== undefined) out.claims_redirect_uris = body.claims_redirect_uris;
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
    consent_per_organization: typeof c.consent_per_organization === 'boolean' ? c.consent_per_organization : null,
    dpop_bound_access_tokens: c.dpop_bound_access_tokens === true,
    tls_client_certificate_bound_access_tokens: c.tls_client_certificate_bound_access_tokens === true,
    require_pushed_authorization_requests: c.require_pushed_authorization_requests === true,
    backchannel_token_delivery_mode: c.backchannel_token_delivery_mode ?? 'poll',
    backchannel_client_notification_endpoint: c.backchannel_client_notification_endpoint ?? null,
    response_types: clientResponseTypes(c),
    require_signed_request_object: c.require_signed_request_object === true,
    ...clientExtras(c),
    request_object_signing_alg: c.request_object_signing_alg ?? null,
    request_uris: c.request_uris ?? [],
    jwks: c.jwks ?? null,
    jwks_uri: c.jwks_uri ?? null,
    backchannel_logout_uri: c.backchannel_logout_uri ?? null,
    frontchannel_logout_uri: c.frontchannel_logout_uri ?? null,
    claims_redirect_uris: c.claims_redirect_uris ?? [],
    created_at: c.created_at,
    updated_at: c.updated_at,
    ...(secret ? { client_secret: secret } : {}),
  };
};

/** The client's event webhook (kept on the client row): url, events, and the secrets that sign (new first). */
const hookOf = (row: Obj): Obj => {
  if (!row.webhook) throw notFound('Webhook');
  return row.webhook;
};
const presentHook = (e: Engine, h: Obj): Obj => ({
  object: 'oauth_client_webhook',
  id: h.id,
  url: h.url,
  enabled_events: h.enabled_events,
  active: true,
  available_events: ['user.updated', 'user.deleted', 'grant.revoked', 'user.deletion_scheduled', 'user.deletion_canceled', 'signing_key.staged', 'signing_key.activated'],
  created_at: h.created_at,
  last_delivery_at: h.last_delivery_at ?? null,
  ...(h.previous_secret && h.previous_until > e.clock.now() ? { previous_secret_expires_at: h.previous_until } : {}),
});
const hookSecrets = (e: Engine, h: Obj): string[] => [h.secret, ...(h.previous_secret && h.previous_until > e.clock.now() ? [h.previous_secret] : [])];

const clientWebhookHandlers = (): RouteDef[] => [
  { method: 'GET', pattern: '/v1/oauth_clients/:id/webhook', handler: (c) => ({ body: presentHook(c.engine, hookOf(liveClient(c.engine, c.params.id))) }) },
  {
    method: 'PUT',
    pattern: '/v1/oauth_clients/:id/webhook',
    handler: (c) => {
      const e = c.engine;
      const row = liveClient(e, c.params.id);
      const url = String(need(c.body, 'url')).trim();
      if (!/^https:\/\//.test(url)) throw new EmulatorError('VALIDATION_FAILED', 'url must be a public https URL.', 'url');
      const events = Array.isArray(c.body.enabled_events) && c.body.enabled_events.length ? c.body.enabled_events : ['user.updated', 'user.deleted', 'grant.revoked', 'user.deletion_scheduled', 'user.deletion_canceled', 'signing_key.staged', 'signing_key.activated'];
      const existing = row.webhook as Obj | undefined;
      if (existing) {
        Object.assign(existing, { url, enabled_events: events });
        return { body: presentHook(e, existing) };
      }
      row.webhook = { id: `whep_${randomToken(12)}`, url, enabled_events: events, secret: e.webhooks.newSecret(), created_at: e.clock.now() };
      return { status: 201, body: { ...presentHook(e, row.webhook), webhook_secret: row.webhook.secret, note: 'Copy the signing secret now. It is not shown again.' } };
    },
  },
  {
    method: 'DELETE',
    pattern: '/v1/oauth_clients/:id/webhook',
    handler: (c) => {
      const row = liveClient(c.engine, c.params.id);
      hookOf(row);
      delete row.webhook;
      return { status: 204, body: null };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/oauth_clients/:id/webhook/rotate_secret',
    handler: (c) => {
      const e = c.engine;
      const h = hookOf(liveClient(e, c.params.id));
      const overlap = c.body.overlap_seconds === undefined || c.body.overlap_seconds === null ? 86_400 : c.body.overlap_seconds;
      if (typeof overlap !== 'number' || !Number.isInteger(overlap) || overlap < 0 || overlap > 604_800) throw new EmulatorError('VALIDATION_FAILED', 'overlap_seconds must be an integer from 0 to 604800.', 'overlap_seconds');
      h.previous_secret = overlap > 0 ? h.secret : undefined;
      h.previous_until = e.clock.now() + overlap * 1000;
      h.secret = e.webhooks.newSecret();
      return { body: { object: 'webhook_secret', webhook_secret: h.secret, overlap_seconds: overlap, previous_secret_expires_at: overlap > 0 ? h.previous_until : null } };
    },
  },
  {
    method: 'POST',
    pattern: '/v1/oauth_clients/:id/webhook/test',
    handler: async (c) => {
      const e = c.engine;
      const row = liveClient(e, c.params.id);
      const h = hookOf(row);
      let creator: { id: string } | null = null;
      const userId = c.body.user_id;
      if (userId !== undefined && userId !== null) {
        if (typeof userId !== 'string') throw notFound('User');
        // The Atlas user id, or the sub this client receives for the user; no grant is needed.
        let resolved: string | undefined = e.db.users.get(userId) ? userId : undefined;
        if (!resolved) for (const u of e.db.users.all()) if ((await subjectFor(e, row, u.id)) === userId) { resolved = u.id; break; }
        if (!resolved) throw notFound('User');
        creator = { id: await subjectFor(e, row, resolved) };
      }
      const now = e.clock.now();
      const id = `evt_${randomToken(12)}`;
      const body = JSON.stringify({ id, type: 'webhook.test', timestamp: now, instance_id: e.instanceId, actor: { type: 'system', id: null }, idempotency_key: null, data: { object: 'webhook_test', id: `test_${randomToken(8)}` }, creator });
      // One entry per secret, the new one first, like the real API.
      const signed = await Promise.all(hookSecrets(e, h).map((secret) => signDelivery({ secret, id, timestampMs: now, body })));
      const headers = { ...signed[0]!, 'atlas-signature': signed.map((s) => s['atlas-signature']).join(' '), 'content-type': 'application/json' };
      let status: number | null = null;
      let error: string | null = null;
      try {
        status = (await (e.options.fetch ?? fetch)(h.url, { method: 'POST', headers, body })).status;
      } catch (err) {
        error = (err as Error).message;
      }
      h.last_delivery_at = now;
      const ok = status !== null && status >= 200 && status < 300;
      return { body: { object: 'webhook_test_result', ok, event_id: id, event_type: 'webhook.test', url: h.url, status: ok ? 'success' : 'failed', status_code: status, http_status: status, duration_ms: e.clock.now() - now, latency_ms: e.clock.now() - now, error: ok ? null : (error ?? (status !== null ? `HTTP ${status}` : null)), signature_header_sent: headers['atlas-signature'] } };
    },
  },
];

const liveClient = (e: Engine, id: string | undefined): Obj => {
  const c = e.db.oauthClients.get(id);
  if (!c || c.deleted) throw notFound('OAuth client');
  return c;
};

/** Client authentication with the method the client is REGISTERED for: Basic, `client_id` (+ `client_secret`) in the body, a signed `client_assertion` (private_key_jwt), or nothing for a public client. */
export async function authenticateClient(e: Engine, c: RouteContext): Promise<{ client: Obj } | { error: Reply }> {
  let id = typeof c.body.client_id === 'string' ? c.body.client_id : undefined;
  let secret = typeof c.body.client_secret === 'string' ? c.body.client_secret : undefined;
  const basic = /^Basic\s+(.+)$/i.exec(c.request.headers.get('authorization') ?? '')?.[1];
  if (basic) {
    const [i, ...rest] = atob(basic).split(':');
    id = decodeURIComponent(i ?? '');
    secret = decodeURIComponent(rest.join(':'));
  }
  // A client assertion names the client itself when no client_id was sent.
  id ??= assertionClientId(c.body);
  const client = e.db.oauthClients.get(id);
  if (!client || client.deleted) return { error: fail(401, 'invalid_client', 'Unknown client.') };
  if (client.auth_method === 'private_key_jwt') {
    const problem = secret !== undefined ? 'This client must authenticate with a private_key_jwt client assertion.' : await verifyClientAssertion(e, c.body, client);
    return problem ? { error: fail(401, 'invalid_client', problem) } : { client };
  }
  const previousOk = client.previous_secret !== undefined && client.previous_secret === secret && e.clock.now() < client.previous_until;
  if (client.auth_method !== 'none' && client.secret_expires_at && e.clock.now() >= client.secret_expires_at) return { error: fail(401, 'invalid_client', 'Client authentication failed.') };
  if (client.auth_method !== 'none' && client.secret !== secret && !previousOk) return { error: fail(401, 'invalid_client', 'Client authentication failed.') };
  return { client };
}

export const splitScope = (s: unknown): string[] => (typeof s === 'string' ? s.split(/\s+/).filter(Boolean) : []);

export async function mintAccess(e: Engine, input: { client: Obj; userId: string | null; scope: string[]; grant: Grant | null; audience?: string; extra?: Obj; cnf?: Obj; ttl?: number }): Promise<{ token: string; jti: string }> {
  const ttl = input.ttl ?? ACCESS_TTL_S;
  const jti = e.db.newId('oat');
  const token = await e.tokens.signClaims(
    {
      sub: input.userId ? await subjectFor(e, input.client, input.userId) : input.client.id,
      aud: input.audience ?? input.client.id,
      client_id: input.client.id,
      scope: input.scope.join(' '),
      jti,
      token_use: 'access_token',
      ...(input.cnf ? { cnf: input.cnf } : {}),
      ...(input.extra ?? {}),
    },
    ttl,
  );
  const s = st(e);
  s.access.set(jti, { clientId: input.client.id, userId: input.userId, scope: input.scope, exp: e.clock.now() + ttl * 1000, revoked: false, grantId: input.grant?.id ?? null, cnf: input.cnf });
  input.grant?.jtis.add(jti);
  return { token, jti };
}

export const userClaims = (e: Engine, userId: string, scope: string[]): Obj => {
  const u = e.db.users.get(userId);
  if (!u) return {};
  const primary = (u.emails as Obj[]).find((m) => m.id === u.primary_email_address_id);
  return {
    ...(scope.includes('email') && primary ? { email: primary.email_address, email_verified: primary.verified === true } : {}),
    ...(scope.includes('profile') ? { name: [u.first_name, u.last_name].filter(Boolean).join(' ') || undefined, picture: u.image_url ?? undefined, given_name: u.first_name ?? undefined, family_name: u.last_name ?? undefined } : {}),
  };
};

export async function issueTokens(e: Engine, client: Obj, grant: Grant, nonce: string | null, authTime: number, refreshRec?: string, cnf?: Obj): Promise<Obj> {
  const access = await mintAccess(e, { client, userId: grant.userId, scope: grant.scope, grant, cnf, extra: grant.managedId ? { grant_id: grant.managedId } : undefined });
  const out: Obj = { access_token: access.token, token_type: cnf?.jkt ? 'DPoP' : 'Bearer', expires_in: ACCESS_TTL_S, scope: grant.scope.join(' ') };
  if (grant.managedId) out.grant_id = grant.managedId;
  if (grant.details?.length) out.authorization_details = grant.details;
  if (grant.scope.includes('offline_access') || client.grant_types.includes('refresh_token')) {
    const rt = refreshRec ?? `ort_${randomToken(32)}`;
    if (!st(e).refresh.has(rt)) st(e).refresh.set(rt, { grantId: grant.id });
    out.refresh_token = rt;
  }
  if (grant.scope.includes('openid') && grant.userId) {
    out.id_token = await idTokenFor(e, client, grant.userId, grant.scope, nonce, authTime, grant.sid);
    recordRp(e, grant.sid, client.id, grant.userId);
  }
  return out;
}

export async function idTokenFor(e: Engine, client: Obj, userId: string, scope: string[], nonce: string | null, authTime: number, sid?: string, extra: Obj = {}): Promise<string> {
  return e.tokens.signClaimsAs(client.id_token_signed_response_alg ?? null, { sub: await subjectFor(e, client, userId), aud: client.id, azp: client.id, auth_time: Math.floor(authTime / 1000), ...(nonce ? { nonce } : {}), ...(sid ? { sid } : {}), token_use: 'id_token', ...userClaims(e, userId, scope), ...extra }, ACCESS_TTL_S);
}

/** End a grant and every access token minted from it. */
export function revokeGrant(e: Engine, g: Grant): void {
  g.revoked = true;
  for (const j of g.jtis) {
    const a = st(e).access.get(j);
    if (a) a.revoked = true;
  }
}

/** A presented access token for a resource of this provider: signature, revocation and its sender constraint (DPoP proof or client certificate). */
export async function checkResourceToken(c: RouteContext, bearer: string, scheme: string): Promise<{ rec: NonNullable<ReturnType<OAuthState['access']['get']>> } | { error: true; message: string }> {
  const e = c.engine;
  const v = await e.tokens.verifyAny(bearer);
  const rec = v.ok ? st(e).access.get(String(v.claims.jti)) : undefined;
  if (!v.ok || v.claims.token_use !== 'access_token' || !rec || rec.revoked || (rec.grantId && st(e).grants.get(rec.grantId)?.revoked)) return { error: true, message: 'The access token is invalid or expired.' };
  const bad = { error: true as const, message: 'A valid DPoP proof for this token is required.' };
  if (rec.cnf?.jkt) {
    const proof = c.request.headers.get('dpop');
    if (scheme.toLowerCase() !== 'dpop' || !proof) return bad;
    try {
      const r = await verifyDpopProof({ proof, htm: c.request.method, htu: c.request.url, nowMs: e.clock.now(), accessToken: bearer });
      if (r.jkt !== rec.cnf.jkt || !claimDpopJti(e, r.jkt, r.jti, (DPOP_IAT_WINDOW_S + 5) * 1000)) return bad;
    } catch {
      return bad;
    }
  } else if (rec.cnf?.['x5t#S256'] && (await forwardedCertThumbprint(c.request.headers)) !== rec.cnf['x5t#S256']) return { error: true, message: 'The token is bound to a client certificate that was not presented.' };
  return { rec };
}

/** Create the grant and the single-use authorization code for an approved request (after login and, when needed, consent). */
export function issueCode(e: Engine, a: { client: Obj; userId: string; scope: string[]; redirectUri: string; challenge: string | null; nonce: string | null; ext?: AuthExt }): string {
  const grant: Grant = { id: e.db.newId('oag'), clientId: a.client.id, userId: a.userId, scope: a.scope, revoked: false, jtis: new Set(), sid: sidFor(e, a.userId), details: a.ext?.details ?? null, organizationId: a.ext?.organizationId ?? null };
  st(e).grants.set(grant.id, grant);
  const code = `oc_${randomToken(24)}`;
  const now = e.clock.now();
  st(e).codes.set(code, { grantId: grant.id, redirectUri: a.redirectUri, challenge: a.challenge, nonce: a.nonce, authTime: now, expiresAt: now + CODE_TTL_MS, used: false, ext: a.ext });
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
  return [
    // ── client registry ──
    {
      method: 'POST',
      pattern: '/v1/oauth_clients',
      handler: async (c) => {
        const e = c.engine;
        const name = String(need(c.body, 'name'));
        const uris = c.body.redirect_uris;
        if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string')) throw new EmulatorError('VALIDATION_FAILED', 'redirect_uris needs at least one URI.', 'redirect_uris');
        const method = c.body.token_endpoint_auth_method ?? 'client_secret_basic';
        if (!AUTH_METHODS.includes(method)) throw new EmulatorError('VALIDATION_FAILED', `token_endpoint_auth_method must be one of: ${AUTH_METHODS.join(', ')}.`, 'token_endpoint_auth_method');
        const flowFields = pickFlowFields(c.body);
        const keyedProblem = keyedClientProblem(method, flowFields.jwks, flowFields.jwks_uri);
        if (keyedProblem) throw new EmulatorError('VALIDATION_FAILED', keyedProblem, 'jwks');
        const subject = await resolveSubject(e, { subject_type: c.body.subject_type, sector_identifier_uri: c.body.sector_identifier_uri, redirect_uris: uris, redirectUrisChanged: true });
        if (!subject.ok) throw new EmulatorError('VALIDATION_FAILED', subject.message, subject.param);
        const rtProblem = responseTypeProblem(clientResponseTypes(c.body), c.body.grant_types ?? ['authorization_code', 'refresh_token']);
        if (rtProblem) throw new EmulatorError('VALIDATION_FAILED', rtProblem, 'response_types');
        const now = e.clock.now();
        const secret = method === 'none' || method === 'private_key_jwt' ? undefined : `oacs_${randomToken(32)}`;
        const row = e.db.oauthClients.insert({
          name,
          redirect_uris: uris,
          allowed_scopes: c.body.allowed_scopes ?? SCOPES,
          grant_types: c.body.grant_types ?? ['authorization_code', 'refresh_token'],
          auth_method: method,
          first_party: c.body.first_party === true,
          post_logout_redirect_uris: c.body.post_logout_redirect_uris ?? [],
          ...flowFields,
          ...subject.value,
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
      handler: async (c) => {
        const e = c.engine;
        const row = liveClient(e, c.params.id);
        const next: Record<string, any> = { ...row };
        for (const k of ['name', 'redirect_uris', 'allowed_scopes', 'grant_types', 'first_party', 'post_logout_redirect_uris']) if (k in c.body) next[k] = c.body[k];
        Object.assign(next, pickFlowFields(c.body, row));
        const keyedProblem = keyedClientProblem(next.auth_method, next.jwks, next.jwks_uri);
        if (keyedProblem) throw new EmulatorError('VALIDATION_FAILED', keyedProblem, 'jwks');
        if (c.body.subject_type !== undefined || c.body.sector_identifier_uri !== undefined || c.body.redirect_uris !== undefined) {
          const subject = await resolveSubject(e, { subject_type: c.body.subject_type, sector_identifier_uri: c.body.sector_identifier_uri, redirect_uris: next.redirect_uris, redirectUrisChanged: c.body.redirect_uris !== undefined, existing: row, publisherSector: publisherSectorOf(e, row) });
          if (!subject.ok) throw new EmulatorError('VALIDATION_FAILED', subject.message, subject.param);
          Object.assign(next, subject.value);
        }
        const rtProblem = responseTypeProblem(clientResponseTypes(next), next.grant_types);
        if (rtProblem) throw new EmulatorError('VALIDATION_FAILED', rtProblem, 'response_types');
        Object.assign(row, next); // validated first: a refused PATCH changes nothing
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
        const at = e.clock.now();
        for (const g of st(e).grants.values()) {
          if (g.clientId !== row.id) continue;
          const wasLive = !g.revoked;
          g.revoked = true;
          if (wasLive && g.userId) {
            e.changed({ type: 'grant.revoked', data: { object: 'grant', ...grantEvent(e, { id: g.id, userId: g.userId, clientId: row.id, organizationId: g.organizationId ?? null, scopes: new Set(g.scope), at: row.created_at }), session_ids: [] } });
            e.changed({ type: 'oauth_tokens.revoked', data: { object: 'oauth_tokens_revocation', client_id: row.id, user_id: g.userId, grant_id: g.managedId ?? null, family_id: g.id, audience: null, access_token_jtis: [], reason: 'client_revoked', revoked_at: at } });
          }
        }
        for (const a of st(e).access.values()) if (a.clientId === row.id) a.revoked = true;
        // One feed row for the whole client, so a client_credentials token (no family) is covered too.
        st(e).clientRevocations.push({ clientId: row.id, at });
        e.changed({ type: 'oauth_client.deleted', data: { object: 'oauth_client', id: row.id, deleted: true } });
        return { body: { object: 'oauth_client', id: row.id, deleted: true } };
      },
    },
    {
      // The users who authorized the client, derived from its grants: active while any grant is live.
      method: 'GET',
      pattern: '/v1/oauth_clients/:id/consents',
      handler: (c) => {
        const e = c.engine;
        const row = liveClient(e, c.params.id);
        const status = c.query.get('status') ?? 'active';
        if (!['active', 'revoked', 'all'].includes(status)) throw new EmulatorError('VALIDATION_FAILED', 'status must be active, revoked or all.', 'status');
        const limit = Math.min(100, Math.max(1, Number(c.query.get('limit') ?? 50) || 50));
        const after = c.query.get('starting_after') ?? '';
        const byUser = new Map<string, Grant[]>();
        for (const g of st(e).grants.values()) if (g.clientId === row.id && g.userId) byUser.set(g.userId, [...(byUser.get(g.userId) ?? []), g]);
        const rows = [...byUser.entries()]
          .filter(([u]) => u > after)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([userId, gs]) => ({ userId, gs, active: gs.some((g) => !g.revoked) }))
          .filter((r) => status === 'all' || (status === 'active') === r.active);
        const page = rows.slice(0, limit);
        const hasMore = rows.length > page.length;
        return {
          body: {
            object: 'list',
            client_id: row.id,
            data: page.map((r) => ({
              object: 'oauth_client_consent',
              user_id: r.userId,
              scopes: [...new Set(r.gs.flatMap((g) => g.scope))],
              status: r.active ? 'active' : 'revoked',
              created_at: row.created_at,
              last_used_at: null,
              revoked_at: r.active ? null : row.updated_at,
            })),
            has_more: hasMore,
            next_cursor: hasMore ? page[page.length - 1]!.userId : null,
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/oauth_clients/:id/consents/revoke',
      handler: (c) => {
        const e = c.engine;
        const row = liveClient(e, c.params.id);
        const only = c.body.user_ids;
        if (only !== undefined && (!Array.isArray(only) || only.length === 0 || !only.every((u) => typeof u === 'string'))) throw new EmulatorError('VALIDATION_FAILED', 'user_ids must be a list of user ids.', 'user_ids');
        const users = new Set<string>();
        let tokens = 0;
        for (const g of st(e).grants.values()) {
          if (g.clientId !== row.id || g.revoked || !g.userId || (only && !(only as string[]).includes(g.userId))) continue;
          g.revoked = true;
          tokens++;
          users.add(g.userId);
          e.changed({ type: 'grant.revoked', data: { object: 'grant', ...grantEvent(e, { id: g.id, userId: g.userId, clientId: row.id, organizationId: g.organizationId ?? null, scopes: new Set(g.scope), at: row.created_at }), session_ids: [] } });
        }
        // Every consent of those users (one per organization), including ones that were not remembered.
        for (const h of consentGrants(e)) {
          if (h.clientId !== row.id || (only && !(only as string[]).includes(h.userId))) continue;
          users.add(h.userId);
          removeConsentHold(e, h);
        }
        return { body: { object: 'oauth_client_consents_revocation', client_id: row.id, consents_revoked: users.size, tokens_revoked: tokens } };
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
    ...clientWebhookHandlers(),
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
      handler: async (c) => {
        const e = c.engine;
        const rawUri = c.query.get('request_uri');
        // An https request_uri names a request object to fetch (RFC 9101); anything else is a pushed request (RFC 9126).
        const jarUri = rawUri && /^https:\/\//i.test(rawUri) ? rawUri : null;
        const resolved = jarUri ? { query: c.query } : resolveRequestUri(e, c.query);
        if ('error' in resolved) return fail(400, resolved.error.code, resolved.error.description);
        const parUsed = !!rawUri && !jarUri;
        const q = resolved.query;
        const client = e.db.oauthClients.get(q.get('client_id') ?? undefined);
        if (!client || client.deleted) return fail(400, 'invalid_request', 'Unknown client_id.');
        if (client.require_pushed_authorization_requests && !parUsed) return fail(400, 'invalid_request', 'This client must push its authorization request (POST /oauth2/par) and send the request_uri.');
        const p: Record<string, string> = Object.fromEntries(q.entries());
        let rarRaw: unknown = p.authorization_details;
        if (client.require_signed_request_object === true && !parUsed && !p.request && !jarUri) return fail(400, 'invalid_request', 'This client must send a signed request object.');
        // A signed request object supersedes the query parameters; it is verified BEFORE the redirect_uri is trusted.
        if (p.request || jarUri) {
          const loaded = await loadRequestObject(e, client, { request: p.request, requestUri: jarUri ?? undefined });
          if (!loaded.ok) return fail(400, loaded.error, loaded.description);
          for (const k of REQUEST_OBJECT_PARAMS) if (typeof loaded.claims[k] === 'string') p[k] = loaded.claims[k];
          if (loaded.claims.authorization_details !== undefined) rarRaw = loaded.claims.authorization_details;
          delete p.request;
        }
        const redirectUri = p.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
        if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return fail(400, 'invalid_request', 'redirect_uri is not registered for this client.');
        const state = p.state;
        const rt = parseResponseType(p.response_type);
        const mode = p.response_mode ?? null;
        const back = (params: Record<string, string | undefined>): Promise<Reply> => authReply(e, client, redirectUri, authUrl(e, redirectUri, { ...params, state, iss: e.issuer }, !!rt?.frontChannelTokens, mode), mode);
        if (!rt) return back({ error: 'unsupported_response_type', error_description: 'The response_type is not supported.' });
        if (!clientResponseTypes(client).includes(rt.canonical)) return back({ error: 'unauthorized_client', error_description: 'This client is not registered for this response_type.' });
        if (mode && !['query', 'fragment', ...EXT_RESPONSE_MODES].includes(mode)) return back({ error: 'invalid_request', error_description: 'The response_mode is not supported.' });
        if (mode && !responseModeAllowed(rt, mode)) return back({ error: 'invalid_request', error_description: 'A response_type that returns tokens cannot use the query response mode.' });
        // OIDC Core 3.2.2.1 / 3.3.2.1: the nonce is required whenever an ID token comes back from the authorization endpoint.
        if (rt.idToken && !p.nonce) return back({ error: 'invalid_request', error_description: 'The nonce parameter is required for this response_type.' });
        const gmParsed = parseGrantManagement(p.grant_management_action, p.grant_id);
        if (!gmParsed.ok) return back({ error: 'invalid_request', error_description: gmParsed.message });
        const gm = gmParsed.value;
        if (rt.code && !client.grant_types.includes('authorization_code')) return back({ error: 'unauthorized_client', error_description: 'This client is not permitted the authorization_code grant.' });
        if (rt.frontChannelTokens && !client.grant_types.includes('implicit')) return back({ error: 'unauthorized_client', error_description: 'This client is not permitted the implicit grant.' });
        const scope = splitScope(p.scope ?? 'openid');
        const outside = scope.filter((s) => !client.allowed_scopes.includes(s) && !SCOPES.includes(s));
        if (outside.length) return back({ error: 'invalid_scope', error_description: `Scope not allowed: ${outside.join(' ')}.` });
        const challenge = p.code_challenge ?? null;
        if (challenge && (p.code_challenge_method ?? 'plain') !== 'S256') return back({ error: 'invalid_request', error_description: 'code_challenge_method must be S256.' });
        if (!challenge && rt.code && client.auth_method === 'none') return back({ error: 'invalid_request', error_description: 'A public client must use PKCE (code_challenge).' });
        // RFC 9396: authorization_details against the instance's type allowlist (an empty allowlist refuses any type).
        const rar = validateAuthorizationDetails(rarRaw, adv(e).cfg.authorization_details_types);
        if (!rar.ok) return back({ error: 'invalid_authorization_details', error_description: rar.message });
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
        const details = rar.value ?? null;
        // Grant management: a merge or replace names this client's and this user's active grant; adding anything to it asks the user again.
        const gmProblem = gmValid(e, gm, client.id, user.id);
        if (gmProblem) return back({ error: 'invalid_grant', error_description: gmProblem });
        const widens = !!gm && gm.action !== 'create' && gmWidens(gm, managedFor(e, gm.grantId!, client.id, user.id), scope, details);
        // The organization the request names (id or slug): the user must belong to it.
        let organizationId: string | null = null;
        if (p.organization) {
          const org = memberOrg(e, p.organization, user.id);
          if (!org) return back({ error: 'access_denied', error_description: 'The user is not a member of the requested organization.' });
          organizationId = org.id;
        }
        const ext: AuthExt = { rt: rt.canonical, mode, details, gm, organizationId };
        const gate = await consentGate(e, { client, user, scope, redirectUri, challenge, nonce: p.nonce ?? null, state, prompt: q.get('prompt'), ext, force: widens, organizationId });
        if (gate) return gate;
        return authReply(e, client, redirectUri, await completeAuth(e, { client, userId: user.id, scope, redirectUri, challenge, nonce: p.nonce ?? null, state, ext }), mode);
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
        const auth = await authenticateClient(e, c);
        if ('error' in auth) return auth.error;
        const client = auth.client;
        const type = String(c.body.grant_type ?? '');
        if (!type) return fail(400, 'invalid_request', 'grant_type is required.');
        const umaPat = type === 'client_credentials' && !c.body.audience && splitScope(c.body.scope).includes('uma_protection') && umaEnabled(e);
        if (type !== EXCHANGE && type !== UMA_GRANT_TYPE && !umaPat && !client.grant_types.includes(type) && !(type === 'refresh_token')) return fail(400, 'unauthorized_client', `This client may not use ${type}.`);
        const s = st(e);
        const now = e.clock.now();
        const pr = await provedOf(c, client);
        if ('error' in pr) return pr.error;
        const cnf = cnfFor(pr.proved);

        const ext = await extensionGrant(c, client, type, cnf);
        if (ext) return ext;
        if (umaPat) return client.auth_method === 'none' ? fail(401, 'invalid_client', 'A protection API token requires a confidential client.') : umaProtectionToken(c, client);
        if (type === UMA_GRANT_TYPE && umaEnabled(e)) return umaTicketGrant(c, client);

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
          // OpenID grant management: apply the create / merge / replace the code carried; the tokens are for the grant as it stands afterwards.
          if (rec.ext?.gm) {
            const applied = applyGrantManagement(e, grant, rec.ext.gm);
            if (applied) return fail(400, applied.error, applied.message);
          }
          return { body: await issueTokens(e, client, grant, rec.nonce, rec.authTime, undefined, cnf), headers: { 'cache-control': 'no-store', pragma: 'no-cache' } };
        }

        if (type === 'refresh_token') {
          const token = String(c.body.refresh_token ?? '');
          const rec = s.refresh.get(token);
          const grant = rec ? s.grants.get(rec.grantId) : undefined;
          if (!rec || !grant || grant.clientId !== client.id) return fail(400, 'invalid_grant', 'The refresh token is invalid.');
          if (grant.revoked || (grant.managedId && adv(e).managed.get(grant.managedId)?.status !== 'active')) return fail(400, 'invalid_grant', 'The grant was revoked.');
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

        if (type === EXCHANGE && c.body.subject_token_type === GOOGLE_ACCESS_TOKEN_TYPE) return googleTokenExchange(c, client);
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
      handler: async (c) => {
        const e = c.engine;
        const auth = await authenticateClient(e, c);
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
        const auth = await authenticateClient(e, c);
        if ('error' in auth) return auth.error;
        const token = String(c.body.token ?? '');
        const s = st(e);
        const inactive = { body: { active: false }, headers: { 'cache-control': 'no-store' } };
        const rt = s.refresh.get(token);
        if (rt) {
          const g = s.grants.get(rt.grantId);
          if (!g || g.revoked || rt.rotatedAt !== undefined || g.clientId !== auth.client.id) return inactive;
          return { body: { active: true, token_use: 'refresh_token', client_id: g.clientId, ...(g.userId ? { sub: await subjectFor(e, auth.client, g.userId) } : {}), scope: g.scope.join(' '), ...(g.details?.length ? { authorization_details: g.details } : {}), ...(g.managedId ? { grant_id: g.managedId } : {}) }, headers: { 'cache-control': 'no-store' } };
        }
        const v = await e.tokens.verifyAny(token);
        if (!v.ok || v.claims.token_use !== 'access_token') return inactive;
        const rec = s.access.get(String(v.claims.jti));
        if (!rec || rec.revoked || (rec.grantId && s.grants.get(rec.grantId)?.revoked)) return inactive;
        // another client's token: do not leak (a resource server may introspect the tokens issued for it)
        if (rec.clientId !== auth.client.id && v.claims.uma_rs !== auth.client.id) return inactive;
        const granted = rec.grantId ? s.grants.get(rec.grantId) : undefined;
        return { body: { active: true, token_type: rec.cnf?.jkt ? 'DPoP' : 'Bearer', ...(granted?.details?.length ? { authorization_details: granted.details } : {}), ...(v.claims.grant_id ? { grant_id: v.claims.grant_id } : {}), ...(v.claims.permissions ? { permissions: v.claims.permissions, uma_rs: v.claims.uma_rs } : {}), ...(rec.cnf ? { cnf: rec.cnf } : {}), token_use: 'access_token', client_id: rec.clientId, sub: v.claims.sub, aud: v.claims.aud, iss: v.claims.iss, scope: rec.scope.join(' '), exp: v.claims.exp, iat: v.claims.iat, jti: v.claims.jti, ...(v.claims.act ? { act: v.claims.act } : {}) }, headers: { 'cache-control': 'no-store' } };
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
          return { body: { sub: await subjectFor(e, e.db.oauthClients.get(rec.clientId), rec.userId), ...userClaims(e, rec.userId, rec.scope) } };
        },
      }),
    ),
  ];
}
