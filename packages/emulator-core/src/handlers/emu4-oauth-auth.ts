/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { bytesToB64url } from '../crypto-util';
import { EmulatorError } from '../errors';
import { decodeJwt, verifyJws } from '../jws';
import { isOpDecryptAlg, JWE_ENCS, OP_DECRYPT_ALGS } from '../jwe';
import type { Obj } from '../openapi';
import { REQUEST_OBJECT_ALGS } from './oauth-adv';
import { auditOf } from './emu4-oauth-audit';
import { engineState } from './support';

/**
 * Client authentication with a signed assertion (`private_key_jwt`, RFC 7523), encryption keys for request objects,
 * the response modes `form_post` and the JARM family (`jwt`, `query.jwt`, `fragment.jwt`, `form_post.jwt`), pairwise
 * subject identifiers and software statements for dynamic registration.
 */
export const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** The algorithms the OP signs ID tokens, user info and authorization responses (JARM) with. */
export const OP_SIGNING_ALGS = ['RS256', 'PS256', 'ES256', 'ES384', 'EdDSA'];
export const EXT_RESPONSE_MODES = ['form_post', 'jwt', 'query.jwt', 'fragment.jwt', 'form_post.jwt'];
const CLOCK_SKEW_S = 5;

interface Issuer {
  issuer: string;
  jwks?: { keys: Obj[] };
  jwks_uri?: string;
}
interface AuthState {
  seen: Map<string, number>;
  pairwiseSecret: Uint8Array;
  dcr: { require_software_statement: boolean; software_statement_issuers: Issuer[] };
}
const authState = engineState((): AuthState => ({ seen: new Map(), pairwiseSecret: crypto.getRandomValues(new Uint8Array(32)), dcr: { require_software_statement: false, software_statement_issuers: [] } }));
export const dcrConfig = (e: Engine): AuthState['dcr'] => authState(e).dcr;

const fetchOf = (e: Engine): typeof fetch => e.options.fetch ?? fetch;

/** The public keys of a client (inline `jwks`, else fetched from `jwks_uri`), narrowed to the signing keys named by `kid`. */
async function signingKeysOf(e: Engine, holder: { jwks?: { keys?: Obj[] } | null; jwks_uri?: string | null }, kid?: string): Promise<Obj[]> {
  let keys: Obj[] = Array.isArray(holder.jwks?.keys) ? (holder.jwks!.keys as Obj[]) : [];
  if (!keys.length && holder.jwks_uri) {
    try {
      const res = await fetchOf(e)(holder.jwks_uri);
      keys = res.ok ? (((await res.json()) as any).keys ?? []) : [];
    } catch {
      keys = [];
    }
  }
  return keys.filter((k) => k.use !== 'enc' && (!kid || k.kid === kid));
}

/** The client a `client_assertion` names (its `iss`), for requests that carry no client_id. */
export function assertionClientId(body: Obj): string | undefined {
  const a = typeof body.client_assertion === 'string' ? decodeJwt(body.client_assertion) : null;
  return typeof a?.payload.iss === 'string' ? a.payload.iss : undefined;
}

/** Authenticate a `private_key_jwt` client; null on success, else the `invalid_client` description. Mirrors the real order of checks. */
export async function verifyClientAssertion(e: Engine, body: Obj, client: Obj): Promise<string | null> {
  const assertion = body.client_assertion;
  if (body.client_assertion_type !== ASSERTION_TYPE || typeof assertion !== 'string' || !assertion) return 'This client must authenticate with a private_key_jwt client assertion.';
  const jwt = decodeJwt(assertion);
  const alg = String(jwt?.header.alg ?? '');
  if (!jwt || !REQUEST_OBJECT_ALGS.includes(alg)) return 'The client assertion signature is invalid or expired.';
  const keys = await signingKeysOf(e, client, typeof jwt.header.kid === 'string' ? jwt.header.kid : undefined);
  if (!keys.length) return 'The client has no resolvable keys for its assertion.';
  let verified = false;
  for (const k of keys) if ((verified = await verifyJws(jwt, k))) break;
  const nowS = e.clock.now() / 1000;
  const c = jwt.payload;
  if (!verified || (typeof c.exp === 'number' && c.exp + CLOCK_SKEW_S <= nowS) || (typeof c.nbf === 'number' && c.nbf - CLOCK_SKEW_S > nowS)) return 'The client assertion signature is invalid or expired.';
  if (c.iss !== client.id || c.sub !== client.id) return 'The client assertion iss and sub must equal the client_id.';
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  const accepted = [`${e.issuer}/oauth2/token`, `${e.issuer}/oauth2/par`, e.issuer];
  if (!auds.some((a: unknown) => typeof a === 'string' && accepted.includes(a))) return 'The client assertion audience does not match this endpoint.';
  if (typeof c.exp !== 'number') return 'The client assertion must carry an exp.';
  if (typeof c.jti !== 'string' || !c.jti) return 'The client assertion must carry a jti.';
  // Single use until the assertion's own expiry.
  const seen = authState(e).seen;
  const now = e.clock.now();
  for (const [k, until] of seen) if (until <= now) seen.delete(k);
  const key = `${client.id}:${c.jti}`;
  if (seen.has(key)) return 'The client assertion has already been used.';
  seen.set(key, c.exp * 1000);
  return null;
}

/** The message when a keyed client authentication method has no key to authenticate with, else null. */
export const keyedClientProblem = (method: unknown, jwks: unknown, jwksUri: unknown): string | null => (method === 'private_key_jwt' && !jwks && !jwksUri ? 'private_key_jwt needs jwks or jwks_uri.' : null);
export const AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'];

// ── encryption keys for request objects ─────────────────────────────

/** Publish (make) the encryption key of every algorithm a client registered `request_object_encryption_alg` for. */
export async function ensureRegisteredEncryptionKeys(e: Engine): Promise<void> {
  for (const c of e.db.oauthClients.all()) {
    if (!c.deleted && isOpDecryptAlg(c.request_object_encryption_alg)) await e.tokens.ensureEncryptionKey(c.request_object_encryption_alg);
  }
}

// ── pairwise subject identifiers (OIDC Core section 8) ─────────────

const pairwiseOf = (c: Obj): boolean => c.subject_type === 'pairwise' && typeof c.sector_identifier === 'string' && !!c.sector_identifier;

/** The `sub` a client sees for a user: the user id, or for a pairwise client HMAC-SHA256(secret, sector NUL user id). */
export async function subjectFor(e: Engine, client: Obj | undefined, userId: string): Promise<string> {
  if (!client || !pairwiseOf(client)) return userId;
  const key = await crypto.subtle.importKey('raw', authState(e).pairwiseSecret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToB64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${client.sector_identifier}\u0000${userId}`) as BufferSource)));
}

const redirectSector = (uri: string): string | undefined => {
  try {
    const u = new URL(uri);
    return u.hostname ? u.hostname.toLowerCase() : u.protocol.replace(/:$/, '').toLowerCase() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * The subject settings of a registration (OIDC Registration section 2), as the real validator words them. Returns the
 * fields to store, or a message and the parameter. `existing` is the stored client on an update.
 */
export async function resolveSubject(e: Engine, input: { subject_type?: unknown; sector_identifier_uri?: unknown; redirect_uris: string[]; redirectUrisChanged: boolean; existing?: Obj; publisherSector?: string | null }): Promise<{ ok: true; value: Obj } | { ok: false; message: string; param: string }> {
  const fail = (message: string, param: string) => ({ ok: false as const, message, param });
  if (input.publisherSector) {
    if (input.subject_type !== undefined || input.sector_identifier_uri !== undefined) return fail(`This client belongs to a publisher that shares the sector ${input.publisherSector}. Detach it from the publisher before changing subject_type or sector_identifier_uri.`, input.subject_type !== undefined ? 'subject_type' : 'sector_identifier_uri');
    return { ok: true, value: {} };
  }
  if (input.subject_type !== undefined && input.subject_type !== 'public' && input.subject_type !== 'pairwise') return fail('subject_type must be public or pairwise.', 'subject_type');
  let sectorUri: string | null | undefined;
  if (input.sector_identifier_uri !== undefined) {
    const raw = input.sector_identifier_uri;
    if (raw === null || raw === '') sectorUri = null;
    else if (typeof raw !== 'string') return fail('sector_identifier_uri must be an https URL.', 'sector_identifier_uri');
    else {
      let url: URL;
      try {
        url = new URL(raw.trim());
      } catch {
        return fail('sector_identifier_uri must be an https URL.', 'sector_identifier_uri');
      }
      if (url.protocol !== 'https:' || url.hash || url.username || url.password) return fail('sector_identifier_uri must be an https URL with no fragment or credentials.', 'sector_identifier_uri');
      sectorUri = url.toString();
    }
  }
  if (input.subject_type === undefined && input.sector_identifier_uri === undefined && !input.redirectUrisChanged) return { ok: true, value: {} };
  const subjectType = (input.subject_type as string | undefined) ?? (input.existing?.subject_type as string | undefined) ?? 'public';
  const effectiveUri = sectorUri !== undefined ? sectorUri : ((input.existing?.sector_identifier_uri as string | null | undefined) ?? null);
  if (effectiveUri && (sectorUri !== undefined || input.redirectUrisChanged)) {
    let listed: unknown;
    try {
      const res = await fetchOf(e)(effectiveUri, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' });
      if (res.status !== 200) return fail(`The sector_identifier_uri answered ${res.status}; it must answer 200 with a JSON array.`, 'sector_identifier_uri');
      listed = JSON.parse(await res.text());
    } catch (err) {
      return fail(err instanceof SyntaxError ? 'The sector_identifier_uri must serve a JSON array of redirect URIs.' : 'The sector_identifier_uri could not be fetched.', 'sector_identifier_uri');
    }
    if (!Array.isArray(listed) || !listed.every((u) => typeof u === 'string')) return fail('The sector_identifier_uri must serve a JSON array of redirect URIs.', 'sector_identifier_uri');
    const missing = input.redirect_uris.filter((u) => !(listed as string[]).includes(u));
    if (missing.length) return fail(`The sector_identifier_uri does not list every redirect_uri (missing: ${missing.join(', ')}).`, 'sector_identifier_uri');
  }
  let sector: string | null = null;
  if (subjectType === 'pairwise') {
    if (effectiveUri) sector = new URL(effectiveUri).hostname.toLowerCase();
    else {
      const hosts = [...new Set(input.redirect_uris.map(redirectSector))];
      if (hosts.length !== 1 || !hosts[0]) return fail('A pairwise client whose redirect_uris span more than one host must register a sector_identifier_uri.', 'sector_identifier_uri');
      sector = hosts[0];
    }
    const previous = input.existing?.subject_type === 'pairwise' ? (input.existing.sector_identifier as string | null) : null;
    if (previous && previous !== sector) return fail(`This change would move the client's sector from ${previous} to ${sector}, which changes every user's subject identifier. Register a sector_identifier_uri on ${previous} that lists the new redirect_uris instead.`, input.redirectUrisChanged && sectorUri === undefined ? 'redirect_uris' : 'sector_identifier_uri');
  }
  const value: Obj = { sector_identifier: sector };
  if (input.subject_type !== undefined || !input.existing) value.subject_type = subjectType;
  if (sectorUri !== undefined) value.sector_identifier_uri = sectorUri;
  return { ok: true, value };
}

// ── software statements (RFC 7591 section 2.3) ─────────────────────

const REGISTERED = new Set(['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti']);
/** The claims of a software statement signed by an approved publisher, or the registration error. */
export async function verifySoftwareStatement(e: Engine, statement: string): Promise<{ ok: true; claims: Obj } | { ok: false; error: string; message: string }> {
  const jwt = decodeJwt(statement);
  if (!jwt) return { ok: false, error: 'invalid_software_statement', message: 'The software statement is not a JWT.' };
  const trusted = dcrConfig(e).software_statement_issuers.find((i) => i.issuer === jwt.payload.iss);
  if (!trusted) return { ok: false, error: 'unapproved_software_statement', message: 'The software statement publisher is not approved on this server.' };
  const keys = await signingKeysOf(e, trusted, typeof jwt.header.kid === 'string' ? jwt.header.kid : undefined);
  if (!keys.length) return { ok: false, error: 'invalid_software_statement', message: 'The software publisher keys could not be loaded.' };
  let ok = false;
  if (REQUEST_OBJECT_ALGS.includes(String(jwt.header.alg))) for (const k of keys) if ((ok = await verifyJws(jwt, k))) break;
  const nowS = e.clock.now() / 1000;
  const p = jwt.payload;
  if (!ok || (typeof p.exp === 'number' && p.exp + CLOCK_SKEW_S <= nowS) || (typeof p.nbf === 'number' && p.nbf - CLOCK_SKEW_S > nowS)) return { ok: false, error: 'invalid_software_statement', message: 'The software statement signature or claims are invalid.' };
  return { ok: true, claims: Object.fromEntries(Object.entries(p).filter(([k]) => !REGISTERED.has(k))) };
}

// ── response modes ──────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function formPost(redirectUri: string, params: Record<string, string>): Reply {
  const fields = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n');
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Signing in...</title></head>\n<body><form method="post" action="${esc(redirectUri)}">\n${fields}\n<noscript><p>Your browser has JavaScript disabled. Continue to finish signing in.</p><button type="submit">Continue</button></noscript>\n</form><script>document.forms[0].submit();</script></body></html>`;
  return { status: 200, raw: html, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' } };
}

/**
 * Deliver an authorization response. `location` is the redirect the plain modes use (parameters in its query or
 * fragment); `form_post` answers an auto-submitting form instead and a JARM mode packs the parameters into one signed
 * `response` (iss, aud, exp = ten minutes) in the client's `authorization_signed_response_alg`.
 */
export async function authReply(e: Engine, client: Obj | undefined, redirectUri: string, location: string, mode: string | null): Promise<Reply> {
  const plain: Reply = { status: 302, headers: { location, 'cache-control': 'no-store' } };
  if (!mode || !EXT_RESPONSE_MODES.includes(mode)) return plain;
  const u = new URL(location);
  const inFragment = u.hash.length > 1;
  const found = new URLSearchParams(inFragment ? u.hash.slice(1) : u.search);
  if (!inFragment) for (const k of new URL(redirectUri).searchParams.keys()) found.delete(k);
  const params = Object.fromEntries(found.entries());
  if (mode === 'form_post') return formPost(redirectUri, params);
  const claims: Obj = { ...params, iss: e.issuer, aud: client?.id, sub: undefined, token_use: undefined };
  const jwt = await e.tokens.signClaimsAs(client?.authorization_signed_response_alg ?? null, claims, 600);
  const base = new URL(redirectUri);
  if (mode === 'form_post.jwt') return formPost(redirectUri, { response: jwt });
  // A response that may carry tokens never rides in the query: `query.jwt` and `jwt` answer in the fragment then.
  const fragment = mode === 'fragment.jwt' || (inFragment && (mode === 'jwt' || mode === 'query.jwt'));
  if (fragment) base.hash = new URLSearchParams({ response: jwt }).toString();
  else base.searchParams.set('response', jwt);
  return { status: 302, headers: { location: base.toString(), 'cache-control': 'no-store' } };
}

// ── client fields this module adds to a client's view ──────────────

export function clientExtras(c: Obj): Obj {
  return {
    ...(c.authorization_signed_response_alg ? { authorization_signed_response_alg: c.authorization_signed_response_alg } : {}),
    ...(c.request_object_encryption_alg ? { request_object_encryption_alg: c.request_object_encryption_alg, request_object_encryption_enc: c.request_object_encryption_enc ?? 'A128CBC-HS256' } : {}),
    ...(c.id_token_signed_response_alg ? { id_token_signed_response_alg: c.id_token_signed_response_alg } : {}),
    homepage_url: c.homepage_url ?? null,
    subject_type: c.subject_type ?? 'public',
    sector_identifier_uri: c.sector_identifier_uri ?? null,
    sector_identifier: c.sector_identifier ?? null,
    publisher_id: c.publisher_id ?? null,
  };
}

/** Validate the fields this module adds to a client create/update body; only keys present are returned. */
export function parseExtraClientFields(body: Obj): { ok: true; value: Obj } | { ok: false; message: string } {
  const out: Obj = {};
  const bad = (message: string) => ({ ok: false as const, message });
  if (body.authorization_signed_response_alg !== undefined) {
    const v = body.authorization_signed_response_alg;
    if (v === null) out.authorization_signed_response_alg = null;
    else if (typeof v !== 'string' || !OP_SIGNING_ALGS.includes(v)) return bad(`authorization_signed_response_alg must be one of: ${OP_SIGNING_ALGS.join(', ')}.`);
    else out.authorization_signed_response_alg = v;
  }
  if (body.id_token_signed_response_alg !== undefined) {
    const v = body.id_token_signed_response_alg;
    if (v === null) out.id_token_signed_response_alg = null;
    else if (typeof v !== 'string' || !OP_SIGNING_ALGS.includes(v)) return bad(`id_token_signed_response_alg must be one of: ${OP_SIGNING_ALGS.join(', ')}.`);
    else out.id_token_signed_response_alg = v;
  }
  if (body.request_object_encryption_alg !== undefined) {
    const v = body.request_object_encryption_alg;
    if (v === null) out.request_object_encryption_alg = null;
    else if (typeof v !== 'string' || !OP_DECRYPT_ALGS.includes(v as any)) return bad(`request_object_encryption_alg must be one of: ${OP_DECRYPT_ALGS.join(', ')}.`);
    else out.request_object_encryption_alg = v;
  }
  if (body.request_object_encryption_enc !== undefined) {
    const v = body.request_object_encryption_enc;
    if (v === null) out.request_object_encryption_enc = null;
    else if (typeof v !== 'string' || !JWE_ENCS.includes(v as any)) return bad(`request_object_encryption_enc must be one of: ${JWE_ENCS.join(', ')}.`);
    else out.request_object_encryption_enc = v;
  }
  if (body.homepage_url !== undefined) {
    const v = body.homepage_url;
    if (v === null || v === '') out.homepage_url = null;
    else {
      let ok = typeof v === 'string' && v.length <= 2048;
      try {
        ok = ok && new URL(v).protocol === 'https:';
      } catch {
        ok = false;
      }
      if (!ok) return bad('homepage_url must be an absolute https URL.');
      out.homepage_url = v;
    }
  }
  return { ok: true, value: out };
}

export function emu4AuthHandlers(): RouteDef[] {
  return [
    {
      // Which publishers may sign a software statement, and whether dynamic registration demands one.
      method: 'POST',
      pattern: '/__emulator/oauth/dcr',
      public: true,
      handler: (c: RouteContext) => {
        const cfg = dcrConfig(c.engine);
        if (c.body.require_software_statement !== undefined) {
          if (typeof c.body.require_software_statement !== 'boolean') throw new EmulatorError('VALIDATION_FAILED', 'require_software_statement must be true or false.', 'require_software_statement');
          cfg.require_software_statement = c.body.require_software_statement;
        }
        const issuers = c.body.software_statement_issuers;
        if (issuers !== undefined) {
          if (!Array.isArray(issuers) || issuers.some((i) => !i || typeof i.issuer !== 'string' || (!i.jwks && !i.jwks_uri))) throw new EmulatorError('VALIDATION_FAILED', 'software_statement_issuers must be a list of { issuer, jwks | jwks_uri }.', 'software_statement_issuers');
          cfg.software_statement_issuers = issuers;
        }
        return { body: { ...cfg } };
      },
    },
    // The audit rows the signing-key, publisher and delivery routes wrote (newest last); `action` narrows them.
    { method: 'GET', pattern: '/__emulator/oauth/audit', public: true, handler: (c: RouteContext) => ({ body: { object: 'list', data: auditOf(c.engine).filter((r) => !c.query.get('action') || r.action === c.query.get('action')) } }) },
    { method: 'GET', pattern: '/__emulator/oauth/dcr', public: true, handler: (c: RouteContext) => ({ body: { ...dcrConfig(c.engine) } }) },
  ];
}
