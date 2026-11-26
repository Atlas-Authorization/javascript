/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { bytesToB64url, sha256 } from '../crypto-util';
import { EmulatorError } from '../errors';
import { decodeJwt, verifyJws } from '../jws';
import type { Obj } from '../openapi';
import { randomToken } from '../store';
import { checkResourceToken, fail, idTokenFor, issueCode, mintAccess, revokeGrant, splitScope, st, type Grant } from './oauth';
import { engineState } from './support';
import { AUTH_METHODS, clientExtras, dcrConfig, ensureRegisteredEncryptionKeys, keyedClientProblem, parseExtraClientFields, resolveSubject, subjectFor, verifySoftwareStatement } from './emu4-oauth-auth';
import { publisherSectorOf } from './emu4-oauth-pub';
import { enqueueBackchannelLogout } from './emu4-oauth-delivery';

/**
 * The OAuth provider's advanced surface, on top of `oauth.ts` / `oauth-flows.ts`: OIDC implicit and hybrid response types,
 * signed request objects (RFC 9101), rich authorization requests (RFC 9396), OpenID grant management, dynamic client
 * registration with its management endpoint (RFC 7591 / 7592) and initial access tokens, RP-initiated logout with
 * back-channel and front-channel fan-out, and UMA 2.0. Each follows the real provider's validation and error text.
 */

export interface AuthExt {
  /** Canonical response_type (`code`, `code id_token`, ...). */
  rt: string;
  mode: string | null;
  details: unknown[] | null;
  gm: { action: string; grantId?: string } | null;
  /** The organization the authorization is made in (consent and the grant are kept per organization). */
  organizationId?: string | null;
}
export const CODE_EXT: AuthExt = { rt: 'code', mode: null, details: null, gm: null };

interface Managed {
  id: string;
  clientId: string;
  userId: string;
  scopes: string[];
  details: unknown[] | null;
  status: 'active' | 'revoked';
  revision: number;
  createdAt: number;
  updatedAt: number;
}
interface Iat {
  id: string;
  token: string;
  description: string | null;
  owner: string | null;
  allowedGrantTypes: string[] | null;
  httpsRedirectsOnly: boolean;
  maxClients: number | null;
  maxUses: number | null;
  useCount: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
}
interface UmaRes {
  id: string;
  clientId: string;
  name: string;
  type?: string;
  uri?: string;
  iconUri?: string;
  scopes: string[];
  owner?: string;
  shares: Map<string, string[]>;
}
interface Adv {
  cfg: { dynamic_registration: boolean; require_initial_access_token: boolean; authorization_details_types: string[]; uma_enabled: boolean; dynamic_client_secret_ttl_seconds: number; optional_scopes: string[] };
  managed: Map<string, Managed>;
  sessions: Map<string, string>;
  rp: Array<{ sid: string; clientId: string; userId: string }>;
  iats: Map<string, Iat>;
  uma: { res: Map<string, UmaRes>; tickets: Map<string, { clientId: string; perms: Array<{ resource_id: string; resource_scopes: string[] }>; userId?: string; expiresAt: number }>; pct: Map<string, { clientId: string; userId: string }> };
}
export const adv = engineState((): Adv => ({
  cfg: { dynamic_registration: false, require_initial_access_token: false, authorization_details_types: [], uma_enabled: false, dynamic_client_secret_ttl_seconds: 0, optional_scopes: [] },
  managed: new Map(),
  sessions: new Map(),
  rp: [],
  iats: new Map(),
  uma: { res: new Map(), tickets: new Map(), pct: new Map() },
}));

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };
const GRANT_QUERY_SCOPE = 'grant_management_query';
const GRANT_REVOKE_SCOPE = 'grant_management_revoke';
export const GRANT_MANAGEMENT_SCOPES = [GRANT_QUERY_SCOPE, GRANT_REVOKE_SCOPE];
export const SUPPORTED_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'organizations', 'device_sso'];
export const REQUEST_OBJECT_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'ES256', 'ES384', 'ES512', 'EdDSA'];
const UMA_GRANT = 'urn:ietf:params:oauth:grant-type:uma-ticket';
export const UMA_GRANT_TYPE = UMA_GRANT;
const UMA_PROTECTION_SCOPE = 'uma_protection';

// ── response types ──────────────────────────────────────────────────

export const RESPONSE_TYPES_SUPPORTED = ['code', 'id_token', 'id_token token', 'code id_token', 'code token', 'code id_token token'];
const RT_ORDER = ['code', 'id_token', 'token'];
export interface ParsedResponseType {
  canonical: string;
  code: boolean;
  idToken: boolean;
  token: boolean;
  frontChannelTokens: boolean;
}
/** Parse a `response_type`; null when empty, repeating a token or naming an unknown one. */
export function parseResponseType(value: string | undefined | null): ParsedResponseType | null {
  if (!value) return null;
  const parts = value.split(' ').filter(Boolean);
  if (!parts.length || new Set(parts).size !== parts.length || !parts.every((p) => RT_ORDER.includes(p))) return null;
  const has = (t: string) => parts.includes(t);
  return { canonical: RT_ORDER.filter(has).join(' '), code: has('code'), idToken: has('id_token'), token: has('token'), frontChannelTokens: has('id_token') || has('token') };
}
/** Tokens never travel in the URL query (OAuth Multiple Response Types section 5). */
export const responseModeAllowed = (rt: ParsedResponseType, mode: string): boolean => !rt.frontChannelTokens || (mode !== 'query' && mode !== 'query.jwt');
export const clientResponseTypes = (client: Obj): string[] => (Array.isArray(client.response_types) && client.response_types.length ? client.response_types : ['code']);

/** The redirect URL of an authorization response: query for code, fragment for any front-channel token (and for errors on such a request). */
export function authUrl(e: Engine, redirectUri: string, params: Record<string, string | undefined>, front: boolean, mode: string | null): string {
  const u = new URL(redirectUri);
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as Array<[string, string]>;
  if (front || mode === 'fragment') u.hash = new URLSearchParams(entries).toString();
  else for (const [k, v] of entries) u.searchParams.set(k, v);
  return u.toString();
}

/** The OP session (the browser session whose id is the `sid` of every ID token it issued) for a user. */
export function sidFor(e: Engine, userId: string): string {
  const s = adv(e).sessions;
  let sid = s.get(userId);
  if (!sid) s.set(userId, (sid = e.db.newId('osid')));
  return sid;
}
export function recordRp(e: Engine, sid: string | undefined, clientId: string, userId: string | null): void {
  if (!sid || !userId) return;
  const rp = adv(e).rp;
  if (!rp.some((r) => r.sid === sid && r.clientId === clientId)) rp.push({ sid, clientId, userId });
}

/** Finish an approved authorization request for any response type and return where to send the browser. */
export async function completeAuth(e: Engine, a: { client: Obj; userId: string; scope: string[]; redirectUri: string; challenge: string | null; nonce: string | null; state?: string; ext: AuthExt }): Promise<string> {
  const rt = parseResponseType(a.ext.rt)!;
  const params: Record<string, string | undefined> = { state: a.state, iss: e.issuer };
  let code: string | undefined;
  if (rt.code) params.code = code = issueCode(e, { ...a, ext: a.ext });
  if (rt.frontChannelTokens) {
    // Tokens minted at the authorization endpoint belong to no refresh grant and carry no refresh token.
    let accessToken: string | undefined;
    if (rt.token) {
      const t = await mintAccess(e, { client: a.client, userId: a.userId, scope: a.scope, grant: null });
      accessToken = t.token;
      Object.assign(params, { access_token: t.token, token_type: 'Bearer', expires_in: '3600', scope: a.scope.join(' ') });
    }
    if (rt.idToken) {
      const half = async (v: string) => bytesToB64url((await sha256(v)).slice(0, 16));
      const sid = sidFor(e, a.userId);
      params.id_token = await idTokenFor(e, a.client, a.userId, a.scope, a.nonce, e.clock.now(), sid, { ...(accessToken ? { at_hash: await half(accessToken) } : {}), ...(code ? { c_hash: await half(code) } : {}) });
      recordRp(e, sid, a.client.id, a.userId);
    }
  }
  return authUrl(e, a.redirectUri, params, rt.frontChannelTokens, a.ext.mode);
}

// ── rich authorization requests (RFC 9396) ─────────────────────────

export function validateAuthorizationDetails(raw: unknown, allowlist: string[]): { ok: true; value: unknown[] | undefined } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, message: 'authorization_details must be a JSON array.' };
    }
  }
  if (!Array.isArray(parsed) || !parsed.length) return { ok: false, message: 'authorization_details must be a non-empty JSON array.' };
  for (const el of parsed) {
    if (typeof el !== 'object' || el === null || Array.isArray(el)) return { ok: false, message: 'Each authorization_details element must be an object.' };
    const type = (el as any).type;
    if (typeof type !== 'string' || !type) return { ok: false, message: 'Each authorization_details element needs a string "type".' };
    if (!allowlist.includes(type)) return { ok: false, message: `authorization_details type is not supported: ${type}.` };
  }
  return { ok: true, value: parsed };
}

// ── grant management ───────────────────────────────────────────────

interface Content {
  scopes: string[];
  details: unknown[] | null;
}
const stable = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1))) : val));
const dedupe = (items: unknown[]): unknown[] => {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(stable(i)) && !!seen.add(stable(i)));
};

export function parseGrantManagement(action: unknown, grantId: unknown): { ok: true; value: { action: string; grantId?: string } | null } | { ok: false; message: string } {
  const hasAction = action !== undefined && action !== null && action !== '';
  const hasId = grantId !== undefined && grantId !== null && grantId !== '';
  if (!hasAction) return hasId ? { ok: false, message: 'grant_id requires grant_management_action.' } : { ok: true, value: null };
  if (typeof action !== 'string' || !['create', 'merge', 'replace'].includes(action)) return { ok: false, message: 'grant_management_action must be one of create, merge, replace.' };
  if (action === 'create') return hasId ? { ok: false, message: 'grant_id must not be sent with grant_management_action=create.' } : { ok: true, value: { action } };
  if (typeof grantId !== 'string' || !grantId || grantId.length > 128) return { ok: false, message: `grant_id is required with grant_management_action=${action}.` };
  return { ok: true, value: { action, grantId } };
}
const widens = (cur: Content, req: Content): boolean => {
  const held = new Set(cur.scopes);
  const have = new Set((cur.details ?? []).map(stable));
  return req.scopes.some((s) => !held.has(s)) || (req.details ?? []).some((d) => !have.has(stable(d)));
};
function planChange(action: string, cur: Content, req: Content): { ok: true; content: Content; widens: boolean } | { ok: false; error: string; message: string } {
  const w = widens(cur, req);
  if (action === 'replace') return { ok: true, content: req, widens: w };
  const details = dedupe([...(cur.details ?? []), ...(req.details ?? [])]);
  return { ok: true, widens: w, content: { scopes: [...new Set([...cur.scopes, ...req.scopes])], details: details.length ? details : null } };
}
const contentOf = (m: Managed): Content => ({ scopes: m.scopes, details: m.details });

/** The grant a merge or replace names: this client's and this user's, and still active; else the refusal. */
export function managedFor(e: Engine, id: string, clientId: string, userId: string): Managed | undefined {
  const m = adv(e).managed.get(id);
  return m && m.status === 'active' && m.clientId === clientId && m.userId === userId ? m : undefined;
}
/** Would this request add anything to the grant it names (so the user must see the consent screen again)? */
export function gmWidens(gm: { action: string; grantId?: string }, m: Managed | undefined, scope: string[], details: unknown[] | null): boolean {
  return !!m && gm.action !== 'create' && widens(contentOf(m), { scopes: scope, details });
}
export function gmValid(e: Engine, gm: { action: string; grantId?: string } | null, clientId: string, userId: string): string | null {
  return gm && gm.action !== 'create' && !managedFor(e, gm.grantId!, clientId, userId) ? 'The grant_id does not name an active grant of this client and user.' : null;
}

/** Apply the create / merge / replace a redeemed code carried; the grant's tokens are issued for the result. */
export function applyGrantManagement(e: Engine, grant: Grant, gm: { action: string; grantId?: string }): { error: string; message: string } | null {
  const now = e.clock.now();
  const req: Content = { scopes: grant.scope, details: grant.details ?? null };
  const a = adv(e);
  if (gm.action === 'create') {
    const m: Managed = { id: e.db.newId('ogm'), clientId: grant.clientId, userId: grant.userId!, scopes: req.scopes, details: req.details, status: 'active', revision: 1, createdAt: now, updatedAt: now };
    a.managed.set(m.id, m);
    grant.managedId = m.id;
    return null;
  }
  const m = managedFor(e, gm.grantId!, grant.clientId, grant.userId ?? '');
  if (!m) return { error: 'invalid_grant', message: 'The grant is no longer active.' };
  const plan = planChange(gm.action, contentOf(m), req);
  if (!plan.ok) return plan;
  m.scopes = plan.content.scopes;
  m.details = plan.content.details;
  m.revision++;
  m.updatedAt = now;
  grant.managedId = m.id;
  grant.scope = m.scopes;
  grant.details = m.details;
  if (gm.action === 'replace') clampLinked(e, m);
  return null;
}
/** After a grant shrank: the refresh grants minted under it may no longer mint more than it holds. */
function clampLinked(e: Engine, m: Managed): void {
  for (const g of st(e).grants.values()) {
    if (g.managedId !== m.id || g.revoked) continue;
    g.scope = g.scope.filter((s) => m.scopes.includes(s));
    g.details = m.details;
  }
}

const presentGrant = (m: Managed): Obj => ({
  grant_id: m.id,
  client_id: m.clientId,
  status: m.status,
  scopes: m.scopes.map((scope) => ({ scope })),
  ...(m.details && m.details.length ? { authorization_details: m.details } : {}),
  revision: m.revision,
  created_at: m.createdAt,
  updated_at: m.updatedAt,
});

// ── signed request objects (RFC 9101) ──────────────────────────────

export const REQUEST_OBJECT_PARAMS = ['response_type', 'redirect_uri', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'audience', 'resource', 'response_mode', 'grant_management_action', 'grant_id'];
type Loaded = { ok: true; claims: Obj } | { ok: false; error: 'invalid_request_object' | 'invalid_request_uri' | 'invalid_request'; description: string };
const lf = (error: 'invalid_request_object' | 'invalid_request_uri' | 'invalid_request', description: string): Loaded => ({ ok: false, error, description });

/** Load and verify the request object a client sends by value (`request`) or by reference (a registered https `request_uri`). */
export async function loadRequestObject(e: Engine, client: Obj, input: { request?: string; requestUri?: string }): Promise<Loaded> {
  const doFetch = e.options.fetch ?? fetch;
  let raw = input.request;
  if (input.requestUri) {
    if (!(Array.isArray(client.request_uris) ? client.request_uris : []).includes(input.requestUri)) return lf('invalid_request_uri', 'The request_uri is not registered for this client.');
    try {
      const res = await doFetch(input.requestUri, { headers: { accept: 'application/oauth-authz-req+jwt, application/jwt, */*' } });
      if (!res.ok) return lf('invalid_request_uri', 'The request_uri could not be fetched.');
      const text = (await res.text()).trim();
      if (!text || text.length > 64 * 1024) return lf('invalid_request_uri', 'The request_uri document has an unusable size.');
      raw = text;
    } catch {
      return lf('invalid_request_uri', 'The request_uri could not be fetched.');
    }
  }
  if (!raw) return lf('invalid_request', 'No request object was sent.');
  // A 5-part compact serialization is a JWE addressed to the emulator's published encryption key; the signed JWT is inside it.
  if (raw.split('.').length === 5) {
    await ensureRegisteredEncryptionKeys(e);
    const inner = await e.tokens.decryptEncrypted(raw);
    if (!inner) return lf('invalid_request_object', 'The encrypted request object could not be decrypted.');
    raw = inner;
  } else if (client.request_object_encryption_alg) {
    return lf('invalid_request_object', 'This client registered request object encryption; the request object must be encrypted.');
  }
  const d = decodeJwt(raw);
  if (!d) return lf('invalid_request_object', 'The request object is malformed.');
  const alg = String(d.header.alg ?? '');
  if (!REQUEST_OBJECT_ALGS.includes(alg)) return lf('invalid_request_object', 'The request object must be signed with an asymmetric algorithm.');
  if (client.request_object_signing_alg && client.request_object_signing_alg !== alg) return lf('invalid_request_object', 'The request object algorithm is not the one this client registered.');
  let keys: Obj[] = Array.isArray(client.jwks?.keys) ? client.jwks.keys : [];
  if (!keys.length && client.jwks_uri) {
    try {
      const res = await doFetch(client.jwks_uri);
      keys = res.ok ? ((await res.json()) as any).keys ?? [] : [];
    } catch {
      keys = [];
    }
  }
  const cands = keys.filter((k) => k.use !== 'enc' && (!d.header.kid || k.kid === d.header.kid));
  if (!cands.length) return lf('invalid_request_object', 'This client has no registered keys for a signed request object.');
  let verified = false;
  for (const k of cands) if ((verified = await verifyJws(d, k))) break;
  const nowS = e.clock.now() / 1000;
  const c = d.payload;
  if (!verified || (typeof c.exp === 'number' && c.exp + 5 <= nowS) || (typeof c.nbf === 'number' && c.nbf - 5 > nowS)) return lf('invalid_request_object', 'The signed request object is invalid.');
  const aud = c.aud === undefined ? [] : Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== undefined && c.iss !== client.id) return lf('invalid_request_object', 'The request object iss is not the client_id.');
  if (aud.length && !aud.includes(e.issuer)) return lf('invalid_request_object', 'The request object aud is not this issuer.');
  if (c.client_id !== undefined && c.client_id !== client.id) return lf('invalid_request_object', 'The request object client_id does not match.');
  return { ok: true, claims: c };
}

// ── client metadata (registration and the management endpoint) ──────

const isHttps = (u: string): boolean => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};
const loopback = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
/** https, or http on a loopback host (any port); a public native client may also use a private-use scheme; never a fragment. */
const validRedirect = (uri: string, allowNative: boolean): boolean => {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback(u.hostname))) return true;
  return allowNative && /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['http:', 'javascript:', 'data:', 'file:'].includes(u.protocol);
};
const registrable = (uri: string): boolean => {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
};
const PRIVATE_JWK = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/** The client-key and OIDC metadata fields on a create / update body; only the keys present are returned. Messages follow the real validator. */
export function parseClientMeta(body: Obj): { ok: true; value: Obj } | { ok: false; message: string } {
  const out: Obj = {};
  const bad = (message: string) => ({ ok: false as const, message });
  if (body.jwks !== undefined) {
    const j = body.jwks;
    if (j === null) out.jwks = null;
    else {
      if (typeof j !== 'object' || !Array.isArray(j.keys) || !j.keys.length || j.keys.length > 20) return bad('jwks must be a JWK Set ({ keys: [...] }) of 1 to 20 keys.');
      for (const k of j.keys) {
        if (typeof k !== 'object' || k === null || typeof k.kty !== 'string') return bad('Each jwks key must be a JWK with a kty.');
        if (PRIVATE_JWK.some((p) => p in k)) return bad('jwks must hold public keys only; remove the private parameters.');
      }
      out.jwks = { keys: j.keys };
    }
  }
  if (body.jwks_uri !== undefined) {
    if (body.jwks_uri === null || body.jwks_uri === '') out.jwks_uri = null;
    else if (typeof body.jwks_uri !== 'string' || !isHttps(body.jwks_uri) || body.jwks_uri.length > 2048 || new URL(body.jwks_uri).hash) return bad('jwks_uri must be an absolute https URL.');
    else out.jwks_uri = body.jwks_uri;
  }
  if (out.jwks && out.jwks_uri) return bad('Register jwks or jwks_uri, not both.');
  if (body.request_object_signing_alg !== undefined) {
    const v = body.request_object_signing_alg;
    if (v === null) out.request_object_signing_alg = null;
    else if (typeof v !== 'string' || !REQUEST_OBJECT_ALGS.includes(v)) return bad(`request_object_signing_alg must be one of: ${REQUEST_OBJECT_ALGS.join(', ')}.`);
    else out.request_object_signing_alg = v;
  }
  if (body.require_signed_request_object !== undefined) {
    if (typeof body.require_signed_request_object !== 'boolean') return bad('require_signed_request_object must be true or false.');
    out.require_signed_request_object = body.require_signed_request_object;
  }
  if (body.response_types !== undefined) {
    const rt = body.response_types;
    if (!Array.isArray(rt) || !rt.length || rt.length > 6 || !rt.every((x) => typeof x === 'string')) return bad('response_types must be a non-empty array of strings.');
    const canon: string[] = [];
    for (const r of rt) {
      const c = r.split(' ').filter(Boolean).sort((a: string, b: string) => RT_ORDER.indexOf(a) - RT_ORDER.indexOf(b)).join(' ');
      if (!RESPONSE_TYPES_SUPPORTED.includes(c)) return bad(`Unsupported response_type: ${r}.`);
      if (!canon.includes(c)) canon.push(c);
    }
    out.response_types = canon;
  }
  if (body.request_uris !== undefined) {
    const ru = body.request_uris;
    if (ru === null) out.request_uris = null;
    else if (!Array.isArray(ru) || ru.length > 20 || !ru.every((u) => typeof u === 'string' && isHttps(u))) return bad('request_uris must be an array of at most 20 absolute https URIs.');
    else out.request_uris = ru;
  }
  const extra = parseExtraClientFields(body);
  if (!extra.ok) return bad(extra.message);
  Object.assign(out, extra.value);
  return { ok: true, value: out };
}

/** Whether every response type the client holds is covered by its grant types (OIDC Registration section 2). */
export function responseTypeProblem(responseTypes: string[], grantTypes: string[]): string | null {
  for (const rt of responseTypes) {
    const parts = rt.split(' ');
    if (parts.includes('code') && !grantTypes.includes('authorization_code')) return `response_type "${rt}" needs the authorization_code grant_type.`;
    if ((parts.includes('id_token') || parts.includes('token')) && !grantTypes.includes('implicit')) return `response_type "${rt}" needs the implicit grant_type.`;
  }
  return null;
}

// ── handlers ───────────────────────────────────────────────────────

export function oauthAdvHandlers(): RouteDef[] {
  const tokenErr = (status: number, error: string, description: string, headers: Record<string, string> = {}): Reply => ({ status, body: { error, error_description: description }, headers: { ...NO_STORE, ...headers } });
  const bearerOf = (c: RouteContext): string | undefined => /^Bearer\s+(.+)$/i.exec(c.request.headers.get('authorization') ?? '')?.[1]?.trim();

  /** The client's own registration, found by the Bearer registration_access_token; one 401 for every reason it cannot be reached. */
  const regClient = (c: RouteContext): { client: Obj } | { error: Reply } => {
    const client = c.engine.db.oauthClients.get(c.params.clientId);
    const bearer = bearerOf(c);
    if (!bearer || !client || client.deleted || !client.registration_access_token || client.registration_access_token !== bearer) return { error: tokenErr(401, 'invalid_token', 'Invalid registration access token.') };
    return { client };
  };
  const clientView = (c: Obj): Obj => ({
    client_id: c.id,
    client_id_issued_at: Math.floor(c.created_at / 1000),
    client_secret_expires_at: c.secret_expires_at ? Math.floor(c.secret_expires_at / 1000) : 0,
    redirect_uris: c.redirect_uris,
    grant_types: c.grant_types,
    response_types: clientResponseTypes(c),
    token_endpoint_auth_method: c.auth_method,
    scope: (c.allowed_scopes ?? []).join(' '),
    client_name: c.name,
    ...(c.logo_uri ? { logo_uri: c.logo_uri } : {}),
    ...(c.jwks ? { jwks: c.jwks } : {}),
    ...(c.jwks_uri ? { jwks_uri: c.jwks_uri } : {}),
    ...(c.request_uris ? { request_uris: c.request_uris } : {}),
    ...(c.request_object_signing_alg ? { request_object_signing_alg: c.request_object_signing_alg } : {}),
    ...(c.require_signed_request_object !== undefined ? { require_signed_request_object: c.require_signed_request_object } : {}),
    ...clientExtras(c),
  });
  const dropClient = (e: Engine, row: Obj): void => {
    row.deleted = true;
    for (const g of st(e).grants.values()) if (g.clientId === row.id) revokeGrant(e, g);
  };

  // ── UMA helpers ──
  const umaOn = (e: Engine) => adv(e).cfg.uma_enabled;
  const umaErr = (status: number, code: string, message: string, headers: Record<string, string> = {}): Reply => ({ status, body: { errors: [{ code, message }] }, headers });
  const umaView = (r: UmaRes): Obj => ({ _id: r.id, name: r.name, ...(r.type ? { type: r.type } : {}), ...(r.uri ? { uri: r.uri } : {}), ...(r.iconUri ? { icon_uri: r.iconUri } : {}), resource_scopes: r.scopes, ...(r.owner ? { owner: r.owner } : {}), owner_approval: false });
  const parseRes = (b: Obj): { value: Partial<UmaRes> } | { error: Reply } => {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 200) return { error: umaErr(400, 'VALIDATION_FAILED', 'name is required (at most 200 characters).') };
    for (const k of ['type', 'uri', 'icon_uri']) if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== 'string' || b[k].length > 2000)) return { error: umaErr(400, 'VALIDATION_FAILED', `${k} must be a string.`) };
    const s = b.resource_scopes ?? [];
    if (!Array.isArray(s) || s.length > 100 || s.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9._:\-/]+$/.test(x))) return { error: umaErr(400, 'VALIDATION_FAILED', 'resource_scopes must be an array of scope strings.') };
    return { value: { name: b.name, type: b.type ?? undefined, uri: b.uri ?? undefined, iconUri: b.icon_uri ?? undefined, scopes: [...new Set(s as string[])], ...(typeof b.owner === 'string' && b.owner ? { owner: b.owner } : {}) } };
  };
  /** The protection API needs a PAT: a bearer access token with `uma_protection` from a confidential client. */
  const rsFor = async (c: RouteContext): Promise<{ client: Obj; patUser: string | null } | { error: Reply }> => {
    const e = c.engine;
    if (!umaOn(e)) return { error: umaErr(404, 'NOT_FOUND', 'UMA is not enabled for this instance.') };
    const challenge = (error: string, status: number, message: string) => umaErr(status, error, message, { 'www-authenticate': `Bearer realm="uma", error="${error}", scope="${UMA_PROTECTION_SCOPE}"` });
    const bearer = bearerOf(c);
    if (!bearer) return { error: challenge('invalid_token', 401, 'The protection API requires a Protection API Access Token.') };
    const v = await e.tokens.verifyAny(bearer);
    const rec = v.ok && v.claims.token_use === 'access_token' ? st(e).access.get(String(v.claims.jti)) : undefined;
    if (!v.ok || !rec || rec.revoked) return { error: challenge('invalid_token', 401, 'The Protection API Access Token is invalid or expired.') };
    if (!rec.scope.includes(UMA_PROTECTION_SCOPE)) return { error: challenge('insufficient_scope', 403, `The token needs the ${UMA_PROTECTION_SCOPE} scope.`) };
    const client = e.db.oauthClients.get(rec.clientId);
    if (!client || client.deleted) return { error: challenge('invalid_token', 401, 'Unknown client.') };
    if (client.auth_method === 'none') return { error: challenge('invalid_token', 401, 'The protection API requires a confidential client.') };
    return { client, patUser: rec.userId };
  };
  const ownedRes = async (c: RouteContext): Promise<{ client: Obj; res: UmaRes } | { error: Reply }> => {
    const rs = await rsFor(c);
    if ('error' in rs) return rs;
    const res = adv(c.engine).uma.res.get(c.params.id ?? '');
    return res && res.clientId === rs.client.id ? { client: rs.client, res } : { error: umaErr(404, 'not_found', 'Unknown resource.') };
  };

  return [
    // ── emulator control ──
    {
      method: 'POST',
      pattern: '/__emulator/oauth/config',
      public: true,
      handler: (c) => {
        const cfg = adv(c.engine).cfg;
        for (const k of ['dynamic_registration', 'require_initial_access_token', 'uma_enabled'] as const) {
          if (c.body[k] === undefined) continue;
          if (typeof c.body[k] !== 'boolean') throw new EmulatorError('VALIDATION_FAILED', `${k} must be true or false.`, k);
          cfg[k] = c.body[k];
        }
        const types = c.body.authorization_details_types;
        if (types !== undefined) {
          if (!Array.isArray(types) || types.some((t) => typeof t !== 'string')) throw new EmulatorError('VALIDATION_FAILED', 'authorization_details_types must be a list of strings.', 'authorization_details_types');
          cfg.authorization_details_types = types;
        }
        const optional = c.body.optional_scopes;
        if (optional !== undefined) {
          if (!Array.isArray(optional) || optional.some((t) => typeof t !== 'string' || t === 'openid')) throw new EmulatorError('VALIDATION_FAILED', 'optional_scopes must be a list of scope names (never openid).', 'optional_scopes');
          cfg.optional_scopes = optional;
        }
        const ttl = c.body.dynamic_client_secret_ttl_seconds;
        if (ttl !== undefined) {
          if (!Number.isInteger(ttl) || ttl < 0) throw new EmulatorError('VALIDATION_FAILED', 'dynamic_client_secret_ttl_seconds must be a whole number of seconds (0 = no expiry).', 'dynamic_client_secret_ttl_seconds');
          cfg.dynamic_client_secret_ttl_seconds = ttl;
        }
        return { body: { ...cfg } };
      },
    },
    { method: 'GET', pattern: '/__emulator/oauth/config', public: true, handler: (c) => ({ body: { ...adv(c.engine).cfg } }) },
    {
      // The resource owner's sharing policy (set through an account page on the real provider): who may hold which scopes of a resource.
      method: 'POST',
      pattern: '/__emulator/oauth/uma/share',
      public: true,
      handler: (c) => {
        const res = adv(c.engine).uma.res.get(String(c.body.resource_id ?? ''));
        if (!res) throw new EmulatorError('NOT_FOUND', 'Unknown resource.');
        if (typeof c.body.user_id !== 'string' || !Array.isArray(c.body.scopes) || c.body.scopes.some((s: unknown) => typeof s !== 'string')) throw new EmulatorError('VALIDATION_FAILED', 'user_id and scopes are required.');
        res.shares.set(c.body.user_id, c.body.scopes);
        return { body: { ok: true } };
      },
    },

    // ── initial access tokens (RFC 7591 section 3), Backend API ──
    {
      method: 'GET',
      pattern: '/v1/oauth_initial_access_tokens',
      scope: 'oauth_clients:read',
      handler: (c) => ({ body: { object: 'list', data: [...adv(c.engine).iats.values()].sort((a, b) => b.createdAt - a.createdAt).map((t) => presentIat(c.engine, t)), has_more: false } }),
    },
    {
      method: 'POST',
      pattern: '/v1/oauth_initial_access_tokens',
      scope: 'oauth_clients:write',
      handler: (c) => {
        const e = c.engine;
        const b = c.body;
        const v = (m: string, p: string) => new EmulatorError('VALIDATION_FAILED', m, p);
        if (b.description !== undefined && b.description !== null && (typeof b.description !== 'string' || b.description.length > 200)) throw v('description must be a string of at most 200 characters.', 'description');
        const int = (k: string, lo: number, hi: number, msg: string): number | null => {
          if (b[k] === undefined || b[k] === null) return null;
          if (typeof b[k] !== 'number' || !Number.isInteger(b[k]) || b[k] < lo || b[k] > hi) throw v(msg, k);
          return b[k];
        };
        const ttl = int('expires_in_seconds', 60, 365 * 86400, 'expires_in_seconds must be a whole number of seconds from 60 to 31536000.');
        const maxUses = int('max_uses', 1, 1_000_000, 'max_uses must be a whole number from 1 to 1000000.');
        const owner = b.owner === undefined || b.owner === null ? null : typeof b.owner === 'string' && b.owner.trim() && b.owner.length <= 128 ? b.owner.trim() : undefined;
        if (owner === undefined) throw v('owner must be an Atlas user or organization id.', 'owner');
        let allowed: string[] | null = null;
        if (b.allowed_grant_types !== undefined && b.allowed_grant_types !== null) {
          const ok = ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'implicit'];
          if (!Array.isArray(b.allowed_grant_types) || !b.allowed_grant_types.length || !b.allowed_grant_types.every((x: unknown) => typeof x === 'string' && ok.includes(x))) throw v(`allowed_grant_types must be a non-empty list of: ${ok.join(', ')}.`, 'allowed_grant_types');
          allowed = [...new Set<string>(b.allowed_grant_types)];
        }
        if (b.https_redirects_only !== undefined && typeof b.https_redirects_only !== 'boolean') throw v('https_redirects_only must be true or false.', 'https_redirects_only');
        const maxClients = int('max_clients', 1, 10_000, 'max_clients must be a whole number from 1 to 10000.');
        if (maxClients !== null && !owner) throw v('max_clients needs an owner to count against.', 'max_clients');
        const now = e.clock.now();
        const row: Iat = { id: e.db.newId('oiat'), token: `oiat_${randomToken(24)}`, description: typeof b.description === 'string' ? b.description.trim() || null : null, owner, allowedGrantTypes: allowed, httpsRedirectsOnly: b.https_redirects_only === true, maxClients, maxUses, useCount: 0, expiresAt: ttl !== null ? now + ttl * 1000 : null, revokedAt: null, lastUsedAt: null, createdAt: now };
        adv(e).iats.set(row.id, row);
        return { status: 201, body: { ...presentIat(e, row), token: row.token, note: 'Copy the token now. Only a hash is stored, so it cannot be shown again.' } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/oauth_initial_access_tokens/:id',
      scope: 'oauth_clients:write',
      handler: (c) => {
        const row = adv(c.engine).iats.get(c.params.id ?? '');
        if (!row) throw new EmulatorError('NOT_FOUND', 'Unknown initial access token.');
        row.revokedAt ??= c.engine.clock.now();
        return { body: presentIat(c.engine, row) };
      },
    },

    // ── dynamic client registration (RFC 7591) ──
    {
      method: 'POST',
      pattern: '/oauth2/register',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const a = adv(e);
        if (!a.cfg.dynamic_registration) return fail(403, 'access_denied', 'Dynamic client registration is disabled on this server.');
        let body = c.body;
        // RFC 7591 section 2.3: claims of a statement signed by an approved publisher override the request's.
        if (body.software_statement !== undefined || dcrConfig(e).require_software_statement) {
          if (typeof body.software_statement !== 'string') return fail(400, 'invalid_software_statement', 'A software statement is required to register here.');
          const stmt = await verifySoftwareStatement(e, body.software_statement);
          if (!stmt.ok) return fail(400, stmt.error, stmt.message);
          body = { ...body, ...stmt.claims };
        }
        const presented = bearerOf(c);
        const iatErr = (d: string) => tokenErr(401, 'invalid_token', d, { 'www-authenticate': 'Bearer error="invalid_token"' });
        const uris = body.redirect_uris;
        if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string')) return fail(400, 'invalid_redirect_uri', 'redirect_uris is required and must be a non-empty array of strings.');
        if (body.application_type !== undefined && body.application_type !== 'native' && body.application_type !== 'web') return fail(400, 'invalid_client_metadata', 'application_type must be web or native.');
        const native = body.application_type === 'native';
        const method = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : native ? 'none' : 'client_secret_basic';
        if (!AUTH_METHODS.includes(method)) return fail(400, 'invalid_client_metadata', 'Unsupported token_endpoint_auth_method.');
        const isPublic = method === 'none';
        const meta = parseClientMeta(body);
        if (!meta.ok) return fail(400, 'invalid_client_metadata', meta.message);
        const keyedProblem = keyedClientProblem(method, meta.value.jwks, meta.value.jwks_uri);
        if (keyedProblem) return fail(400, 'invalid_client_metadata', keyedProblem);
        const badUri = uris.find((u: string) => !validRedirect(u, isPublic));
        if (badUri) return fail(400, 'invalid_redirect_uri', `Invalid redirect_uri: ${badUri}. It must be https or an http loopback address${isPublic ? ' or a private-use scheme' : ''}.`);
        // OIDC Registration section 2 / Core section 8: subject_type and its sector.
        const subject = await resolveSubject(e, { subject_type: body.subject_type, sector_identifier_uri: body.sector_identifier_uri, redirect_uris: uris, redirectUrisChanged: true });
        if (!subject.ok) return fail(400, 'invalid_client_metadata', subject.message);
        if (iatRequiredButMissing(a, presented)) return iatErr('An initial access token is required to register a client here.');
        const requested = (typeof body.scope === 'string' ? body.scope : 'openid profile email').split(' ').filter(Boolean);
        const unknownScopes = requested.filter((s) => !SUPPORTED_SCOPES.includes(s));
        if (unknownScopes.length) return fail(400, 'invalid_client_metadata', `Unsupported scope: ${unknownScopes.join(' ')}.`);
        const scopes = requested.length ? requested : ['openid', 'profile', 'email'];
        const grantTypes: string[] = Array.isArray(body.grant_types) && body.grant_types.every((g: unknown) => typeof g === 'string') ? body.grant_types : ['authorization_code', 'refresh_token'];
        const unknownGrants = grantTypes.filter((g) => !['authorization_code', 'refresh_token', 'implicit'].includes(g));
        if (unknownGrants.length) return fail(400, 'invalid_client_metadata', `Unsupported grant_types: ${unknownGrants.join(' ')}.`);
        const responseTypes = clientResponseTypes(meta.value);
        const rtProblem = responseTypeProblem(responseTypes, grantTypes);
        if (rtProblem) return fail(400, 'invalid_client_metadata', rtProblem);
        const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name : 'Dynamically Registered Client';
        const logo = typeof body.logo_uri === 'string' ? body.logo_uri : null;
        let postLogout: string[] = [];
        if (body.post_logout_redirect_uris !== undefined) {
          const p = body.post_logout_redirect_uris;
          if (!Array.isArray(p) || !p.every((u) => typeof u === 'string')) return fail(400, 'invalid_client_metadata', 'post_logout_redirect_uris must be an array of strings.');
          const bad = p.find((u) => !registrable(u));
          if (bad) return fail(400, 'invalid_client_metadata', `post_logout_redirect_uri must be an absolute https URI (or http://localhost): ${bad}`);
          postLogout = p;
        }
        let claimsUris: string[] = [];
        if (body.claims_redirect_uris !== undefined) {
          const r = body.claims_redirect_uris;
          if (!Array.isArray(r) || r.length > 20 || !r.every((u) => typeof u === 'string') || r.some((u) => !registrable(u))) return fail(400, 'invalid_client_metadata', 'claims_redirect_uris must be an array of absolute https URIs (or http://localhost).');
          claimsUris = r;
        }
        const logoutUri = (k: 'backchannel_logout_uri' | 'frontchannel_logout_uri'): string | null | undefined => {
          const v = body[k];
          return typeof v === 'string' && v ? (registrable(v) ? v : undefined) : null;
        };
        const bcl = logoutUri('backchannel_logout_uri');
        if (bcl === undefined) return fail(400, 'invalid_client_metadata', 'backchannel_logout_uri must be an absolute https URI (or http://localhost).');
        const fcl = logoutUri('frontchannel_logout_uri');
        if (fcl === undefined) return fail(400, 'invalid_client_metadata', 'frontchannel_logout_uri must be an absolute https URI (or http://localhost).');
        const now = e.clock.now();
        // A presented token is spent only once the registration is otherwise valid, so a malformed request never burns a use.
        const iat = presented ? [...a.iats.values()].find((t) => t.token === presented) : undefined;
        if (iat) {
          const badGrant = iat.allowedGrantTypes ? grantTypes.find((g) => !iat.allowedGrantTypes!.includes(g)) : undefined;
          if (badGrant) return fail(400, 'invalid_client_metadata', `grant_type ${badGrant} is not allowed for this developer.`);
          const insecure = iat.httpsRedirectsOnly ? uris.find((u: string) => !u.startsWith('https://')) : undefined;
          if (insecure) return fail(400, 'invalid_redirect_uri', `redirect_uri ${insecure} must use https.`);
          if (iat.owner && iat.maxClients != null && e.db.oauthClients.filter((x) => !x.deleted && x.owner === iat.owner).length >= iat.maxClients) return fail(400, 'invalid_client_metadata', `This developer already holds the maximum of ${iat.maxClients} clients.`);
        }
        if (presented) {
          if (!iat || iat.revokedAt !== null || (iat.expiresAt !== null && iat.expiresAt <= now) || (iat.maxUses !== null && iat.useCount >= iat.maxUses)) return iatErr('The initial access token is invalid, expired, revoked or used up.');
          iat.useCount++;
          iat.lastUsedAt = now;
        }
        const id = `client_${randomToken(16)}`;
        const secret = isPublic || method === 'private_key_jwt' ? undefined : `oacs_${randomToken(24)}`;
        const ttl = a.cfg.dynamic_client_secret_ttl_seconds;
        const secretExpires = secret && ttl > 0 ? now + ttl * 1000 : null;
        const rat = `oarat_${randomToken(24)}`;
        const row = e.db.oauthClients.insert({
          id,
          name,
          redirect_uris: uris,
          allowed_scopes: scopes,
          grant_types: grantTypes,
          auth_method: method,
          first_party: false,
          post_logout_redirect_uris: postLogout,
          claims_redirect_uris: claimsUris,
          backchannel_logout_uri: bcl,
          frontchannel_logout_uri: fcl,
          logo_uri: logo,
          secret,
          secret_expires_at: secretExpires,
          registration_access_token: rat,
          owner: iat?.owner ?? null,
          dynamic: true,
          ...stripNulls(meta.value),
          ...subject.value,
          created_at: now,
          updated_at: now,
        });
        e.changed({ type: 'oauth_client.created', data: { object: 'oauth_client', id: row.id, client_id: row.id, name } });
        return {
          status: 201,
          headers: NO_STORE,
          body: {
            id,
            ...clientView(row),
            application_type: native ? 'native' : 'web',
            post_logout_redirect_uris: postLogout,
            ...(claimsUris.length ? { claims_redirect_uris: claimsUris } : {}),
            backchannel_logout_session_required: body.backchannel_logout_session_required === true,
            frontchannel_logout_session_required: body.frontchannel_logout_session_required === true,
            ...(bcl ? { backchannel_logout_uri: bcl } : {}),
            ...(fcl ? { frontchannel_logout_uri: fcl } : {}),
            ...(secret ? { client_secret: secret } : {}),
            ...(row.owner ? { owner: row.owner } : {}),
            status: 'approved',
            registration_access_token: rat,
            registration_client_uri: `${e.issuer}/oauth2/register/${id}`,
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/oauth2/register/:clientId',
      public: true,
      handler: (c) => {
        const r = regClient(c);
        return 'error' in r ? r.error : { body: clientView(r.client), headers: { 'cache-control': 'no-store' } };
      },
    },
    {
      method: 'PUT',
      pattern: '/oauth2/register/:clientId',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const r = regClient(c);
        if ('error' in r) return r.error;
        const client = r.client;
        const body = c.body;
        const patch: Obj = {};
        if (Array.isArray(body.redirect_uris)) {
          const uris = body.redirect_uris.filter((u: unknown): u is string => typeof u === 'string');
          const native = client.auth_method === 'none';
          if (!uris.length || uris.some((u: string) => !validRedirect(u, native))) return fail(400, 'invalid_redirect_uri', `redirect_uris must be non-empty and each be https or an http loopback address${native ? ' or a private-use scheme' : ''}.`);
          patch.redirect_uris = uris;
        }
        if (typeof body.client_name === 'string' && body.client_name.trim()) patch.name = body.client_name;
        if (typeof body.logo_uri === 'string') patch.logo_uri = body.logo_uri;
        const meta = parseClientMeta(body);
        if (!meta.ok) return fail(400, 'invalid_client_metadata', meta.message);
        if ((meta.value.jwks && client.jwks_uri && meta.value.jwks_uri === undefined) || (meta.value.jwks_uri && client.jwks && meta.value.jwks === undefined)) return fail(400, 'invalid_client_metadata', 'Register jwks or jwks_uri, not both.');
        Object.assign(patch, meta.value);
        const keyed = keyedClientProblem(client.auth_method, (patch.jwks !== undefined ? patch.jwks : client.jwks), (patch.jwks_uri !== undefined ? patch.jwks_uri : client.jwks_uri));
        if (keyed) return fail(400, 'invalid_client_metadata', keyed);
        if (body.subject_type !== undefined || body.sector_identifier_uri !== undefined || patch.redirect_uris) {
          const subject = await resolveSubject(e, { subject_type: body.subject_type, sector_identifier_uri: body.sector_identifier_uri, redirect_uris: (patch.redirect_uris ?? client.redirect_uris) as string[], redirectUrisChanged: patch.redirect_uris !== undefined, existing: client, publisherSector: publisherSectorOf(e, client) });
          if (!subject.ok) return fail(400, 'invalid_client_metadata', subject.message);
          Object.assign(patch, subject.value);
        }
        if (typeof body.scope === 'string') {
          const req = body.scope.split(' ').filter(Boolean);
          const unknown = req.filter((s: string) => !SUPPORTED_SCOPES.includes(s));
          if (unknown.length) return fail(400, 'invalid_client_metadata', `Unsupported scope: ${unknown.join(' ')}.`);
          if (req.length) patch.allowed_scopes = req;
        }
        const problem = responseTypeProblem(clientResponseTypes({ ...client, ...patch }), client.grant_types);
        if (problem) return fail(400, 'invalid_client_metadata', problem);
        Object.assign(client, patch, { updated_at: e.clock.now() });
        e.changed({ type: 'oauth_client.updated', data: { object: 'oauth_client', id: client.id, client_id: client.id, name: client.name } });
        return { body: clientView(client), headers: { 'cache-control': 'no-store' } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/oauth2/register/:clientId',
      public: true,
      handler: (c) => {
        const r = regClient(c);
        if ('error' in r) return r.error;
        dropClient(c.engine, r.client);
        c.engine.changed({ type: 'oauth_client.deleted', data: { object: 'oauth_client', id: r.client.id, deleted: true } });
        return { status: 204 };
      },
    },
    {
      // Rotate the client's own secret with its registration_access_token; the old secret keeps working for the usual overlap.
      method: 'POST',
      pattern: '/oauth2/register/:clientId/secret',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const r = regClient(c);
        if ('error' in r) return r.error;
        const client = r.client;
        if (client.auth_method === 'none') return fail(400, 'invalid_request', 'This client has no secret to rotate.');
        const now = e.clock.now();
        const ttl = adv(e).cfg.dynamic_client_secret_ttl_seconds;
        client.previous_secret = client.secret;
        client.previous_until = now + 86_400_000;
        client.secret = `oacs_${randomToken(24)}`;
        client.secret_expires_at = ttl > 0 ? now + ttl * 1000 : null;
        client.updated_at = now;
        return { headers: NO_STORE, body: { client_id: client.id, client_secret: client.secret, client_secret_expires_at: client.secret_expires_at ? Math.floor(client.secret_expires_at / 1000) : 0 } };
      },
    },

    // ── RP-initiated logout (end_session_endpoint) ──
    ...(['GET', 'POST'] as const).map((method): RouteDef => ({ method, pattern: '/oauth2/logout', public: true, handler: (c) => logout(c) })),

    // ── grant management ──
    ...(
      [
        ['GET', GRANT_QUERY_SCOPE],
        ['DELETE', GRANT_REVOKE_SCOPE],
        ['PATCH', GRANT_REVOKE_SCOPE],
      ] as const
    ).map(
      ([method, needed]): RouteDef => ({
        method,
        pattern: '/oauth2/grants/:id',
        public: true,
        handler: async (c) => {
          const e = c.engine;
          const presented = /^(Bearer|DPoP)\s+(.+)$/i.exec(c.request.headers.get('authorization') ?? '');
          const scheme = presented?.[1] ?? 'Bearer';
          const err = (status: number, error: string, d: string) => tokenErr(status, error, d, { 'www-authenticate': `${scheme} error="${error}"` });
          if (!presented) return err(401, 'invalid_request', 'A Bearer or DPoP access token is required.');
          const chk = await checkResourceToken(c, presented[2]!, presented[1]!);
          if ('error' in chk) return err(401, 'invalid_token', chk.message);
          const rec = chk.rec;
          if (!rec.scope.includes(needed)) return err(403, 'insufficient_scope', `The access token needs the ${needed} scope.`);
          const m = adv(e).managed.get(c.params.id ?? '');
          const client = e.db.oauthClients.get(rec.clientId);
          // The same answer for missing, revoked and someone else's, so ids cannot be probed.
          if (!m || !client || m.status !== 'active' || m.clientId !== client.id || (rec.userId !== null && rec.userId !== m.userId)) return tokenErr(404, 'invalid_grant', 'Unknown grant.');
          if (method === 'GET') return { body: presentGrant(m), headers: NO_STORE };
          if (method === 'DELETE') {
            m.status = 'revoked';
            m.updatedAt = e.clock.now();
            for (const g of st(e).grants.values()) {
              if (g.managedId !== m.id || g.revoked) continue;
              revokeGrant(e, g);
              e.webhooks.emit('grant.revoked', { object: 'grant', id: g.id, client_id: client.id, user_id: g.userId, organization_id: null, session_ids: [] });
            }
            return { status: 204, headers: NO_STORE };
          }
          // PATCH: the client trims its own grant; it never widens it.
          const b = c.body;
          const scopes = b.scopes === undefined ? undefined : Array.isArray(b.scopes) && b.scopes.every((s: unknown) => typeof s === 'string') ? (b.scopes as string[]) : null;
          const details = b.authorization_details === undefined ? undefined : Array.isArray(b.authorization_details) ? (b.authorization_details as unknown[]) : null;
          if (scopes === null || details === null || (scopes === undefined && details === undefined)) return fail(400, 'invalid_request', 'Send scopes (array of strings) and/or authorization_details (array).');
          const next = scopes ?? m.scopes;
          const extra = next.filter((s) => !m.scopes.includes(s));
          if (extra.length) return fail(400, 'invalid_request', `A grant can only be narrowed. Sending the user through authorization with grant_management_action=merge is the way to add: ${extra.join(' ')}.`);
          let nextDetails = m.details;
          if (details !== undefined) {
            const have = new Set((m.details ?? []).map(stable));
            if (details.some((d) => !have.has(stable(d)))) return fail(400, 'invalid_request', 'A grant can only be narrowed; authorization_details cannot gain entries.');
            nextDetails = details.length ? details : null;
          }
          if (!next.length) return fail(400, 'invalid_request', 'A grant cannot be narrowed to nothing; revoke it instead.');
          m.scopes = [...new Set(next)];
          m.details = nextDetails;
          m.revision++;
          m.updatedAt = e.clock.now();
          clampLinked(e, m);
          return { body: presentGrant(m), headers: NO_STORE };
        },
      }),
    ),

    // ── UMA 2.0 ──
    {
      method: 'GET',
      pattern: '/.well-known/uma2-configuration',
      public: true,
      handler: (c) => {
        const e = c.engine;
        if (!umaOn(e)) return umaErr(404, 'NOT_FOUND', 'UMA is not enabled for this instance.');
        const iss = e.issuer;
        return {
          headers: { 'cache-control': 'public, max-age=3600' },
          body: {
            issuer: iss,
            authorization_endpoint: `${iss}/oauth2/authorize`,
            token_endpoint: `${iss}/oauth2/token`,
            jwks_uri: `${iss}/.well-known/jwks.json`,
            introspection_endpoint: `${iss}/oauth2/introspect`,
            revocation_endpoint: `${iss}/oauth2/revoke`,
            resource_registration_endpoint: `${iss}/oauth2/uma/resource_set`,
            permission_endpoint: `${iss}/oauth2/uma/permission`,
            claims_interaction_endpoint: `${iss}/oauth2/uma/claims`,
            grant_types_supported: [UMA_GRANT, 'client_credentials', 'authorization_code', 'refresh_token'],
            uma_profiles_supported: [],
            pat_profiles_supported: ['bearer'],
            claim_token_format: [ID_TOKEN_FORMAT, ACCESS_TOKEN_FORMAT],
            claim_token_profiles_supported: [ID_TOKEN_FORMAT, ACCESS_TOKEN_FORMAT],
            scopes_supported: [UMA_PROTECTION_SCOPE],
            response_types_supported: ['code'],
            response_modes_supported: ['query'],
            code_challenge_methods_supported: ['S256'],
            subject_types_supported: ['public', 'pairwise'],
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'private_key_jwt'],
            introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'private_key_jwt'],
            ...(adv(e).cfg.dynamic_registration ? { registration_endpoint: `${iss}/oauth2/register` } : {}),
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: '/oauth2/uma/resource_set',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const rs = await rsFor(c);
        if ('error' in rs) return rs.error;
        const p = parseRes(c.body);
        if ('error' in p) return p.error;
        const id = e.db.newId('umar');
        adv(e).uma.res.set(id, { id, clientId: rs.client.id, name: '', scopes: [], ...p.value, ...(p.value.owner === undefined && rs.patUser ? { owner: rs.patUser } : {}), shares: new Map() } as UmaRes);
        return { status: 201, headers: { location: `${e.issuer}/oauth2/uma/resource_set/${id}` }, body: { _id: id } };
      },
    },
    {
      method: 'GET',
      pattern: '/oauth2/uma/resource_set',
      public: true,
      handler: async (c) => {
        const rs = await rsFor(c);
        return 'error' in rs ? rs.error : { body: [...adv(c.engine).uma.res.values()].filter((r) => r.clientId === rs.client.id).map((r) => r.id) };
      },
    },
    { method: 'GET', pattern: '/oauth2/uma/resource_set/:id', public: true, handler: async (c) => { const o = await ownedRes(c); return 'error' in o ? o.error : { body: umaView(o.res) }; } },
    {
      method: 'PUT',
      pattern: '/oauth2/uma/resource_set/:id',
      public: true,
      handler: async (c) => {
        const o = await ownedRes(c);
        if ('error' in o) return o.error;
        const p = parseRes(c.body);
        if ('error' in p) return p.error;
        Object.assign(o.res, p.value);
        return { body: umaView(o.res) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/oauth2/uma/resource_set/:id',
      public: true,
      handler: async (c) => {
        const o = await ownedRes(c);
        if ('error' in o) return o.error;
        adv(c.engine).uma.res.delete(o.res.id);
        return { status: 204 };
      },
    },
    {
      // The resource server asks for a permission ticket for what a client wants to reach.
      method: 'POST',
      pattern: '/oauth2/uma/permission',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const rs = await rsFor(c);
        if ('error' in rs) return rs.error;
        const raw: unknown = c.body;
        const list = Array.isArray(raw) ? raw : [raw];
        if (!list.length || list.length > 50) return umaErr(400, 'VALIDATION_FAILED', 'Between 1 and 50 permissions are required.');
        const perms: Array<{ resource_id: string; resource_scopes: string[] }> = [];
        for (const p of list as Obj[]) {
          const res = typeof p?.resource_id === 'string' ? adv(e).uma.res.get(p.resource_id) : undefined;
          if (!res || res.clientId !== rs.client.id) return umaErr(400, 'invalid_resource_id', 'Unknown resource_id.');
          const s = p.resource_scopes ?? [];
          if (!Array.isArray(s) || s.some((x) => typeof x !== 'string' || !res.scopes.includes(x))) return umaErr(400, 'invalid_scope', `resource_scopes must be scopes registered on ${res.id}.`);
          perms.push({ resource_id: res.id, resource_scopes: [...new Set(s as string[])] });
        }
        const ticket = randomToken(32);
        adv(e).uma.tickets.set(ticket, { clientId: rs.client.id, perms, expiresAt: e.clock.now() + UMA_TICKET_TTL_MS });
        return { status: 201, body: { ticket } };
      },
    },
    {
      // Claims gathering: the emulator signs in the requesting party (login_hint, else the emulator user, else the only user) and returns them to the claims redirect URI with a new ticket bound to them.
      method: 'GET',
      pattern: '/oauth2/uma/claims',
      public: true,
      handler: (c) => {
        const e = c.engine;
        if (!umaOn(e)) return umaErr(404, 'NOT_FOUND', 'UMA is not enabled for this instance.');
        const bad = (m: string): Reply => ({ ...page(`<h1>This request cannot continue</h1><p>${esc(m)}</p>`), status: 400 });
        const client = e.db.oauthClients.get(c.query.get('client_id') ?? undefined);
        if (!client || client.deleted) return bad('The application is not recognised.');
        const registered: string[] = client.claims_redirect_uris ?? [];
        const redirect = c.query.get('claims_redirect_uri') ?? (registered.length === 1 ? registered[0] : undefined);
        if (!redirect || !registered.includes(redirect)) return bad('The claims redirect address is missing or not registered for this application.');
        const ticket = c.query.get('ticket') ?? '';
        const t = adv(e).uma.tickets.get(ticket);
        if (!t || t.expiresAt <= e.clock.now()) return bad('The access request has expired. Return to the application and start again.');
        const state = c.query.get('state') ?? undefined;
        if (state !== undefined && state.length > 1000) return bad('The state value is too long.');
        const go = (p: Record<string, string | undefined>): Reply => {
          const u = new URL(redirect);
          for (const [k, v] of Object.entries(p)) if (v !== undefined) u.searchParams.set(k, v);
          return { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } };
        };
        const hint = c.query.get('login_hint');
        const live = e.db.users.filter((u) => !u.deleted);
        const user = hint ? live.find((u) => u.id === hint || (u.emails as Obj[]).some((m) => m.email_address.toLowerCase() === hint.toLowerCase())) : st(e).autoUser ? live.find((u) => u.id === st(e).autoUser) : live.length === 1 ? live[0] : undefined;
        if (!user) return fail(400, 'login_required', 'No user to sign in. Pass login_hint or POST /__emulator/oauth/login.');
        if (c.query.get('emulator_decision') === 'deny') return go({ error: 'access_denied', state });
        adv(e).uma.tickets.delete(ticket);
        const next = randomToken(32);
        adv(e).uma.tickets.set(next, { ...t, userId: user.id, expiresAt: e.clock.now() + UMA_TICKET_TTL_MS });
        return go({ ticket: next, state });
      },
    },
  ];

  function presentIat(e: Engine, t: Iat): Obj {
    const now = e.clock.now();
    const status = t.revokedAt !== null ? 'revoked' : t.expiresAt !== null && t.expiresAt <= now ? 'expired' : t.maxUses !== null && t.useCount >= t.maxUses ? 'used_up' : 'active';
    return { object: 'oauth_initial_access_token', id: t.id, token_prefix: t.token.slice(0, 9), description: t.description, profile: null, owner: t.owner, allowed_grant_types: t.allowedGrantTypes, https_redirects_only: t.httpsRedirectsOnly, max_clients: t.maxClients, default_status: 'development', login_url: null, consent_url: null, status, max_uses: t.maxUses, use_count: t.useCount, expires_at: t.expiresAt, revoked_at: t.revokedAt, last_used_at: t.lastUsedAt, created_at: t.createdAt };
  }
}

const ID_TOKEN_FORMAT = 'http://openid.net/specs/openid-connect-core-1_0.html#IDToken';
const ACCESS_TOKEN_FORMAT = 'urn:ietf:params:oauth:token-type:access_token';
const UMA_TICKET_TTL_MS = 5 * 60_000;
const UMA_RPT_TTL_S = 300;
const iatRequiredButMissing = (a: Adv, presented: string | undefined): boolean => a.cfg.require_initial_access_token && !presented;
const stripNulls = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

// ── logout ───────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const page = (body: string): Reply => ({ status: 200, raw: `<!doctype html><html><body>${body}</body></html>`, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" } });
const hintAudience = (claims: Obj): string | undefined => {
  const aud = claims.aud;
  if (typeof aud === 'string') return aud;
  if (!Array.isArray(aud)) return undefined;
  if (typeof claims.azp === 'string' && aud.includes(claims.azp)) return claims.azp;
  return aud.length === 1 && typeof aud[0] === 'string' ? aud[0] : undefined;
};

/**
 * RP-Initiated Logout 1.0 with Back-Channel and Front-Channel Logout 1.0. A verified `id_token_hint` names the user and the OP
 * session (`sid`) to end; every client that holds a session under that `sid` is told. A `post_logout_redirect_uri` is
 * honoured only when it exactly matches one the hint's client registered (or the `client_id`'s, when there is no hint).
 * shortcut: the emulator has no browser session, so a request without a verified hint ends nothing and answers the confirmation page.
 */
async function logout(c: RouteContext): Promise<Reply> {
  const e = c.engine;
  const a = adv(e);
  const param = (n: string): string | undefined => {
    const v = c.body[n] ?? c.query.get(n);
    return typeof v === 'string' && v ? v : undefined;
  };
  const hintToken = param('id_token_hint');
  const post = param('post_logout_redirect_uri');
  const state = param('state');
  const cid = param('client_id');
  let hint: { sub: string; sid?: string; client: Obj } | undefined;
  let hintFailed = false;
  if (hintToken) {
    const v = await e.tokens.verifyAny(hintToken, { ignoreExp: true });
    const aud = v.ok && v.claims.token_use === 'id_token' ? hintAudience(v.claims) : undefined;
    const hc = aud ? e.db.oauthClients.get(aud) : undefined;
    if (v.ok && hc && !hc.deleted && (!cid || cid === aud)) hint = { sub: String(v.claims.sub), sid: typeof v.claims.sid === 'string' && v.claims.sid ? v.claims.sid : undefined, client: hc };
    else hintFailed = true;
  }
  const named = hint ? hint.client : !hintFailed && cid ? e.db.oauthClients.get(cid) : undefined;
  const rpClient = named && !named.deleted ? named : undefined;
  const redirect = post && rpClient && (rpClient.post_logout_redirect_uris ?? []).includes(post) ? post : undefined;
  if (!hint || !hint.sid) return page('<p>Sign out? Send the id_token_hint of the session to end.</p>');
  const sid = hint.sid;
  // The hint's `sub` is what its client saw: for a pairwise client it names the user through the per-sector map.
  const ended: typeof a.rp = [];
  for (const r of a.rp.filter((x) => x.sid === sid)) if ((await subjectFor(e, hint.client, r.userId)) === hint.sub) ended.push(r);
  const hintUser = ended[0]?.userId ?? hint.sub;
  a.rp = a.rp.filter((r) => !ended.includes(r));
  if (a.sessions.get(hintUser) === sid) a.sessions.delete(hintUser);
  for (const g of st(e).grants.values()) if (g.sid === sid && g.userId === hintUser && !g.revoked) revokeGrant(e, g);
  const front: string[] = [];
  await Promise.allSettled(
    ended.map(async (r) => {
      const cl = e.db.oauthClients.get(r.clientId);
      if (!cl || cl.deleted) return;
      // Queued with the real retry schedule; the first attempt is made now.
      if (cl.backchannel_logout_uri) await enqueueBackchannelLogout(e, cl, { userId: r.userId, sid: r.sid });
      if (cl.frontchannel_logout_uri) {
        const u = new URL(cl.frontchannel_logout_uri);
        u.searchParams.set('iss', e.issuer);
        u.searchParams.set('sid', r.sid);
        front.push(u.toString());
      }
    }),
  );
  let to: string | undefined;
  if (redirect) {
    const u = new URL(redirect);
    if (state !== undefined) u.searchParams.set('state', state);
    to = u.toString();
  }
  if (to && !front.length) return { status: 302, headers: { location: to, 'cache-control': 'no-store' } };
  return page(`${[...new Set(front)].map((f) => `<iframe src="${esc(f)}" hidden></iframe>`).join('')}<p>You have been signed out.</p>${to ? `<script>setTimeout(function(){location.href=${JSON.stringify(to)}},300)</script><a href="${esc(to)}">Continue</a>` : ''}`);
}

// ── UMA ticket grant (called from the token endpoint) ─────────────────

/** Trade a permission ticket plus the requesting party's claims for a Requesting Party Token. */
export async function umaTicketGrant(c: RouteContext, client: Obj): Promise<Reply> {
  const e = c.engine;
  const u = adv(e).uma;
  const now = e.clock.now();
  const body = c.body;
  const f = (status: number, error: string, d: string, extra: Obj = {}) => fail(status, error, d, extra);
  if (typeof body.ticket !== 'string' || !body.ticket) return f(400, 'invalid_request', 'Missing ticket.');
  const ticket = u.tickets.get(body.ticket);
  const invalid = () => f(400, 'invalid_grant', 'The permission ticket is invalid, expired or already used.');
  if (!ticket || ticket.expiresAt <= now) return invalid();
  if (body.claim_token_format !== undefined && body.claim_token === undefined) return f(400, 'invalid_request', 'claim_token_format must accompany claim_token.');
  const format = body.claim_token_format ?? ID_TOKEN_FORMAT;
  if (body.claim_token && format !== ID_TOKEN_FORMAT && format !== ACCESS_TOKEN_FORMAT) return f(400, 'invalid_request', 'Unsupported claim_token_format.');
  let userId: string | undefined = ticket.userId;
  let viaPct = false;
  if (!userId && body.pct) {
    const p = u.pct.get(String(body.pct));
    if (p && p.clientId === client.id) {
      userId = p.userId;
      viaPct = true;
    }
  }
  if (!userId && body.claim_token) {
    const v = await e.tokens.verifyAny(String(body.claim_token));
    const ok = v.ok && (format === ACCESS_TOKEN_FORMAT ? v.claims.token_use === 'access_token' && v.claims.sub !== v.claims.client_id : v.claims.token_use === 'id_token');
    userId = ok && v.ok && e.db.users.get(String(v.claims.sub)) ? String(v.claims.sub) : undefined;
    if (!userId) return f(403, 'request_denied', 'The claim token does not identify an active user.');
  }
  if (!userId) {
    const next = randomToken(32);
    u.tickets.delete(body.ticket);
    u.tickets.set(next, { ...ticket, expiresAt: now + UMA_TICKET_TTL_MS });
    return f(403, 'need_info', 'The requesting party must be identified.', {
      ticket: next,
      required_claims: [{ name: 'sub', friendly_name: 'Requesting party', claim_type: 'urn:ietf:params:oauth:claim-type:subject', claim_token_format: [ID_TOKEN_FORMAT, ACCESS_TOKEN_FORMAT], issuer: [e.issuer] }],
      ...((client.claims_redirect_uris ?? []).length ? { redirect_user: `${e.issuer}/oauth2/uma/claims` } : {}),
    });
  }
  const user = e.db.users.get(userId);
  if (!user || user.deleted || user.banned) return f(403, 'request_denied', 'The claim token does not identify an active user.');
  const held = (r: UmaRes): string[] => (r.owner === userId ? r.scopes : r.scopes.filter((s) => (r.shares.get(userId!) ?? []).includes(s)));
  const asked = splitScope(body.scope);
  const granted = new Map<string, Set<string>>();
  let rsId = ticket.clientId;
  for (const p of ticket.perms) {
    const r = u.res.get(p.resource_id);
    if (!r) continue;
    rsId = r.clientId;
    const wanted = [...new Set([...(p.resource_scopes.length ? p.resource_scopes : r.scopes), ...asked.filter((s) => r.scopes.includes(s))])];
    const ok = wanted.filter((s) => held(r).includes(s));
    if (ok.length) granted.set(r.id, new Set(ok));
  }
  // An earlier RPT upgrades: it must be live, this client's, this party's; each carried scope is re-checked, so a revoked share never survives.
  let upgraded = false;
  if (body.rpt && granted.size) {
    const v = await e.tokens.verifyAny(String(body.rpt));
    const rec = v.ok ? st(e).access.get(String(v.claims.jti)) : undefined;
    if (v.ok && rec && !rec.revoked && typeof v.claims.uma_rs === 'string' && v.claims.client_id === client.id && v.claims.sub === userId && Array.isArray(v.claims.permissions)) {
      for (const p of v.claims.permissions as Obj[]) {
        const r = u.res.get(String(p.resource_id));
        if (!r || r.clientId !== ticket.clientId) continue;
        const still = held(r).filter((s) => (p.resource_scopes as string[]).includes(s));
        if (!still.length) continue;
        upgraded = true;
        granted.set(r.id, new Set([...(granted.get(r.id) ?? []), ...still]));
      }
    }
  }
  if (!granted.size) return f(403, 'request_denied', 'The requesting party has no access to the requested resources.');
  const iat = Math.floor(now / 1000);
  const permissions = [...granted].map(([resource_id, s]) => ({ resource_id, resource_scopes: [...s], exp: iat + UMA_RPT_TTL_S, iat, nbf: iat }));
  // A ticket is spent only when an RPT is issued.
  u.tickets.delete(body.ticket);
  const rs = e.db.oauthClients.get(rsId);
  const rpt = await mintAccess(e, { client, userId, scope: [...new Set(permissions.flatMap((p) => p.resource_scopes))], grant: null, audience: rs?.id ?? client.id, extra: { permissions, ...(rs ? { uma_rs: rs.id } : {}) }, ttl: UMA_RPT_TTL_S });
  let pct = viaPct ? String(body.pct) : undefined;
  if (!viaPct) {
    pct = randomToken(32);
    u.pct.set(pct, { clientId: client.id, userId });
  }
  return { body: { access_token: rpt.token, token_type: 'Bearer', upgraded, expires_in: UMA_RPT_TTL_S, pct }, headers: NO_STORE };
}

/** The protection API access token: a confidential client trades its credentials for a bearer token with `uma_protection`. */
export async function umaProtectionToken(c: RouteContext, client: Obj): Promise<Reply> {
  if (splitScope(c.body.scope).some((s) => s !== UMA_PROTECTION_SCOPE)) return fail(400, 'invalid_scope', 'A protection API token carries only the uma_protection scope.');
  const t = await mintAccess(c.engine, { client, userId: null, scope: [UMA_PROTECTION_SCOPE], grant: null, audience: c.engine.issuer });
  return { body: { access_token: t.token, token_type: 'Bearer', expires_in: 3600, scope: UMA_PROTECTION_SCOPE }, headers: NO_STORE };
}
export const umaEnabled = (e: Engine): boolean => adv(e).cfg.uma_enabled;
