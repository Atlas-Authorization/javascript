import type { InvitationRecord, SsoConnectionRecord, UserRecord } from '@atlasauth/migrate';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export frontegg` — a Frontegg environment onto the canonical
 * bundle models, read with the environment's client id and API key on this
 * machine (`POST /auth/vendor` → a management token).
 *
 *   - users (email, verified flag, phone, name, picture, metadata and
 *     vendorMetadata, usernames, locked / disabled state) with each account
 *     (tenant) membership and its roles;
 *   - accounts (tenants) → organizations (verified SSO domains included), roles
 *     and their permissions, user groups (kept on the user, their roles folded
 *     into the member's roles), invitations, and each account's SAML / OIDC
 *     SSO configuration;
 *   - password hashes: Frontegg never returns them (its API and its docs only
 *     IMPORT bcrypt / scrypt / firebase hashes). Turn on the `frontegg`
 *     lazy-migration preset: Atlas checks each password against Frontegg on
 *     the user's first sign-in.
 *
 * Authenticator-app and SMS second factors, passkeys, social-login provider
 * user ids and API token secrets are not exportable: they are reported as left
 * out with what to do instead.
 */

export const FRONTEGG_REGIONS: Record<string, string> = {
  eu: 'https://api.frontegg.com',
  us: 'https://api.us.frontegg.com',
  ca: 'https://api.ca.frontegg.com',
  au: 'https://api.au.frontegg.com',
};

export interface FronteggConnection {
  clientId: string;
  apiKey: string;
  /** `eu` (default), `us`, `ca` or `au`. */
  region?: string;
  /** API root override (tests, private deployments). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface FronteggExportOptions extends FronteggConnection {
  onProgress?: (message: string) => void;
}

const PAGE = 200;

/** The API root for a region name (or an explicit override). */
export function fronteggApiRoot(region: string | undefined, baseUrl?: string): string {
  if (baseUrl) return baseUrl.replace(/\/+$/, '');
  const key = (region ?? 'eu').trim().toLowerCase();
  const root = FRONTEGG_REGIONS[key];
  if (!root) throw new Error(`Unknown Frontegg region "${region}": use eu, us, ca or au.`);
  return root;
}

/** The management client plus per-account clients (the `frontegg-tenant-id` header), all sharing one token. */
export interface FronteggApi {
  http: VendorHttp;
  tenant(tenantId: string): VendorHttp;
}

/**
 * Authenticates with the environment credentials (`POST /auth/vendor`) and
 * renews the management token a minute before it expires.
 */
export function fronteggApi(c: FronteggConnection): FronteggApi {
  if (!c.clientId || !c.apiKey) throw new Error('Frontegg needs the environment client id and API key.');
  const root = fronteggApiRoot(c.region, c.baseUrl);
  const now = c.now ?? Date.now;
  const auth = new VendorHttp({ vendor: 'Frontegg', baseUrl: root, fetchImpl: c.fetchImpl, sleep: c.sleep });
  let token: string | undefined;
  let expiresAt = 0;
  const authHeaders = async (): Promise<Record<string, string>> => {
    if (!token || now() >= expiresAt - 60_000) {
      // A refused login must not look like "feature off" to optional().
      const { body } = await auth.post<Obj>('/auth/vendor', { clientId: c.clientId, secret: c.apiKey }).catch((err: unknown) => {
        throw err instanceof VendorApiError ? new Error(`Frontegg refused the environment credentials (${err.status}): check the client id and API key.`) : err;
      });
      const t = str(body?.token);
      if (!t) throw new Error('Frontegg did not return a management token: check the client id and API key.');
      token = t;
      const secs = typeof body.expiresIn === 'number' ? body.expiresIn : 3600;
      expiresAt = now() + secs * 1000;
    }
    return { authorization: `Bearer ${token}` };
  };
  const make = (extra: Record<string, string>) =>
    new VendorHttp({ vendor: 'Frontegg', baseUrl: root, fetchImpl: c.fetchImpl, sleep: c.sleep, headers: async () => ({ ...(await authHeaders()), ...extra }) });
  const cache = new Map<string, VendorHttp>();
  return {
    http: make({}),
    tenant(tenantId) {
      let client = cache.get(tenantId);
      if (!client) {
        client = make({ 'frontegg-tenant-id': tenantId });
        cache.set(tenantId, client);
      }
      return client;
    },
  };
}

/** A body that is a list, or wraps one under a known key. */
export function listOf(body: unknown, ...keys: string[]): Obj[] {
  if (Array.isArray(body)) return objs(body);
  if (!isObj(body)) return [];
  for (const k of ['items', ...keys]) if (Array.isArray(body[k])) return objs(body[k]);
  return [];
}

/** A call whose "not available" answers (feature off, no permission) mean "nothing there". */
export async function optional<T>(http: VendorHttp, path: string): Promise<T | null> {
  try {
    return (await http.get<T>(path)).body;
  } catch (err) {
    if (err instanceof VendorApiError && [400, 401, 403, 404, 405].includes(err.status)) return null;
    throw err;
  }
}

/** Every page of a listing, stopping on a short page, the reported page count, or a page that repeats. */
async function* pages(
  http: VendorHttp,
  path: string,
  idOf: (o: Obj) => string | undefined,
  keys: string[],
): AsyncGenerator<Obj[]> {
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    let body: unknown;
    try {
      body = (await http.get<unknown>(`${path}${sep}_limit=${PAGE}&_offset=${page}`)).body;
    } catch (err) {
      if (page === 0 && err instanceof VendorApiError && [400, 403, 404].includes(err.status)) return;
      throw err;
    }
    const items = listOf(body, ...keys);
    const fresh = items.filter((o) => {
      const id = idOf(o);
      if (id === undefined) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (fresh.length > 0) yield fresh;
    const totalPages = isObj(body) && isObj(body._metadata) && typeof body._metadata.totalPages === 'number' ? body._metadata.totalPages : undefined;
    if (items.length < PAGE || fresh.length === 0 || (totalPages !== undefined && page + 1 >= totalPages)) return;
  }
}

/** A metadata field: Frontegg stores it as a JSON string. */
export function metadataOf(v: unknown): Obj | undefined {
  if (isObj(v)) return bag(v);
  const s = str(v);
  if (!s) return undefined;
  try {
    const parsed: unknown = JSON.parse(s);
    return bag(parsed);
  } catch {
    return undefined;
  }
}

const SOCIAL_PROVIDERS = new Set(['google', 'github', 'facebook', 'microsoft', 'linkedin', 'slack', 'apple', 'twitter', 'x', 'gitlab', 'discord']);

export async function exportFrontegg(opts: FronteggExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const progress = opts.onProgress ?? (() => undefined);
  const api = fronteggApi(opts);
  const http = api.http;
  const root = fronteggApiRoot(opts.region, opts.baseUrl);

  progress('accounts (tenants)');
  const tenants: Obj[] = [];
  const tenantIds = new Set<string>();
  for await (const batch of pages(http, '/tenants/resources/tenants/v2', (o) => str(o.tenantId), ['tenants'])) {
    for (const t of batch) {
      const id = str(t.tenantId);
      if (!id || tenantIds.has(id)) continue;
      tenantIds.add(id);
      tenants.push(t);
      if (str(t.parentTenantId)) set.warn('Some accounts are sub-accounts: Atlas organizations are flat, so each one is imported on its own and the parent link is kept in public_metadata.frontegg_parent_tenant_id.');
    }
  }

  progress('permissions and roles');
  const permissionKeys = new Map<string, string>();
  for (const p of listOf(await optional<unknown>(http, '/identity/resources/permissions/v1'))) {
    const id = str(p.id);
    const key = str(p.key);
    if (id && key) permissionKeys.set(id, key);
  }
  const roleKeys = new Map<string, string>(); // Frontegg role id → Atlas role key
  const addRole = (r: Obj): string | undefined => {
    const raw = str(r.key) ?? str(r.name);
    if (!raw) return undefined;
    const key = keyOf(raw);
    const id = str(r.id);
    if (id) roleKeys.set(id, key);
    const tenantId = str(r.tenantId);
    const org = tenantId && tenantIds.has(tenantId) ? tenantId : undefined;
    const permissions = (Array.isArray(r.permissions) ? r.permissions : [])
      .map((p) => (isObj(p) ? (str(p.key) ?? permissionKeys.get(str(p.id) ?? '')) : (permissionKeys.get(String(p)) ?? undefined)))
      .filter((p): p is string => !!p);
    set.add(
      'role',
      compact({ key, name: str(r.name) ?? raw, description: str(r.description), scope: 'organization' as const, organization_id: org, permissions }),
      `org:${org ?? ''}:${key}`,
    );
    return key;
  };
  for await (const batch of pages(http, '/identity/resources/roles/v2', (o) => str(o.id), ['roles'])) for (const r of batch) addRole(r);

  progress('user groups');
  // userId → groups of one account, with the role keys each group grants there.
  const groupsOf = new Map<string, Array<{ tenantId: string; name: string; roles: string[] }>>();
  for (const tid of tenantIds) {
    for await (const batch of pages(api.tenant(tid), '/identity/resources/groups/v2?_groupsRelations=rolesAndUsers', (o) => str(o.id), ['groups'])) {
      for (const g of batch) {
        const name = str(g.name);
        if (!name) continue;
        const roles = objs(g.roles).map(addRole).filter((k): k is string => !!k);
        for (const m of objs(g.users)) {
          const uid = str(m.id);
          if (!uid) continue;
          const list = groupsOf.get(uid) ?? [];
          list.push({ tenantId: tid, name, roles });
          groupsOf.set(uid, list);
        }
      }
    }
  }

  progress('single sign-on');
  const domainsOf = new Map<string, string[]>();
  for (const tid of tenantIds) {
    const body = await optional<unknown>(api.tenant(tid), '/team/resources/sso/v1/configurations');
    for (const c of listOf(body, 'configurations')) {
      const conn = mapSsoConfig(c, tid);
      if (!conn) continue;
      set.add('sso_connection', conn, conn.id);
      domainsOf.set(tid, [...new Set([...(domainsOf.get(tid) ?? []), ...(conn.domains ?? [])])]);
      if (conn.protocol === 'oidc') set.warn(`Account ${tid} OIDC SSO: Frontegg does not return the client secret; enter it in Atlas after the import.`);
    }
  }

  for (const t of tenants) {
    const id = str(t.tenantId)!;
    set.add(
      'organization',
      compact({
        id,
        name: str(t.name) ?? id,
        image_url: str(t.logoUrl),
        domains: domainsOf.get(id),
        public_metadata: bag({ ...metadataOf(t.metadata), ...(str(t.parentTenantId) ? { frontegg_parent_tenant_id: str(t.parentTenantId) } : {}) }),
        created_at: str(t.createdAt),
      }),
    );
  }

  progress('usernames');
  const usernames = new Map<string, string>();
  for await (const batch of pages(http, '/identity/resources/usernames/v1', (o) => `${str(o.userId)}:${str(o.username)}`, ['usernames'])) {
    for (const u of batch) {
      const uid = str(u.userId);
      const name = str(u.username);
      if (uid && name) usernames.set(uid, name);
    }
  }

  progress('users');
  const emailOf = new Map<string, string>();
  for await (const batch of pages(http, '/identity/resources/users/v3?_sortBy=id&_order=ASC', (o) => str(o.id), ['users'])) {
    for (const u of batch) {
      const user = mapFronteggUser(u, usernames);
      if (!user) {
        set.omit('user', u.invisible === true ? 'invisible (support) user' : 'no email, phone number or username');
        continue;
      }
      const groups = groupsOf.get(user.id) ?? [];
      if (groups.length) user.private_metadata = { ...user.private_metadata, frontegg_groups: groups.map((g) => ({ tenant_id: g.tenantId, name: g.name })) };
      set.add('user', user, user.id);
      const email = user.emails?.[0]?.email;
      if (email) emailOf.set(user.id, email);
      for (const m of objs(u.tenants)) {
        const tid = str(m.tenantId);
        if (!tid) continue;
        if (!tenantIds.has(tid)) {
          set.omit('membership', 'account not in the tenant listing');
          continue;
        }
        const direct = objs(m.roles).map(addRole).filter((k): k is string => !!k);
        const viaGroups = groups.filter((g) => g.tenantId === tid).flatMap((g) => g.roles);
        const all = [...new Set([...direct, ...viaGroups])];
        if (all.length > 1) set.warn('Some members hold several Frontegg roles; Atlas seats each member with one role (the first, direct roles before group roles).');
        set.add('membership', compact({ organization_id: tid, user_id: user.id, role: all[0] ?? 'member' }), `${tid}:${user.id}`);
      }
      if (u.mfaEnrolled === true) set.omit('mfa_factor', 'Frontegg does not export authenticator-app or SMS second factors; re-enrol in Atlas');
      if (SOCIAL_PROVIDERS.has((str(u.provider) ?? '').toLowerCase())) {
        set.omit('identity', "Frontegg does not export social accounts' provider user ids: they relink by verified email on first social sign-in");
      }
    }
  }
  if (set.count('user') > 0) {
    set.warn('No password hashes: Frontegg never returns them. Turn on the frontegg lazy-migration preset so each password moves on its first sign-in.');
  }

  progress('invitations');
  for (const inv of listOf(await optional<unknown>(http, '/identity/resources/tenants/invites/v1/all'))) {
    const id = str(inv.id);
    const tid = str(inv.tenantId);
    const email = emailOf.get(str(inv.userId) ?? '');
    if (!id || !tid || !tenantIds.has(tid) || !email) {
      set.omit('invitation', 'invitation without a known account or user email');
      continue;
    }
    const role = strs(inv.roleIds).map((r) => roleKeys.get(r)).find((r): r is string => !!r);
    const record: InvitationRecord = compact({ id, organization_id: tid, email, role, status: 'pending' as const, expires_at: str(inv.expires) });
    set.add('invitation', record, id);
  }

  progress('api tokens');
  let tokens = 0;
  for (const tid of tenantIds) {
    const scope = api.tenant(tid);
    tokens += listOf(await optional<unknown>(scope, '/identity/resources/tenants/api-tokens/v1')).length;
    tokens += listOf(await optional<unknown>(scope, '/identity/resources/tenants/access-tokens/v1'), 'accessTokens').length;
  }
  if (tokens) set.omit('api_key', 'Frontegg never reveals API token secrets: reissue them as Atlas API keys', tokens);

  set.manifest = { origin: root, settings: { region: (opts.region ?? 'eu').toLowerCase() } };
  return set;
}

/** One Frontegg user (v3 listing) → a user record. */
export function mapFronteggUser(u: Obj, usernames: ReadonlyMap<string, string> = new Map()): UserRecord | null {
  const id = str(u.id) ?? str(u.sub);
  if (!id || u.invisible === true) return null;
  const email = str(u.email)?.toLowerCase();
  const phone = e164(u.phoneNumber);
  const username = usernames.get(id);
  const memberships = objs(u.tenants);
  const disabled = memberships.length > 0 && memberships.every((m) => m.isDisabled === true);
  const user: UserRecord = compact({
    id,
    emails: email ? [{ email, verified: u.verified === true, primary: true }] : [],
    // Frontegg verifies a number before storing it, but does not say so in the listing: the safe default is unverified.
    phones: phone ? [{ phone, verified: false, primary: !email }] : [],
    username,
    name: str(u.name),
    image_url: str(u.profilePictureUrl),
    banned: disabled ? true : undefined,
    locked: u.isLocked === true ? true : undefined,
    public_metadata: metadataOf(u.metadata),
    private_metadata: bag({
      ...metadataOf(u.vendorMetadata),
      ...(str(u.externalId) ? { frontegg_external_id: str(u.externalId) } : {}),
      ...(u.superUser === true ? { frontegg_super_user: true } : {}),
    }),
    created_at: str(u.createdAt),
    last_sign_in_at: str(u.lastLogin),
  });
  return user.emails?.length || user.phones?.length || user.username ? user : null;
}

/**
 * One SSO configuration of an account → a connection. The listing's exact
 * shape is not in the public reference beyond its create request, so both the
 * flat request names (`ssoEndpoint`, `publicCertificate`, `acsUrl`,
 * `spEntityId`, `oidcClientId`) and `configMetadata` are read.
 */
export function mapSsoConfig(c: Obj, tenantId: string): SsoConnectionRecord | null {
  const type = (str(c.type) ?? '').toLowerCase();
  const meta = isObj(c.configMetadata) ? c.configMetadata : {};
  const domains = (Array.isArray(c.domains) ? c.domains : [])
    .map((d) => (isObj(d) ? (d.validated === false ? undefined : str(d.domain)) : str(d)))
    .filter((d): d is string => !!d);
  const base = { name: str(c.name), organization_id: tenantId, domains: [...new Set(domains)], enabled: c.enabled === false ? false : undefined };
  const rawId = str(c.id);
  if (type === 'oidc' || (!type && str(c.oidcClientId))) {
    const clientId = str(c.oidcClientId);
    if (!clientId) return null;
    return compact({
      id: rawId ?? `${tenantId}:oidc`,
      ...base,
      name: base.name ?? `${tenantId} OIDC`,
      protocol: 'oidc' as const,
      oidc: compact({ issuer: str(meta.issuer), discovery_url: str(meta.discoveryUrl) ?? str(meta.wellKnownUrl), client_id: clientId, scopes: strs(meta.scopes) }),
    });
  }
  const sso = str(c.ssoEndpoint);
  const cert = str(c.publicCertificate);
  const entity = str(meta.entityId) ?? str(meta.idpEntityId) ?? str(meta.issuer);
  if (!sso && !cert && !entity) return null;
  return compact({
    id: rawId ?? `${tenantId}:saml`,
    ...base,
    name: base.name ?? `${tenantId} SAML`,
    protocol: 'saml' as const,
    saml: compact({
      idp_entity_id: entity,
      idp_sso_url: sso,
      idp_certificate: cert,
      idp_metadata_url: str(meta.metadataUrl),
      sp_entity_id: str(c.spEntityId),
      sp_acs_url: str(c.acsUrl),
    }),
  });
}
