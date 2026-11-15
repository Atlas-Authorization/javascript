/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import { randomToken, Table } from '../store';
import { fail } from './oauth';
import { heldConsent } from './oauth-flows';
import { issueRefreshToken } from './sessions';
import { recordAudit } from './emu4-oauth-audit';
import { engineState } from './support';

/**
 * Verified OAuth publishers (`/v1/oauth_publishers`) and the Google access-token exchange, with the real rules.
 *
 * Publishers: a DNS TXT record (`_atlas-publisher.<domain>`, value `atlas-publisher-verification=...`) proves the
 * domain; the emulator has no DNS, so `POST /__emulator/oauth/dns` plays the zone (a TXT record, or a transient
 * lookup failure). Verified status is only ever set by `POST /v1/oauth_publishers/{id}/verify`.
 *
 * Google exchange: a first-party client trades a Google access token for an Atlas session at the token endpoint
 * (`subject_token_type=urn:atlas:token-type:google_access_token`). The emulator has no Google; `POST
 * /__emulator/google/tokens` registers the token Google would vouch for, and the checks Atlas makes against Google's
 * tokeninfo and userinfo answers are the real ones.
 */
export const MAX_PUBLISHERS = 50;
export const MAX_PUBLISHER_APPS = 200;
export const PUBLISHER_SKIP_SCOPES = new Set(['openid', 'email', 'profile']);
export const GOOGLE_ACCESS_TOKEN_TYPE = 'urn:atlas:token-type:google_access_token';
const SESSION_TOKEN_TYPE = 'urn:atlas:token-type:session';
const TOKEN_PREFIX = 'atlas-publisher-verification=';

interface PubState {
  publishers: Table;
  dns: Map<string, { records: string[][]; error: string | null }>;
  google: {
    cfg: { enabled: boolean; clientIds: string[]; hostedDomains: string[]; allowSignUp: boolean; atlasClientIds: string[] };
    tokens: Map<string, Obj>;
    links: Map<string, string>;
  };
}
const ps = engineState((e: Engine): PubState => ({
  publishers: new Table('oauth_publishers', e.clock.now, 'opub'),
  dns: new Map(),
  google: { cfg: { enabled: false, clientIds: [], hostedDomains: [], allowSignUp: false, atlasClientIds: [] }, tokens: new Map(), links: new Map() },
}));

const bad = (message: string, param?: string): EmulatorError => new EmulatorError('VALIDATION_FAILED', message, param);
const conflict = (message: string): EmulatorError => new EmulatorError('CONFLICT', message);
const notFoundPub = (): EmulatorError => new EmulatorError('NOT_FOUND', 'Unknown publisher.');

const recordName = (domain: string): string => `_atlas-publisher.${domain}`;

function parseDomain(raw: unknown): string {
  const domain = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(domain)) throw bad('domain must be a host name such as example.com.', 'domain');
  return domain;
}
function nameOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length < 1 || raw.trim().length > 100) throw bad('name must be 1 to 100 characters.', 'name');
  return raw.trim();
}
function boolOf(raw: unknown, param: string): boolean {
  if (typeof raw !== 'boolean') throw bad(`${param} must be true or false.`, param);
  return raw;
}

/** Does an https homepage live on `domain` (or a subdomain of it)? */
export function homepageOnDomain(url: unknown, domain: string): boolean {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname.toLowerCase() === domain || u.hostname.toLowerCase().endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

const liveClients = (e: Engine, publisherId: string): Obj[] => e.db.oauthClients.filter((c) => !c.deleted && c.publisher_id === publisherId);

function publisherView(e: Engine, p: Obj): Obj {
  const verified = p.verified_at !== null;
  return {
    object: 'oauth_publisher',
    id: p.id,
    name: p.name,
    domain: p.domain,
    verified,
    verified_at: p.verified_at,
    last_checked_at: p.last_checked_at,
    record_name: recordName(p.domain),
    record_value: p.verification_token,
    shared_sector: p.shared_sector,
    sector_identifier: p.shared_sector && verified ? p.domain : null,
    skip_consent: p.skip_consent,
    client_ids: liveClients(e, p.id).map((c) => c.id),
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

const find = (e: Engine, id: string | undefined): Obj => {
  const p = ps(e).publishers.get(id);
  if (!p) throw notFoundPub();
  return p;
};

function announce(e: Engine, id: string, action: string, current: Obj | null, before: Obj | null): void {
  recordAudit(e, `oauth_publisher.${action}`, 'api_key', 'oauth_publisher', id, { before, after: current });
  e.webhooks.emit('oauth_publisher.updated', { object: 'oauth_publisher', publisher: id, action, current, at: e.clock.now() });
}

/** The verified publisher an app belongs to, or undefined. */
export function publisherOf(e: Engine, client: Obj): Obj | undefined {
  const p = client.publisher_id ? ps(e).publishers.get(client.publisher_id) : undefined;
  return p && p.verified_at !== null && homepageOnDomain(client.homepage_url, p.domain) ? p : undefined;
}
/** The shared sector of the publisher an app belongs to (its subject settings are then the publisher's). */
export const publisherSectorOf = (e: Engine, client: Obj): string | null => {
  const p = client.publisher_id ? ps(e).publishers.get(client.publisher_id) : undefined;
  return p?.shared_sector ? p.domain : null;
};

/**
 * The consent step for an app of a verified publisher: the name to show, and whether one consent covers the publisher's
 * other apps (the publisher opted in, only openid/email/profile asked, and the user already consented to another
 * enabled app of the publisher for at least those scopes).
 */
export function publisherDecision(e: Engine, client: Obj, userId: string, requested: string[]): { publisherName: string | null; skipConsent: boolean } {
  const p = publisherOf(e, client);
  if (!p) return { publisherName: null, skipConsent: false };
  if (!p.skip_consent || !requested.every((s) => PUBLISHER_SKIP_SCOPES.has(s))) return { publisherName: p.name, skipConsent: false };
  const covered = liveClients(e, p.id).filter((s) => s.id !== client.id).some((s) => {
    const held = heldConsent(e, userId, s.id);
    return !!held && requested.every((r) => held.has(r));
  });
  return { publisherName: p.name, skipConsent: covered };
}

// ── Google access-token exchange ───────────────────────────────────

const TOKEN_RE = /^[\x21-\x7e]{16,4096}$/;
const SUB_RE = /^[0-9A-Za-z_-]{1,255}$/;
const isTrue = (v: unknown): boolean => v === true || v === 'true';

type GoogleCheck = { ok: true; sub: string; email: string; user: Obj } | { ok: false; reason: string };

/** The real checks, in the real order, against what the stubbed Google answers (tokeninfo, then userinfo). */
function verifyGoogleToken(e: Engine, token: string): GoogleCheck {
  const g = ps(e).google;
  const cfg = g.cfg;
  if (!cfg.clientIds.length) return { ok: false, reason: 'no_google_client_ids' };
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'malformed_token' };
  const rec = g.tokens.get(token);
  if (!rec) return { ok: false, reason: 'google_rejected_token' };
  if (typeof rec.aud !== 'string' || !cfg.clientIds.includes(rec.aud)) return { ok: false, reason: 'audience_not_allowed' };
  if (rec.azp !== undefined && (typeof rec.azp !== 'string' || !cfg.clientIds.includes(rec.azp))) return { ok: false, reason: 'authorized_party_not_allowed' };
  if (!(rec.issued_at + Number(rec.expires_in) * 1000 > e.clock.now())) return { ok: false, reason: 'expired' };
  if (typeof rec.sub !== 'string' || !SUB_RE.test(rec.sub)) return { ok: false, reason: 'no_subject' };
  const scopes = typeof rec.scope === 'string' ? rec.scope.split(' ') : [];
  if (!scopes.includes('openid') && !scopes.includes('https://www.googleapis.com/auth/userinfo.email')) return { ok: false, reason: 'scope_missing' };
  const email = typeof rec.email === 'string' ? rec.email.trim().toLowerCase() : '';
  if (!email || !isTrue(rec.email_verified)) return { ok: false, reason: 'email_not_verified' };
  if (cfg.hostedDomains.length) {
    const hd = typeof rec.hd === 'string' ? rec.hd.toLowerCase() : '';
    if (!hd || !cfg.hostedDomains.includes(hd) || !email.endsWith(`@${hd}`)) return { ok: false, reason: 'domain_not_allowed' };
  }
  return { ok: true, sub: rec.sub, email, user: rec };
}

/** The `urn:atlas:token-type:google_access_token` branch of the token-exchange grant. */
export async function googleTokenExchange(c: RouteContext, client: Obj): Promise<Reply> {
  const e = c.engine;
  const g = ps(e).google;
  const b = c.body;
  const refuse = (status: number, error: string, description: string): Reply => fail(status, error, description);
  if (!g.cfg.enabled) return refuse(400, 'invalid_request', 'The Google token exchange is not enabled for this instance.');
  if (client.first_party !== true || !g.cfg.atlasClientIds.includes(client.id)) return refuse(403, 'unauthorized_client', 'This client may not exchange a Google access token for a session.');
  if (b.requested_token_type !== undefined && b.requested_token_type !== SESSION_TOKEN_TYPE) return refuse(400, 'invalid_request', `A Google access token can only be exchanged for a session (requested_token_type ${SESSION_TOKEN_TYPE}).`);
  if (b.actor_token) return refuse(400, 'invalid_request', 'A Google token exchange takes no actor_token.');
  const checked = verifyGoogleToken(e, String(b.subject_token ?? ''));
  // One generic answer for every Google-side refusal, so a caller cannot probe the configuration.
  if (!checked.ok) return refuse(400, 'invalid_grant', 'The Google access token was not accepted.');
  const key = `google:${checked.sub}`;
  let user = e.db.users.get(g.links.get(key));
  if (!user || user.deleted) {
    user = e.db.users.filter((u) => !u.deleted && (u.emails as Obj[]).some((m) => m.verified === true && m.email_address.toLowerCase() === checked.email))[0];
    if (!user && g.cfg.allowSignUp) {
      const res = await e.handle(new Request(`${e.issuer}/v1/users`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${e.keys[0]!.key}` }, body: JSON.stringify({ email_address: checked.email, first_name: checked.user.given_name, last_name: checked.user.family_name, image_url: checked.user.picture }) }));
      if (res.status === 201) user = e.db.users.get(((await res.json()) as Obj).id);
    }
    if (!user) return refuse(403, 'access_denied', 'No Atlas account matches this Google account.');
    g.links.set(key, user.id);
  }
  if (user.banned || user.locked || user.deleted) return refuse(403, 'access_denied', 'This account cannot sign in.');
  const now = e.clock.now();
  const session = e.db.sessions.insert({ user_id: user.id, organization_id: null, status: 'active', created_at: now, expires_at: now + 7 * 86_400_000, last_active_at: now, minted_via: 'google_token_exchange', client_id: client.id, ...(typeof b.device_name === 'string' && b.device_name ? { device_name: b.device_name.slice(0, 100) } : {}) });
  const minted = await e.tokens.mintSession({ userId: user.id, sessionId: session.id, claims: { azp: client.id } });
  return { body: { access_token: minted.jwt, issued_token_type: SESSION_TOKEN_TYPE, token_type: 'Bearer', expires_in: minted.expiresIn, refresh_token: issueRefreshToken(e, session.id), session_id: session.id }, headers: { 'cache-control': 'no-store', pragma: 'no-cache' } };
}

// ── routes ──────────────────────────────────────────────────────────

export function emu4PublisherHandlers(): RouteDef[] {
  const read = 'oauth_clients:read';
  const write = 'oauth_clients:write';
  return [
    { method: 'GET', pattern: '/v1/oauth_publishers', scope: read, handler: (c) => ({ body: { object: 'list', data: ps(c.engine).publishers.all().reverse().map((p) => publisherView(c.engine, p)), has_more: false } }) },
    {
      method: 'POST',
      pattern: '/v1/oauth_publishers',
      scope: write,
      handler: (c) => {
        const e = c.engine;
        const t = ps(e).publishers;
        const domain = parseDomain(c.body.domain);
        const name = nameOf(c.body.name);
        const sharedSector = c.body.shared_sector === undefined ? false : boolOf(c.body.shared_sector, 'shared_sector');
        const skipConsent = c.body.skip_consent === undefined ? false : boolOf(c.body.skip_consent, 'skip_consent');
        if (sharedSector) throw bad('shared_sector can only be turned on once the domain is verified. Create the publisher, verify it, then set shared_sector.', 'shared_sector');
        if (t.size >= MAX_PUBLISHERS) throw bad(`An instance holds at most ${MAX_PUBLISHERS} publishers.`, 'domain');
        if (t.find((p) => p.domain === domain)) throw conflict(`A publisher for ${domain} already exists.`);
        const now = e.clock.now();
        const row = t.insert({ name, domain, verification_token: `${TOKEN_PREFIX}${randomToken(18)}`, verified_at: null, last_checked_at: null, shared_sector: false, skip_consent: skipConsent, created_at: now, updated_at: now });
        const view = publisherView(e, row);
        announce(e, row.id, 'created', view, null);
        return { status: 201, body: view };
      },
    },
    { method: 'GET', pattern: '/v1/oauth_publishers/:id', scope: read, handler: (c) => ({ body: publisherView(c.engine, find(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/oauth_publishers/:id',
      scope: write,
      handler: (c) => {
        const e = c.engine;
        const p = find(e, c.params.id);
        const patch: Obj = {};
        if (c.body.name !== undefined) patch.name = nameOf(c.body.name);
        if (c.body.skip_consent !== undefined) patch.skip_consent = boolOf(c.body.skip_consent, 'skip_consent');
        if (c.body.shared_sector !== undefined) {
          const on = boolOf(c.body.shared_sector, 'shared_sector');
          if (on && p.verified_at === null) throw bad('shared_sector needs a verified domain.', 'shared_sector');
          if (!on && p.shared_sector && liveClients(e, p.id).length) throw conflict("Detach the publisher's apps before turning shared_sector off: they keep the shared subject identifiers, and a publisher without the shared sector could no longer manage them.");
          patch.shared_sector = on;
        }
        const before = publisherView(e, p);
        if (Object.entries(patch).every(([k, v]) => p[k] === v)) return { body: before };
        Object.assign(p, patch, { updated_at: e.clock.now() });
        const view = publisherView(e, p);
        announce(e, p.id, 'updated', view, before);
        return { body: view };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/oauth_publishers/:id',
      scope: write,
      handler: (c) => {
        const e = c.engine;
        const p = find(e, c.params.id);
        if (p.shared_sector && liveClients(e, p.id).length) throw conflict("Detach the publisher's apps first: they share its subject identifiers.");
        const before = publisherView(e, p);
        for (const cl of e.db.oauthClients.all()) if (cl.publisher_id === p.id) cl.publisher_id = null;
        ps(e).publishers.delete(p.id);
        announce(e, p.id, 'deleted', null, before);
        return { body: { object: 'oauth_publisher', id: p.id, deleted: true } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/oauth_publishers/:id/verify',
      scope: write,
      handler: (c) => {
        const e = c.engine;
        const p = find(e, c.params.id);
        const zone = ps(e).dns.get(recordName(p.domain));
        // NXDOMAIN / no data means the record is absent; any other failure says nothing, so a verified domain stays verified.
        const lookupFailed = zone?.error != null && zone.error !== 'ENOTFOUND' && zone.error !== 'ENODATA';
        const found = (zone && !zone.error ? zone.records : []).some((chunks) => chunks.join('') === p.verification_token);
        const now = e.clock.now();
        const wasVerified = p.verified_at !== null;
        p.last_checked_at = now;
        if (found && !wasVerified) p.verified_at = now;
        if (!found && !lookupFailed) p.verified_at = null;
        p.updated_at = now;
        const view = { ...publisherView(e, p), record_found: found };
        if ((p.verified_at !== null) !== wasVerified) announce(e, p.id, 'verified', { verified: p.verified_at !== null }, { verified: wasVerified });
        return { body: view };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/oauth_publishers/:id/clients/:client_id',
      scope: write,
      handler: (c) => {
        const e = c.engine;
        const p = find(e, c.params.id);
        if (p.verified_at === null) throw bad("Verify the publisher's domain before attaching apps.", 'client_id');
        const allowChange = c.body.allow_subject_change === undefined ? false : boolOf(c.body.allow_subject_change, 'allow_subject_change');
        const client = e.db.oauthClients.get(c.params.client_id);
        if (!client || client.deleted) throw new EmulatorError('NOT_FOUND', 'Unknown app.');
        if (!homepageOnDomain(client.homepage_url, p.domain)) throw bad(`The app's homepage_url must be an https URL on ${p.domain}.`, 'client_id');
        if (liveClients(e, p.id).length >= MAX_PUBLISHER_APPS) throw bad(`A publisher holds at most ${MAX_PUBLISHER_APPS} apps.`, 'client_id');
        if (client.publisher_id === p.id) return { body: publisherView(e, p) };
        const other = client.publisher_id ? ps(e).publishers.get(client.publisher_id) : undefined;
        if (other) throw conflict(`The app already belongs to the publisher for ${other.domain}. Detach it there first.`);
        if (p.shared_sector) {
          if (client.subject_type !== 'pairwise') throw bad("A publisher with a shared sector takes pairwise apps only. Set the app's subject_type to pairwise first.", 'client_id');
          if (client.sector_identifier && client.sector_identifier !== p.domain && !allowChange) throw conflict(`Attaching this app moves its sector from ${client.sector_identifier} to ${p.domain}, which changes every user's subject identifier in it. Send allow_subject_change: true to confirm.`);
        }
        const before = publisherView(e, p);
        client.publisher_id = p.id;
        if (p.shared_sector && client.sector_identifier !== p.domain) client.sector_identifier = p.domain;
        const view = publisherView(e, p);
        announce(e, p.id, 'client_attached', view, before);
        return { body: view };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/oauth_publishers/:id/clients/:client_id',
      scope: write,
      handler: (c) => {
        const e = c.engine;
        const p = find(e, c.params.id);
        const client = e.db.oauthClients.get(c.params.client_id);
        if (!client || client.deleted) throw new EmulatorError('NOT_FOUND', 'Unknown app.');
        if (client.publisher_id !== p.id) throw new EmulatorError('NOT_FOUND', 'That app does not belong to this publisher.');
        const before = publisherView(e, p);
        // A shared-sector app keeps the sector, so no subject identifier changes.
        client.publisher_id = null;
        const view = publisherView(e, p);
        announce(e, p.id, 'client_detached', view, before);
        return { body: view };
      },
    },
    {
      // The DNS zone: a TXT record (`records` is a list of strings or of string chunks), or `error` for a failed lookup (ENOTFOUND, ENODATA or anything else = transient).
      method: 'POST',
      pattern: '/__emulator/oauth/dns',
      public: true,
      handler: (c) => {
        const name = c.body.name;
        if (typeof name !== 'string' || !name) throw bad('name is required.', 'name');
        const raw = c.body.records ?? [];
        if (!Array.isArray(raw)) throw bad('records must be a list of TXT values.', 'records');
        ps(c.engine).dns.set(name.toLowerCase(), { records: raw.map((r: unknown) => (Array.isArray(r) ? r.map(String) : [String(r)])), error: typeof c.body.error === 'string' ? c.body.error : null });
        return { status: 201, body: { ok: true } };
      },
    },
    { method: 'DELETE', pattern: '/__emulator/oauth/dns', public: true, handler: (c) => (ps(c.engine).dns.delete(String(c.body.name ?? '').toLowerCase()), { body: { ok: true } }) },
    {
      method: 'POST',
      pattern: '/__emulator/oauth/google_exchange',
      public: true,
      handler: (c) => {
        const cfg = ps(c.engine).google.cfg;
        const lists: Array<[string, 'clientIds' | 'hostedDomains' | 'atlasClientIds']> = [['client_ids', 'clientIds'], ['hosted_domains', 'hostedDomains'], ['atlas_client_ids', 'atlasClientIds']];
        for (const [k, f] of lists) {
          if (c.body[k] === undefined) continue;
          if (!Array.isArray(c.body[k]) || c.body[k].some((x: unknown) => typeof x !== 'string')) throw bad(`${k} must be a list of strings.`, k);
          cfg[f] = f === 'hostedDomains' ? c.body[k].map((x: string) => x.toLowerCase()) : c.body[k];
        }
        for (const [k, f] of [['enabled', 'enabled'], ['allow_sign_up', 'allowSignUp']] as const) {
          if (c.body[k] === undefined) continue;
          if (typeof c.body[k] !== 'boolean') throw bad(`${k} must be true or false.`, k);
          cfg[f] = c.body[k];
        }
        return { body: { enabled: cfg.enabled, client_ids: cfg.clientIds, hosted_domains: cfg.hostedDomains, allow_sign_up: cfg.allowSignUp, atlas_client_ids: cfg.atlasClientIds } };
      },
    },
    {
      // Register the token Google would vouch for (its tokeninfo and userinfo answers).
      method: 'POST',
      pattern: '/__emulator/google/tokens',
      public: true,
      handler: (c) => {
        const b = c.body;
        const token = typeof b.token === 'string' && b.token ? b.token : `ya29.${randomToken(32)}`;
        ps(c.engine).google.tokens.set(token, { aud: b.aud, azp: b.azp, sub: b.sub ?? randomToken(10), email: b.email, email_verified: b.email_verified ?? true, hd: b.hd, given_name: b.given_name, family_name: b.family_name, picture: b.picture, name: b.name, scope: typeof b.scope === 'string' ? b.scope : 'openid email profile', expires_in: typeof b.expires_in === 'number' ? b.expires_in : 3600, issued_at: c.engine.clock.now() });
        return { status: 201, body: { access_token: token } };
      },
    },
    { method: 'DELETE', pattern: '/__emulator/google/tokens/:token', public: true, handler: (c) => (ps(c.engine).google.tokens.delete(c.params.token ?? ''), { body: { ok: true } }) },
  ];
}
