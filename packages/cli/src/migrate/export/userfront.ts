import type { UserRecord } from '@atlasauth/migrate';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export userfront` — a Userfront tenant onto the canonical
 * bundle models, read with an admin API key (`uf_live_admin_…`) on this
 * machine.
 *
 *   - users (email, username, phone, names, image, custom `data`, confirmed
 *     flags, locked) with their roles on the tenant;
 *   - sub-tenants → organizations, with each member's role in them;
 *   - roles (the tenant's role list plus any a user holds).
 *
 * Userfront never returns password hashes, so passwords move by lazy
 * migration: the `userfront` preset checks each password against Userfront's
 * own sign-in on a member's first Atlas sign-in. Not exportable: second
 * factors (re-enrol), passkeys (register again), social account ids (relink
 * by verified email), pending invitations (create only, no listing).
 */

export interface UserfrontExportOptions {
  tenantId: string;
  /** An admin key: `uf_live_admin_…` for the live tenant, `uf_test_admin_…` for test mode. */
  apiKey: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

const API = 'https://api.userfront.com/v0';
const MAX_PAGES = 100_000;
/** First-factor strategies that are not a social login. */
const NON_SOCIAL = new Set(['password', 'link', 'verificationCode', 'totp', 'sso', 'saml', 'passkey', 'webauthn', 'email', 'phone']);

export function checkTenantId(tenantId: string): string {
  const t = tenantId.trim();
  if (!/^[A-Za-z0-9]{4,16}$/.test(t)) throw new Error(`Not a Userfront tenant id: ${tenantId}`);
  return t;
}

export function userfrontHttp(o: { apiKey: string; apiBase?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): VendorHttp {
  return new VendorHttp({
    vendor: 'Userfront',
    baseUrl: (o.apiBase ?? API).replace(/\/+$/, ''),
    headers: { authorization: `Bearer ${o.apiKey}` },
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
}

export async function exportUserfront(opts: UserfrontExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const tid = checkTenantId(opts.tenantId);
  if (!/^uf_(test|live)_admin_/.test(opts.apiKey)) throw new Error('Userfront export needs an admin API key (uf_live_admin_… or uf_test_admin_…).');
  const progress = opts.onProgress ?? (() => undefined);
  const http = userfrontHttp(opts);

  progress('organizations');
  const orgIds = new Set<string>();
  await walk(
    async (page) => (await http.get<Obj>(`/tenants/${tid}/tenants?page=${page}`)).body,
    (body) => objs(body?.results).concat(objs(body?.tenants)),
    (body) => {
      const n = body?.totalPages;
      return typeof n === 'number' ? n : undefined;
    },
    (t) => {
      const id = str(t.tenantId);
      if (!id || id === tid || orgIds.has(id)) return false;
      orgIds.add(id);
      set.add('organization', compact({ id, name: str(t.name) ?? id, image_url: str(t.image), public_metadata: bag(t.data), created_at: str(t.createdAt) }), id);
      return true;
    },
  );

  progress('roles');
  const roleNames = new Set<string>();
  const rolesBody = await optional(async () => (await http.get<Obj>(`/tenants/${tid}/roles`)).body);
  for (const r of objs(rolesBody?.roles)) {
    const name = str(r.name);
    if (name) roleNames.add(name);
  }

  progress('users');
  const seen = new Set<string>();
  let unknownOrgs = 0;
  let mfa = 0;
  let passkeys = 0;
  let social = 0;
  await walk(
    (page) => findUsers(http, tid, page),
    (body) => objs(body?.results),
    (body) => {
      const meta = body?.meta;
      return isObj(meta) && typeof meta.totalPages === 'number' ? meta.totalPages : undefined;
    },
    (u) => {
      const rawId = str(u.userId);
      if (rawId && seen.has(rawId)) return false;
      if (rawId) seen.add(rawId);
      const user = mapUserfrontUser(u, tid);
      if (!user) {
        set.omit('user', 'no email, phone number or username');
        return true;
      }
      const authz = isObj(u.authorization) ? u.authorization : {};
      const mine = authz[tid];
      const own = isObj(mine) ? strs(mine.roles) : [];
      if (own.length) user.roles = own.map(keyOf);
      for (const n of own) roleNames.add(n);
      set.add('user', user, user.id);
      for (const [orgId, raw] of Object.entries(authz)) {
        if (orgId === tid || !isObj(raw)) continue;
        if (!orgIds.has(orgId)) {
          unknownOrgs++;
          continue;
        }
        const roles = strs(raw.roles).map(keyOf);
        set.add('membership', { organization_id: orgId, user_id: user.id, role: roles[0] ?? 'member' }, `${orgId}:${user.id}`);
        for (const r of strs(raw.roles)) roleNames.add(r);
        if (roles.length > 1) set.warn('Some organization members hold several Userfront roles; Atlas seats each member with one role (the first).');
      }
      const auth = isObj(u.authentication) ? u.authentication : {};
      if (u.isMfaRequired === true || objs(auth.secondFactors).length > 0) mfa++;
      for (const f of objs(auth.firstFactors)) {
        const strategy = str(f.strategy);
        if (strategy && /passkey|webauthn/i.test(strategy)) passkeys++;
        else if (strategy && !NON_SOCIAL.has(strategy)) social++;
      }
      return true;
    },
  );
  if (unknownOrgs > 0) {
    set.warn(`${unknownOrgs} organization grant(s) name a tenant that is not in the organization listing; those memberships were left out.`);
  }
  if (mfa > 0) set.omit('mfa_factor', 'Userfront does not export second-factor secrets; members enrol again in Atlas', mfa);
  if (passkeys > 0) set.omit('passkey', 'Userfront does not export passkey public keys; register again in Atlas', passkeys);
  if (social > 0) set.omit('identity', "Userfront does not export social accounts' provider user ids: they relink by verified email on first social sign-in", social);
  if (set.count('user') > 0) {
    set.warn('Userfront never returns password hashes: turn on the userfront lazy-migration preset so each password moves on its first Atlas sign-in.');
  }

  for (const name of roleNames) {
    const key = keyOf(name);
    set.add('role', { key, name, scope: 'app' as const }, `app:${key}`);
    if (orgIds.size > 0) set.add('role', { key, name, scope: 'organization' as const }, `org:${key}`);
  }

  set.manifest = { origin: tid, settings: { tenant_id: tid } };
  return set;
}

/**
 * Walk a paged listing whose page numbering Userfront does not document: page
 * 0 is probed, then pages go up from 1 until one is empty, past the reported
 * total, or adds nobody new (a row seen twice is taken once).
 */
async function walk(
  get: (page: number) => Promise<Obj | null>,
  rowsOf: (body: Obj | null) => Obj[],
  totalPages: (body: Obj | null) => number | undefined,
  take: (row: Obj) => boolean,
): Promise<void> {
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await optional(() => get(page));
    const rows = rowsOf(body);
    let fresh = 0;
    for (const r of rows) if (take(r)) fresh++;
    const pages = totalPages(body);
    if (page > 0 && (rows.length === 0 || (pages !== undefined && page > pages))) break;
    if (page >= 2 && fresh === 0) break;
  }
}

async function findUsers(http: VendorHttp, tenantId: string, page: number): Promise<Obj | null> {
  return (await http.post<Obj>(`/tenants/${tenantId}/users/find`, { filters: {}, page, order: [['createdAt', 'ASC']] })).body;
}

/** One Userfront user (users/find result) → a user record. */
export function mapUserfrontUser(u: Obj, tenantId: string): UserRecord | null {
  const id = str(u.userId);
  if (!id) return null;
  const email = str(u.email)?.toLowerCase();
  const phone = e164(u.phoneNumber);
  const username = str(u.username);
  const uuid = str(u.userUuid);
  const user: UserRecord = compact({
    id,
    emails: email ? [{ email, verified: u.isEmailConfirmed === true || (u.isEmailConfirmed === undefined && u.isConfirmed === true), primary: true }] : [],
    phones: phone ? [{ phone, verified: u.isPhoneNumberConfirmed === true, primary: !email }] : [],
    username,
    name: str(u.name),
    image_url: str(u.image),
    locked: u.locked === true ? true : undefined,
    public_metadata: bag(u.data),
    private_metadata: bag({ ...(uuid ? { userfront_user_uuid: uuid } : {}), userfront_tenant_id: tenantId }),
    created_at: str(u.createdAt),
    last_sign_in_at: str(u.lastActiveAt),
  });
  return user.emails?.length || user.phones?.length || user.username ? user : null;
}

async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VendorApiError && [400, 403, 404, 405].includes(err.status)) return null;
    throw err;
  }
}
