import type { UserRecord } from '@atlasauth/migrate';
import { parseCsv } from '../../import/csv';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export descope` — a Descope project onto the canonical
 * bundle models, read with a management key on this machine.
 *
 *   - users (login ids, verified email / phone, names, custom attributes,
 *     project roles, tenant memberships with their roles); test users skipped;
 *   - tenants → organizations (self-provisioning domains included), roles and
 *     permissions, and each tenant's SSO configuration (SAML or OIDC);
 *   - password hashes: Descope does not return them by API. Its support team
 *     can export them (Descope stores Argon2id); pass that file with
 *     --descope-hashes-file. Otherwise turn on the `descope` lazy-migration preset: Atlas
 *     checks each password against Descope's password sign-in on first use.
 *
 * Descope does not export TOTP seeds, passkeys or access-key secrets; those
 * are re-enrolled / reissued. Sessions are Descope JWTs, bridged by the
 * `descope` bridge preset (project JWKS).
 */

export interface DescopeExportOptions {
  projectId: string;
  managementKey: string;
  /** API base, for regional or custom-domain projects (default https://api.descope.com). */
  baseUrl?: string;
  /** The password-hash export from Descope support (CSV or NDJSON). */
  hashesText?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

const PAGE = 100;

export async function exportDescope(opts: DescopeExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  if (!/^P[A-Za-z0-9]{10,}$/.test(opts.projectId)) throw new Error(`Not a Descope project id: ${opts.projectId}`);
  if (!opts.managementKey) throw new Error('Descope export needs a management key (DESCOPE_MANAGEMENT_KEY).');
  const progress = opts.onProgress ?? (() => undefined);
  const http = new VendorHttp({
    vendor: 'Descope',
    baseUrl: (opts.baseUrl ?? 'https://api.descope.com').replace(/\/+$/, ''),
    headers: { authorization: `Bearer ${opts.projectId}:${opts.managementKey}` },
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });

  progress('tenants');
  const tenants = objs((await http.get<Obj>('/v1/mgmt/tenant/all')).body?.tenants);
  const tenantIds = new Set<string>();
  for (const t of tenants) {
    const id = str(t.id);
    const name = str(t.name) ?? id;
    if (!id || !name) continue;
    tenantIds.add(id);
    set.add(
      'organization',
      compact({ id, name, domains: strs(t.selfProvisioningDomains), public_metadata: bag(t.customAttributes) }),
    );
  }

  progress('roles');
  const roles = objs((await optional<Obj>(http, 'GET', '/v1/mgmt/role/all'))?.roles);
  for (const r of roles) {
    const name = str(r.name);
    if (!name) continue;
    const tenantId = str(r.tenantId);
    const key = roleKey(name);
    // A Descope role serves both project-level assignment and tenant
    // membership: it becomes an app role and an organization role.
    set.add('role', compact({ key, name, description: str(r.description), scope: 'app' as const, permissions: strs(r.permissionNames) }), `app:${key}`);
    set.add(
      'role',
      compact({ key, name, description: str(r.description), scope: 'organization' as const, organization_id: tenantId && tenantIds.has(tenantId) ? tenantId : undefined, permissions: strs(r.permissionNames) }),
      `org:${tenantId ?? ''}:${key}`,
    );
  }

  progress('users');
  const hashes = opts.hashesText ? indexHashes(opts.hashesText) : null;
  const userIds = new Set<string>();
  let withHash = 0;
  for (let page = 0; ; page++) {
    const { body } = await http.post<Obj>('/v2/mgmt/user/search', { limit: PAGE, page, withTestUser: false });
    const users = objs(body?.users);
    for (const u of users) {
      const user = mapDescopeUser(u);
      if (!user) {
        set.omit('user', u.test === true ? 'test user' : 'no email, phone number or login id');
        continue;
      }
      const h = hashes ? (hashes.get(user.id) ?? strs(u.loginIds).map((l) => hashes.get(l.toLowerCase())).find(Boolean)) : undefined;
      if (h) {
        user.password = { algorithm: 'auto', hash: h };
        withHash++;
      }
      set.add('user', user);
      userIds.add(user.id);
      for (const t of objs(u.userTenants)) {
        const tid = str(t.tenantId);
        if (!tid || !tenantIds.has(tid)) continue;
        set.add('membership', { organization_id: tid, user_id: user.id, role: strs(t.roleNames)[0] ? roleKey(strs(t.roleNames)[0]!) : 'member' }, `${tid}:${user.id}`);
        if (strs(t.roleNames).length > 1) set.warn('Some tenant members hold several Descope roles; Atlas seats each member with one role (the first).');
      }
      if (isObj(u.OAuth) && Object.values(u.OAuth).some(Boolean)) {
        set.omit('identity', "Descope does not export social accounts' provider user ids: they relink by verified email on first social sign-in");
      }
      if (u.TOTP === true) set.omit('mfa_factor', 'Descope does not export TOTP seeds; re-enrol in Atlas');
      if (u.webauthn === true) set.omit('passkey', 'Descope does not export passkey public keys; register again in Atlas');
    }
    const total = typeof body?.total === 'number' ? body.total : undefined;
    if (users.length < PAGE || (total !== undefined && (page + 1) * PAGE >= total)) break;
  }
  if (!hashes && set.count('user') > 0) {
    set.warn(
      'No password hashes: Descope exports them only through its support team. Pass that file with --descope-hashes-file, or turn on the descope lazy-migration preset so each password moves on its first sign-in.',
    );
  } else if (hashes && withHash === 0) {
    set.warn('The hash file matched no user (by user id or login id): check its columns.');
  }

  progress('sso');
  for (const tid of tenantIds) await addSso(set, http, tid);

  progress('access keys');
  const keys = objs((await optional<Obj>(http, 'POST', '/v1/mgmt/accesskey/search', { tenantIds: [] }))?.keys);
  if (keys.length) set.omit('api_key', 'Descope never reveals access-key secrets: reissue them as Atlas API keys', keys.length);

  set.manifest = { origin: opts.projectId, settings: { project_id: opts.projectId } };
  return set;
}

/** One Descope user (search result) → a user record. */
export function mapDescopeUser(u: Obj): UserRecord | null {
  const id = str(u.userId);
  if (!id || u.test === true) return null;
  const email = str(u.email)?.toLowerCase();
  const phone = e164(u.phone);
  const loginIds = strs(u.loginIds);
  // A login id that is neither the email nor the phone is a username.
  const username = loginIds.find((l) => l.toLowerCase() !== email && e164(l) !== phone && !l.includes('@'));
  const status = str(u.status);
  const user: UserRecord = compact({
    id,
    emails: email ? [{ email, verified: u.verifiedEmail === true, primary: true }] : [],
    phones: phone ? [{ phone, verified: u.verifiedPhone === true, primary: !email }] : [],
    username,
    first_name: str(u.givenName),
    last_name: str(u.familyName),
    name: !str(u.givenName) && !str(u.familyName) ? str(u.name) : undefined,
    image_url: str(u.picture),
    roles: strs(u.roleNames).map(roleKey),
    banned: status === 'disabled' ? true : undefined,
    private_metadata: bag({ ...(isObj(u.customAttributes) ? u.customAttributes : {}), ...(strs(u.externalIds).length ? { descope_external_ids: strs(u.externalIds) } : {}) }),
    created_at: typeof u.createdTime === 'number' ? u.createdTime * 1000 : undefined,
  });
  return user.emails?.length || user.phones?.length || user.username ? user : null;
}

/** Descope role names are free text: `Tenant Admin` → `tenant_admin`. */
export function roleKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role';
}

/**
 * The support export, by user id and login id (lowercased). Its exact layout
 * is not published: accepted as CSV with a hash column and a user id / login
 * id / email column, or NDJSON objects with the same names.
 */
function indexHashes(text: string): Map<string, string> {
  const t = text.trim();
  const rows: Obj[] = t.startsWith('{') ? t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Obj) : parseCsv(t);
  const out = new Map<string, string>();
  for (const r of rows) {
    const keys = Object.keys(r);
    const hashKey = keys.find((k) => /hash/i.test(k) && !/algo/i.test(k));
    const hash = hashKey ? str(r[hashKey]) : undefined;
    if (!hash) continue;
    for (const k of keys) {
      if (/^(user_?id|userid|login_?id|loginid|email|login_?ids)$/i.test(k)) {
        for (const v of String(r[k] ?? '').split(/[|,;]/)) if (v.trim()) out.set(/user_?id/i.test(k) ? v.trim() : v.trim().toLowerCase(), hash);
      }
    }
  }
  return out;
}

async function addSso(set: RecordSet, http: VendorHttp, tenantId: string): Promise<void> {
  const body = (await optional<Obj>(http, 'GET', `/v2/mgmt/sso/settings?tenantId=${encodeURIComponent(tenantId)}`)) ?? (await optional<Obj>(http, 'GET', `/v1/mgmt/sso/settings?tenantId=${encodeURIComponent(tenantId)}`));
  if (!body) return;
  const saml = isObj(body.saml) ? body.saml : undefined;
  const oidc = isObj(body.oidc) ? body.oidc : undefined;
  const domains = [...strs(body.domains), ...(str(body.domain) ? [str(body.domain)!] : []), ...(isObj(body.tenant) ? strs(body.tenant.domains) : [])];
  if (saml && (str(saml.idpEntityId) || str(saml.idpMetadataUrl) || str(saml.idpSSOUrl))) {
    const mapping = isObj(saml.attributeMapping) ? saml.attributeMapping : undefined;
    set.add(
      'sso_connection',
      compact({
        id: `${tenantId}:saml`,
        name: `${tenantId} SAML`,
        organization_id: tenantId,
        protocol: 'saml' as const,
        domains: [...new Set(domains)],
        saml: compact({
          idp_entity_id: str(saml.idpEntityId),
          idp_sso_url: str(saml.idpSSOUrl),
          idp_certificate: str(saml.idpCertificate),
          idp_metadata_url: str(saml.idpMetadataUrl),
          sp_entity_id: str(saml.spEntityId),
          sp_acs_url: str(saml.spACSUrl),
          attribute_mapping: mapping ? (Object.fromEntries(Object.entries(mapping).filter(([, v]) => typeof v === 'string' && v)) as Record<string, string>) : undefined,
        }),
      }),
    );
  } else if (oidc && (str(oidc.issuer) || str(oidc.clientId))) {
    set.add(
      'sso_connection',
      compact({
        id: `${tenantId}:oidc`,
        name: str(oidc.name) ?? `${tenantId} OIDC`,
        organization_id: tenantId,
        protocol: 'oidc' as const,
        domains: [...new Set(domains)],
        oidc: compact({ issuer: str(oidc.issuer), discovery_url: str(oidc.wellKnownUrl), client_id: str(oidc.clientId), scopes: strs(oidc.scope) }),
      }),
    );
    set.warn(`Tenant ${tenantId} OIDC SSO: Descope does not return the client secret; enter it in Atlas after the import.`);
  }
}

async function optional<T>(http: VendorHttp, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
  try {
    return (await http.request<T>(method, path, body)).body;
  } catch (err) {
    if (err instanceof VendorApiError && [400, 403, 404, 405].includes(err.status)) return null;
    throw err;
  }
}
