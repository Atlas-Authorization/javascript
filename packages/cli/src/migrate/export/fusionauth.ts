import { createHash } from 'node:crypto';
import type { ApiKeyRecord, IdentityRecord, PasswordHash, SsoConnectionRecord, UserRecord } from '@atlasauth/migrate';
import { bool, col, json, text, time, type Row, type Tables } from './frameworks/tables';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export fusionauth` — a FusionAuth tenant (self-hosted or
 * FusionAuth Cloud) onto the canonical bundle models. Two ways in, both on the
 * owner's machine:
 *
 *   - the API with an API key (read-only is enough): users with their
 *     registrations, roles, groups, linked identity providers, two-factor
 *     methods (SMS, email) and recovery codes, identity providers (SAML v2 /
 *     OpenID Connect as SSO connections), applications and API keys. The API
 *     NEVER returns password hashes or authenticator secrets.
 *   - a DATABASE DUMP of a self-hosted install (one file per table, see
 *     {@link fusionAuthSnapshotFromTables}): the only path with the hashes
 *     (`password`, `salt`, `factor`, `encryption_scheme`) and authenticator
 *     secrets. FusionAuth Cloud has no database access: ask FusionAuth support
 *     for the export, or use the `fusionauth` lazy-migration preset.
 *
 * Both paths build one {@link FusionAuthSnapshot}; {@link mapFusionAuth} maps it.
 * The FusionAuth user id is the `sub` of every FusionAuth JWT, so it is the user id.
 */

export interface FusionAuthSnapshot {
  baseUrl?: string;
  tenants: Obj[];
  /** Applications with their `roles` ([{ name, isDefault, isSuperRole }]). */
  applications: Obj[];
  /** Groups with `roles` ({ <applicationId>: [role names] }). */
  groups: Obj[];
  identityProviders: Obj[];
  /** Public keys by key id (PEM), for SAML identity providers. */
  keys: Record<string, string>;
  apiKeys: Obj[];
  /**
   * Users in the API shape (`registrations`, `memberships`, `twoFactor.methods`) plus what the API
   * cannot return: `password`, `salt`, `factor`, `encryptionScheme`, `links` (identity provider links) and `recoveryCodes`.
   */
  users: Obj[];
  source: 'api' | 'database';
}

export interface FusionAuthMapOptions {
  /** Groups move as organizations (default), as app roles, or not at all. */
  groupsAs?: 'organizations' | 'roles' | 'skip';
  /** Several tenants: each tenant becomes an organization its users belong to. */
  tenantsAs?: 'organizations' | 'skip';
}

// ── password schemes ────────────────────────────────────────────────────────

/**
 * A FusionAuth password (`password`, `salt`, `factor`, `encryption_scheme`) →
 * an Atlas hash. Schemes and their registry ids are documented in core's
 * fusionauth-hashes.ts; salts are base64 except bcrypt's 22-character salt.
 */
export function fusionAuthPassword(u: { password?: unknown; salt?: unknown; factor?: unknown; encryptionScheme?: unknown }): { hash: PasswordHash } | { problem: string } | null {
  const value = str(u.password);
  if (!value) return null;
  const scheme = str(u.encryptionScheme)?.toLowerCase();
  const salt = str(u.salt);
  const factor = Number(u.factor);
  if (!scheme) return { problem: 'no encryption scheme' };
  const needs = (what: string) => ({ problem: `${scheme} without ${what}` });
  if (scheme === 'bcrypt') {
    if (!salt || !Number.isInteger(factor) || factor < 4 || factor > 31) return needs('a salt or cost factor');
    return { hash: { algorithm: 'bcrypt', hash: `$2a$${String(factor).padStart(2, '0')}$${salt}${value}` } };
  }
  const pbkdf2 = /^salted-pbkdf2-hmac-(sha256|sha512)(?:-512)?$/.exec(scheme);
  if (pbkdf2) {
    if (!salt || !Number.isInteger(factor) || factor < 1) return needs('a salt or iteration count');
    return { hash: { algorithm: 'pbkdf2', hash: value, salt, params: { digest: pbkdf2[1]!, iterations: factor, encoding: 'base64', salt_encoding: 'base64' } } };
  }
  if (scheme === 'salted-hmac-sha256') {
    if (!salt) return needs('a salt');
    return { hash: { algorithm: 'hmac_sha256', hash: value, salt, params: { key_encoding: 'base64', encoding: 'base64' } } };
  }
  if (scheme === 'salted-md5' || scheme === 'salted-sha256') {
    if (!salt || !Number.isInteger(factor) || factor < 1) return needs('a salt or factor');
    return { hash: { algorithm: 'fusionauth_salted', hash: value, salt, params: { digest: scheme === 'salted-md5' ? 'md5' : 'sha256', iterations: factor } } };
  }
  if (scheme === 'phpass-md5' || scheme === 'phppass-sha512' || scheme === 'phpass-sha512') {
    if (!salt || !Number.isInteger(factor) || factor < 1) return needs('a salt or factor');
    return { hash: { algorithm: 'fusionauth_phpass', hash: value, salt, params: { digest: scheme === 'phpass-md5' ? 'md5' : 'sha512', iterations: factor } } };
  }
  return { problem: `the "${scheme}" scheme (a custom password plugin)` };
}

// ── reading ─────────────────────────────────────────────────────────────────

export interface FusionAuthApiOptions {
  /** `https://auth.example.com` or `https://acme.fusionauth.io`. */
  baseUrl: string;
  apiKey: string;
  /** Required by FusionAuth when the API key is not tenant-locked and there are several tenants. */
  tenantId?: string;
  pageSize?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (m: string) => void;
}

export function fusionAuthBase(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(s) ? s : `https://${s}`;
}

export function fusionAuthHttp(o: FusionAuthApiOptions): VendorHttp {
  return new VendorHttp({
    vendor: 'FusionAuth',
    baseUrl: fusionAuthBase(o.baseUrl),
    headers: { authorization: o.apiKey, ...(o.tenantId ? { 'X-FusionAuth-TenantId': o.tenantId } : {}) },
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
}

/** Read a tenant through the API into a snapshot. */
export async function fetchFusionAuth(http: VendorHttp, o: Pick<FusionAuthApiOptions, 'baseUrl' | 'pageSize' | 'onProgress'> & { warn?: (m: string) => void }): Promise<FusionAuthSnapshot> {
  const progress = o.onProgress ?? (() => undefined);
  const warn = o.warn ?? (() => undefined);
  const size = Math.min(Math.max(o.pageSize ?? 100, 1), 1000);
  /** A resource the key may not read (401/403) or this version lacks (404). */
  const optional = async <T>(path: string, what: string, pick: (b: Obj) => T, empty: T): Promise<T> => {
    try {
      const { body } = await http.get<unknown>(path);
      return isObj(body) ? pick(body) : empty;
    } catch (err) {
      if (!(err instanceof VendorApiError) || ![401, 403, 404].includes(err.status)) throw err;
      if (err.status !== 404) warn(`${what} could not be read with this API key (${err.status}) and were skipped.`);
      return empty;
    }
  };

  progress('tenants and applications');
  const tenants = await optional('/api/tenant', 'Tenants', (b) => objs(b.tenants), [] as Obj[]);
  const applications = await optional('/api/application', 'Applications', (b) => objs(b.applications), [] as Obj[]);
  progress('groups');
  const groups = await optional('/api/group', 'Groups', (b) => objs(b.groups), [] as Obj[]);
  progress('identity providers');
  const identityProviders = await optional('/api/identity-provider', 'Identity providers', (b) => objs(b.identityProviders), [] as Obj[]);
  const keys: Record<string, string> = {};
  for (const idp of identityProviders) {
    const keyId = str(idp.keyId);
    if (!keyId || keys[keyId]) continue;
    const pem = await optional(`/api/key/${encodeURIComponent(keyId)}`, `Key ${keyId}`, (b) => (isObj(b.key) ? str(b.key.publicKey) : undefined), undefined);
    if (pem) keys[keyId] = pem;
  }
  progress('API keys');
  const apiKeys = await optional('/api/api-key', 'API keys', (b) => objs(b.apiKeys), [] as Obj[]);

  progress('users');
  const users: Obj[] = [];
  for (let startRow = 0; ; startRow += size) {
    const { body } = await http.post<unknown>('/api/user/search', { search: { queryString: '*', numberOfResults: size, startRow } });
    const page = isObj(body) ? objs(body.users) : [];
    users.push(...page);
    const total = isObj(body) && typeof body.total === 'number' ? body.total : undefined;
    if (page.length < size || (total !== undefined && startRow + size >= total)) break;
  }
  for (const [i, u] of users.entries()) {
    const id = str(u.id);
    if (!id) continue;
    if (i > 0 && i % 100 === 0) progress(`users (${i}/${users.length})`);
    u.links = await optional(`/api/identity-provider/link?userId=${encodeURIComponent(id)}`, 'Identity provider links', (b) => objs(b.identityProviderLinks), [] as Obj[]);
    const methods = isObj(u.twoFactor) ? objs(u.twoFactor.methods) : [];
    if (methods.length) u.recoveryCodes = await optional(`/api/user/two-factor/recovery-code/${encodeURIComponent(id)}`, 'Recovery codes', (b) => strs(b.recoveryCodes), [] as string[]);
  }
  return { baseUrl: fusionAuthBase(o.baseUrl), tenants, applications, groups, identityProviders, keys, apiKeys, users, source: 'api' };
}

const roleLookup = (rows: Row[], idCol: string[]): Map<string, Row> => new Map(rows.map((r) => [text(col(r, ...idCol)) ?? '', r]));

/**
 * A snapshot from a dump of a self-hosted FusionAuth database: one file per
 * table (`psql \copy users TO 'users.csv' CSV HEADER`, or `mysql … --batch`
 * converted, or a JSON array), named as in FusionAuth's schema: `users`,
 * `identities` (1.59+), `tenants`, `applications`, `application_roles`,
 * `user_registrations`, `user_registrations_application_roles`, `groups`,
 * `group_members`, `group_application_roles`, `identity_providers`,
 * `identity_provider_links`, `twofactor_methods`, `twofactor_recovery_codes`,
 * `api_keys`, `keys`.
 */
export function fusionAuthSnapshotFromTables(t: Tables): FusionAuthSnapshot {
  const tenantRows = t.rows('tenants');
  const tenants = tenantRows.map((r) => {
    const data = json(col(r, 'data')) ?? {};
    return compact({ id: text(col(r, 'id')), name: text(col(r, 'name')), issuer: text(data.issuer) ?? text(col(r, 'issuer')) }) as Obj;
  });
  const appRoles = t.rows('application_roles');
  const roleById = roleLookup(appRoles, ['id']);
  const rolesByApp = new Map<string, Obj[]>();
  for (const r of appRoles) {
    const appId = text(col(r, 'applications_id', 'application_id'));
    if (!appId) continue;
    const list = rolesByApp.get(appId) ?? [];
    list.push({ id: text(col(r, 'id')), name: text(col(r, 'name')), isDefault: bool(col(r, 'is_default')), isSuperRole: bool(col(r, 'is_super_role')) });
    rolesByApp.set(appId, list);
  }
  const applications = t.rows('applications').map((r) => ({
    id: text(col(r, 'id')),
    name: text(col(r, 'name')),
    tenantId: text(col(r, 'tenants_id', 'tenant_id')),
    roles: rolesByApp.get(text(col(r, 'id')) ?? '') ?? [],
  }));

  const groupRoles = new Map<string, Record<string, string[]>>();
  for (const r of t.rows('group_application_roles')) {
    const role = roleById.get(text(col(r, 'application_roles_id', 'application_role_id')) ?? '');
    const gid = text(col(r, 'groups_id', 'group_id'));
    const name = role && text(col(role, 'name'));
    const appId = role && text(col(role, 'applications_id', 'application_id'));
    if (!gid || !name || !appId) continue;
    const m = groupRoles.get(gid) ?? {};
    (m[appId] ??= []).push(name);
    groupRoles.set(gid, m);
  }
  const groups = t.rows('groups').map((r) => ({ id: text(col(r, 'id')), name: text(col(r, 'name')), tenantId: text(col(r, 'tenants_id', 'tenant_id')), roles: groupRoles.get(text(col(r, 'id')) ?? '') ?? {} }));

  const memberships = new Map<string, Obj[]>();
  for (const r of t.rows('group_members')) {
    const uid = text(col(r, 'users_id', 'user_id'));
    if (!uid) continue;
    (memberships.get(uid) ?? memberships.set(uid, []).get(uid)!).push({ groupId: text(col(r, 'groups_id', 'group_id')) });
  }
  const regRoles = new Map<string, string[]>();
  for (const r of t.rows('user_registrations_application_roles')) {
    const role = roleById.get(text(col(r, 'application_roles_id', 'application_role_id')) ?? '');
    const rid = text(col(r, 'user_registrations_id', 'user_registration_id'));
    const name = role && text(col(role, 'name'));
    if (rid && name) (regRoles.get(rid) ?? regRoles.set(rid, []).get(rid)!).push(name);
  }
  const registrations = new Map<string, Obj[]>();
  for (const r of t.rows('user_registrations')) {
    const uid = text(col(r, 'users_id', 'user_id'));
    if (!uid) continue;
    (registrations.get(uid) ?? registrations.set(uid, []).get(uid)!).push({
      applicationId: text(col(r, 'applications_id', 'application_id')),
      username: text(col(r, 'username')),
      verified: bool(col(r, 'verified')),
      roles: regRoles.get(text(col(r, 'id')) ?? '') ?? [],
    });
  }
  const links = new Map<string, Obj[]>();
  for (const r of t.rows('identity_provider_links', 'identity_providers_links')) {
    const uid = text(col(r, 'users_id', 'user_id'));
    if (!uid) continue;
    (links.get(uid) ?? links.set(uid, []).get(uid)!).push({
      identityProviderId: text(col(r, 'identity_providers_id', 'identity_provider_id')),
      identityProviderUserId: text(col(r, 'identity_provider_user_id')),
      displayName: text(col(r, 'display_name')),
    });
  }
  const methods = new Map<string, Obj[]>();
  for (const r of t.rows('twofactor_methods', 'two_factor_methods')) {
    const uid = text(col(r, 'users_id', 'user_id'));
    if (!uid) continue;
    const settings = json(col(r, 'settings', 'data')) ?? {};
    const authenticator = isObj(settings.authenticator) ? settings.authenticator : {};
    (methods.get(uid) ?? methods.set(uid, []).get(uid)!).push(
      compact({ id: text(col(r, 'id')), method: text(col(r, 'method')), mobilePhone: text(col(r, 'mobile_phone')), email: text(col(r, 'email')), authenticator: compact({ ...authenticator, secret: text(col(r, 'secret')) }) }),
    );
  }
  const recovery = new Map<string, string[]>();
  for (const r of t.rows('twofactor_recovery_codes', 'two_factor_recovery_codes')) {
    const uid = text(col(r, 'users_id', 'user_id'));
    const raw = col(r, 'recovery_codes', 'codes');
    let codes: string[] = [];
    if (Array.isArray(raw)) codes = strs(raw);
    else if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown;
        codes = Array.isArray(parsed) ? strs(parsed) : [];
      } catch {
        codes = raw.split(/[\s,;]+/).filter(Boolean);
      }
    }
    if (uid && codes.length) recovery.set(uid, codes);
  }

  // 1.59+ keeps email / username in `identities`; older versions have them on `users`.
  const identities = new Map<string, Row[]>();
  for (const r of t.rows('identities')) {
    const uid = text(col(r, 'users_id', 'user_id'));
    if (uid) (identities.get(uid) ?? identities.set(uid, []).get(uid)!).push(r);
  }
  const users = t.rows('users').map((r) => {
    const id = text(col(r, 'id'))!;
    const idents = identities.get(id) ?? [];
    const emailRow = idents.find((i) => text(col(i, 'email')));
    const nameRow = idents.find((i) => text(col(i, 'username')));
    const data = json(col(r, 'data')) ?? {};
    const mfa = methods.get(id) ?? [];
    // Before 1.26 a single secret lived on the user row.
    const legacySecret = text(col(r, 'two_factor_secret'));
    if (!mfa.length && legacySecret) mfa.push({ method: 'authenticator', authenticator: { secret: legacySecret } });
    return compact({
      id,
      tenantId: text(col(r, 'tenants_id', 'tenant_id')),
      email: text(col(emailRow ?? r, 'email')),
      verified: bool(col(emailRow ?? r, 'verified')),
      username: text(col(nameRow ?? r, 'username')),
      firstName: text(col(r, 'first_name')),
      lastName: text(col(r, 'last_name')),
      fullName: text(col(r, 'full_name')),
      mobilePhone: text(col(r, 'mobile_phone')),
      imageUrl: text(col(r, 'image_url')),
      active: col(r, 'active') === undefined ? true : bool(col(r, 'active')),
      insertInstant: time(col(r, 'insert_instant')),
      lastLoginInstant: time(col(r, 'last_login_instant')),
      passwordChangeRequired: bool(col(r, 'password_change_required')),
      data,
      password: text(col(r, 'password')),
      salt: text(col(r, 'salt')),
      factor: col(r, 'factor'),
      encryptionScheme: text(col(r, 'encryption_scheme')),
      registrations: registrations.get(id) ?? [],
      memberships: memberships.get(id) ?? [],
      twoFactor: mfa.length ? { methods: mfa } : undefined,
      links: links.get(id) ?? [],
      recoveryCodes: recovery.get(id),
    }) as Obj;
  });

  const idps = t.rows('identity_providers').map((r) => {
    const data = json(col(r, 'data', 'settings')) ?? {};
    return { ...data, id: text(col(r, 'id')), type: text(col(r, 'type')), name: text(col(r, 'name')), enabled: col(r, 'enabled') === undefined ? true : bool(col(r, 'enabled')), keyId: text(col(r, 'keys_id', 'key_id')) ?? text(data.keyId) } as Obj;
  });
  const keys: Record<string, string> = {};
  for (const r of t.rows('keys')) {
    const id = text(col(r, 'id'));
    const pem = text(col(r, 'public_key', 'certificate'));
    if (id && pem) keys[id] = pem;
  }
  const apiKeys = t.rows('api_keys').map((r) =>
    compact({
      id: text(col(r, 'id')),
      key: text(col(r, 'key_value', 'key')),
      keyManager: bool(col(r, 'key_manager')),
      metaData: json(col(r, 'meta_data', 'metadata')),
      tenantId: text(col(r, 'tenants_id', 'tenant_id')),
      expirationInstant: time(col(r, 'expiration_instant', 'expiration')),
      insertInstant: time(col(r, 'insert_instant')),
    }),
  ) as Obj[];
  return { tenants, applications, groups, identityProviders: idps, keys, apiKeys, users, source: 'database' };
}

// ── mapping ─────────────────────────────────────────────────────────────────

/** Enterprise identity providers: SSO connections, not social sign-in. */
const ENTERPRISE = new Set(['SAMLv2', 'OpenIDConnect', 'SAMLv2IdPInitiated']);

const epoch = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? v : typeof v === 'string' ? (Date.parse(v) || undefined) : undefined);

function authenticatorSecret(raw: string): string | undefined {
  // FusionAuth keeps the authenticator secret base64 encoded; Atlas wants base32.
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length) return undefined;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}

/** Map a snapshot (API or database) onto canonical records. */
export function mapFusionAuth(snap: FusionAuthSnapshot, opts: FusionAuthMapOptions = {}): RecordSet {
  const set = new RecordSet();
  const groupsAs = opts.groupsAs ?? 'organizations';
  const tenantsAs = opts.tenantsAs ?? (snap.tenants.length > 1 ? 'organizations' : 'skip');
  const tenantName = new Map(snap.tenants.map((t) => [str(t.id) ?? '', str(t.name) ?? str(t.id) ?? '']));
  const appName = new Map(snap.applications.map((a) => [str(a.id) ?? '', str(a.name) ?? '']));

  // ── organizations: tenants and groups ──
  const orgIds = new Set<string>();
  if (tenantsAs === 'organizations') {
    for (const t of snap.tenants) {
      const id = str(t.id);
      if (!id) continue;
      orgIds.add(`tenant:${id}`);
      set.add('organization', compact({ id: `tenant:${id}`, name: tenantName.get(id)!, slug: keyOf(tenantName.get(id)!).replace(/_/g, '-'), private_metadata: { fusionauth_tenant_id: id, fusionauth_issuer: str(t.issuer) } }));
    }
  }
  const groups = new Map<string, Obj>();
  for (const g of snap.groups) if (str(g.id) && str(g.name)) groups.set(str(g.id)!, g);
  if (groupsAs === 'organizations') {
    for (const g of groups.values()) {
      const id = str(g.id)!;
      orgIds.add(`group:${id}`);
      set.add('organization', { id: `group:${id}`, name: str(g.name)!, slug: keyOf(str(g.name)!).replace(/_/g, '-'), private_metadata: { fusionauth_group_id: id } });
    }
  }
  if (orgIds.size) set.add('role', { key: 'member', name: 'Member', scope: 'organization' }, 'org:member');

  // ── roles: application roles (FusionAuth puts the plain names in the JWT roles claim) ──
  for (const app of snap.applications) {
    for (const r of objs(app.roles)) {
      const name = str(r.name);
      if (!name) continue;
      set.add('role', compact({ key: keyOf(name), name, description: r.isSuperRole === true ? `Super role of ${appName.get(str(app.id) ?? '') || 'an application'}` : undefined, scope: 'app' as const }), keyOf(name));
    }
  }
  if (groupsAs === 'roles') {
    for (const g of groups.values()) set.add('role', { key: `group:${keyOf(str(g.name)!)}`, name: str(g.name)!, description: 'FusionAuth group', scope: 'app' }, `group:${keyOf(str(g.name)!)}`);
  }

  // ── identity providers ──
  const idps = new Map<string, Obj>();
  for (const idp of snap.identityProviders) if (str(idp.id)) idps.set(str(idp.id)!, idp);
  const connections = new Set<string>();
  for (const [id, idp] of idps) {
    const type = str(idp.type) ?? '';
    if (!ENTERPRISE.has(type)) continue;
    if (type === 'SAMLv2IdPInitiated') {
      set.omit('sso_connection', `IdP-initiated SAML provider ${str(idp.name) ?? id}: Atlas SAML connections are SP-initiated`);
      continue;
    }
    set.add('sso_connection', ssoConnection(idp, id, snap, (m) => set.warn(m)));
    connections.add(id);
  }

  // ── users ──
  const counts = { password: 0, totp: 0, forced: 0, inactive: 0 };
  const badHashes = new Map<string, number>();
  const seenUsernames = new Set<string>();
  const userIds = new Set<string>();
  for (const u of snap.users) {
    const id = str(u.id);
    if (!id) continue;
    const email = str(u.email)?.toLowerCase();
    const username = str(u.username)?.toLowerCase();
    const phone = e164(u.mobilePhone);
    if (!email && !username && !phone) {
      set.omit('user', 'no email, username or phone');
      continue;
    }
    const name = str(u.fullName);
    const user: UserRecord = compact({
      id,
      emails: email ? [{ email, verified: u.verified === true, primary: true }] : [],
      phones: phone ? [{ phone, verified: false, primary: !email }] : [],
      username: username && !seenUsernames.has(username) ? username : undefined,
      first_name: str(u.firstName),
      last_name: str(u.lastName),
      name: !str(u.firstName) && !str(u.lastName) ? name : undefined,
      image_url: typeof u.imageUrl === 'string' && /^https:\/\//.test(u.imageUrl) ? u.imageUrl : undefined,
      banned: u.active === false ? true : undefined,
      ban_reason: u.active === false ? 'Deactivated in FusionAuth' : undefined,
      private_metadata: bag(compact({ ...(isObj(u.data) ? u.data : {}), fusionauth_tenant_id: str(u.tenantId), fusionauth_password_change_required: u.passwordChangeRequired === true ? true : undefined })),
      created_at: epoch(u.insertInstant),
      last_sign_in_at: epoch(u.lastLoginInstant),
    });
    if (username) seenUsernames.add(username);
    if (u.active === false) counts.inactive++;
    if (u.passwordChangeRequired === true) counts.forced++;

    const pw = fusionAuthPassword(u);
    if (pw && 'hash' in pw) user.password = pw.hash;
    else if (pw) badHashes.set(pw.problem, (badHashes.get(pw.problem) ?? 0) + 1);
    else if (snap.source === 'api') counts.password++;

    // Application roles from every registration, plus the roles of the user's groups.
    const roles = new Set<string>();
    for (const reg of objs(u.registrations)) for (const r of strs(reg.roles)) roles.add(keyOf(r));
    const memberOf = objs(u.memberships).map((m) => groups.get(str(m.groupId) ?? '')).filter((g): g is Obj => !!g);
    for (const g of memberOf) {
      for (const names of Object.values(isObj(g.roles) ? g.roles : {})) for (const r of strs(names)) roles.add(keyOf(r));
      if (groupsAs === 'roles') roles.add(`group:${keyOf(str(g.name)!)}`);
    }
    if (roles.size) user.roles = [...roles];
    set.add('user', compact(user));
    userIds.add(id);

    // Linked identities.
    for (const link of objs(u.links)) {
      const idp = idps.get(str(link.identityProviderId) ?? '');
      const providerUserId = str(link.identityProviderUserId);
      if (!idp || !providerUserId) continue;
      const identity = linkIdentity(idp, link, id, providerUserId, connections);
      set.add('identity', identity, `${identity.provider}:${providerUserId}`);
    }

    // Second factors.
    const methods = isObj(u.twoFactor) ? objs(u.twoFactor.methods) : [];
    for (const m of methods) {
      const method = str(m.method);
      if (method === 'authenticator') {
        const a = isObj(m.authenticator) ? m.authenticator : {};
        const secret = str(a.secret) ? authenticatorSecret(str(a.secret)!) : undefined;
        if (!secret) {
          counts.totp++;
          continue;
        }
        const algo = str(a.algorithm)?.toUpperCase().replace('HMAC', '').replace('-', '');
        set.add('mfa_factor', compact({
          user_id: id,
          type: 'totp' as const,
          secret_base32: secret,
          digits: typeof a.codeLength === 'number' ? a.codeLength : 6,
          period: typeof a.timeStep === 'number' ? a.timeStep : 30,
          algorithm: algo === 'SHA256' || algo === 'SHA512' ? algo : ('SHA1' as const),
          verified: true,
        }), `totp:${id}:${str(m.id) ?? ''}`);
      } else if (method === 'sms') {
        const p = e164(m.mobilePhone);
        if (p) set.add('mfa_factor', { user_id: id, type: 'phone', phone: p, verified: true }, `phone:${id}:${p}`);
      } else if (method === 'email') {
        set.add('mfa_factor', { user_id: id, type: 'email', verified: true }, `email:${id}`);
      } else if (method) set.omit('mfa_factor', `FusionAuth two-factor method "${method}" has no Atlas counterpart`);
    }
    const codes = strs(u.recoveryCodes);
    if (codes.length) set.add('mfa_factor', { user_id: id, type: 'backup_codes', backup_codes: codes }, `recovery:${id}`);

    // Memberships.
    if (tenantsAs === 'organizations' && str(u.tenantId) && orgIds.has(`tenant:${str(u.tenantId)}`)) {
      set.add('membership', { organization_id: `tenant:${str(u.tenantId)}`, user_id: id, role: 'member' }, `tenant:${str(u.tenantId)}:${id}`);
    }
    if (groupsAs === 'organizations') {
      for (const g of memberOf) set.add('membership', { organization_id: `group:${str(g.id)}`, user_id: id, role: 'member' }, `group:${str(g.id)}:${id}`);
    }
  }

  // ── API keys ──
  let managers = 0;
  for (const k of snap.apiKeys) {
    const key = str(k.key);
    const id = str(k.id);
    if (!id || !key) continue;
    if (k.keyManager === true) {
      managers++;
      continue;
    }
    const meta = isObj(k.metaData) ? k.metaData : {};
    const attrs = isObj(meta.attributes) ? meta.attributes : {};
    const endpoints = isObj(k.permissions) && isObj(k.permissions.endpoints) ? Object.keys(k.permissions.endpoints) : [];
    const record: ApiKeyRecord = compact({
      id,
      name: str(attrs.description) ?? `FusionAuth API key ${id.slice(0, 8)}`,
      hash: createHash('sha256').update(key, 'utf8').digest('hex'),
      hash_algorithm: 'sha256' as const,
      start: key.slice(0, 6),
      scopes: endpoints.length ? endpoints : undefined,
      expires_at: epoch(k.expirationInstant),
      created_at: epoch(k.insertInstant),
    });
    set.add('api_key', record);
  }
  if (managers) set.omit('api_key', 'FusionAuth key-manager API keys (they manage other keys)', managers);
  if (snap.apiKeys.length) set.warn('FusionAuth API keys are imported as Atlas API keys carrying the endpoint permissions as scopes: review each before cutover (a FusionAuth key authorises FusionAuth endpoints, not Atlas ones).');

  // ── what could not move ──
  if (counts.password) {
    set.warn(
      `${counts.password} user(s) have a FusionAuth password, but the API never returns password hashes. Export from the database of a self-hosted install (--set fusionauth-dump=<dir>), ask FusionAuth support for the hashes (Cloud), or turn on the fusionauth lazy-migration preset: each password is then checked against FusionAuth on its first Atlas sign-in.`,
    );
  }
  if (counts.totp) set.warn(`${counts.totp} user(s) use an authenticator app; FusionAuth returns no authenticator secrets over the API (a database export carries them). Those users enrol again in Atlas.`);
  if (counts.forced) set.warn(`${counts.forced} user(s) must change their password at next sign-in in FusionAuth; their current password was set by an administrator.`);
  for (const [problem, n] of badHashes) set.warn(`${n} user(s) were imported without a password (${problem}); they reset it, or use lazy migration.`);
  set.warn('FusionAuth sessions are not exportable: the fusionauth bridge preset exchanges FusionAuth access tokens for Atlas sessions instead.');

  const tenant = snap.tenants[0];
  set.manifest = {
    origin: snap.baseUrl ?? (str(tenant?.name) ? `tenant ${str(tenant?.name)}` : 'fusionauth'),
    sourceVersion: null,
    providers: [...new Set(set.list('identity').map((i) => i.provider))].sort(),
    settings: compact({
      source: snap.source === 'api' ? 'api' : 'database',
      groups_as: groupsAs,
      tenants_as: tenantsAs,
      issuer: snap.tenants.length === 1 ? str(snap.tenants[0]!.issuer) : undefined,
    }),
  };
  return set;
}

function linkIdentity(idp: Obj, link: Obj, userId: string, providerUserId: string, connections: Set<string>): IdentityRecord {
  const id = str(idp.id)!;
  const type = str(idp.type) ?? '';
  const enterprise = connections.has(id);
  return compact({
    user_id: userId,
    provider: enterprise ? id : type.toLowerCase(),
    provider_user_id: providerUserId,
    kind: enterprise ? (type === 'SAMLv2' ? ('saml' as const) : ('oidc' as const)) : ('oauth' as const),
    sso_connection_id: enterprise ? id : undefined,
    profile: bag(compact({ display_name: str(link.displayName) })),
  });
}

function ssoConnection(idp: Obj, id: string, snap: FusionAuthSnapshot, warn: (m: string) => void): SsoConnectionRecord {
  const name = str(idp.name) ?? id;
  const domains = strs(idp.domains).map((d) => d.toLowerCase());
  if (str(idp.type) === 'SAMLv2') {
    const keyId = str(idp.keyId);
    const cert = keyId ? snap.keys[keyId] : undefined;
    if (!cert) warn(`SAML identity provider ${name}: its verification certificate could not be read; add it in Atlas.`);
    return compact({
      id,
      name,
      protocol: 'saml' as const,
      domains,
      enabled: idp.enabled !== false,
      saml: compact({
        idp_entity_id: str(idp.issuer),
        idp_sso_url: str(idp.idpEndpoint),
        idp_certificate: cert,
        attribute_mapping: str(idp.emailClaim) ? { email: str(idp.emailClaim)! } : undefined,
      }),
    });
  }
  const o = isObj(idp.oauth2) ? idp.oauth2 : {};
  const secret = str(o.client_secret);
  // FusionAuth returns the secret to a key that may read identity providers; a masked or absent one cannot be used.
  const real = secret && !/^\*+$/.test(secret) ? secret : undefined;
  if (!real) warn(`OIDC identity provider ${name}: its client secret was not available; enter it on the SSO connection after the import.`);
  const issuer = str(o.issuer);
  return compact({
    id,
    name,
    protocol: 'oidc' as const,
    domains,
    enabled: idp.enabled !== false,
    oidc: compact({
      issuer,
      discovery_url: issuer ? `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration` : undefined,
      client_id: str(o.client_id),
      client_secret: real,
      scopes: str(o.scope)?.split(/\s+/).filter(Boolean),
    }),
  });
}

// ── the exporter the plugin calls ───────────────────────────────────────────

export interface ExportFusionAuthOptions extends FusionAuthMapOptions {
  /** A database dump of a self-hosted install (hashes and authenticator secrets included). */
  tables?: Tables;
  /** The API, when exporting live (no hashes, no authenticator secrets). */
  api?: FusionAuthApiOptions;
}

export async function exportFusionAuth(o: ExportFusionAuthOptions): Promise<RecordSet> {
  if (o.tables) {
    const snap = fusionAuthSnapshotFromTables(o.tables);
    if (o.api?.baseUrl) snap.baseUrl = fusionAuthBase(o.api.baseUrl);
    return mapFusionAuth(snap, o);
  }
  if (!o.api) throw new Error('FusionAuth: pass a database dump, or the URL and an API key.');
  const warnings: string[] = [];
  const snap = await fetchFusionAuth(fusionAuthHttp(o.api), { baseUrl: o.api.baseUrl, pageSize: o.api.pageSize, onProgress: o.api.onProgress, warn: (m) => warnings.push(m) });
  const set = mapFusionAuth(snap, o);
  for (const w of warnings) set.warn(w);
  return set;
}
