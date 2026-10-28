import { createHash } from 'node:crypto';
import type { IdentityRecord, PasswordHash, UserRecord } from '@atlasauth/migrate';
import { parseCsv } from '../../import/csv';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export clerk` — everything Clerk lets an instance owner take
 * out, mapped onto the canonical bundle models.
 *
 * Two sources, merged by Clerk user id:
 *   - the Backend API (secret key, on this machine only): users with their
 *     emails, phones, social and enterprise accounts and all three metadata
 *     bags; organizations, domains, memberships, roles and permissions,
 *     pending invitations, enterprise (SAML/OIDC) connections, API keys and
 *     the instance's public signing keys;
 *   - the dashboard CSV export (Users → Export), the ONLY place Clerk hands
 *     out password digests (`password_digest` + `password_hasher`) and TOTP
 *     secrets (`totp_secret`). The API never returns either.
 *
 * Clerk cannot export passkeys (only their names) or backup codes: those
 * users enrol again. Sessions are not exported — Clerk session tokens are
 * JWTs, bridged by the `clerk` bridge preset (JWKS) instead.
 */

export interface ClerkExportOptions {
  secretKey?: string;
  /** Defaults to https://api.clerk.com. */
  apiUrl?: string;
  /** The dashboard CSV export text, when the owner downloaded one. */
  csv?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Skip API-key secrets (they are read one call per key). */
  skipApiKeys?: boolean;
  onProgress?: (message: string) => void;
}

const PAGE = 500;

export async function exportClerk(opts: ClerkExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  if (!opts.secretKey && !opts.csv) throw new Error('Clerk export needs the secret key (CLERK_SECRET_KEY) or the dashboard CSV export.');
  const csvRows = opts.csv ? parseCsv(opts.csv) : [];
  const csvById = new Map(csvRows.filter((r) => str(r.id)).map((r) => [r.id!, r]));

  if (!opts.secretKey) {
    // CSV only: users, passwords and TOTP — no orgs, social accounts or metadata.
    set.warn('Exported from the dashboard CSV only: organizations, social accounts and metadata need the Backend API (pass the secret key).');
    for (const row of csvRows) addCsvUser(set, row);
    finishManifest(set, null);
    return set;
  }

  const http = new VendorHttp({
    vendor: 'Clerk',
    baseUrl: opts.apiUrl ?? 'https://api.clerk.com',
    headers: { authorization: `Bearer ${opts.secretKey}` },
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  const progress = opts.onProgress ?? (() => undefined);

  // Organizations first: memberships and invitations point at them.
  progress('organizations');
  const orgs = await listAll(http, '/v1/organizations?include_members_count=false');
  for (const o of orgs) {
    const id = str(o.id);
    const name = str(o.name);
    if (!id || !name) continue;
    const domains = await optionalList(http, `/v1/organizations/${id}/domains`);
    set.add(
      'organization',
      compact({
        id,
        name,
        slug: str(o.slug),
        image_url: str(o.image_url),
        domains: domains.filter((d) => isObj(d.verification) && d.verification.status === 'verified').map((d) => str(d.name)).filter((d): d is string => !!d),
        max_members: typeof o.max_allowed_memberships === 'number' && o.max_allowed_memberships > 0 ? o.max_allowed_memberships : undefined,
        public_metadata: bag(o.public_metadata),
        private_metadata: bag(o.private_metadata),
        created_at: typeof o.created_at === 'number' ? o.created_at : undefined,
      }),
    );
  }

  progress('roles');
  for (const r of await optionalList(http, '/v1/organization_roles')) {
    const key = str(r.key);
    if (!key) continue;
    set.add(
      'role',
      compact({
        key: roleKey(key),
        name: str(r.name),
        description: str(r.description),
        scope: 'organization' as const,
        permissions: objs(r.permissions).map((p) => str(p.key)).filter((p): p is string => !!p).map(permissionKey),
      }),
      key,
    );
  }

  progress('users');
  const users = await listAll(http, '/v1/users?order_by=%2Bcreated_at');
  const apiIds = new Set<string>();
  for (const u of users) {
    const id = str(u.id);
    if (!id) continue;
    apiIds.add(id);
    addApiUser(set, u, csvById.get(id));
  }
  // A CSV row the API no longer lists (deleted since the export) is skipped.
  const stale = csvRows.filter((r) => str(r.id) && !apiIds.has(r.id!)).length;
  if (stale) set.omit('user', 'in the CSV export but no longer in Clerk (deleted since)', stale);
  if (!opts.csv && users.some((u) => u.password_enabled === true)) {
    set.warn(
      'No password digests: Clerk only exports them in the dashboard CSV (Users → Export). Pass it with --clerk-csv, or enable lazy migration so passwords move on first sign-in.',
    );
  }

  progress('memberships');
  for (const o of orgs) {
    const orgId = str(o.id);
    if (!orgId) continue;
    for (const m of await listAll(http, `/v1/organizations/${orgId}/memberships`)) {
      const userId = str(isObj(m.public_user_data) ? m.public_user_data.user_id : undefined);
      const role = str(m.role);
      if (!userId || !role || !apiIds.has(userId)) continue;
      set.add('membership', compact({ id: str(m.id), organization_id: orgId, user_id: userId, role: roleKey(role), created_at: num(m.created_at) }), `${orgId}:${userId}`);
    }
  }

  progress('invitations');
  for (const o of orgs) {
    const orgId = str(o.id);
    if (!orgId) continue;
    for (const inv of await listAll(http, `/v1/organizations/${orgId}/invitations?status=pending`)) {
      const id = str(inv.id);
      const email = str(inv.email_address);
      if (!id || !email) continue;
      set.add('invitation', compact({ id, organization_id: orgId, email, role: str(inv.role) ? roleKey(str(inv.role)!) : undefined, status: 'pending' as const, expires_at: num(inv.expires_at), created_at: num(inv.created_at) }));
    }
  }
  for (const inv of await optionalList(http, '/v1/invitations?status=pending')) {
    const id = str(inv.id);
    const email = str(inv.email_address);
    if (id && email) set.add('invitation', compact({ id, email, status: 'pending' as const, expires_at: num(inv.expires_at), created_at: num(inv.created_at) }));
  }

  if (!opts.skipApiKeys) {
    progress('api keys');
    await addApiKeys(set, http, apiIds, new Set(orgs.map((o) => str(o.id)).filter((x): x is string => !!x)));
  }

  progress('enterprise connections');
  await addSsoConnections(set, http);

  progress('signing keys');
  const jwks = await optionalGet<{ keys?: Obj[] }>(http, '/v1/jwks');
  for (const k of objs(jwks?.keys)) {
    const kid = str(k.kid);
    if (kid) set.add('jwks', { kid, jwk: k });
  }

  finishManifest(set, opts.apiUrl ?? 'https://api.clerk.com');
  return set;
}

function finishManifest(set: RecordSet, origin: string | null): void {
  const providers = new Set(set.list('identity').map((i) => i.provider));
  set.manifest = { ...set.manifest, origin, providers: [...providers].sort() };
  set.warn('Clerk does not export passkeys or backup codes: those users register a passkey / new codes after the move.');
}

// ── users ───────────────────────────────────────────────────────────────────

function addApiUser(set: RecordSet, u: Obj, csv: Record<string, string> | undefined): void {
  const id = str(u.id)!;
  const emails = objs(u.email_addresses)
    .filter((e) => str(e.email_address))
    .map((e) => ({
      email: str(e.email_address)!.toLowerCase(),
      verified: isObj(e.verification) && e.verification.status === 'verified',
      primary: e.id === u.primary_email_address_id,
    }));
  const phones = objs(u.phone_numbers)
    .map((p) => ({ phone: e164(p.phone_number), verified: isObj(p.verification) && p.verification.status === 'verified', primary: p.id === u.primary_phone_number_id }))
    .filter((p): p is { phone: string; verified: boolean; primary: boolean } => !!p.phone);
  const user: UserRecord = compact({
    id,
    emails,
    phones,
    username: str(u.username),
    first_name: str(u.first_name),
    last_name: str(u.last_name),
    image_url: u.has_image === false ? undefined : str(u.image_url),
    banned: u.banned === true ? true : undefined,
    locked: u.locked === true ? true : undefined,
    public_metadata: bag(u.public_metadata),
    private_metadata: bag(u.private_metadata),
    unsafe_metadata: bag(u.unsafe_metadata),
    created_at: num(u.created_at),
    last_sign_in_at: num(u.last_sign_in_at),
  });
  if (csv) attachCsvPassword(set, user, csv);
  else if (u.password_enabled === true) set.omit('password', 'password digests are only in the dashboard CSV export');
  if (!user.emails?.length && !user.phones?.length && !user.username) {
    // A web3-wallet-only user: Clerk's wallet sign-in has no Atlas identifier to carry.
    set.omit('user', 'no email, phone or username (wallet-only users)');
    return;
  }
  set.add('user', user);

  for (const ext of objs(u.external_accounts)) {
    const provider = str(ext.provider);
    const sub = str(ext.provider_user_id) ?? str(ext.external_id);
    if (!provider || !sub) continue;
    set.add(
      'identity',
      compact<IdentityRecord>({
        id: str(ext.id),
        user_id: id,
        provider,
        provider_user_id: sub,
        kind: 'oauth',
        email: str(ext.email_address),
        email_verified: isObj(ext.verification) ? ext.verification.status === 'verified' : undefined,
        scopes: str(ext.approved_scopes)?.split(/\s+/),
        profile: bag(compact({ first_name: str(ext.first_name), last_name: str(ext.last_name), image_url: str(ext.image_url), username: str(ext.username) })),
      }),
    );
  }
  for (const ent of [...objs(u.enterprise_accounts), ...objs(u.saml_accounts)]) {
    const conn = isObj(ent.enterprise_connection) ? ent.enterprise_connection : isObj(ent.saml_connection) ? ent.saml_connection : undefined;
    const sub = str(ent.provider_user_id);
    if (!sub || ent.active === false) continue;
    set.add(
      'identity',
      compact<IdentityRecord>({
        id: str(ent.id),
        user_id: id,
        provider: str(ent.provider) ?? 'saml',
        provider_user_id: sub,
        kind: str(ent.protocol) === 'oauth' || str(ent.provider)?.startsWith('oidc') ? 'oidc' : 'saml',
        sso_connection_id: str(conn?.id),
        email: str(ent.email_address),
      }),
      `ent:${str(ent.id) ?? sub}`,
    );
  }
  const totp = csv ? str(csv.totp_secret) : undefined;
  if (totp) set.add('mfa_factor', { user_id: id, type: 'totp', secret_base32: totp.replace(/\s+/g, '').toUpperCase(), digits: 6, period: 30, algorithm: 'SHA1', verified: true });
  else if (u.totp_enabled === true) set.omit('mfa_factor', 'TOTP secrets are only in the dashboard CSV export');
  if (u.backup_code_enabled === true) set.omit('mfa_factor', 'Clerk does not export backup codes');
  if (objs(u.passkeys).length) set.omit('passkey', 'Clerk does not export passkey public keys', objs(u.passkeys).length);
}

/** A user from the CSV alone (no API access). */
function addCsvUser(set: RecordSet, r: Record<string, string>): void {
  const id = str(r.id);
  if (!id) return;
  const verified = split(r.verified_email_addresses);
  const unverified = split(r.unverified_email_addresses);
  const primary = str(r.primary_email_address)?.toLowerCase();
  const emails = [...new Set([...(primary ? [primary] : []), ...verified, ...unverified].map((e) => e.toLowerCase()))].map((email) => ({
    email,
    verified: verified.map((e) => e.toLowerCase()).includes(email),
    primary: email === primary,
  }));
  const vPhones = split(r.verified_phone_numbers);
  const phones = [...new Set([str(r.primary_phone_number), ...vPhones, ...split(r.unverified_phone_numbers)].filter((p): p is string => !!p))]
    .map((p) => ({ phone: e164(p), verified: vPhones.includes(p), primary: p === str(r.primary_phone_number) }))
    .filter((p): p is { phone: string; verified: boolean; primary: boolean } => !!p.phone);
  const user: UserRecord = compact({ id, emails, phones, username: str(r.username), first_name: str(r.first_name), last_name: str(r.last_name) });
  attachCsvPassword(set, user, r);
  if (!user.emails?.length && !user.phones?.length && !user.username) {
    set.omit('user', 'no email, phone or username');
    return;
  }
  set.add('user', user);
  const totp = str(r.totp_secret);
  if (totp) set.add('mfa_factor', { user_id: id, type: 'totp', secret_base32: totp.replace(/\s+/g, '').toUpperCase(), digits: 6, period: 30, algorithm: 'SHA1', verified: true });
}

function attachCsvPassword(set: RecordSet, user: UserRecord, r: Record<string, string>): void {
  const digest = str(r.password_digest);
  if (!digest) return;
  const mapped = clerkPasswordHash(str(r.password_hasher) ?? 'bcrypt', digest);
  if ('reason' in mapped) {
    set.omit('password', mapped.reason);
    return;
  }
  user.password = mapped;
}

const split = (v: string | undefined): string[] => (v ?? '').split(/[|,;]/).map((s) => s.trim()).filter(Boolean);

/**
 * A Clerk `password_digest` + `password_hasher` → the bundle's password hash
 * (an Atlas hash-registry algorithm with its parameters). Formats per Clerk's
 * `createUser` reference. Returns a reason when the digest cannot move: those
 * users sign in through lazy migration (Clerk's verify_password) instead.
 */
export function clerkPasswordHash(hasher: string, digest: string): PasswordHash | { reason: string } {
  const h = hasher.trim().toLowerCase();
  const parts = digest.split('$');
  const int = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : NaN);
  const isHex = (v: string) => v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v);
  switch (h) {
    case 'bcrypt':
      return { algorithm: 'bcrypt', hash: digest };
    case 'bcrypt_sha256_django':
      return { algorithm: 'bcrypt_sha256_django', hash: digest };
    case 'argon2i':
    case 'argon2id':
      return { algorithm: 'argon2', hash: digest };
    case 'phpass':
    case 'md5_phpass':
      return { algorithm: 'phpass', hash: digest };
    case 'ldap_ssha':
      return { algorithm: 'ldap_ssha', hash: digest };
    case 'md5':
    case 'sha256':
      return /^[0-9a-f]+$/i.test(digest) ? { algorithm: h, hash: digest.toLowerCase(), params: { encoding: 'hex' } } : { reason: `${h} digest is not hex` };
    case 'md5_salted':
    case 'sha256_salted':
      // Clerk does not document whether the salt is prepended or appended; a
      // guess that is wrong would lock the user out, so these verify lazily.
      return { reason: `${h}: Clerk does not document the salt position; these users move through lazy migration` };
    case 'pbkdf2_sha256_django':
      return { algorithm: 'pbkdf2_django', hash: digest };
    case 'pbkdf2_sha256': {
      // pbkdf2_sha256$<iterations>$<base64 salt>$<base64 hash>
      const [, it, salt, hash] = parts;
      if (parts.length !== 4 || !Number.isFinite(int(it)) || !salt || !hash) return { reason: 'malformed pbkdf2_sha256 digest' };
      return { algorithm: 'pbkdf2', hash, salt, params: { digest: 'sha256', iterations: int(it), encoding: 'base64', salt_encoding: 'base64' } };
    }
    case 'pbkdf2_sha1': {
      // pbkdf2_sha1$<iterations>$<salt>$<hex hash>[$<key length>]; the salt is
      // hex when it parses as hex, raw bytes otherwise.
      const [, it, salt, hash, keylen] = parts;
      if ((parts.length !== 4 && parts.length !== 5) || !Number.isFinite(int(it)) || !salt || !hash || !isHex(hash)) return { reason: 'malformed pbkdf2_sha1 digest' };
      const params: Record<string, string | number> = { digest: 'sha1', iterations: int(it), encoding: 'hex', salt_encoding: isHex(salt) ? 'hex' : 'utf8' };
      if (keylen && Number.isFinite(int(keylen))) params.key_length = int(keylen);
      return { algorithm: 'pbkdf2', hash, salt, params };
    }
    case 'pbkdf2_sha512':
    case 'pbkdf2_sha512_hex': {
      const [, it, salt, hash] = parts;
      if (parts.length !== 4 || !Number.isFinite(int(it)) || !salt || !hash || !isHex(hash)) return { reason: `malformed ${h} digest` };
      return { algorithm: 'pbkdf2', hash, salt, params: { digest: 'sha512', iterations: int(it), encoding: 'hex', salt_encoding: h === 'pbkdf2_sha512_hex' ? 'hex' : 'utf8' } };
    }
    case 'scrypt_firebase': {
      // <hash>$<salt>$<signer key>$<salt separator>$<rounds>$<memory cost>
      const [hash, salt, signerKey, saltSeparator, rounds, mem] = parts;
      if (parts.length !== 6 || !hash || !signerKey) return { reason: 'malformed scrypt_firebase digest' };
      return {
        algorithm: 'scrypt_firebase',
        hash,
        salt: salt ?? '',
        params: { signer_key: signerKey, salt_separator: saltSeparator ?? '', rounds: int(rounds), mem_cost: int(mem) },
      };
    }
    case 'scrypt_werkzeug': {
      // Werkzeug writes `scrypt:N:r:p$salt$<hex>`; Clerk documents the layout with
      // a leading `$` and a base64 hash. Normalise to Werkzeug's own form.
      const m = /^\$?(scrypt:\d+:\d+:\d+)\$([^$]+)\$([^$]+)$/.exec(digest);
      if (!m) return { reason: 'malformed scrypt_werkzeug digest' };
      const hex = isHex(m[3]!) ? m[3]!.toLowerCase() : Buffer.from(m[3]!, 'base64').toString('hex');
      return hex ? { algorithm: 'scrypt_werkzeug', hash: `${m[1]}$${m[2]}$${hex}` } : { reason: 'malformed scrypt_werkzeug digest' };
    }
    case 'sha512_symfony': {
      // sha512_symfony$<iterations>$<salt>$<base64 hash>
      const [, it, salt, hash] = parts;
      if (parts.length !== 4 || !Number.isFinite(int(it)) || salt === undefined || !hash) return { reason: 'malformed sha512_symfony digest' };
      return { algorithm: 'sha512_symfony', hash, salt, params: { iterations: int(it), encoding: 'base64' } };
    }
    case 'bcrypt_peppered':
      return { reason: 'bcrypt_peppered: the pepper never leaves Clerk; these users move through lazy migration' };
    case 'awscognito':
      return { reason: 'awscognito: the password still lives in Amazon Cognito; these users move through lazy migration' };
    default:
      return { reason: `password hasher "${hasher}" is not supported; these users move through lazy migration` };
  }
}

// ── organizations, keys, connections ────────────────────────────────────────

/** Clerk role keys carry an `org:` prefix; the bundle uses the bare key. */
export function roleKey(key: string): string {
  return key.replace(/^org:/, '');
}

/** `org:invoices:read` → `invoices:read`; system permissions keep their `sys_` key. */
export function permissionKey(key: string): string {
  return key.replace(/^org:/, '');
}

async function addApiKeys(set: RecordSet, http: VendorHttp, users: Set<string>, orgs: Set<string>): Promise<void> {
  let keys: Obj[];
  try {
    keys = await listAll(http, '/v1/api_keys', 100);
  } catch (err) {
    if (err instanceof VendorApiError && (err.status === 404 || err.status === 403)) return;
    throw err;
  }
  for (const k of keys) {
    const id = str(k.id);
    const subject = str(k.subject);
    if (!id || !subject || k.revoked === true) continue;
    // Clerk returns the secret on request: Atlas stores only its sha256, so
    // the key keeps working after the move.
    const secret = await optionalGet<{ secret?: string }>(http, `/v1/api_keys/${id}/secret`);
    const value = str(secret?.secret);
    if (!value) {
      set.omit('api_key', 'secret not retrievable; reissue');
      continue;
    }
    set.add(
      'api_key',
      compact({
        id,
        user_id: users.has(subject) ? subject : undefined,
        organization_id: orgs.has(subject) ? subject : undefined,
        name: str(k.name),
        hash: createHash('sha256').update(value, 'utf8').digest('hex'),
        hash_algorithm: 'sha256' as const,
        start: value.slice(0, 8),
        scopes: strs(k.scopes),
        expires_at: num(k.expiration),
        last_used_at: num(k.last_used_at),
        created_at: num(k.created_at),
      }),
    );
  }
}

async function addSsoConnections(set: RecordSet, http: VendorHttp): Promise<void> {
  let conns = await optionalList(http, '/v1/enterprise_connections');
  if (!conns.length) conns = await optionalList(http, '/v1/saml_connections');
  for (const c of conns) {
    const id = str(c.id);
    if (!id) continue;
    const saml = isObj(c.saml_connection) ? c.saml_connection : c;
    const oidc = isObj(c.oauth_config) ? c.oauth_config : isObj(c.oidc_connection) ? c.oidc_connection : undefined;
    const protocol = oidc && !str(saml.idp_sso_url) ? 'oidc' : 'saml';
    const domains = [...strs(c.domains), ...(str(c.domain) ? [str(c.domain)!] : [])];
    const mapping = isObj(saml.attribute_mapping) ? saml.attribute_mapping : undefined;
    set.add(
      'sso_connection',
      compact({
        id,
        name: str(c.name),
        organization_id: str(c.organization_id),
        protocol: protocol as 'saml' | 'oidc',
        domains: [...new Set(domains)],
        enabled: c.active !== false,
        saml:
          protocol === 'saml'
            ? compact({
                idp_entity_id: str(saml.idp_entity_id),
                idp_sso_url: str(saml.idp_sso_url),
                idp_certificate: str(saml.idp_certificate),
                idp_metadata_url: str(saml.idp_metadata_url),
                idp_metadata_xml: str(saml.idp_metadata),
                sp_entity_id: str(saml.sp_entity_id),
                sp_acs_url: str(saml.acs_url),
                attribute_mapping: mapping
                  ? (Object.fromEntries(Object.entries(mapping).filter(([, v]) => typeof v === 'string' && v)) as Record<string, string>)
                  : undefined,
              })
            : undefined,
        oidc:
          protocol === 'oidc' && oidc
            ? compact({ discovery_url: str(oidc.discovery_url), issuer: str(oidc.issuer), client_id: str(oidc.client_id), scopes: str(oidc.scopes)?.split(/\s+/) })
            : undefined,
      }),
    );
    if (protocol === 'oidc') set.warn(`Enterprise OIDC connection ${str(c.name) ?? id}: Clerk does not return its client secret; enter it in Atlas after the import.`);
  }
}

// ── paging ──────────────────────────────────────────────────────────────────

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** Clerk lists answer either a bare array or `{ data, total_count }`. */
function rowsOf(body: unknown): Obj[] {
  if (Array.isArray(body)) return body.filter(isObj);
  if (isObj(body) && Array.isArray(body.data)) return body.data.filter(isObj);
  return [];
}

async function listAll(http: VendorHttp, path: string, limit = PAGE): Promise<Obj[]> {
  const out: Obj[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += limit) {
    const { body } = await http.get<unknown>(`${path}${sep}limit=${limit}&offset=${offset}`);
    const rows = rowsOf(body);
    out.push(...rows);
    const total = isObj(body) && typeof body.total_count === 'number' ? body.total_count : undefined;
    if (rows.length < limit || (total !== undefined && out.length >= total)) return out;
  }
}

/** A list that may not exist on this instance's plan or API version: empty instead of an error. */
async function optionalList(http: VendorHttp, path: string): Promise<Obj[]> {
  try {
    return await listAll(http, path);
  } catch (err) {
    if (err instanceof VendorApiError && [400, 402, 403, 404, 410, 422].includes(err.status)) return [];
    throw err;
  }
}

async function optionalGet<T>(http: VendorHttp, path: string): Promise<T | null> {
  try {
    return (await http.get<T>(path)).body;
  } catch (err) {
    if (err instanceof VendorApiError && [400, 402, 403, 404, 410, 422].includes(err.status)) return null;
    throw err;
  }
}
