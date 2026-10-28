import type { UserRecord } from '@atlasauth/migrate';
import { parseCsv } from '../../import/csv';
import { RecordSet, bag, compact, isObj, objs, str, strs, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export propelauth` — a PropelAuth project onto the canonical
 * bundle models, read with a backend API key on this machine.
 *
 *   - users (email + confirmed flag, username, names, picture, locked /
 *     disabled, metadata) with every organization they belong to and the role
 *     they hold there;
 *   - organizations (slug, self-join domains, member cap), the roles seen on
 *     members (with the permissions they carry) and pending invitations;
 *   - password hashes: PropelAuth has no password-verify API and does not
 *     return hashes. Support can export them; pass that file with
 *     --propelauth-hashes-file (self-describing hashes are recognised on their
 *     own). Without it members set a password again (reset link) — or sign in
 *     with the method they already use.
 *
 * Not exportable: TOTP secrets (only the factor type is readable), social
 * account ids (users relink by verified email), end-user API key secrets
 * (reissue), SAML IdP settings (write-only: set the connection up again).
 * Sessions are RS256 tokens verified with the project's verifier key: see the
 * `propelauth` bridge preset.
 */

export interface PropelauthExportOptions {
  /** The project's auth URL (https://123456.propelauthtest.com or a custom domain). */
  authUrl: string;
  apiKey: string;
  /** Backend API host (default https://propelauth-api.com). */
  apiBase?: string;
  /** The password-hash export from PropelAuth support (CSV or NDJSON). */
  hashesText?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

const API = 'https://propelauth-api.com';
const PAGE = 100;
const MAX_PAGES = 100_000;
const BUILT_IN_ROLES = new Set(['admin', 'member']);

/** `https://x.propelauthtest.com/` → `https://x.propelauthtest.com`; anything but a plain https origin is refused. */
export function normalizeAuthUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, '');
  const withScheme = /^https:\/\//.test(url) ? url : /^[a-z0-9.-]+$/i.test(url) ? `https://${url}` : url;
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(withScheme)) throw new Error(`Not a PropelAuth auth URL: ${raw}`);
  return withScheme;
}

export function propelauthHttp(o: { authUrl: string; apiKey: string; apiBase?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): VendorHttp {
  return new VendorHttp({
    vendor: 'PropelAuth',
    baseUrl: (o.apiBase ?? API).replace(/\/+$/, ''),
    headers: { authorization: `Bearer ${o.apiKey}`, 'x-propelauth-url': normalizeAuthUrl(o.authUrl).replace(/^https:\/\//, '') },
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
}

export async function exportPropelauth(opts: PropelauthExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const authUrl = normalizeAuthUrl(opts.authUrl);
  if (!opts.apiKey) throw new Error('PropelAuth export needs a backend API key (PROPELAUTH_API_KEY).');
  const progress = opts.onProgress ?? (() => undefined);
  const http = propelauthHttp({ authUrl, apiKey: opts.apiKey, apiBase: opts.apiBase, fetchImpl: opts.fetchImpl, sleep: opts.sleep });

  progress('organizations');
  const orgs = await listOrgs(http);
  const orgIds = new Set<string>();
  let saml = 0;
  for (const o of orgs) {
    const id = str(o.org_id);
    const name = str(o.name) ?? str(o.org_name) ?? id;
    if (!id || !name) continue;
    orgIds.add(id);
    const detail = await optional(async () => (await http.get<Obj>(`/api/backend/v1/org/${encodeURIComponent(id)}`)).body);
    const domains = detail && detail.domain_autojoin === true ? [str(detail.domain), ...strs(detail.extra_domains)].filter((d): d is string => !!d) : [];
    set.add(
      'organization',
      compact({
        id,
        name,
        slug: str(detail?.url_safe_org_slug) ?? str(o.url_safe_org_slug) ?? str(o.url_safe_org_name),
        domains: [...new Set(domains.map((d) => d.toLowerCase()))],
        max_members: typeof o.max_users === 'number' && o.max_users > 0 ? o.max_users : undefined,
        public_metadata: bag(o.metadata),
        created_at: toMs(o.created_at),
      }),
      id,
    );
    if (o.is_saml_configured === true) saml++;
  }
  if (saml > 0) {
    set.omit('sso_connection', 'PropelAuth never returns a SAML connection\'s IdP settings (write-only): set the connection up again in Atlas, with the same IdP', saml);
  }

  progress('users');
  const hashes = opts.hashesText ? indexHashes(opts.hashesText) : null;
  const userIds = new Set<string>();
  const rolePerms = new Map<string, Set<string>>();
  let withHash = 0;
  let noPassword = 0;
  let multiRole = false;
  const users = await listAll(http, '/api/backend/v1/user/query?include_orgs=true&order_by=CREATED_AT_ASC', 'users');
  for (const u of users) {
    const user = mapPropelauthUser(u);
    if (!user) {
      set.omit('user', 'no email or username');
      continue;
    }
    const email = user.emails?.[0]?.email;
    const h = hashes ? (hashes.get(user.id) ?? (email ? hashes.get(email) : undefined) ?? hashes.get(str(u.legacy_user_id) ?? '\0')) : undefined;
    if (h) {
      user.password = { algorithm: 'auto', hash: h };
      withHash++;
    }
    if (u.has_password === false) noPassword++;
    set.add('user', user, user.id);
    userIds.add(user.id);
    if (u.mfa_enabled === true) set.omit('mfa_factor', 'PropelAuth does not export TOTP secrets; members enrol again in Atlas');
    const info = isObj(u.org_id_to_org_info) ? u.org_id_to_org_info : {};
    for (const [orgId, raw] of Object.entries(info)) {
      if (!isObj(raw)) continue;
      if (!orgIds.has(orgId)) {
        // Listed on a member but missing from the organization listing: keep the membership.
        orgIds.add(orgId);
        set.add('organization', compact({ id: orgId, name: str(raw.org_name) ?? orgId, slug: str(raw.url_safe_org_name) }), orgId);
      }
      const role = keyOf(str(raw.user_role) ?? 'member');
      if (strs(raw.additional_roles).length > 0) multiRole = true;
      else if (!rolePerms.has(role)) rolePerms.set(role, new Set(strs(raw.user_permissions)));
      else for (const p of strs(raw.user_permissions)) rolePerms.get(role)!.add(p);
      set.add('membership', { organization_id: orgId, user_id: user.id, role }, `${orgId}:${user.id}`);
    }
  }
  if (multiRole) set.warn('Some members hold additional roles in an organization; Atlas seats each member with one role (their main role).');
  if (noPassword > 0) {
    set.omit('identity', "PropelAuth does not export social accounts' provider user ids: they relink by verified email on first social sign-in", noPassword);
  }
  if (!hashes && set.count('user') > 0) {
    set.warn('No password hashes: PropelAuth has no password-verify API, so only a hash export from PropelAuth support can carry passwords. Pass it with --propelauth-hashes-file, or members set a password again on first sign-in.');
  } else if (hashes && withHash === 0) {
    set.warn('The hash file matched no user (by user id, email or legacy user id): check its columns.');
  }

  progress('invitations');
  const invitedRoles = new Set<string>();
  for (const orgId of orgIds) {
    const invites = await optional(() => listAll(http, `/api/backend/v1/pending_org_invites?org_id=${encodeURIComponent(orgId)}`, 'invites'));
    for (const inv of invites ?? []) {
      const email = str(inv.invitee_email)?.toLowerCase();
      if (!email) continue;
      const role = keyOf(str(inv.role_in_org) ?? 'member');
      invitedRoles.add(role);
      const inviter = str(inv.inviter_user_id);
      set.add(
        'invitation',
        compact({
          id: `${orgId}:${email}`,
          organization_id: orgId,
          email,
          role,
          status: 'pending' as const,
          inviter_user_id: inviter && userIds.has(inviter) ? inviter : undefined,
          expires_at: toMs(inv.expires_at),
          created_at: toMs(inv.created_at),
        }),
        `${orgId}:${email}`,
      );
    }
  }

  const roleKeys = new Set([...rolePerms.keys(), ...invitedRoles]);
  for (const key of roleKeys) {
    if (BUILT_IN_ROLES.has(key)) continue;
    set.add('role', compact({ key, name: key, scope: 'organization' as const, permissions: [...(rolePerms.get(key) ?? [])] }), key);
  }

  progress('api keys');
  const keys = (await optional(() => listAll(http, '/api/backend/v1/end_user_api_keys', 'api_keys'))) ?? [];
  if (keys.length) set.omit('api_key', 'PropelAuth never reveals end-user API key secrets: reissue them as Atlas API keys', keys.length);

  set.manifest = { origin: authUrl, settings: { auth_url: authUrl } };
  return set;
}

/** One PropelAuth user (user query result) → a user record. */
export function mapPropelauthUser(u: Obj): UserRecord | null {
  const id = str(u.user_id);
  if (!id) return null;
  const email = str(u.email)?.toLowerCase();
  const username = str(u.username);
  const legacy = str(u.legacy_user_id);
  const user: UserRecord = compact({
    id,
    emails: email ? [{ email, verified: u.email_confirmed === true, primary: true }] : [],
    username,
    first_name: str(u.first_name),
    last_name: str(u.last_name),
    image_url: str(u.picture_url),
    banned: u.enabled === false ? true : undefined,
    locked: u.locked === true ? true : undefined,
    private_metadata: bag({ ...(isObj(u.metadata) ? u.metadata : {}), ...(legacy ? { propelauth_legacy_user_id: legacy } : {}) }),
    created_at: toMs(u.created_at),
    last_sign_in_at: toMs(u.last_active_at),
  });
  return user.emails?.length || user.username ? user : null;
}

/** PropelAuth timestamps are Unix seconds. */
function toMs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : undefined;
}

/**
 * The support export, by user id, email and legacy user id (emails lowercased).
 * Its layout is not published: CSV with a hash column and an id / email
 * column, or NDJSON objects with the same names.
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
      const v = str(r[k]);
      if (!v) continue;
      if (/^(user_?id|legacy_?user_?id)$/i.test(k)) out.set(v, hash);
      else if (/^e-?mail$/i.test(k)) out.set(v.toLowerCase(), hash);
    }
  }
  return out;
}

async function listAll(http: VendorHttp, path: string, key: string): Promise<Obj[]> {
  const out: Obj[] = [];
  for (let n = 0; n < MAX_PAGES; n++) {
    const sep = path.includes('?') ? '&' : '?';
    const { body } = await http.get<Obj>(`${path}${sep}page_size=${PAGE}&page_number=${n}`);
    const rows = objs(body?.[key]);
    out.push(...rows);
    if (body?.has_more_results !== true || rows.length === 0) break;
  }
  return out;
}

/** Organizations: a GET with query parameters, or (older projects) a POST with a JSON body. */
async function listOrgs(http: VendorHttp): Promise<Obj[]> {
  try {
    return await listAll(http, '/api/backend/v1/org/query?order_by=CREATED_AT_ASC', 'orgs');
  } catch (err) {
    if (!(err instanceof VendorApiError) || ![404, 405].includes(err.status)) throw err;
  }
  const out: Obj[] = [];
  for (let n = 0; n < MAX_PAGES; n++) {
    const { body } = await http.post<Obj>('/api/backend/v1/org/query', { page_size: PAGE, page_number: n, order_by: 'CREATED_AT_ASC' });
    const rows = objs(body?.orgs);
    out.push(...rows);
    if (body?.has_more_results !== true || rows.length === 0) break;
  }
  return out;
}

/** A call that may be missing or not permitted for this project: `null` then. */
async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VendorApiError && [400, 403, 404, 405].includes(err.status)) return null;
    throw err;
  }
}
