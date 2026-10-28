import type { PasswordHash, SsoConnectionRecord, UserRecord } from '@atlasauth/migrate';
import { base64url, bool, col, sha256Hex, text, time, type Row, type Tables } from './frameworks/tables';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export logto` — Logto (self-hosted OSS and Logto Cloud) onto
 * the canonical bundle models. Two ways in:
 *
 *   - a DATABASE DUMP of a self-hosted Logto (one file per table, made with
 *     `psql \copy … csv header` or `json_agg`, see the guide): everything,
 *     including MFA secrets — TOTP keys, WebAuthn credentials (passkeys) and
 *     backup codes live in `users.mfa_verifications`, which no API returns;
 *   - the MANAGEMENT API with a machine-to-machine app (`client_credentials`
 *     against `{endpoint}/oidc/token`, resource `https://{tenant}.logto.app/api`,
 *     `default` for OSS): users, roles, organizations, invitations, SSO
 *     connectors. The API is asked for password hashes too
 *     (`includePasswordHash=true`) and uses them when a Logto version returns
 *     them; otherwise passwords move by lazy migration. MFA secrets never
 *     leave over the API: those users enrol again.
 *
 * What maps where:
 *   - users: username, primary email / phone (Logto only stores them once
 *     verified, or set by an admin), name, avatar, OIDC profile, custom data;
 *     suspended users arrive banned. `user.id` is the Logto user id, the `sub`
 *     of every Logto token.
 *   - passwords: Argon2i/id/d PHC strings, bcrypt, unsalted MD5/SHA1/SHA256
 *     hex, and `Legacy` expressions (`["sha256", ["salt", "@"], "…"]`): the
 *     plain shapes map onto the registry's ids, the rest keep the expression
 *     for the `logto_legacy` verifier.
 *   - social identities (`users.identities`, keyed by connector target) and
 *     enterprise SSO identities (`user_sso_identities`, with their connector);
 *   - roles (tenant "User" roles with their API scopes as permissions; M2M
 *     roles are app credentials and stay behind), organizations (JIT email
 *     domains as verified domains), organization roles with organization and
 *     API scopes, memberships, invitations;
 *   - personal access tokens (stored in plain text by Logto: Atlas keeps the
 *     sha256, so they keep working);
 *   - the tenant's public signing keys (`/oidc/jwks`) for the cutover.
 */

export interface LogtoExportOptions {
  /** A self-hosted Logto database dump (one table per file). */
  tables?: Tables;
  /** The Logto endpoint (`https://auth.example.com`, `https://abc123.logto.app`): the Management API, the JWKS, the passkey rp id and SAML SP URLs. */
  endpoint?: string;
  /** A machine-to-machine app with the Management API role (API export). */
  m2m?: { appId: string; appSecret: string };
  /** The tenant: `default` on a self-hosted Logto, the Cloud tenant id (the `abc123` of abc123.logto.app). */
  tenantId?: string;
  /** The WebAuthn relying-party id passkeys were registered on (default: the endpoint's host). */
  rpId?: string;
  /** API export: read each user's personal access tokens too (one call per user). */
  personalAccessTokens?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/** Everything the record mapping needs, the same shape from a dump or the API (camelCase rows). */
export interface LogtoSnapshot {
  source: 'database' | 'api';
  users: Obj[];
  /** Tenant roles of type User (machine-to-machine roles are left out). */
  roles: Obj[];
  /** Role id → permission (scope) names. */
  rolePermissions: Map<string, string[]>;
  /** User id → role ids. */
  userRoles: Map<string, string[]>;
  organizations: Obj[];
  organizationRoles: Obj[];
  /** Organization role id → organization scope and API scope names. */
  organizationRolePermissions: Map<string, string[]>;
  members: Array<{ organizationId: string; userId: string; roleIds: string[] }>;
  invitations: Array<{ row: Obj; roleIds: string[] }>;
  /** Organization id → JIT email domains. */
  organizationDomains: Map<string, string[]>;
  ssoConnectors: Obj[];
  ssoIdentities: Obj[];
  personalAccessTokens: Obj[];
  jwks: Obj[];
  /** Users carry `mfaVerifications` (a database dump); the API never returns factor secrets. */
  hasFactors: boolean;
}

/** Logto user columns the user record carries itself (the rest of `profile` lands in metadata). */
const NAME_KEYS = new Set(['givenName', 'familyName']);

/** The Management API's page size cap. */
const PAGE = 100;
/** TOTP as Logto runs it (otplib authenticator defaults). */
const TOTP = { algorithm: 'SHA1' as const, digits: 6, period: 30 };

export async function exportLogto(opts: LogtoExportOptions): Promise<RecordSet> {
  const progress = opts.onProgress ?? (() => undefined);
  const endpoint = opts.endpoint ? normalizeEndpoint(opts.endpoint) : undefined;
  // A dump names its tenant (`default` when self-hosted); the API's is in a Cloud endpoint.
  const tenantId = opts.tenantId ?? (!opts.tables && endpoint ? tenantOfEndpoint(endpoint) : null) ?? 'default';
  let snap: LogtoSnapshot;
  if (opts.tables) {
    progress('database dump');
    snap = snapshotFromTables(opts.tables, tenantId);
    // The public signing keys, when the endpoint is known (never from the dump: logto_configs holds the PRIVATE keys).
    if (endpoint) snap.jwks = await readJwks(new VendorHttp({ vendor: 'Logto', baseUrl: endpoint, fetchImpl: opts.fetchImpl, sleep: opts.sleep, attempts: 2 })).catch(() => []);
  } else {
    if (!endpoint) throw new Error('Logto export needs a database dump (--set logto-dump=<dir>) or the Logto endpoint and a machine-to-machine app for the Management API.');
    if (!opts.m2m) throw new Error('The Logto Management API needs a machine-to-machine app id and secret (LOGTO_M2M_APP_ID / LOGTO_M2M_APP_SECRET).');
    snap = await fetchLogtoSnapshot({ ...opts, endpoint, m2m: opts.m2m, tenantId, onProgress: progress });
  }
  return buildLogtoRecordSet(snap, { endpoint, tenantId, rpId: opts.rpId ?? (endpoint ? new URL(endpoint).hostname : undefined) });
}

/** `https://auth.example.com/` → `https://auth.example.com` (https only, no path). */
export function normalizeEndpoint(raw: string): string {
  const withScheme = /^https?:\/\//.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error(`The Logto endpoint must be https: ${raw}`);
  return `${url.protocol}//${url.host}`;
}

/** The Cloud tenant id of `https://abc123.logto.app`, or null for any other host. */
export function tenantOfEndpoint(endpoint: string): string | null {
  const m = /^https:\/\/([a-z0-9]+)\.logto\.app$/.exec(endpoint);
  return m ? m[1]! : null;
}

/** The Management API resource indicator of a tenant. */
export function managementResource(tenantId: string): string {
  return `https://${tenantId}.logto.app/api`;
}

// ── database dump ───────────────────────────────────────────────────────────

/** JSONB columns (camelCase): a CSV dump carries them as JSON text. */
const JSON_KEYS = new Set([
  'profile',
  'identities',
  'customData',
  'logtoConfig',
  'mfaVerifications',
  'config',
  'domains',
  'branding',
  'color',
  'metadata',
  'detail',
  'oidcClientMetadata',
  'customClientMetadata',
  'protectedAppMetadata',
  'signIn',
  'signUp',
  'socialSignIn',
  'socialSignInConnectorTargets',
  'passwordPolicy',
  'mfa',
  'adaptiveMfa',
  'trustedDevice',
  'languageInfo',
  'customContent',
  'captchaPolicy',
  'sentinelPolicy',
  'emailBlocklistPolicy',
  'verificationCodePolicy',
  'forgotPasswordMethods',
  'passkeySignIn',
  'signUpProfileFields',
  'passwordExpiration',
  'usernamePolicy',
]);

/** A database row as the Management API would spell it: camelCase keys, JSONB parsed. */
export function logtoRow(row: Row): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(row)) {
    const key = k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    out[key] = JSON_KEYS.has(key) && typeof v === 'string' ? parseJson(v) : v;
  }
  return out;
}

function parseJson(v: string): unknown {
  const t = v.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return v;
  }
}

/** One table's rows of one tenant (a dump made with `where tenant_id = …` has every row already). */
export function tenantRows(tables: Tables, name: string, tenantId: string): Obj[] {
  return tables
    .rows(name)
    .filter((r) => {
      const t = text(col(r, 'tenant_id', 'tenantId'));
      return t === undefined || t === tenantId;
    })
    .map(logtoRow);
}

function group(rows: Obj[], key: string, value: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const k = str(r[key]);
    const v = str(r[value]);
    if (!k || !v) continue;
    out.set(k, [...(out.get(k) ?? []), v]);
  }
  return out;
}

export function snapshotFromTables(tables: Tables, tenantId: string): LogtoSnapshot {
  const t = (name: string) => tenantRows(tables, name, tenantId);
  const roles = t('roles').filter((r) => str(r.type) !== 'MachineToMachine');
  const roleIds = new Set(roles.map((r) => str(r.id)).filter((x): x is string => !!x));
  const scopeName = new Map(t('scopes').map((s) => [str(s.id) ?? '', str(s.name) ?? ''] as const));
  const orgScopeName = new Map(t('organization_scopes').map((s) => [str(s.id) ?? '', str(s.name) ?? ''] as const));
  const named = (ids: string[] | undefined, names: Map<string, string>) => (ids ?? []).map((id) => names.get(id)).filter((n): n is string => !!n);

  const rolePermissions = new Map<string, string[]>();
  for (const [roleId, scopeIds] of group(t('roles_scopes'), 'roleId', 'scopeId')) rolePermissions.set(roleId, named(scopeIds, scopeName));
  const userRoles = new Map<string, string[]>();
  for (const [userId, ids] of group(t('users_roles'), 'userId', 'roleId')) userRoles.set(userId, ids.filter((id) => roleIds.has(id)));

  const organizationRoles = t('organization_roles').filter((r) => str(r.type) !== 'MachineToMachine');
  const orgScopes = group(t('organization_role_scope_relations'), 'organizationRoleId', 'organizationScopeId');
  const orgResourceScopes = group(t('organization_role_resource_scope_relations'), 'organizationRoleId', 'scopeId');
  const organizationRolePermissions = new Map<string, string[]>();
  for (const r of organizationRoles) {
    const id = str(r.id);
    if (id) organizationRolePermissions.set(id, [...named(orgScopes.get(id), orgScopeName), ...named(orgResourceScopes.get(id), scopeName)]);
  }

  const memberRoles = new Map<string, string[]>();
  for (const r of t('organization_role_user_relations')) {
    const k = `${str(r.organizationId)}:${str(r.userId)}`;
    const role = str(r.organizationRoleId);
    if (role) memberRoles.set(k, [...(memberRoles.get(k) ?? []), role]);
  }
  const members = t('organization_user_relations')
    .map((r) => ({ organizationId: str(r.organizationId) ?? '', userId: str(r.userId) ?? '' }))
    .filter((m) => m.organizationId && m.userId)
    .map((m) => ({ ...m, roleIds: memberRoles.get(`${m.organizationId}:${m.userId}`) ?? [] }));

  const invitationRoles = group(t('organization_invitation_role_relations'), 'organizationInvitationId', 'organizationRoleId');
  return {
    source: 'database',
    users: t('users'),
    roles,
    rolePermissions,
    userRoles,
    organizations: t('organizations'),
    organizationRoles,
    organizationRolePermissions,
    members,
    invitations: t('organization_invitations').map((row) => ({ row, roleIds: invitationRoles.get(str(row.id) ?? '') ?? [] })),
    organizationDomains: group(t('organization_jit_email_domains'), 'organizationId', 'emailDomain'),
    ssoConnectors: t('sso_connectors'),
    ssoIdentities: t('user_sso_identities'),
    personalAccessTokens: t('personal_access_tokens'),
    jwks: [],
    hasFactors: true,
  };
}

// ── Management API ──────────────────────────────────────────────────────────

/** A Management API client: an M2M access token fetched (and refreshed) on this machine. */
export function logtoManagementHttp(o: {
  endpoint: string;
  m2m: { appId: string; appSecret: string };
  tenantId: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): VendorHttp {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  let cached: { token: string; until: number } | null = null;
  const token = async (): Promise<string> => {
    if (cached && cached.until > now()) return cached.token;
    const res = await fetchImpl(`${o.endpoint}/oidc/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${o.m2m.appId}:${o.m2m.appSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', resource: managementResource(o.tenantId), scope: 'all' }).toString(),
    });
    const body = (await res.json().catch(() => null)) as Obj | null;
    const access = str(body?.access_token);
    if (res.status !== 200 || !access) {
      throw new VendorApiError('Logto', res.status, '/oidc/token', str(body?.error_description) ?? str(body?.error) ?? 'no access token (check the app id, secret and the Management API role)');
    }
    const ttl = typeof body?.expires_in === 'number' ? body.expires_in : 3600;
    cached = { token: access, until: now() + Math.max(ttl - 60, 30) * 1000 };
    return access;
  };
  return new VendorHttp({ vendor: 'Logto', baseUrl: o.endpoint, headers: async () => ({ authorization: `Bearer ${await token()}` }), fetchImpl: o.fetchImpl, sleep: o.sleep });
}

/** Every page of a paginated Management API listing (`page`, `page_size`). */
async function pages(http: VendorHttp, path: string): Promise<Obj[]> {
  const out: Obj[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= 100_000; page++) {
    const { body } = await http.get<unknown>(`${path}${sep}page=${page}&page_size=${PAGE}`);
    const rows = objs(body);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** A listing an older Logto (or a narrower token) may not have: empty, with a warning. */
async function optional<T>(warnings: string[], what: string, fn: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VendorApiError && [401, 403, 404, 501].includes(err.status)) {
      warnings.push(`${what} could not be read (${err.status}): skipped.`);
      return empty;
    }
    throw err;
  }
}

async function readJwks(http: VendorHttp): Promise<Obj[]> {
  const { body } = await http.get<{ keys?: unknown }>('/oidc/jwks');
  return objs(body?.keys);
}

export async function fetchLogtoSnapshot(
  o: Omit<LogtoExportOptions, 'tables' | 'endpoint' | 'm2m'> & { endpoint: string; m2m: { appId: string; appSecret: string }; tenantId: string; onProgress: (m: string) => void; warnings?: string[] },
): Promise<LogtoSnapshot & { warnings: string[] }> {
  const http = logtoManagementHttp({ endpoint: o.endpoint, m2m: o.m2m, tenantId: o.tenantId, fetchImpl: o.fetchImpl, sleep: o.sleep });
  const warnings: string[] = o.warnings ?? [];

  o.onProgress('users');
  const users = await pages(http, '/api/users?includePasswordHash=true');

  o.onProgress('roles');
  const roles = (await pages(http, '/api/roles')).filter((r) => str(r.type) !== 'MachineToMachine');
  const rolePermissions = new Map<string, string[]>();
  const userRoles = new Map<string, string[]>();
  for (const r of roles) {
    const id = str(r.id);
    if (!id) continue;
    const { body } = await http.get<unknown>(`/api/roles/${encodeURIComponent(id)}/scopes`);
    rolePermissions.set(id, objs(body).map((s) => str(s.name)).filter((s): s is string => !!s));
    for (const u of await pages(http, `/api/roles/${encodeURIComponent(id)}/users`)) {
      const uid = str(u.id);
      if (uid) userRoles.set(uid, [...(userRoles.get(uid) ?? []), id]);
    }
  }

  o.onProgress('organizations');
  const organizations = await optional(warnings, 'Organizations', () => pages(http, '/api/organizations'), []);
  const organizationRoles = (await optional(warnings, 'Organization roles', () => pages(http, '/api/organization-roles'), [])).filter((r) => str(r.type) !== 'MachineToMachine');
  const organizationRolePermissions = new Map<string, string[]>();
  for (const r of organizationRoles) {
    const id = str(r.id);
    if (!id) continue;
    organizationRolePermissions.set(id, [...objs(r.scopes), ...objs(r.resourceScopes)].map((s) => str(s.name)).filter((s): s is string => !!s));
  }
  const members: LogtoSnapshot['members'] = [];
  const organizationDomains = new Map<string, string[]>();
  for (const org of organizations) {
    const id = str(org.id);
    if (!id) continue;
    for (const u of await pages(http, `/api/organizations/${encodeURIComponent(id)}/users`)) {
      const uid = str(u.id);
      if (uid) members.push({ organizationId: id, userId: uid, roleIds: objs(u.organizationRoles).map((x) => str(x.id)).filter((x): x is string => !!x) });
    }
    const domains = await optional(warnings, `JIT email domains of organization ${id}`, async () => objs((await http.get<unknown>(`/api/organizations/${encodeURIComponent(id)}/jit/email-domains`)).body), []);
    const list = domains.map((d) => str(d.emailDomain)).filter((d): d is string => !!d);
    if (list.length) organizationDomains.set(id, list);
  }
  const invitations = (await optional(warnings, 'Organization invitations', async () => objs((await http.get<unknown>('/api/organization-invitations')).body), [])).map((row) => ({
    row,
    roleIds: objs(row.organizationRoles).map((x) => str(x.id)).filter((x): x is string => !!x),
  }));

  o.onProgress('enterprise SSO');
  const ssoConnectors = await optional(warnings, 'SSO connectors', async () => objs((await http.get<unknown>('/api/sso-connectors')).body), []);
  const ssoIdentities: Obj[] = [];
  if (ssoConnectors.length) {
    // SSO identities only come with the single-user read.
    for (const u of users) {
      const uid = str(u.id);
      if (!uid) continue;
      const { body } = await http.get<Obj>(`/api/users/${encodeURIComponent(uid)}?includeSsoIdentities=true`);
      for (const s of objs(isObj(body) ? body.ssoIdentities : undefined)) ssoIdentities.push({ ...s, userId: str(s.userId) ?? uid });
    }
  }

  const personalAccessTokens: Obj[] = [];
  if (o.personalAccessTokens) {
    o.onProgress('personal access tokens');
    for (const u of users) {
      const uid = str(u.id);
      if (!uid) continue;
      const rows = await optional(warnings, 'Personal access tokens', async () => objs((await http.get<unknown>(`/api/users/${encodeURIComponent(uid)}/personal-access-tokens`)).body), []);
      for (const p of rows) personalAccessTokens.push({ ...p, userId: str(p.userId) ?? uid });
    }
  }

  o.onProgress('signing keys');
  const jwks = await optional(warnings, 'The signing keys (/oidc/jwks)', () => readJwks(http), []);

  return {
    source: 'api',
    users,
    roles,
    rolePermissions,
    userRoles,
    organizations,
    organizationRoles,
    organizationRolePermissions,
    members,
    invitations,
    organizationDomains,
    ssoConnectors,
    ssoIdentities,
    personalAccessTokens,
    jwks,
    hasFactors: false,
    warnings: [...new Set(warnings)],
  };
}

// ── passwords ───────────────────────────────────────────────────────────────

const PLAIN_DIGESTS = new Set(['md5', 'sha1', 'sha256', 'sha512']);
const PBKDF2_DIGESTS = new Set(['sha1', 'sha256', 'sha384', 'sha512']);
const HEX = /^[0-9a-f]+$/i;

/** A Logto `Legacy` expression `["algorithm", [args with "@"], "hash"]`, or null. */
export function parseLegacyExpression(value: string): { algorithm: string; args: string[]; hash: string } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(doc) || doc.length !== 3) return null;
  const [algorithm, args, hash] = doc as [unknown, unknown, unknown];
  if (typeof algorithm !== 'string' || typeof hash !== 'string' || !Array.isArray(args)) return null;
  if (!args.every((a): a is string => typeof a === 'string') || !args.includes('@')) return null;
  return { algorithm, args, hash };
}

/**
 * A Logto password digest and its `password_encryption_method` → the bundle's
 * password. Null when the user has none or Logto itself could not verify it.
 */
export function mapLogtoPassword(digest: unknown, method: unknown): PasswordHash | null {
  const d = typeof digest === 'string' ? digest.trim() : '';
  if (!d) return null;
  switch (str(method)) {
    case 'Argon2i':
    case 'Argon2id':
    case 'Argon2d':
      return /^\$argon2(id|i|d)\$/.test(d) ? { algorithm: 'argon2', hash: d } : null;
    case 'Bcrypt':
      return { algorithm: 'bcrypt', hash: d };
    // hash-wasm hex digests of the bare password.
    case 'MD5':
      return { algorithm: 'md5', hash: d, params: { encoding: 'hex' } };
    case 'SHA1':
      return { algorithm: 'sha1', hash: d, params: { encoding: 'hex' } };
    case 'SHA256':
      return { algorithm: 'sha256', hash: d, params: { encoding: 'hex' } };
    case 'Legacy':
      return mapLegacy(d);
    default:
      return null;
  }
}

function mapLegacy(d: string): PasswordHash | null {
  const e = parseLegacyExpression(d);
  if (!e) return null;
  const { algorithm, args, hash } = e;
  const at = args.indexOf('@');
  // The plain shapes onto the registry's own verifiers.
  if (PLAIN_DIGESTS.has(algorithm) && HEX.test(hash)) {
    if (args.length === 1) return { algorithm, hash, params: { encoding: 'hex' } };
    const salt = args.length === 2 ? args[at === 0 ? 1 : 0]! : '@';
    if (salt !== '@') return { algorithm: `${algorithm}_salted`, hash, salt, params: { salt_position: at === 0 ? 'suffix' : 'prefix', encoding: 'hex' } };
  }
  if ((algorithm === 'pbkdf2' || algorithm === 'pbkdf2Sync') && args.length === 5 && at === 4) {
    const [salt, iterations, keylen, digest] = args as [string, string, string, string];
    const hexSalt = salt.startsWith('hex:') ? salt.slice(4) : undefined;
    const ok =
      PBKDF2_DIGESTS.has(digest) && /^\d+$/.test(iterations) && /^\d+$/.test(keylen) && HEX.test(hash) && hash.length === Number(keylen) * 2 && (hexSalt === undefined || (HEX.test(hexSalt) && hexSalt.length % 2 === 0));
    if (ok) {
      return {
        algorithm: 'pbkdf2',
        hash,
        salt: hexSalt ?? salt,
        params: { digest, iterations: Number(iterations), key_length: Number(keylen), encoding: 'hex', salt_encoding: hexSalt === undefined ? 'utf8' : 'hex' },
      };
    }
  }
  if (algorithm === 'firebase-scrypt' && args.length === 6 && at === 5) {
    const [salt, signerKey, separator, rounds, memCost] = args as [string, string, string, string, string];
    return { algorithm: 'scrypt_firebase', hash, salt, params: { signer_key: signerKey, salt_separator: separator, rounds: Number(rounds), mem_cost: Number(memCost) } };
  }
  // Everything else (several args around the password, other digests, PBKDF2
  // variants, SHA-crypt) keeps the expression for the logto_legacy verifier.
  return { algorithm: 'logto_legacy', hash: d };
}

// ── records ─────────────────────────────────────────────────────────────────

/** A unique key per name within a scope (`Billing Admin` → `billing_admin`, then `billing_admin_x1y2`). */
function keyer(): (name: string, id: string) => string {
  const used = new Set<string>();
  return (name, id) => {
    let key = keyOf(name);
    if (used.has(key)) key = `${key}_${id.slice(-4).toLowerCase()}`;
    used.add(key);
    return key;
  };
}

/** One Logto user → a user record (null when it has nothing to sign in with). */
export function mapLogtoUser(u: Obj, roles: string[] = []): { user: UserRecord | null; passwordUnsupported: boolean } {
  const id = str(u.id);
  if (!id) return { user: null, passwordUnsupported: false };
  const profile = isObj(u.profile) ? u.profile : {};
  const primary = str(u.primaryEmail)?.toLowerCase();
  const phone = e164(u.primaryPhone);
  const username = str(u.username);
  // Logto keeps no verified flag: an address is only set once verified (or by an admin).
  const emails = primary ? [{ email: primary, verified: true, primary: true }] : [];
  if (!primary && !phone && !username) {
    // A social-only account: the provider's address, unverified, so the user can be matched.
    const social = Object.values(isObj(u.identities) ? u.identities : {})
      .map((i) => (isObj(i) && isObj(i.details) ? str(i.details.email)?.toLowerCase() : undefined))
      .find((e) => e?.includes('@'));
    if (social) emails.push({ email: social, verified: false, primary: true });
  }
  const digest = u.passwordEncrypted ?? u.passwordDigest;
  const method = u.passwordEncryptionMethod ?? u.passwordAlgorithm;
  const password = mapLogtoPassword(digest, method);
  const extraProfile = Object.fromEntries(Object.entries(profile).filter(([k, v]) => !NAME_KEYS.has(k) && v !== null && v !== undefined && v !== ''));
  const suspended = bool(u.isSuspended);
  const user: UserRecord = compact({
    id,
    emails,
    phones: phone ? [{ phone, verified: true, primary: !primary }] : [],
    username,
    first_name: str(profile.givenName),
    last_name: str(profile.familyName),
    name: str(u.name),
    image_url: str(u.avatar),
    password: password ?? undefined,
    roles,
    banned: suspended ? true : undefined,
    ban_reason: suspended ? 'Suspended in Logto' : undefined,
    public_metadata: bag(u.customData),
    private_metadata: bag({
      ...(Object.keys(extraProfile).length ? { logto_profile: extraProfile } : {}),
      ...(str(u.applicationId) ? { logto_application_id: str(u.applicationId) } : {}),
      ...(bool(u.isPasswordExpired) ? { logto_password_expired: true } : {}),
    }),
    created_at: time(u.createdAt),
    last_sign_in_at: time(u.lastSignInAt),
  });
  const ok = !!(user.emails?.length || user.phones?.length || user.username);
  return { user: ok ? user : null, passwordUnsupported: !password && typeof digest === 'string' && digest.trim() !== '' };
}

/** SAML providers vs OIDC ones (Logto's SsoProviderName). */
const SAML_PROVIDERS = new Set(['SAML', 'AzureAD']);

function mapSsoConnector(c: Obj, endpoint: string | undefined): SsoConnectionRecord | null {
  const id = str(c.id);
  const provider = str(c.providerName);
  if (!id || !provider) return null;
  const config = isObj(c.config) ? c.config : {};
  const domains = strs(c.domains);
  const name = str(c.connectorName) ?? provider;
  if (SAML_PROVIDERS.has(provider)) {
    const mapping = isObj(config.attributeMapping) ? Object.fromEntries(Object.entries(config.attributeMapping).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
    return compact({
      id,
      name,
      protocol: 'saml' as const,
      domains,
      enabled: true,
      saml: compact({
        idp_entity_id: str(config.entityId),
        idp_sso_url: str(config.signInEndpoint),
        idp_certificate: str(config.x509Certificate),
        idp_metadata_url: str(config.metadataUrl),
        idp_metadata_xml: str(config.metadata),
        // Logto's SP identifiers: the IdP must be updated when these change.
        sp_entity_id: endpoint ? `${endpoint}/enterprise-sso/${id}` : undefined,
        sp_acs_url: endpoint ? `${endpoint}/api/authn/single-sign-on/saml/${id}` : undefined,
        attribute_mapping: Object.keys(mapping).length ? mapping : undefined,
      }),
    });
  }
  // OIDC, Okta, Azure AD (OIDC) and Google Workspace are OpenID Connect underneath.
  const issuer = str(config.issuer) ?? (provider === 'GoogleWorkspace' ? 'https://accounts.google.com' : undefined);
  return compact({
    id,
    name,
    protocol: 'oidc' as const,
    domains,
    enabled: true,
    oidc: compact({
      issuer,
      client_id: str(config.clientId),
      client_secret: str(config.clientSecret),
      scopes: str(config.scope)?.split(/[ +]/).filter(Boolean),
    }),
  });
}

const INVITATION_STATUS: Record<string, 'pending' | 'accepted' | 'revoked' | 'expired'> = { Pending: 'pending', Accepted: 'accepted', Revoked: 'revoked', Expired: 'expired' };

export function buildLogtoRecordSet(
  snap: LogtoSnapshot & { warnings?: string[] },
  o: { endpoint?: string; tenantId: string; rpId?: string },
): RecordSet {
  const set = new RecordSet();
  for (const w of snap.warnings ?? []) set.warn(w);

  // ── roles ──
  const appKey = keyer();
  const appRoleKey = new Map<string, string>();
  const defaults: string[] = [];
  for (const r of snap.roles) {
    const id = str(r.id);
    const name = str(r.name);
    if (!id || !name) continue;
    const key = appKey(name, id);
    appRoleKey.set(id, key);
    if (bool(r.isDefault)) defaults.push(name);
    set.add('role', compact({ key, name, description: str(r.description), scope: 'app' as const, permissions: snap.rolePermissions.get(id) ?? [] }), `app:${key}`);
  }
  if (defaults.length) {
    set.warn(`Logto gives every new user the default role(s) ${defaults.join(', ')}; Atlas does not assign roles at sign-up. Existing users keep them; give new users the role with an action or the Backend API.`);
  }
  const orgKey = keyer();
  const orgRoleKey = new Map<string, string>();
  for (const r of snap.organizationRoles) {
    const id = str(r.id);
    const name = str(r.name);
    if (!id || !name) continue;
    const key = orgKey(name, id);
    orgRoleKey.set(id, key);
    set.add('role', compact({ key, name, description: str(r.description), scope: 'organization' as const, permissions: snap.organizationRolePermissions.get(id) ?? [] }), `org:${key}`);
  }

  // ── organizations ──
  const orgIds = new Set<string>();
  for (const org of snap.organizations) {
    const id = str(org.id);
    const name = str(org.name);
    if (!id || !name) continue;
    orgIds.add(id);
    const branding = isObj(org.branding) ? org.branding : {};
    set.add(
      'organization',
      compact({
        id,
        name,
        image_url: str(branding.logoUrl),
        domains: snap.organizationDomains.get(id) ?? [],
        public_metadata: bag({ ...(isObj(org.customData) ? org.customData : {}), ...(str(org.description) ? { description: str(org.description) } : {}) }),
        private_metadata: bool(org.isMfaRequired) ? { logto_mfa_required: true } : undefined,
        created_at: time(org.createdAt),
      }),
    );
  }
  if (snap.organizations.some((org) => bool(org.isMfaRequired))) {
    set.warn('Some organizations require MFA of their members in Logto (private_metadata.logto_mfa_required): set an organization MFA policy in Atlas.');
  }

  // ── enterprise SSO ──
  const connectorProtocol = new Map<string, 'saml' | 'oidc'>();
  const connectorName = new Map<string, string>();
  for (const c of snap.ssoConnectors) {
    const record = mapSsoConnector(c, o.endpoint);
    if (!record) continue;
    connectorProtocol.set(record.id, record.protocol);
    connectorName.set(record.id, record.name ?? record.id);
    set.add('sso_connection', record);
  }
  if (snap.ssoConnectors.some((c) => SAML_PROVIDERS.has(str(c.providerName) ?? '')) && !o.endpoint) {
    set.warn('The Logto endpoint was not given, so the SAML connections carry no SP entity id / ACS URL: pass --set logto-endpoint=<url> to record them.');
  }

  // ── users ──
  const userIds = new Set<string>();
  const algorithms: Record<string, number> = {};
  let unsupported = 0;
  let hashless = 0;
  for (const u of snap.users) {
    const id = str(u.id);
    const roles = (snap.userRoles.get(id ?? '') ?? []).map((r) => appRoleKey.get(r)).filter((k): k is string => !!k);
    const { user, passwordUnsupported } = mapLogtoUser(u, roles);
    if (!user) {
      set.omit('user', 'no email, phone number or username');
      continue;
    }
    userIds.add(user.id);
    set.add('user', user);
    if (user.password) algorithms[user.password.algorithm] = (algorithms[user.password.algorithm] ?? 0) + 1;
    if (passwordUnsupported) unsupported++;
    if (!user.password && !passwordUnsupported && u.hasPassword === true) hashless++;
  }
  if (unsupported) set.warn(`${unsupported} user(s) have a password hash Logto itself cannot verify (unknown method or malformed Legacy expression): they reset their password, or move by lazy migration.`);
  if (hashless) {
    set.warn(
      `${hashless} user(s) have a password the Management API did not return (the Management API does not return hashes on every Logto version, or the token is read-only): turn on the logto lazy-migration preset, or export from the database.`,
    );
  }
  if (snap.source === 'api' && userIds.size) {
    set.warn('The Management API never returns MFA secrets (TOTP keys, WebAuthn credentials, backup codes): users with MFA enrol again in Atlas, or export from the database to keep them.');
  }

  // ── identities ──
  for (const u of snap.users) {
    const id = str(u.id);
    if (!id || !userIds.has(id)) continue;
    for (const [target, identity] of Object.entries(isObj(u.identities) ? u.identities : {})) {
      if (!isObj(identity)) continue;
      const providerUserId = str(identity.userId);
      if (!providerUserId) continue;
      const details = isObj(identity.details) ? identity.details : {};
      set.add('identity', compact({ user_id: id, provider: target, provider_user_id: providerUserId, kind: 'oauth' as const, email: str(details.email)?.toLowerCase(), profile: bag(details) }), `${target}:${providerUserId}`);
    }
  }
  for (const s of snap.ssoIdentities) {
    const userId = str(s.userId);
    const connectorId = str(s.ssoConnectorId);
    const identityId = str(s.identityId);
    if (!userId || !userIds.has(userId) || !connectorId || !identityId) continue;
    if (!connectorProtocol.has(connectorId)) {
      set.omit('identity', 'SSO identity of a connector the export does not carry');
      continue;
    }
    const detail = isObj(s.detail) ? s.detail : {};
    set.add(
      'identity',
      compact({
        id: str(s.id),
        user_id: userId,
        provider: connectorName.get(connectorId) ?? connectorId,
        provider_user_id: identityId,
        kind: connectorProtocol.get(connectorId),
        sso_connection_id: connectorId,
        email: str(detail.email)?.toLowerCase(),
        profile: bag({ ...detail, ...(str(s.issuer) ? { issuer: str(s.issuer) } : {}) }),
      }),
      `sso:${connectorId}:${identityId}`,
    );
  }

  // ── second factors and passkeys (database dumps) ──
  if (snap.hasFactors) {
    for (const u of snap.users) {
      const userId = str(u.id);
      if (!userId || !userIds.has(userId)) continue;
      const factors = Array.isArray(u.mfaVerifications) ? objs(u.mfaVerifications) : [];
      for (const f of factors) addFactor(set, userId, f, o.rpId);
    }
  }

  // ── memberships and invitations ──
  let multiRole = 0;
  let fallback = false;
  for (const m of snap.members) {
    if (!orgIds.has(m.organizationId) || !userIds.has(m.userId)) continue;
    const keys = m.roleIds.map((r) => orgRoleKey.get(r)).filter((k): k is string => !!k);
    if (keys.length > 1) multiRole++;
    if (!keys.length) fallback = true;
    set.add('membership', { organization_id: m.organizationId, user_id: m.userId, role: keys[0] ?? 'member' }, `${m.organizationId}:${m.userId}`);
  }
  if (fallback && !set.list('role').some((r) => r.scope === 'organization' && r.key === 'member')) {
    set.add('role', { key: 'member', name: 'Member', scope: 'organization' }, 'org:member');
  }
  if (multiRole) {
    set.warn(`${multiRole} membership(s) hold several organization roles in Logto; Atlas keeps one role per membership (the first). Merge the permissions into one role where a member needs both.`);
  }
  for (const { row, roleIds } of snap.invitations) {
    const id = str(row.id);
    const email = str(row.invitee)?.toLowerCase();
    const organizationId = str(row.organizationId);
    if (!id || !email || !email.includes('@')) {
      set.omit('invitation', 'the invitee is not an email address');
      continue;
    }
    if (organizationId && !orgIds.has(organizationId)) continue;
    set.add(
      'invitation',
      compact({
        id,
        organization_id: organizationId,
        email,
        role: roleIds.map((r) => orgRoleKey.get(r)).find((k): k is string => !!k),
        status: INVITATION_STATUS[str(row.status) ?? ''],
        inviter_user_id: str(row.inviterId),
        expires_at: time(row.expiresAt),
        created_at: time(row.createdAt),
      }),
    );
  }

  // ── personal access tokens ──
  for (const p of snap.personalAccessTokens) {
    const userId = str(p.userId);
    const name = str(p.name);
    const value = str(p.value);
    if (!userId || !userIds.has(userId) || !name || !value) continue;
    set.add('api_key', compact({ id: `${userId}:${name}`, user_id: userId, name, hash: sha256Hex(value), hash_algorithm: 'sha256' as const, start: value.slice(0, 8), expires_at: time(p.expiresAt), created_at: time(p.createdAt) }));
  }

  // ── signing keys ──
  for (const k of snap.jwks) {
    const kid = str(k.kid);
    if (kid) set.add('jwks', { kid, jwk: k });
  }

  set.manifest = {
    origin: o.endpoint ? new URL(o.endpoint).host : `Logto database (tenant ${o.tenantId})`,
    ...(o.rpId ? { rpId: o.rpId } : {}),
    providers: [...new Set(set.list('identity').map((i) => i.provider))].sort(),
    settings: { tenant_id: o.tenantId, read_from: snap.source, password_algorithms: algorithms, totp: TOTP },
  };
  return set;
}

/** One `mfa_verifications` entry → a factor or a passkey. */
function addFactor(set: RecordSet, userId: string, f: Obj, rpId: string | undefined): void {
  const type = str(f.type);
  const created = time(f.createdAt);
  if (type === 'Totp') {
    const secret = str(f.key)?.replace(/[\s=]/g, '').toUpperCase();
    if (!secret || !/^[A-Z2-7]+$/.test(secret)) {
      set.omit('mfa_factor', 'a TOTP key that is not base32');
      return;
    }
    set.add('mfa_factor', compact({ id: str(f.id), user_id: userId, type: 'totp' as const, secret_base32: secret, ...TOTP, verified: true, created_at: created }));
  } else if (type === 'BackupCode') {
    const codes = objs(f.codes)
      .filter((c) => !str(c.usedAt))
      .map((c) => str(c.code))
      .filter((c): c is string => !!c);
    if (!codes.length) {
      set.omit('mfa_factor', 'every backup code already used');
      return;
    }
    set.add('mfa_factor', compact({ id: str(f.id), user_id: userId, type: 'backup_codes' as const, backup_codes: codes, verified: true, created_at: created }));
  } else if (type === 'WebAuthn') {
    const credentialId = base64url(f.credentialId);
    const publicKey = base64url(f.publicKey);
    const rp = str(f.rpId) ?? rpId;
    if (!credentialId || !publicKey) {
      set.omit('passkey', 'a WebAuthn credential without its id or public key');
      return;
    }
    if (!rp) {
      set.omit('passkey', 'the relying-party id is unknown (pass --set logto-endpoint=<url> or --set rp-id=<host>)');
      return;
    }
    set.add(
      'passkey',
      compact({
        id: str(f.id),
        user_id: userId,
        credential_id: credentialId,
        public_key: publicKey,
        sign_count: typeof f.counter === 'number' ? f.counter : undefined,
        rp_id: rp,
        transports: strs(f.transports),
        name: str(f.name) ?? str(f.agent),
        created_at: created,
      }),
    );
  } else {
    set.omit('mfa_factor', `Logto factor type ${type ?? 'unknown'}`);
  }
}
