import type { PasswordHash, Timestamp, UserRecord } from '@atlasauth/migrate';
import { bool, col, text, time, timeMs, type Tables } from './frameworks/tables';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export supertokens` — a SuperTokens core (self-hosted, or the
 * managed service) onto the canonical bundle models. Two ways in:
 *
 *   - a DATABASE DUMP of the core (one file per table, made with
 *     `psql \copy … csv header`, see the guide): everything the core keeps —
 *     password hashes (bcrypt, Argon2), TOTP device secrets, email verification
 *     state, user metadata, roles, tenants, user id mappings;
 *   - the core's HTTP API with its API key (`GET /users`, `/recipe/user/…`,
 *     `/recipe/roles`, `/recipe/multitenancy/tenant/list`): users, linked
 *     login methods, verified flags, metadata, roles and tenants. The API never
 *     returns password hashes or TOTP secrets: those users move by lazy
 *     migration / enrol again.
 *
 * What maps where:
 *   - users: one Atlas user per SuperTokens PRIMARY user (account linking
 *     folds emailpassword, thirdparty and passwordless login methods into one);
 *     the id is the id the app sees (`userid_mapping` external id when set), the
 *     `sub` of every access token;
 *   - emails (verified from `emailverification_verified_emails`; passwordless
 *     addresses and phone numbers are verified by the sign-in itself);
 *   - passwords: bcrypt and Argon2 PHC strings as they are; anything else is
 *     counted and left for lazy migration;
 *   - third-party links as identities (`thirdparty_users`);
 *   - roles (app roles with their permissions; roles a user holds on the
 *     public tenant) and tenants (every non-public tenant becomes an
 *     organization, its users members, roles held there their organization role);
 *   - verified TOTP devices as authenticator-app factors;
 *   - user metadata as private metadata (names carried over when present).
 */

export interface SupertokensExportOptions {
  /** A dump of the core database (one table per file). */
  tables?: Tables;
  /** The core's address (`https://st-dev-abc.aws.supertokens.io`, `http://core:3567`). */
  connectionUri?: string;
  /** The core's API key (`api-key` header). */
  apiKey?: string;
  /** The SuperTokens app id (multi-app cores); `public` by default. */
  appId?: string;
  /** The `table_names_prefix` the core runs with, when it has one. */
  tablePrefix?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/** One way of signing in as seen by the core (a recipe user). */
export interface LoginMethod {
  recipeUserId: string;
  recipeId: string;
  email?: string;
  phone?: string;
  thirdParty?: { id: string; userId: string };
  passwordHash?: string;
  verified: boolean;
  timeJoined?: Timestamp;
  tenantIds: string[];
}

/** A primary user and the login methods linked to it. */
export interface StUser {
  /** The primary user id (before any `userid_mapping`). */
  id: string;
  loginMethods: LoginMethod[];
  timeJoined?: Timestamp;
}

export interface TotpDevice {
  name?: string;
  secret?: string;
  period?: number;
  verified: boolean;
}

export interface SupertokensSnapshot {
  source: 'database' | 'api';
  users: StUser[];
  /** User id → metadata object. */
  metadata: Map<string, Obj>;
  /** Role → permissions. */
  roles: Map<string, string[]>;
  userRoles: Array<{ userId: string; tenantId: string; role: string }>;
  /** Tenant ids other than `public`. */
  tenants: string[];
  /** User id → TOTP devices (a database dump; the API carries no secrets). */
  totp: Map<string, TotpDevice[]>;
  /** User id → last active time (epoch ms). */
  lastActive: Map<string, number>;
  /** SuperTokens user id → the external id the app uses. */
  idMappings: Map<string, string>;
  warnings: string[];
}

const PUBLIC = 'public';
const PAGE = 500;

export async function exportSupertokens(opts: SupertokensExportOptions): Promise<RecordSet> {
  const progress = opts.onProgress ?? (() => undefined);
  const appId = opts.appId?.trim() || PUBLIC;
  let snap: SupertokensSnapshot;
  if (opts.tables) {
    progress('database dump');
    snap = snapshotFromTables(opts.tables, appId, opts.tablePrefix ?? '');
  } else {
    if (!opts.connectionUri) throw new Error('SuperTokens export needs a database dump (--set supertokens-dump=<dir>) or the core address (--set supertokens-connection-uri=<url>) with its API key.');
    snap = await fetchSupertokensSnapshot({ ...opts, connectionUri: normalizeCoreUri(opts.connectionUri), appId, onProgress: progress });
  }
  return buildSupertokensRecordSet(snap, { origin: opts.connectionUri ? new URL(normalizeCoreUri(opts.connectionUri)).host : `SuperTokens database (app ${appId})`, appId });
}

/** `st-dev-x.aws.supertokens.io` → `https://st-dev-x.aws.supertokens.io`; an http address is kept (a core inside your network). */
export function normalizeCoreUri(raw: string): string {
  const t = raw.trim();
  const url = new URL(/^https?:\/\//.test(t) ? t : `https://${t}`);
  return `${url.protocol}//${url.host}`;
}

// ── database dump ───────────────────────────────────────────────────────────

const lower = (v: unknown): string | undefined => text(v)?.toLowerCase();

export function snapshotFromTables(tables: Tables, appId: string, prefix = ''): SupertokensSnapshot {
  const rows = (name: string) =>
    tables.rows(`${prefix}${name}`).filter((r) => {
      const a = text(col(r, 'app_id'));
      return a === undefined || a === appId;
    });
  const verified = new Set(rows('emailverification_verified_emails').map((r) => `${text(col(r, 'user_id'))}\u0000${lower(col(r, 'email'))}`));

  const methods = new Map<string, LoginMethod>();
  for (const r of rows('emailpassword_users')) {
    const id = text(col(r, 'user_id'));
    const email = lower(col(r, 'email'));
    if (id) methods.set(id, { recipeUserId: id, recipeId: 'emailpassword', email, passwordHash: text(col(r, 'password_hash')), verified: verified.has(`${id}\u0000${email}`), timeJoined: time(col(r, 'time_joined')), tenantIds: [] });
  }
  for (const r of rows('thirdparty_users')) {
    const id = text(col(r, 'user_id'));
    const providerId = text(col(r, 'third_party_id'));
    const providerUserId = text(col(r, 'third_party_user_id'));
    const email = lower(col(r, 'email'));
    if (id && providerId && providerUserId) {
      methods.set(id, { recipeUserId: id, recipeId: 'thirdparty', email, thirdParty: { id: providerId, userId: providerUserId }, verified: verified.has(`${id}\u0000${email}`), timeJoined: time(col(r, 'time_joined')), tenantIds: [] });
    }
  }
  for (const r of rows('passwordless_users')) {
    const id = text(col(r, 'user_id'));
    if (id) methods.set(id, { recipeUserId: id, recipeId: 'passwordless', email: lower(col(r, 'email')), phone: e164(col(r, 'phone_number')), verified: true, timeJoined: time(col(r, 'time_joined')), tenantIds: [] });
  }

  // all_auth_recipe_users: which primary user each recipe user is linked to, and the tenants it belongs to.
  const primaryOf = new Map<string, string>();
  for (const r of rows('all_auth_recipe_users')) {
    const id = text(col(r, 'user_id'));
    if (!id) continue;
    primaryOf.set(id, text(col(r, 'primary_or_recipe_user_id')) ?? id);
    const m = methods.get(id);
    const tenant = text(col(r, 'tenant_id')) ?? PUBLIC;
    if (m && !m.tenantIds.includes(tenant)) m.tenantIds.push(tenant);
  }
  const users = new Map<string, StUser>();
  for (const m of methods.values()) {
    if (!m.tenantIds.length) m.tenantIds.push(PUBLIC);
    const primary = primaryOf.get(m.recipeUserId) ?? m.recipeUserId;
    const u = users.get(primary) ?? { id: primary, loginMethods: [] };
    u.loginMethods.push(m);
    users.set(primary, u);
  }
  for (const u of users.values()) {
    // The primary's own method first: its password and email lead.
    u.loginMethods.sort((a, b) => Number(b.recipeUserId === u.id) - Number(a.recipeUserId === u.id));
    u.timeJoined = u.loginMethods.map((m) => m.timeJoined).filter((t): t is Timestamp => t !== undefined).sort((a, b) => stMs(a) - stMs(b))[0];
  }

  const metadata = new Map<string, Obj>();
  for (const r of rows('user_metadata')) {
    const id = text(col(r, 'user_id'));
    const raw = col(r, 'user_metadata');
    const doc = isObj(raw) ? raw : typeof raw === 'string' ? parseJson(raw) : undefined;
    if (id && doc) metadata.set(id, doc);
  }
  const roles = new Map<string, string[]>();
  for (const r of rows('roles')) {
    const role = text(col(r, 'role'));
    if (role) roles.set(role, []);
  }
  for (const r of rows('role_permissions')) {
    const role = text(col(r, 'role'));
    const permission = text(col(r, 'permission'));
    if (role && permission) roles.set(role, [...(roles.get(role) ?? []), permission]);
  }
  const userRoles: SupertokensSnapshot['userRoles'] = [];
  for (const r of rows('userroles')) {
    const userId = text(col(r, 'user_id'));
    const role = text(col(r, 'role'));
    if (userId && role) userRoles.push({ userId, tenantId: text(col(r, 'tenant_id')) ?? PUBLIC, role });
  }
  const tenants = rows('tenants')
    .map((r) => text(col(r, 'tenant_id')))
    .filter((t): t is string => !!t && t !== PUBLIC);

  const totp = new Map<string, TotpDevice[]>();
  for (const r of rows('totp_user_devices')) {
    const id = text(col(r, 'user_id'));
    if (!id) continue;
    const period = Number(col(r, 'period'));
    totp.set(id, [...(totp.get(id) ?? []), { name: text(col(r, 'device_name')), secret: text(col(r, 'secret_key')), period: Number.isFinite(period) && period > 0 ? period : undefined, verified: bool(col(r, 'verified')) }]);
  }
  const lastActive = new Map<string, number>();
  for (const r of rows('user_last_active')) {
    const id = text(col(r, 'user_id'));
    const at = timeMs(col(r, 'last_active_time'));
    if (id && at !== undefined) lastActive.set(id, at);
  }
  const idMappings = new Map<string, string>();
  for (const r of rows('userid_mapping')) {
    const a = text(col(r, 'supertokens_user_id'));
    const b = text(col(r, 'external_user_id'));
    if (a && b) idMappings.set(a, b);
  }
  return { source: 'database', users: [...users.values()], metadata, roles, userRoles, tenants: [...new Set(tenants)], totp, lastActive, idMappings, warnings: [] };
}

const stMs = (t: Timestamp): number => (typeof t === 'number' ? t : Date.parse(t));

function parseJson(v: string): Obj | undefined {
  try {
    const doc = JSON.parse(v) as unknown;
    return isObj(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

// ── core API ────────────────────────────────────────────────────────────────

/** A core client: the API key header, the app and tenant path prefixes. */
export function supertokensHttp(o: { connectionUri: string; apiKey?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): VendorHttp {
  return new VendorHttp({
    vendor: 'SuperTokens',
    baseUrl: o.connectionUri,
    headers: { ...(o.apiKey ? { 'api-key': o.apiKey } : {}), 'cdi-version': '5.1' },
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
}

/** `/appid-<app>/<tenant>` path prefix of an app and tenant on the core (public → none). */
export function corePrefix(appId: string, tenantId: string): string {
  return `${appId === PUBLIC ? '' : `/appid-${encodeURIComponent(appId)}`}${tenantId === PUBLIC ? '' : `/${encodeURIComponent(tenantId)}`}`;
}

async function optional<T>(warnings: string[], what: string, fn: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VendorApiError && [401, 403, 404, 405, 501].includes(err.status)) {
      warnings.push(`${what} could not be read (${err.status}): skipped.`);
      return empty;
    }
    throw err;
  }
}

/** The tenants of an app, from the multitenancy recipe (older cores answer on the v1 path). */
export async function listTenants(http: VendorHttp, appId: string): Promise<Obj[]> {
  const base = corePrefix(appId, PUBLIC);
  try {
    return objs((await http.get<{ tenants?: unknown }>(`${base}/recipe/multitenancy/tenant/list/v2`)).body?.tenants);
  } catch (err) {
    if (!(err instanceof VendorApiError) || err.status !== 404) throw err;
    return objs((await http.get<{ tenants?: unknown }>(`${base}/recipe/multitenancy/tenant/list`)).body?.tenants);
  }
}

function methodOf(m: Obj, fallbackTenants: string[]): LoginMethod | null {
  const recipeUserId = str(m.recipeUserId);
  if (!recipeUserId) return null;
  const tp = isObj(m.thirdParty) ? m.thirdParty : undefined;
  return {
    recipeUserId,
    recipeId: str(m.recipeId) ?? 'emailpassword',
    email: str(m.email)?.toLowerCase(),
    phone: e164(m.phoneNumber),
    thirdParty: tp && str(tp.id) && str(tp.userId) ? { id: str(tp.id)!, userId: str(tp.userId)! } : undefined,
    verified: m.verified === true,
    timeJoined: time(m.timeJoined),
    tenantIds: strs(m.tenantIds).length ? strs(m.tenantIds) : fallbackTenants,
  };
}

export async function fetchSupertokensSnapshot(
  o: SupertokensExportOptions & { connectionUri: string; appId: string; onProgress: (m: string) => void },
): Promise<SupertokensSnapshot> {
  const http = supertokensHttp({ connectionUri: o.connectionUri, apiKey: o.apiKey, fetchImpl: o.fetchImpl, sleep: o.sleep });
  const warnings: string[] = [];
  const { appId } = o;

  o.onProgress('tenants');
  const tenantList = await optional(warnings, 'The tenant list', () => listTenants(http, appId), [] as Obj[]);
  const tenantIds = [PUBLIC, ...tenantList.map((t) => str(t.tenantId)).filter((t): t is string => !!t && t !== PUBLIC)];

  o.onProgress('users');
  const users = new Map<string, StUser>();
  for (const tenantId of tenantIds) {
    let token: string | undefined;
    for (let guard = 0; guard < 100_000; guard++) {
      const q = new URLSearchParams({ limit: String(PAGE), ...(token ? { paginationToken: token } : {}) });
      const { body } = await http.get<{ users?: unknown; nextPaginationToken?: unknown }>(`${corePrefix(appId, tenantId)}/users?${q.toString()}`);
      for (const u of objs(body?.users)) {
        const id = str(u.id);
        if (!id) continue;
        const loginMethods = objs(u.loginMethods)
          .map((m) => methodOf(m, [tenantId]))
          .filter((m): m is LoginMethod => !!m);
        const known = users.get(id);
        if (known) {
          // The same user listed under another tenant: add the tenants it is in.
          for (const m of loginMethods) {
            const have = known.loginMethods.find((x) => x.recipeUserId === m.recipeUserId);
            if (!have) {
              known.loginMethods.push(m);
              continue;
            }
            for (const t of m.tenantIds) if (!have.tenantIds.includes(t)) have.tenantIds.push(t);
          }
        } else {
          users.set(id, { id, loginMethods, timeJoined: time(u.timeJoined) });
        }
      }
      token = str(body?.nextPaginationToken);
      if (!token) break;
    }
  }

  o.onProgress('roles');
  const roles = new Map<string, string[]>();
  const roleNames = await optional(warnings, 'Roles', async () => strs((await http.get<{ roles?: unknown }>(`${corePrefix(appId, PUBLIC)}/recipe/roles`)).body?.roles), [] as string[]);
  for (const role of roleNames) {
    roles.set(role, await optional(warnings, `Permissions of role ${role}`, async () => strs((await http.get<{ permissions?: unknown }>(`${corePrefix(appId, PUBLIC)}/recipe/role/permissions?role=${encodeURIComponent(role)}`)).body?.permissions), [] as string[]));
  }
  const userRoles: SupertokensSnapshot['userRoles'] = [];
  const metadata = new Map<string, Obj>();
  if (roleNames.length || users.size) o.onProgress('user roles and metadata');
  for (const u of users.values()) {
    const tenantsOfUser = new Set(u.loginMethods.flatMap((m) => m.tenantIds));
    if (roleNames.length) {
      for (const tenantId of tenantsOfUser) {
        const list = await optional(warnings, 'User roles', async () => strs((await http.get<{ roles?: unknown }>(`${corePrefix(appId, tenantId)}/recipe/user/roles?userId=${encodeURIComponent(u.id)}`)).body?.roles), [] as string[]);
        for (const role of list) userRoles.push({ userId: u.id, tenantId, role });
      }
    }
    const meta = await optional(warnings, 'User metadata', async () => (await http.get<{ metadata?: unknown }>(`${corePrefix(appId, PUBLIC)}/recipe/user/metadata?userId=${encodeURIComponent(u.id)}`)).body?.metadata, undefined as unknown);
    if (isObj(meta) && Object.keys(meta).length) metadata.set(u.id, meta);
  }
  return {
    source: 'api',
    users: [...users.values()],
    metadata,
    roles,
    userRoles,
    tenants: tenantIds.filter((t) => t !== PUBLIC),
    totp: new Map(),
    lastActive: new Map(),
    idMappings: new Map(),
    warnings: [...new Set(warnings)],
  };
}

// ── passwords ───────────────────────────────────────────────────────────────

/** A SuperTokens `password_hash` → the bundle's password; null for a shape Atlas cannot verify. */
export function mapSupertokensPassword(hash: unknown): PasswordHash | null {
  const h = typeof hash === 'string' ? hash.trim() : '';
  if (!h) return null;
  if (/^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(h)) return { algorithm: 'bcrypt', hash: h };
  if (/^\$argon2(id|i|d)\$/.test(h)) return { algorithm: 'argon2', hash: h };
  return null;
}

// ── records ─────────────────────────────────────────────────────────────────

function keyer(): (name: string, id: string) => string {
  const used = new Set<string>();
  return (name, id) => {
    let key = keyOf(name);
    if (used.has(key)) key = `${key}_${id.slice(-4).toLowerCase()}`;
    used.add(key);
    return key;
  };
}

const BASE32 = /^[A-Z2-7]+$/;

export function buildSupertokensRecordSet(snap: SupertokensSnapshot, o: { origin: string; appId: string }): RecordSet {
  const set = new RecordSet();
  for (const w of snap.warnings) set.warn(w);

  // ── roles: app roles, plus an organization role for each role held on a tenant ──
  const appKey = keyer();
  const orgKey = keyer();
  const appRoleKey = new Map<string, string>();
  const orgRoleKey = new Map<string, string>();
  const tenantRoleNames = new Set(snap.userRoles.filter((r) => r.tenantId !== PUBLIC).map((r) => r.role));
  for (const [role, permissions] of snap.roles) {
    const key = appKey(role, role);
    appRoleKey.set(role, key);
    set.add('role', compact({ key, name: role, scope: 'app' as const, permissions }), `app:${key}`);
    if (tenantRoleNames.has(role)) {
      const okey = orgKey(role, role);
      orgRoleKey.set(role, okey);
      set.add('role', compact({ key: okey, name: role, scope: 'organization' as const, permissions }), `org:${okey}`);
    }
  }

  // ── organizations: one per non-public tenant ──
  const tenantIds = new Set(snap.tenants);
  for (const u of snap.users) for (const m of u.loginMethods) for (const t of m.tenantIds) if (t !== PUBLIC) tenantIds.add(t);
  for (const id of tenantIds) set.add('organization', { id, name: id, slug: keyOf(id) });
  if (tenantIds.size) {
    set.warn(`${tenantIds.size} SuperTokens tenant(s) became organizations: a tenant's own login methods and core settings do not carry over (see the config report); set them up per organization with SSO connections.`);
  }

  // ── users ──
  const algorithms: Record<string, number> = {};
  let unsupported = 0;
  let hashless = 0;
  let unverifiedTotp = 0;
  let badTotp = 0;
  let multiRole = 0;
  let needsMember = false;
  const userIds = new Set<string>();
  for (const u of snap.users) {
    const ids = new Set([u.id, ...u.loginMethods.map((m) => m.recipeUserId)]);
    const external = [...ids].map((i) => snap.idMappings.get(i)).find((x): x is string => !!x);
    if (external) ids.add(external);
    const id = external ?? u.id;
    const held = snap.userRoles.filter((r) => ids.has(r.userId));
    const roles = held.filter((r) => r.tenantId === PUBLIC).map((r) => appRoleKey.get(r.role)).filter((k): k is string => !!k);

    const emails: Array<{ email: string; verified: boolean; primary: boolean }> = [];
    for (const m of u.loginMethods) {
      if (!m.email) continue;
      const have = emails.find((e) => e.email === m.email);
      if (have) have.verified ||= m.verified;
      else emails.push({ email: m.email, verified: m.verified, primary: emails.length === 0 });
    }
    const phones: Array<{ phone: string; verified: boolean; primary: boolean }> = [];
    for (const m of u.loginMethods) if (m.phone && !phones.some((p) => p.phone === m.phone)) phones.push({ phone: m.phone, verified: m.verified, primary: phones.length === 0 });
    if (!emails.length && !phones.length) {
      set.omit('user', 'no email address or phone number');
      continue;
    }

    const withHash = u.loginMethods.find((m) => m.passwordHash);
    const password = mapSupertokensPassword(withHash?.passwordHash);
    if (password) algorithms[password.algorithm] = (algorithms[password.algorithm] ?? 0) + 1;
    else if (withHash) unsupported++;
    else if (snap.source === 'api' && u.loginMethods.some((m) => m.recipeId === 'emailpassword')) hashless++;

    const meta = [...ids].map((i) => snap.metadata.get(i)).find((x): x is Obj => !!x);
    const lastActive = [...ids].map((i) => snap.lastActive.get(i)).find((x): x is number => x !== undefined);
    const user: UserRecord = compact({
      id,
      emails,
      phones,
      first_name: str(meta?.first_name) ?? str(meta?.firstName),
      last_name: str(meta?.last_name) ?? str(meta?.lastName),
      name: str(meta?.name),
      password: password ?? undefined,
      roles,
      private_metadata: bag(meta),
      created_at: u.timeJoined,
      last_sign_in_at: lastActive,
    });
    userIds.add(id);
    set.add('user', user);

    // identities
    for (const m of u.loginMethods) {
      if (!m.thirdParty) continue;
      set.add(
        'identity',
        compact({ user_id: id, provider: m.thirdParty.id, provider_user_id: m.thirdParty.userId, kind: 'oauth' as const, email: m.email, email_verified: m.email ? m.verified : undefined }),
        `${m.thirdParty.id}:${m.thirdParty.userId}`,
      );
    }

    // TOTP devices (a database dump carries the secrets)
    for (const i of ids) {
      for (const d of snap.totp.get(i) ?? []) {
        if (!d.verified) {
          unverifiedTotp++;
          continue;
        }
        const secret = d.secret?.replace(/[\s=]/g, '').toUpperCase();
        if (!secret || !BASE32.test(secret)) {
          badTotp++;
          continue;
        }
        set.add('mfa_factor', compact({ user_id: id, type: 'totp' as const, secret_base32: secret, algorithm: 'SHA1' as const, digits: 6, period: d.period ?? 30, verified: true }), `${id}:${d.name ?? secret}`);
      }
    }

    // tenant memberships
    const tenants = new Set(u.loginMethods.flatMap((m) => m.tenantIds).filter((t) => t !== PUBLIC));
    for (const tenant of tenants) {
      const keys = held.filter((r) => r.tenantId === tenant).map((r) => orgRoleKey.get(r.role)).filter((k): k is string => !!k);
      if (keys.length > 1) multiRole++;
      if (!keys.length) needsMember = true;
      set.add('membership', { organization_id: tenant, user_id: id, role: keys[0] ?? 'member' }, `${tenant}:${id}`);
    }
  }
  if (needsMember) set.add('role', { key: 'member', name: 'Member', scope: 'organization' }, 'org:member');
  if (multiRole) set.warn(`${multiRole} tenant membership(s) hold several roles in SuperTokens; Atlas keeps one role per membership (the first). Merge the permissions into one role where a member needs both.`);

  if (unsupported) set.warn(`${unsupported} user(s) have a password hash Atlas cannot verify (not bcrypt or Argon2, for example a Firebase scrypt import): they reset their password, or move by lazy migration.`);
  if (hashless) set.warn(`${hashless} user(s) sign in with a password the core API never returns: turn on the supertokens lazy-migration preset, or export from the core database.`);
  if (unverifiedTotp) set.omit('mfa_factor', 'a TOTP device that was never verified', unverifiedTotp);
  if (badTotp) set.omit('mfa_factor', 'a TOTP secret that is not base32', badTotp);
  if (snap.source === 'api' && userIds.size) {
    set.warn('The core API never returns password hashes or TOTP secrets: users enrol their authenticator app again, and passwords move by lazy migration unless you export from the core database.');
  }
  set.warn('Sessions are not exported: the core keeps only a double hash of each refresh token. The bridge exchanges the access-token JWT a user still holds instead.');

  set.manifest = {
    origin: o.origin,
    providers: [...new Set(set.list('identity').map((i) => i.provider))].sort(),
    settings: { app_id: o.appId, read_from: snap.source, password_algorithms: algorithms, totp: { algorithm: 'SHA1', digits: 6, period: 30 } },
  };
  return set;
}
