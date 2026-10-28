import type { EmailAddress, IdentityRecord, PasskeyRecord, PasswordHash, SsoConnectionRecord, UserRecord } from '@atlasauth/migrate';
import { base64url, bool, col, json, text, time, timeMs, type Row, type Tables } from './frameworks/tables';
import { RecordSet, bag, compact, isObj, objs, str, strs, type Obj } from './record-set';
import { VendorApiError, VendorHttp, type VendorResponse } from './vendor-http';

/**
 * `atlas migrate export hanko` — Hanko (self-hosted, and Hanko Cloud) onto the
 * canonical bundle models. Two ways in:
 *
 *   - a DATABASE DUMP of the Hanko backend (`<table>.json|ndjson|csv` per
 *     table, see frameworks/tables.ts), the complete path: users (`public_id`
 *     is what the session JWT's `sub` carries), emails with their verified and
 *     primary flags, usernames, names, public/private/unsafe metadata, custom
 *     claims, password hashes (bcrypt, or the `$fbscrypt$` Firebase scrypt
 *     strings Hanko imports), TOTP secrets, passkeys and security keys,
 *     third-party and SAML identities, SAML providers, organizations, roles and
 *     memberships;
 *   - the ADMIN API (`GET /users`, `/users/{id}`, `/organizations`, `/roles`)
 *     with a Hanko Cloud API key, for a project whose database you cannot dump.
 *     It returns everything above EXCEPT password hashes and TOTP secrets:
 *     those users sign in once against Hanko through the `hanko` lazy preset
 *     and re-enrol TOTP. Passkeys still move (the API returns public keys).
 *
 * Live sessions are not exported: a Hanko session is a signed JWT the bridge
 * accepts as it is (`hanko` / `hanko_jwt` presets).
 *
 * Schema: github.com/teamhanko/hanko backend/persistence/migrations and
 * backend/persistence/models; Admin API DTOs: backend/dto/admin.
 */

export interface HankoTablesOptions {
  /** `webauthn.relying_party.id` — the domain passkeys were registered for (needed to move passkeys). */
  rpId?: string;
  /** Multi-tenant Hanko: the tenant to export (`tenants.id`). */
  tenantId?: string;
}

export interface HankoApiOptions {
  /** The Admin API base URL (self-hosted `server.admin.address`, or the Hanko Cloud admin URL). */
  adminUrl: string;
  /** Hanko Cloud API key (sent as `Authorization: Bearer`); a self-hosted admin API usually has none. */
  apiKey?: string;
  /** The public API URL: its `/.well-known/jwks.json` (the session signing keys) goes in the bundle. */
  apiUrl?: string;
  rpId?: string;
  pageSize?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/** Hanko's built-in third-party providers (`third_party.providers.<name>`); `custom_<key>` are custom OIDC providers. */
const BUILT_IN_PROVIDERS = new Set(['apple', 'discord', 'facebook', 'github', 'google', 'linkedin', 'microsoft']);

/** Hanko's TOTP parameters (flow_api/services/totp.go: pquerna/otp defaults, not configurable). */
const TOTP = { digits: 6, period: 30, algorithm: 'SHA1' as const };

const NO_PASSKEY_RP =
  'Passkeys were left out: pass the relying-party id they were registered for (--set hanko-rp-id=<webauthn.relying_party.id>, e.g. example.com).';

const MFA_ONLY_NOTE = (n: number) =>
  `${n} WebAuthn credential(s) were Hanko security keys used only as a second factor (mfa_only). They move as passkeys bound to the same relying-party id; Atlas can also accept them as a first factor.`;

// ── password hashes ─────────────────────────────────────────────────────────

/**
 * Hanko's own Firebase-scrypt import format (flow_api/services/password.go,
 * after Supabase's): `$fbscrypt$v=1,n=<mem cost>,r=<rounds>,p=<parallelism>,ss=<salt
 * separator>,sk=<signer key>$<salt>$<hash>`, every value standard base64.
 */
const FBSCRYPT = /^\$fbscrypt\$v=(\d+),n=(\d+),r=(\d+),p=(\d+)(?:,ss=([^,$]+))?(?:,sk=([^$]+))?\$([^$]+)\$(.+)$/;

/** A Hanko `password_credentials.password` as a bundle password; null when Atlas cannot verify it. */
export function hankoPasswordHash(raw: unknown): PasswordHash | null {
  const digest = text(raw);
  if (!digest) return null;
  if (/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(digest)) return { algorithm: 'bcrypt', hash: digest };
  const m = FBSCRYPT.exec(digest);
  // Atlas's scrypt_firebase verifier is Firebase's own construction: version 1, p = 1.
  if (!m || m[1] !== '1' || m[4] !== '1' || !m[6]) return null;
  return {
    algorithm: 'scrypt_firebase',
    hash: m[8]!,
    salt: m[7]!,
    params: { rounds: Number(m[3]), mem_cost: Number(m[2]), salt_separator: m[5] ?? '', signer_key: m[6] },
  };
}

// ── shared mapping ──────────────────────────────────────────────────────────

/** Base64url bytes as Hanko stores them (raw URL encoding); other encodings are normalised. */
function b64u(v: unknown): string | undefined {
  const s = text(v);
  if (!s) return undefined;
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : base64url(s);
}

const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

function passkey(o: {
  id: unknown;
  userId: string;
  publicKey: unknown;
  rpId: string;
  signCount?: unknown;
  aaguid?: unknown;
  backedUp?: unknown;
  name?: unknown;
  transports: string[];
  createdAt?: unknown;
}): PasskeyRecord | null {
  const credentialId = b64u(o.id);
  const publicKey = b64u(o.publicKey);
  if (!credentialId || !publicKey) return null;
  const aaguid = text(o.aaguid);
  const count = Number(o.signCount);
  return compact({
    id: credentialId,
    user_id: o.userId,
    credential_id: credentialId,
    public_key: publicKey,
    sign_count: Number.isFinite(count) && count > 0 ? count : undefined,
    rp_id: o.rpId,
    transports: o.transports,
    aaguid: aaguid && aaguid !== ZERO_AAGUID ? aaguid : undefined,
    backed_up: o.backedUp === undefined ? undefined : bool(o.backedUp),
    name: text(o.name),
    created_at: time(o.createdAt),
  });
}

/** A metadata column / field: a JSON object (or the string Hanko stores), only when it has keys. */
function metadata(v: unknown): Obj | undefined {
  return bag(isObj(v) ? v : json(v));
}

/** `user_custom_claims.claims` stores `{ name: { value, source } }`; the Admin API returns them flat. */
function customClaims(v: unknown, wrapped: boolean): Obj | undefined {
  const o = isObj(v) ? v : json(v);
  if (!o) return undefined;
  if (!wrapped) return bag(o);
  const flat: Obj = {};
  for (const [k, c] of Object.entries(o)) flat[k] = isObj(c) && 'value' in c ? c.value : c;
  return bag(flat);
}

function privateMetadata(priv: Obj | undefined, claims: Obj | undefined): Obj | undefined {
  // Custom claims Hanko put in the session JWT: kept for a JWT template to add back.
  return bag({ ...(priv ?? {}), ...(claims ? { hanko_custom_claims: claims } : {}) });
}

/** A third-party / SAML identity. `provider` is Hanko's provider id (`google`, `custom_<key>`, or a SAML IdP's entity id). */
function identity(o: {
  id?: string;
  userId: string;
  provider: string;
  providerUserId: string;
  data?: Obj;
  ssoConnectionId?: string;
  saml?: boolean;
  fallbackEmail?: string;
}): IdentityRecord {
  const kind = o.saml ? 'saml' : BUILT_IN_PROVIDERS.has(o.provider) ? 'oauth' : 'oidc';
  const verified = o.data?.email_verified;
  return compact({
    id: o.id,
    user_id: o.userId,
    provider: o.provider,
    provider_user_id: o.providerUserId,
    kind,
    sso_connection_id: o.ssoConnectionId,
    email: str(o.data?.email)?.toLowerCase() ?? o.fallbackEmail,
    email_verified: verified === undefined ? undefined : verified === true || verified === 'true',
    profile: bag(o.data),
  });
}

function sortedEmails(list: EmailAddress[]): EmailAddress[] {
  // Primary first, the rest in the order Hanko had them.
  return [...list.filter((e) => e.primary), ...list.filter((e) => !e.primary)];
}

/** A Hanko user with neither an email nor a username cannot be imported (nothing to sign in with). */
const NO_IDENTIFIER = 'Hanko user without an email address or username';

function membershipRole(slugs: string[], set: RecordSet): string {
  const sorted = [...new Set(slugs)].sort();
  if (sorted.length > 1) set.warn('Some memberships carry more than one Hanko role: Atlas keeps one role per membership (the first by slug); grant the others again in Atlas.');
  return sorted[0] ?? 'member';
}

// ── the database dump ───────────────────────────────────────────────────────

/** Read a Hanko database dump (pure). */
export function exportHankoTables(tables: Tables, opts: HankoTablesOptions = {}): RecordSet {
  const set = new RecordSet();
  const tenant = pickTenant(tables, opts.tenantId);
  const rows = (...names: string[]) => tables.rows(...names).filter((r) => !tenant || !text(col(r, 'tenant_id')) || text(col(r, 'tenant_id')) === tenant);
  const by = <T>(list: Row[], key: string, value: (r: Row) => T | undefined): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const r of list) {
      const k = text(col(r, key));
      const v = value(r);
      if (!k || v === undefined) continue;
      out.set(k, [...(out.get(k) ?? []), v]);
    }
    return out;
  };

  const userRows = rows('users');
  if (!userRows.length) throw new Error('No users table in the dump (expected users.json / users.ndjson / users.csv from the Hanko database).');
  // users.id is internal; the JWT `sub` (and every Admin API id) is public_id, equal to id unless set on creation.
  const publicId = new Map<string, string>();
  for (const u of userRows) {
    const id = text(col(u, 'id'));
    if (id) publicId.set(id, text(col(u, 'public_id')) ?? id);
  }

  const primaries = new Set(rows('primary_emails').map((r) => text(col(r, 'email_id'))).filter((v): v is string => !!v));
  const emailRows = rows('emails');
  const emailById = new Map<string, { address: string; userId?: string }>();
  for (const e of emailRows) {
    const id = text(col(e, 'id'));
    const address = text(col(e, 'address'));
    if (id && address) emailById.set(id, { address: address.toLowerCase(), userId: text(col(e, 'user_id')) });
  }
  const emailsOf = by<EmailAddress>(emailRows, 'user_id', (e) => {
    const address = text(col(e, 'address'));
    return address ? { email: address.toLowerCase(), verified: bool(col(e, 'verified')), primary: primaries.has(text(col(e, 'id')) ?? '') } : undefined;
  });
  const usernameOf = new Map<string, string>();
  for (const r of rows('usernames')) {
    const userId = text(col(r, 'user_id'));
    const username = text(col(r, 'username'));
    if (userId && username) usernameOf.set(userId, username);
  }
  const passwordOf = new Map<string, unknown>();
  for (const r of rows('password_credentials')) {
    const userId = text(col(r, 'user_id'));
    if (userId) passwordOf.set(userId, col(r, 'password'));
  }
  const metadataOf = new Map<string, Row>();
  for (const r of rows('user_metadata')) {
    const userId = text(col(r, 'user_id'));
    if (userId) metadataOf.set(userId, r);
  }
  const claimsOf = new Map<string, Obj>();
  for (const r of rows('user_custom_claims')) {
    const userId = text(col(r, 'user_id'));
    const claims = customClaims(col(r, 'claims'), true);
    if (userId && claims) claimsOf.set(userId, claims);
  }

  // ── users ──
  const exported = new Map<string, string>(); // internal id → exported (public) id
  let unsupportedHashes = 0;
  for (const u of userRows) {
    const id = text(col(u, 'id'));
    if (!id) continue;
    const pub = publicId.get(id)!;
    let emails = sortedEmails(emailsOf.get(id) ?? []);
    // Hanko before late 2022 kept one address on the user row.
    const legacyEmail = text(col(u, 'email'));
    if (!emails.length && legacyEmail) emails = [{ email: legacyEmail.toLowerCase(), verified: bool(col(u, 'verified')), primary: true }];
    if (emails.length && !emails.some((e) => e.primary)) emails[0] = { ...emails[0]!, primary: true };
    const username = usernameOf.get(id) ?? text(col(u, 'username'));
    if (!emails.length && !username) {
      set.omit('user', NO_IDENTIFIER);
      continue;
    }
    let password: PasswordHash | undefined;
    if (passwordOf.has(id)) {
      password = hankoPasswordHash(passwordOf.get(id)) ?? undefined;
      if (!password) unsupportedHashes++;
    }
    const meta = metadataOf.get(id);
    set.add(
      'user',
      compact<UserRecord>({
        id: pub,
        emails,
        username,
        first_name: text(col(u, 'given_name')),
        last_name: text(col(u, 'family_name')),
        name: text(col(u, 'name')),
        image_url: text(col(u, 'picture')),
        password,
        public_metadata: meta ? metadata(col(meta, 'public_metadata')) : undefined,
        private_metadata: privateMetadata(meta ? metadata(col(meta, 'private_metadata')) : undefined, claimsOf.get(id)),
        unsafe_metadata: meta ? metadata(col(meta, 'unsafe_metadata')) : undefined,
        created_at: time(col(u, 'created_at')),
      }),
      pub,
    );
    exported.set(id, pub);
  }
  if (unsupportedHashes) {
    set.warn(`${unsupportedHashes} password hash(es) are in a format Atlas cannot verify: those users sign in once through the hanko lazy-migration preset (or reset their password).`);
  }
  const owner = (internal: string | undefined) => (internal ? exported.get(internal) : undefined);

  // ── SAML providers (Hanko ≥ 2.x keeps them in the database; config.yaml ones are synthesised below) ──
  const metadataByProvider = new Map<string, Row>();
  for (const m of rows('saml_idp_metadata')) {
    const pid = text(col(m, 'provider_id'));
    if (pid) metadataByProvider.set(pid, m);
  }
  const connectionByDomain = new Map<string, string>();
  for (const p of rows('saml_providers')) {
    const id = text(col(p, 'id'));
    const domain = text(col(p, 'domain'))?.toLowerCase();
    if (!id) continue;
    if (domain) connectionByDomain.set(domain, id);
    const md = metadataByProvider.get(id);
    const attrs = json(col(p, 'attribute_map'));
    const mapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs ?? {})) if (typeof v === 'string' && v) mapping[k] = v;
    set.add(
      'sso_connection',
      compact<SsoConnectionRecord>({
        id,
        name: text(col(p, 'name')),
        protocol: 'saml',
        domains: domain ? [domain] : undefined,
        enabled: col(p, 'enabled') === undefined ? undefined : bool(col(p, 'enabled')),
        saml: compact({
          idp_entity_id: text(col(p, 'entity_id')) ?? (md ? text(col(md, 'issuer')) : undefined),
          idp_metadata_url: text(col(p, 'metadata_url')),
          idp_metadata_xml: md ? text(col(md, 'raw_metadata_xml')) : undefined,
          idp_sso_url: md ? text(col(md, 'sso_url')) : undefined,
          idp_certificate: md ? text(col(md, 'certificates_pem')) : undefined,
          attribute_mapping: Object.keys(mapping).length ? mapping : undefined,
        }),
      }),
      id,
    );
  }

  // ── identities ──
  const samlDomainOf = new Map<string, string>();
  for (const s of rows('saml_identities')) {
    const identityId = text(col(s, 'identity_id'));
    const domain = text(col(s, 'domain'))?.toLowerCase();
    if (identityId && domain) samlDomainOf.set(identityId, domain);
  }
  const providers = new Set<string>();
  let synthesized = 0;
  for (const r of rows('identities')) {
    // Before 2025 the columns were provider_id (the provider's user id) and provider_name.
    const legacy = col(r, 'provider_name') !== undefined;
    const provider = text(col(r, legacy ? 'provider_name' : 'provider_id'));
    const providerUserId = text(col(r, legacy ? 'provider_id' : 'provider_user_id'));
    const emailId = text(col(r, 'email_id'));
    const user = owner(text(col(r, 'user_id')) ?? (emailId ? emailById.get(emailId)?.userId : undefined));
    if (!provider || !providerUserId || !user) {
      set.omit('identity', 'Identity whose user was not exported');
      continue;
    }
    const id = text(col(r, 'id'));
    const domain = id ? samlDomainOf.get(id) : undefined;
    let ssoConnectionId: string | undefined;
    if (domain) {
      ssoConnectionId = connectionByDomain.get(domain);
      if (!ssoConnectionId) {
        // A SAML provider configured in config.yaml: the connection is created from what the identity knows.
        ssoConnectionId = `saml:${domain}`;
        connectionByDomain.set(domain, ssoConnectionId);
        set.add('sso_connection', { id: ssoConnectionId, name: domain, protocol: 'saml', domains: [domain], saml: { idp_entity_id: provider } }, ssoConnectionId);
        synthesized++;
      }
    } else {
      providers.add(provider);
    }
    set.add(
      'identity',
      identity({
        id,
        userId: user,
        provider,
        providerUserId,
        data: json(col(r, 'data')),
        ssoConnectionId,
        saml: Boolean(domain),
        fallbackEmail: emailId ? emailById.get(emailId)?.address : undefined,
      }),
      `${provider}\u0000${providerUserId}`,
    );
  }
  if (synthesized) {
    set.warn(`${synthesized} SAML connection(s) come from config.yaml (saml.identity_providers) and were created from their users' identities: add each IdP's metadata URL in Atlas (atlas migrate hanko config lists them).`);
  }

  // ── TOTP ──
  for (const r of rows('otp_secrets')) {
    const user = owner(text(col(r, 'user_id')));
    const secret = text(col(r, 'secret'))?.replace(/=+$/, '').toUpperCase();
    if (!user || !secret) continue;
    set.add('mfa_factor', compact({ id: text(col(r, 'id')), user_id: user, type: 'totp' as const, secret_base32: secret, ...TOTP, verified: true, created_at: time(col(r, 'created_at')) }));
  }

  // ── passkeys and security keys ──
  const transports = by<string>(rows('webauthn_credential_transports'), 'webauthn_credential_id', (t) => text(col(t, 'name')));
  const credentials = rows('webauthn_credentials').filter((c) => owner(text(col(c, 'user_id'))));
  if (credentials.length && !opts.rpId) {
    set.omit('passkey', 'No relying-party id given (--set hanko-rp-id)', credentials.length);
    set.warn(NO_PASSKEY_RP);
  } else if (opts.rpId) {
    let mfaOnly = 0;
    for (const c of credentials) {
      const record = passkey({
        id: col(c, 'id'),
        userId: owner(text(col(c, 'user_id')))!,
        publicKey: col(c, 'public_key'),
        rpId: opts.rpId,
        signCount: col(c, 'sign_count'),
        aaguid: col(c, 'aaguid'),
        backedUp: col(c, 'backup_state'),
        name: col(c, 'name'),
        transports: transports.get(text(col(c, 'id')) ?? '') ?? [],
        createdAt: col(c, 'created_at'),
      });
      if (!record) {
        set.omit('passkey', 'WebAuthn credential without an id or public key');
        continue;
      }
      if (bool(col(c, 'mfa_only'))) mfaOnly++;
      set.add('passkey', record, record.credential_id);
    }
    if (mfaOnly) set.warn(MFA_ONLY_NOTE(mfaOnly));
  }

  // ── organizations, roles, memberships ──
  for (const o of rows('organizations')) {
    const id = text(col(o, 'id'));
    const name = text(col(o, 'name'));
    if (id && name) set.add('organization', compact({ id, name, created_at: time(col(o, 'created_at')) }), id);
  }
  const roleSlug = new Map<string, string>();
  for (const r of rows('roles')) {
    const id = text(col(r, 'id'));
    const slug = text(col(r, 'slug'));
    if (!id || !slug) continue;
    roleSlug.set(id, slug);
    set.add('role', compact({ key: slug, name: text(col(r, 'name')), scope: 'organization' as const }), slug);
  }
  const bindings = new Map<string, string[]>();
  for (const b of rows('role_bindings')) {
    const slug = roleSlug.get(text(col(b, 'role_id')) ?? '');
    const key = `${text(col(b, 'user_id'))}\u0000${text(col(b, 'organization_id'))}`;
    if (slug) bindings.set(key, [...(bindings.get(key) ?? []), slug]);
  }
  for (const m of rows('organization_memberships')) {
    const internal = text(col(m, 'user_id'));
    const user = owner(internal);
    const org = text(col(m, 'organization_id'));
    if (!user || !org) {
      set.omit('membership', 'Membership whose user was not exported');
      continue;
    }
    set.add(
      'membership',
      compact({ id: text(col(m, 'id')), organization_id: org, user_id: user, role: membershipRole(bindings.get(`${internal}\u0000${org}`) ?? [], set), created_at: time(col(m, 'created_at')) }),
      `${org}\u0000${user}`,
    );
  }

  // ── what does not move ──
  const now = Date.now();
  const live = rows('sessions').filter((s) => {
    const exp = timeMs(col(s, 'expires_at'));
    return exp === undefined || exp > now;
  }).length;
  if (live) set.omit('session', 'Hanko sessions are JWTs the bridge accepts as they are (hanko preset)', live);
  const webhooks = rows('webhooks').length;
  if (webhooks) set.warn(`${webhooks} Hanko webhook(s) in the database: recreate them as Atlas webhooks (the event names differ).`);

  set.manifest = compact({
    origin: tenant ? `Hanko database dump (tenant ${tenant})` : 'Hanko database dump',
    rpId: opts.rpId,
    providers: [...providers].sort(),
    settings: compact({ hanko_tenant_id: tenant, totp: { ...TOTP } }),
  });
  return set;
}

/** The tenant to export: the one given, the only one in the dump, or an error naming them. */
function pickTenant(tables: Tables, given: string | undefined): string | undefined {
  if (given) return given;
  const tenants = new Set(tables.rows('users').map((u) => text(col(u, 'tenant_id'))).filter((t): t is string => !!t));
  if (tenants.size > 1) {
    throw new Error(`The dump holds users of ${tenants.size} Hanko tenants (${[...tenants].sort().join(', ')}): export one at a time with --set hanko-tenant-id=<tenant id>.`);
  }
  return undefined;
}

// ── the Admin API ───────────────────────────────────────────────────────────

/** Every page of a Hanko admin listing (`?page=&per_page=`; Link / X-Total-Count headers). Null when the endpoint does not exist. */
async function pages(http: VendorHttp, path: string, size: number, optional: boolean): Promise<Obj[] | null> {
  const out: Obj[] = [];
  for (let page = 1; ; page++) {
    let res: VendorResponse<unknown>;
    try {
      res = await http.get<unknown>(`${path}?page=${page}&per_page=${size}`);
    } catch (err) {
      // Older Hanko versions have no organizations / roles.
      if (optional && err instanceof VendorApiError && err.status === 404) return null;
      throw err;
    }
    const list = objs(res.body);
    out.push(...list);
    const total = Number(res.headers.get('x-total-count'));
    if (list.length < size || (Number.isFinite(total) && total > 0 && out.length >= total)) return out;
  }
}

/** Read a Hanko project through the Admin API. */
export async function exportHankoApi(o: HankoApiOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const progress = o.onProgress ?? (() => undefined);
  const size = Math.min(Math.max(o.pageSize ?? 100, 1), 1000);
  const http = new VendorHttp({
    vendor: 'Hanko',
    baseUrl: o.adminUrl,
    headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {},
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });

  progress('organizations');
  for (const org of (await pages(http, '/organizations', size, true)) ?? []) {
    const id = str(org.id);
    const name = str(org.name);
    if (id && name) set.add('organization', compact({ id, name, created_at: str(org.created_at) }), id);
  }
  progress('roles');
  for (const role of (await pages(http, '/roles', size, true)) ?? []) {
    const slug = str(role.slug);
    if (slug) set.add('role', compact({ key: slug, name: str(role.name), scope: 'organization' as const }), slug);
  }

  progress('users');
  const listed = (await pages(http, '/users', size, false)) ?? [];
  const providers = new Set<string>();
  let withPassword = 0;
  let withTotp = 0;
  let mfaOnly = 0;
  let credentialsWithoutRp = 0;
  for (const [i, item] of listed.entries()) {
    const id = str(item.id);
    if (!id) continue;
    if (i > 0 && i % 100 === 0) progress(`users (${i}/${listed.length})`);
    // The listing has emails, passkeys and username; identities, metadata and names need the user itself.
    let u: Obj = item;
    try {
      const { body } = await http.get<unknown>(`/users/${encodeURIComponent(id)}`);
      if (isObj(body)) u = { ...item, ...body };
    } catch (err) {
      if (!(err instanceof VendorApiError && err.status === 404)) throw err;
    }
    const emailById = new Map<string, string>();
    const emails = sortedEmails(
      objs(u.emails).flatMap((e) => {
        const address = str(e.address)?.toLowerCase();
        if (!address) return [];
        if (str(e.id)) emailById.set(str(e.id)!, address);
        return [{ email: address, verified: e.is_verified === true, primary: e.is_primary === true }];
      }),
    );
    const named = u.username;
    const username = isObj(named) ? str(named.username) : str(named);
    if (!emails.length && !username) {
      set.omit('user', NO_IDENTIFIER);
      continue;
    }
    if (isObj(u.password)) withPassword++;
    if (isObj(u.otp)) withTotp++;
    const meta: Obj = isObj(u.metadata) ? u.metadata : {};
    set.add(
      'user',
      compact<UserRecord>({
        id,
        emails,
        username,
        first_name: str(u.given_name),
        last_name: str(u.family_name),
        name: str(u.name),
        image_url: str(u.picture),
        public_metadata: metadata(meta.public_metadata),
        private_metadata: privateMetadata(metadata(meta.private_metadata), customClaims(u.custom_claims, false)),
        unsafe_metadata: metadata(meta.unsafe_metadata),
        created_at: str(u.created_at),
      }),
      id,
    );

    // The admin DTO names them the other way round: provider_id is the provider's user id, provider_name the provider.
    for (const ident of objs(u.identities)) {
      const provider = str(ident.provider_name);
      const providerUserId = str(ident.provider_id);
      if (!provider || !providerUserId) continue;
      const saml = /^(https?:\/\/|urn:)/i.test(provider);
      if (!saml) providers.add(provider);
      set.add(
        'identity',
        identity({ id: str(ident.id), userId: id, provider, providerUserId, saml, fallbackEmail: emailById.get(str(ident.email_id) ?? '') }),
        `${provider}\u0000${providerUserId}`,
      );
    }

    for (const c of objs(u.webauthn_credentials)) {
      if (!o.rpId) {
        credentialsWithoutRp++;
        continue;
      }
      const record = passkey({
        id: c.id,
        userId: id,
        publicKey: c.public_key,
        rpId: o.rpId,
        aaguid: c.aaguid,
        backedUp: c.backup_state,
        name: c.name,
        transports: strs(c.transports),
        createdAt: c.created_at,
      });
      if (!record) {
        set.omit('passkey', 'WebAuthn credential without an id or public key');
        continue;
      }
      if (c.mfa_only === true) mfaOnly++;
      set.add('passkey', record, record.credential_id);
    }

    for (const org of objs(u.organizations)) {
      const orgId = str(org.id);
      if (!orgId) continue;
      if (str(org.name)) set.add('organization', { id: orgId, name: str(org.name)! }, orgId);
      const roles = objs(org.roles);
      for (const r of roles) if (str(r.slug)) set.add('role', compact({ key: str(r.slug)!, name: str(r.name), scope: 'organization' as const }), str(r.slug)!);
      set.add('membership', { organization_id: orgId, user_id: id, role: membershipRole(roles.map((r) => str(r.slug)).filter((s): s is string => !!s), set) }, `${orgId}\u0000${id}`);
    }
  }

  if (withPassword) {
    set.warn(`${withPassword} user(s) have a Hanko password: the Admin API never returns password hashes, so these move by lazy migration (preset hanko) on each user's first Atlas sign-in — or export from the database instead.`);
  }
  if (withTotp) set.warn(`${withTotp} user(s) use TOTP: the Admin API never returns TOTP secrets, so they enrol an authenticator again in Atlas (a database dump carries the secrets).`);
  if (credentialsWithoutRp) {
    set.omit('passkey', 'No relying-party id given (--set hanko-rp-id)', credentialsWithoutRp);
    set.warn(NO_PASSKEY_RP);
  }
  if (mfaOnly) set.warn(MFA_ONLY_NOTE(mfaOnly));

  if (o.apiUrl) {
    progress('signing keys');
    const pub = new VendorHttp({ vendor: 'Hanko', baseUrl: o.apiUrl, fetchImpl: o.fetchImpl, sleep: o.sleep });
    try {
      const { body } = await pub.get<unknown>('/.well-known/jwks.json');
      for (const jwk of objs(isObj(body) ? body.keys : undefined)) {
        const kid = str(jwk.kid);
        if (kid && jwk.d === undefined) set.add('jwks', { kid, jwk }, kid);
      }
    } catch (err) {
      if (!(err instanceof VendorApiError)) throw err;
      set.warn(`Could not read Hanko's signing keys (${err.message}); the bridge fetches them itself.`);
    }
  }

  set.manifest = compact({ origin: `Hanko Admin API ${o.adminUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`, rpId: o.rpId, providers: [...providers].sort(), settings: { totp: { ...TOTP } } });
  return set;
}
