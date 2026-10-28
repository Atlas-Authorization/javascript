import { createDecipheriv } from 'node:crypto';
import type { PasswordHash, UserRecord } from '@atlasauth/migrate';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { VendorApiError, VendorHttp } from './vendor-http';
import { readZip, zipFile } from './zip';

/**
 * `atlas migrate export kinde` — Kinde onto the canonical bundle models.
 *
 * Two sources, merged by Kinde user id (`kp_…`):
 *   - Kinde's DATA EXPORT (Settings → Business → Details → Export data). Choose
 *     "All data" to include password hashes (owners approve it; the file is
 *     available once). It downloads as an AES-256-CTR encrypted `.dat` with a
 *     Key and IV shown at download; this command decrypts it locally, or takes
 *     the already decrypted zip / `users.ndjson`. Each user carries
 *     `password: { hashed_password, hashing_algorithm, hashing_config }`;
 *   - the Management API (a machine-to-machine application's client id +
 *     secret, on this machine): organizations with their members and roles,
 *     roles with permissions, and enterprise connections.
 *
 * Kinde has no password-verifying API (no password grant), so there is no
 * lazy migration from Kinde: the data export is the way passwords move.
 * Kinde does not export second-factor secrets; users re-enrol. Sessions are
 * Kinde-issued JWTs, bridged by the `kinde` bridge preset.
 */

export interface KindeExportOptions {
  /** `https://acme.kinde.com` (KINDE_ISSUER_URL / KINDE_DOMAIN). */
  domain?: string;
  clientId?: string;
  clientSecret?: string;
  /** The encrypted `.dat` export, with the Key and IV Kinde showed at download (hex). */
  encryptedExport?: { data: Buffer; key: string; iv: string };
  /** The decrypted export zip. */
  zip?: Buffer;
  /** `users.ndjson` text, when extracted already. */
  usersNdjson?: string;
  organizationsNdjson?: string;
  /** Include Kinde's default organization (every user is a member of it). */
  includeDefaultOrganization?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/** AES-256-CTR, the scheme of Kinde's `.dat` export (`openssl aes-256-ctr -d -nosalt -K <key> -iv <iv>`). */
export function decryptKindeExport(data: Buffer, keyHex: string, ivHex: string): Buffer {
  const key = Buffer.from(keyHex.trim(), 'hex');
  const iv = Buffer.from(ivHex.trim(), 'hex');
  if (key.length !== 32) throw new Error('The Kinde export Key must be 64 hex characters (AES-256).');
  if (iv.length !== 16) throw new Error('The Kinde export Initialization Vector must be 32 hex characters.');
  const d = createDecipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([d.update(data), d.final()]);
}

export async function exportKinde(opts: KindeExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const progress = opts.onProgress ?? (() => undefined);

  // ── the data export (users + passwords) ──
  let usersText = opts.usersNdjson;
  let orgsText = opts.organizationsNdjson;
  if (opts.encryptedExport || opts.zip) {
    const zip = opts.zip ?? decryptKindeExport(opts.encryptedExport!.data, opts.encryptedExport!.key, opts.encryptedExport!.iv);
    if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error('The decrypted Kinde export is not a zip: check the Key and IV.');
    const files = readZip(zip);
    usersText ??= zipFile(files, 'users.ndjson')?.toString('utf8');
    orgsText ??= zipFile(files, 'organizations.ndjson')?.toString('utf8');
    if (usersText === undefined) throw new Error('The Kinde export has no users.ndjson.');
  }
  const exported = usersText !== undefined ? ndjson(usersText) : [];
  const online = Boolean(opts.domain && opts.clientId && opts.clientSecret);
  if (!online && usersText === undefined) {
    throw new Error('Kinde export needs the data export file (with its Key and IV) and/or a machine-to-machine application (domain, client id, secret).');
  }

  const base = opts.domain ? `https://${opts.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : '';
  let token: string | undefined;
  const http = new VendorHttp({
    vendor: 'Kinde',
    baseUrl: `${base}/api/v1`,
    headers: async () => ({ authorization: `Bearer ${(token ??= await m2mToken(base, opts))}` }),
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });

  // ── organizations ──
  progress('organizations');
  const orgCodes = new Set<string>();
  let defaultOrg: string | undefined;
  const orgRows = online ? await tokenAll(http, '/organizations?page_size=500', 'organizations') : orgsText ? ndjson(orgsText) : [];
  for (const o of orgRows) {
    const code = str(o.code) ?? str(o.organization_code);
    const name = str(o.name);
    if (!code || !name) continue;
    // The API flags it; the export file does not, so it is known there by Kinde's default name.
    if (o.is_default === true || (o.is_default === undefined && name === 'Default Organization')) defaultOrg = code;
    if (code === defaultOrg && !opts.includeDefaultOrganization) continue;
    orgCodes.add(code);
    set.add('organization', compact({ id: code, name, slug: str(o.handle), created_at: str(o.created_on) }));
  }
  if (defaultOrg && !opts.includeDefaultOrganization) {
    set.warn(`Kinde's default organization (${defaultOrg}) holds every user and was not exported as an organization (pass --kinde-include-default-org to keep it).`);
  }

  // ── roles ──
  const roleById = new Map<string, string>();
  if (online) {
    progress('roles');
    for (const r of await tokenAll(http, '/roles?page_size=500', 'roles')) {
      const id = str(r.id);
      const key = str(r.key);
      if (!id || !key) continue;
      roleById.set(id, key);
      const permissions = (await tokenAll(http, `/roles/${id}/permissions?page_size=500`, 'permissions')).map((p) => str(p.key)).filter((p): p is string => !!p);
      set.add('role', compact({ key, name: str(r.name), description: str(r.description), scope: 'organization' as const, permissions }), key);
    }
  }

  // ── users: the export (with passwords) first, the API fills the rest ──
  progress('users');
  const users = new Map<string, Obj>();
  for (const u of exported) if (str(u.id)) users.set(u.id as string, u);
  if (online) {
    for (const u of await tokenAll(http, '/users?page_size=500&expand=organizations,identities', 'users')) {
      const id = str(u.id);
      if (!id) continue;
      users.set(id, { ...u, ...(users.get(id) ?? {}) });
    }
  }
  let withPassword = 0;
  for (const u of users.values()) {
    const user = mapKindeUser(u, set);
    if (!user) {
      set.omit('user', 'no email, phone number or username');
      continue;
    }
    if (user.password) withPassword++;
    set.add('user', user);
    // Without API access, memberships come from the export's organization codes.
    if (!online) {
      for (const code of strs(u.organizations)) {
        if (orgCodes.has(code)) set.add('membership', { organization_id: code, user_id: user.id, role: 'member' }, `${code}:${user.id}`);
      }
    }
  }
  if (exported.length === 0) {
    set.warn('No data export given: password hashes come only from Kinde\'s data export ("All data"). Without them users set a new password (Kinde has no API to verify one).');
  } else if (withPassword === 0) {
    set.warn('The data export has no passwords: request "All data" (not "All data except passwords") to carry them.');
  }

  // ── memberships with roles ──
  if (online) {
    progress('organization members');
    const userIds = new Set(set.list('user').map((u) => u.id));
    for (const code of orgCodes) {
      for (const m of await tokenAll(http, `/organizations/${code}/users?page_size=500`, 'organization_users')) {
        const uid = str(m.id);
        if (!uid || !userIds.has(uid)) continue;
        const role = strs(m.roles)[0] ?? 'member';
        set.add('membership', compact({ organization_id: code, user_id: uid, role, created_at: str(m.joined_on) }), `${code}:${uid}`);
        if (strs(m.roles).length > 1) set.warn('Some organization members hold several Kinde roles; Atlas seats each member with one role (the first).');
      }
    }
    progress('connections');
    await addConnections(set, http);
  }

  set.warn('Kinde does not export second-factor secrets or passkeys: those users re-enrol in Atlas.');
  set.manifest = { origin: base || null, providers: [...new Set(set.list('identity').map((i) => i.provider))].sort() };
  return set;
}

/** One Kinde user (export row and/or API row) → a user record. */
export function mapKindeUser(u: Obj, set?: RecordSet): UserRecord | null {
  const id = str(u.id);
  if (!id) return null;
  const identities = objs(u.identities);
  const email = (str(u.email) ?? str(u.preferred_email))?.toLowerCase();
  const emailIdentity = identities.find((i) => str(i.type) === 'email' && str(i.identity)?.toLowerCase() === email);
  const phone = e164(u.phone) ?? e164(identities.find((i) => str(i.type) === 'phone')?.identity);
  const username = str(u.username) ?? str(identities.find((i) => str(i.type) === 'username')?.identity);
  const user: UserRecord = compact({
    id,
    emails: email
      ? [{ email, verified: u.email_verified === true || emailIdentity?.is_confirmed === true || (u.email_verified === undefined && identities.some((i) => str(i.type)?.startsWith('oauth2:'))), primary: true }]
      : [],
    phones: phone ? [{ phone, verified: false, primary: !email }] : [],
    username,
    first_name: str(u.first_name),
    last_name: str(u.last_name),
    image_url: str(u.picture),
    banned: u.is_suspended === true ? true : undefined,
    private_metadata: bag(compact({ kinde_external_id: str(u.external_id) ?? str(u.provided_id) })),
    created_at: str(u.created_on),
    last_sign_in_at: str(u.last_signed_in),
  });
  if (isObj(u.password)) {
    const mapped = kindePasswordHash(u.password);
    if ('reason' in mapped) set?.omit('password', mapped.reason);
    else user.password = mapped;
  }
  const social = identities.filter((i) => str(i.type)?.startsWith('oauth2:'));
  if (social.length) set?.omit('identity', "Kinde does not export social accounts' provider user ids: they relink by verified email on first social sign-in", social.length);
  return user.emails?.length || user.phones?.length || user.username ? user : null;
}

/**
 * Kinde's exported `password` object → the bundle's password hash. Kinde
 * stores bcrypt; users imported into Kinde keep the algorithm they came with
 * (crypt, md5, sha256, wordpress, pbkdf2, firebase-scrypt, aspnet-identity-v2).
 */
export function kindePasswordHash(p: Obj): PasswordHash | { reason: string } {
  const hash = str(p.hashed_password);
  if (!hash) return { reason: 'empty Kinde password hash' };
  const algorithm = (str(p.hashing_algorithm) ?? '').toLowerCase().replace(/_/g, '-');
  const config = isObj(p.hashing_config) ? p.hashing_config : {};
  const salt = str(config.salt);
  const position = (str(config.salt_position) ?? str(config.salt_location) ?? str(config.position) ?? 'suffix').toLowerCase();
  switch (algorithm) {
    case '':
    case 'bcrypt':
      return { algorithm: 'bcrypt', hash };
    case 'crypt':
    case 'wordpress':
    case 'phpass':
      // Self-describing ($1$, $5$, $6$, $2y$, $P$): the registry recognises them.
      return { algorithm: 'auto', hash };
    case 'md5':
    case 'sha256':
      if (!salt) return { algorithm, hash, params: { encoding: /^[0-9a-f]+$/i.test(hash) ? 'hex' : 'base64' } };
      return {
        algorithm: `${algorithm}_salted`,
        hash,
        salt,
        params: { encoding: /^[0-9a-f]+$/i.test(hash) ? 'hex' : 'base64', salt_position: position === 'prefix' ? 'prefix' : 'suffix' },
      };
    case 'pbkdf2': {
      if (hash.includes('$')) return { algorithm: 'auto', hash };
      const iterations = Number(config.iterations ?? config.rounds);
      if (!salt || !Number.isInteger(iterations)) return { reason: 'Kinde pbkdf2 hash without salt or iterations' };
      return {
        algorithm: 'pbkdf2',
        hash,
        salt,
        params: { digest: str(config.digest)?.toLowerCase() ?? 'sha256', iterations, ...(str(config.salt_encoding) ? { salt_encoding: str(config.salt_encoding)! } : {}) },
      };
    }
    case 'firebase-scrypt': {
      const signer = str(config.signer_key) ?? str(config.base64_signer_key);
      if (!signer) return { reason: 'Kinde firebase-scrypt hash without the project signer key' };
      return {
        algorithm: 'scrypt_firebase',
        hash,
        salt: salt ?? '',
        params: {
          signer_key: signer,
          salt_separator: str(config.salt_separator) ?? str(config.base64_salt_separator) ?? 'Bw==',
          rounds: Number(config.rounds ?? 8),
          mem_cost: Number(config.mem_cost ?? config.memory_cost ?? 14),
        },
      };
    }
    case 'aspnet-identity-v2':
    case 'aspnet-identity-v3':
      return { algorithm: 'aspnet_identity', hash };
    default:
      return { reason: `Kinde password algorithm "${algorithm}" is not supported` };
  }
}

async function addConnections(set: RecordSet, http: VendorHttp): Promise<void> {
  let conns: Obj[];
  try {
    conns = await tokenAll(http, '/connections?page_size=500', 'connections');
  } catch (err) {
    if (err instanceof VendorApiError && (err.status === 403 || err.status === 404)) return;
    throw err;
  }
  for (const c of conns) {
    const id = str(c.id);
    const strategy = str(c.strategy) ?? '';
    if (!id || !/^(saml|wsfed|oidc|oauth2:(azure_ad|microsoft_entra|okta|google_workspace))/.test(strategy)) continue;
    let detail: Obj = c;
    try {
      const { body } = await http.get<Obj>(`/connections/${id}`);
      detail = isObj(body) && isObj(body.connection) ? body.connection : isObj(body) ? body : c;
    } catch (err) {
      if (!(err instanceof VendorApiError)) throw err;
    }
    const o = isObj(detail.options) ? detail.options : {};
    const domains = strs(o.home_realm_domains);
    const name = str(c.display_name) ?? str(c.name);
    if (strategy.startsWith('saml')) {
      set.add(
        'sso_connection',
        compact({
          id,
          name,
          protocol: 'saml' as const,
          domains,
          saml: compact({
            idp_entity_id: str(o.saml_entity_id),
            idp_metadata_url: str(o.saml_idp_metadata_url),
            idp_sso_url: str(o.saml_sign_in_url) ?? str(o.saml_sso_url),
            idp_certificate: str(o.saml_signing_certificate) ?? str(o.saml_certificate),
            sp_acs_url: str(o.saml_acs_url),
          }),
        }),
      );
    } else {
      set.add(
        'sso_connection',
        compact({ id, name, protocol: 'oidc' as const, domains, oidc: compact({ issuer: str(o.issuer) ?? str(o.entra_id_domain), client_id: str(o.client_id) }) }),
      );
      set.warn(`Enterprise connection ${name ?? id}: Kinde does not return its client secret; enter it in Atlas after the import.`);
    }
  }
}

export async function m2mToken(base: string, opts: KindeExportOptions): Promise<string> {
  const res = await (opts.fetchImpl ?? fetch)(`${base}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: opts.clientId!, client_secret: opts.clientSecret!, audience: `${base}/api` }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new VendorApiError('Kinde', res.status, '/oauth2/token', body.error_description ?? 'could not get a Management API token');
  return body.access_token;
}

/** Kinde's `next_token` paging. */
async function tokenAll(http: VendorHttp, path: string, key: string): Promise<Obj[]> {
  const out: Obj[] = [];
  let next: string | undefined;
  do {
    const { body } = await http.get<Obj>(`${path}${next ? `&next_token=${encodeURIComponent(next)}` : ''}`);
    const rows = isObj(body) ? objs(body[key]) : [];
    out.push(...rows);
    next = isObj(body) ? str(body.next_token) : undefined;
    if (rows.length === 0) break;
  } while (next);
  return out;
}

function ndjson(text: string): Obj[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown)
    .filter(isObj);
}
