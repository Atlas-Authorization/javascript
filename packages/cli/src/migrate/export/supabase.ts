import { createDecipheriv, hkdfSync } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { IdentityRecord, MfaFactorRecord, PasskeyRecord, PasswordHash, SessionRecord, SsoConnectionRecord, UserRecord } from '@atlasauth/migrate';
import { sessionTokenHash } from '@atlasauth/migrate';
import { parseCsv } from '../../import/csv';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { VendorHttp } from './vendor-http';

/**
 * `atlas migrate export supabase` — Supabase Auth (GoTrue), hosted or
 * self-hosted, onto the canonical bundle models.
 *
 * The complete export reads the `auth` schema, which only the database
 * exposes: dump the tables with your own tools on your machine, e.g.
 *
 *   for t in users identities mfa_factors sessions refresh_tokens \
 *            sso_providers sso_domains saml_providers webauthn_credentials \
 *            mfa_recovery_code_sets mfa_recovery_codes; do
 *     psql "$SUPABASE_DB_URL" -c "\copy (select * from auth.$t) to '$t.csv' csv header"
 *   done
 *
 * and pass the folder. Files may be `<table>.csv` (with a header), `.json`
 * (an array) or `.ndjson`, named `users.csv` or `auth.users.csv`; missing
 * optional tables are skipped. Nothing connects to the database.
 *
 *   - users with emails / phone and their confirmed state, app_metadata
 *     (public metadata), user_metadata (unsafe metadata: users can edit it),
 *     bans, bcrypt / argon2 / Firebase-scrypt password hashes as stored;
 *   - social / OIDC identities and SAML SSO identities with their providers
 *     and domains;
 *   - TOTP factors WITH their secret (GoTrue stores it in plaintext unless
 *     column encryption is on: pass the GOTRUE_SECURITY_DB_ENCRYPTION key and
 *     both secrets and hashes are decrypted here), phone factors, WebAuthn factors and passkeys
 *     (with --rp-id), recovery codes as their argon2id hashes;
 *   - live sessions keyed by their legacy refresh tokens, for the bridge.
 *
 * Without a dump, the Admin API (`/auth/v1/admin/users`, service_role key)
 * gives users, identities and factor metadata but NO password hashes or TOTP
 * secrets: passwords then move by the supabase lazy-migration preset.
 */

export interface SupabaseExportOptions {
  /** A folder of auth-schema table dumps. */
  dumpDir?: string;
  /** Tables already read (tests, or a caller with its own reader). */
  tables?: Record<string, Obj[]>;
  /** `https://<ref>.supabase.co` (or a self-hosted URL), for the Admin API and the manifest. */
  url?: string;
  /** The service_role / secret key, for the Admin API (only when there is no dump). */
  serviceRoleKey?: string;
  /** The WebAuthn relying-party id passkeys were registered for. */
  rpId?: string;
  includeAnonymous?: boolean;
  /**
   * GoTrue column-encryption keys (GOTRUE_SECURITY_DB_ENCRYPTION_ENCRYPTION_KEY
   * and any _DECRYPTION_KEYS), each `key` or `key_id:key`: encrypted password
   * hashes and TOTP secrets are decrypted on this machine.
   */
  dbEncryptionKeys?: string[];
  /** How long an imported session stays exchangeable when Supabase set no `not_after` (default 30 days). */
  sessionDays?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (message: string) => void;
}

const SIGN_IN_METHODS = new Set(['email', 'phone', 'anonymous']);
const DAY = 24 * 3600_000;

// ── table dumps ────────────────────────────────────────────────────────────

/** Read every table file in a dump folder: `{ users: [...], identities: [...] }` (schema prefix dropped, lowercase). */
export function readTableDump(dir: string): Record<string, Obj[]> {
  const out: Record<string, Obj[]> = {};
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    if (!statSync(path).isFile()) continue;
    const ext = extname(file).toLowerCase();
    if (!['.json', '.ndjson', '.jsonl', '.csv'].includes(ext)) continue;
    const name = basename(file, extname(file)).toLowerCase().replace(/^auth[._]/, '');
    out[name] = parseTableText(readFileSync(path, 'utf8'), ext);
  }
  return out;
}

export function parseTableText(text: string, ext: string): Obj[] {
  const t = text.trim();
  if (!t) return [];
  if (ext === '.csv') return parseCsv(text).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === '' ? null : v])));
  if (ext === '.json') {
    const doc = JSON.parse(t) as unknown;
    if (Array.isArray(doc)) return objs(doc);
    if (isObj(doc) && Array.isArray(doc.rows)) return objs(doc.rows);
    throw new Error('A JSON table dump must be an array of rows.');
  }
  return t
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Obj);
}

/** A jsonb column: an object from JSON dumps, JSON text from CSV. */
function json(v: unknown): Obj | undefined {
  if (isObj(v)) return v;
  const s = str(v);
  if (!s || !s.startsWith('{')) return undefined;
  try {
    const o = JSON.parse(s);
    return isObj(o) ? o : undefined;
  } catch {
    return undefined;
  }
}
/** A jsonb array column: an array from JSON dumps, JSON text from CSV. */
function jsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const s = str(v);
  if (!s?.startsWith('[')) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
/** Postgres booleans: true / 't' / 'true'. */
const bool = (v: unknown): boolean => v === true || (typeof v === 'string' && ['t', 'true', '1'].includes(v.trim().toLowerCase()));
/** A timestamptz as Unix ms (psql writes `2024-05-01 10:00:00.123+00`). */
function ts(v: unknown): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  let iso = s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  // `timestamp without time zone` columns (sessions.refreshed_at) hold UTC.
  if (/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(iso)) iso += 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}
/** bytea (`\x…` hex from psql, or base64) → base64url. */
function bytesB64url(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (/^\\x[0-9a-f]*$/i.test(s)) return Buffer.from(s.slice(2), 'hex').toString('base64url');
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64url');
}

// ── passwords ──────────────────────────────────────────────────────────────

const FBSCRYPT = /^\$fbscrypt\$v=1,n=(\d+),r=(\d+),p=(\d+)(?:,ss=([^,$]+))?(?:,sk=([^$]+))?\$([^$]+)\$(.+)$/;

/**
 * `auth.users.encrypted_password` → a bundle password: bcrypt and argon2 are
 * self-describing; `$fbscrypt$` (Firebase users imported into Supabase) is
 * unpacked into the registry's scrypt_firebase fields. A value encrypted with
 * GoTrue's column encryption (JSON `aes-gcm-hkdf`) cannot be read here.
 */
export function supabasePassword(raw: unknown): { password?: PasswordHash; problem?: 'encrypted' | 'unknown' | 'no_signer_key' } {
  const s = str(raw);
  if (!s) return {};
  if (s.startsWith('{')) return { problem: 'encrypted' };
  if (/^\$2[aby]\$/.test(s) || /^\$argon2(id|i|d)\$/.test(s)) return { password: { algorithm: 'auto', hash: s } };
  const m = FBSCRYPT.exec(s);
  if (m) {
    if (!m[5]) return { problem: 'no_signer_key' };
    return {
      password: {
        algorithm: 'scrypt_firebase',
        hash: m[7]!,
        salt: m[6]!,
        // Supabase's n is the exponent: Firebase mem_cost.
        params: { rounds: Number(m[2]), mem_cost: Number(m[1]), salt_separator: m[4] ?? '', signer_key: m[5] },
      },
    };
  }
  return { problem: 'unknown' };
}

/**
 * GoTrue's column encryption (`crypto.EncryptedString`): a JSON
 * `{"key_id","alg":"aes-gcm-hkdf","data","nonce"}` (std base64), the AES-256-GCM
 * key derived as HKDF-SHA256(ikm = base64url key, no salt, info = the row id —
 * the user id for a password hash, the factor id for a TOTP secret). Keys
 * given as `key_id:key` are tried for their key id only; bare keys for any.
 * Undefined when the value is not an EncryptedString or no key opens it.
 */
export function decryptGotrueColumn(raw: string, rowId: string, keys: readonly string[]): string | undefined {
  let es: Obj;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObj(parsed)) return undefined;
    es = parsed;
  } catch {
    return undefined;
  }
  if (str(es.alg) !== 'aes-gcm-hkdf' || !str(es.data) || !str(es.nonce)) return undefined;
  const keyId = str(es.key_id);
  const data = Buffer.from(str(es.data)!, 'base64');
  const nonce = Buffer.from(str(es.nonce)!, 'base64');
  if (data.length < 17 || nonce.length !== 12) return undefined;
  for (const entry of keys) {
    const sep = entry.indexOf(':');
    const id = sep > 0 ? entry.slice(0, sep) : undefined;
    if (id && keyId && id !== keyId) continue;
    const ikm = Buffer.from((sep > 0 ? entry.slice(sep + 1) : entry).trim(), 'base64url');
    if (!ikm.length) continue;
    try {
      const key = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(rowId, 'utf8'), 32));
      const d = createDecipheriv('aes-256-gcm', key, nonce);
      d.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8');
    } catch {
      // wrong key: try the next one
    }
  }
  return undefined;
}

// ── export ─────────────────────────────────────────────────────────────────

export async function exportSupabase(opts: SupabaseExportOptions): Promise<RecordSet> {
  const progress = opts.onProgress ?? (() => undefined);
  const now = (opts.now ?? Date.now)();
  if (opts.tables || opts.dumpDir) {
    progress('auth schema dump');
    const tables = opts.tables ?? readTableDump(opts.dumpDir!);
    return mapSupabaseTables(tables, { ...opts, now });
  }
  if (!opts.url || !opts.serviceRoleKey) {
    throw new Error('Supabase export needs a dump of the auth schema (supabase-dump=<folder>), or the project URL and service_role key for the Admin API.');
  }
  progress('users (Admin API)');
  const users = await adminUsers(opts);
  const set = mapSupabaseTables({ users, identities: users.flatMap((u) => objs(u.identities).map((i) => ({ ...i, user_id: i.user_id ?? u.id }))), mfa_factors: users.flatMap((u) => objs(u.factors).map((f) => ({ ...f, user_id: u.id }))) }, { ...opts, now });
  set.warn('Exported through the Admin API, which never returns password hashes or TOTP secrets. Turn on the supabase lazy-migration preset (passwords are checked against Supabase on first sign-in), or export from a dump of the auth schema to move the hashes.');
  return set;
}

async function adminUsers(opts: SupabaseExportOptions): Promise<Obj[]> {
  const http = new VendorHttp({
    vendor: 'Supabase',
    baseUrl: `${opts.url!.replace(/\/+$/, '')}/auth/v1`,
    headers: { apikey: opts.serviceRoleKey!, authorization: `Bearer ${opts.serviceRoleKey}` },
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  const out: Obj[] = [];
  for (let page = 1; page < 100_000; page++) {
    const { body } = await http.get<Obj>(`/admin/users?page=${page}&per_page=1000`);
    const users = objs(body?.users);
    out.push(...users);
    if (users.length < 1000) break;
  }
  return out;
}

export function mapSupabaseTables(tables: Record<string, Obj[]>, opts: Omit<SupabaseExportOptions, 'now'> & { now: number }): RecordSet {
  const set = new RecordSet();
  const t = (name: string): Obj[] => tables[name] ?? [];
  if (!tables.users) throw new Error('The Supabase dump has no users table (users.csv / users.json / auth.users.csv).');
  if (opts.url) set.manifest.origin = `supabase ${opts.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;
  if (opts.rpId) set.manifest.rpId = opts.rpId;

  // ── SSO connections ──
  const saml = new Map(t('saml_providers').map((r) => [str(r.sso_provider_id), r] as const));
  const domainsOf = new Map<string, string[]>();
  for (const d of t('sso_domains')) {
    const id = str(d.sso_provider_id);
    const domain = str(d.domain)?.toLowerCase();
    if (id && domain) domainsOf.set(id, [...(domainsOf.get(id) ?? []), domain]);
  }
  const connections = new Set<string>();
  for (const p of t('sso_providers')) {
    const id = str(p.id);
    if (!id) continue;
    const s = saml.get(id);
    connections.add(id);
    set.add('sso_connection', compact({
      id,
      name: str(s?.name) ?? str(p.resource_id) ?? id,
      protocol: 'saml' as const,
      domains: domainsOf.get(id),
      enabled: !bool(p.disabled),
      saml: s ? compact({ idp_entity_id: str(s.entity_id), idp_metadata_xml: str(s.metadata_xml), idp_metadata_url: str(s.metadata_url), attribute_mapping: attributeMapping(json(s.attribute_mapping)) }) : undefined,
    }) as SsoConnectionRecord);
  }
  if (connections.size) set.warn('SAML connections keep their IdP settings, but Atlas has its own ACS URL and entity id: update each IdP before turning the connection on.');

  // ── users ──
  const users = new Set<string>();
  let encrypted = 0;
  let unknownHash = 0;
  let noSignerKey = 0;
  for (const u of t('users')) {
    const id = str(u.id);
    if (!id) continue;
    if (str(u.deleted_at)) {
      set.omit('user', 'deleted (soft-deleted in Supabase)');
      continue;
    }
    const anonymous = bool(u.is_anonymous);
    if (anonymous && !opts.includeAnonymous) {
      set.omit('user', 'anonymous user (left out unless supabase-anonymous=include)');
      continue;
    }
    let stored = u.encrypted_password;
    const keys = opts.dbEncryptionKeys ?? [];
    if (keys.length && typeof stored === 'string' && stored.startsWith('{')) stored = decryptGotrueColumn(stored, id, keys) ?? stored;
    const { password, problem } = supabasePassword(stored);
    if (problem === 'encrypted') encrypted++;
    if (problem === 'unknown') unknownHash++;
    if (problem === 'no_signer_key') noSignerKey++;
    const user = mapSupabaseUser(u, password, opts.now);
    if (!user) {
      set.omit('user', 'no email, phone number or identity');
      continue;
    }
    users.add(id);
    set.add('user', user, id);
  }
  if (encrypted) {
    const how = opts.dbEncryptionKeys?.length ? 'did not decrypt with the keys given' : 'are encrypted with GoTrue column encryption (pass --set supabase-db-encryption-keys=<key_id>:<key> to decrypt them here)';
    set.warn(`${encrypted} password hash(es) ${how} and were left out: those passwords move by lazy migration.`);
  }
  if (unknownHash) set.warn(`${unknownHash} password hash(es) are in a format Supabase does not issue and were left out.`);
  if (noSignerKey) set.warn(`${noSignerKey} Firebase-scrypt hash(es) have no signer key (sk=) and were left out: those passwords move by lazy migration.`);

  // ── identities ──
  for (const i of t('identities')) {
    const userId = str(i.user_id);
    const provider = str(i.provider);
    if (!userId || !provider || !users.has(userId) || SIGN_IN_METHODS.has(provider)) continue;
    const data = json(i.identity_data) ?? {};
    const subject = str(i.provider_id) ?? (str(i.identity_id) ? str(i.id) : undefined) ?? str(data.sub) ?? str(data.provider_id);
    if (!subject) continue;
    const sso = provider.startsWith('sso:') ? provider.slice(4) : undefined;
    set.add('identity', compact({
      // The dump's row id; the Admin API calls it identity_id (its `id` is the provider subject).
      id: str(i.identity_id) ?? (str(i.provider_id) ? str(i.id) : undefined),
      user_id: userId,
      provider: sso ? 'saml' : provider,
      provider_user_id: subject,
      kind: sso ? ('saml' as const) : ('oauth' as const),
      sso_connection_id: sso && connections.has(sso) ? sso : undefined,
      email: str(i.email ?? data.email)?.toLowerCase(),
      email_verified: data.email_verified === true ? true : undefined,
      profile: bag(data),
    }) as IdentityRecord, `${provider}:${subject}`);
  }

  // ── second factors and passkeys ──
  let totpEncrypted = 0;
  let webauthnNoRp = 0;
  for (const f of t('mfa_factors')) {
    const userId = str(f.user_id);
    if (!userId || !users.has(userId)) continue;
    if (str(f.status) !== 'verified') {
      set.omit('mfa_factor', 'unverified factor (enrollment never finished)');
      continue;
    }
    const type = str(f.factor_type);
    const created = ts(f.created_at);
    if (type === 'totp') {
      const secret = str(f.secret);
      if (!secret) {
        set.omit('mfa_factor', 'TOTP secret not in the export (the Admin API never returns it; export from a dump)');
        continue;
      }
      let plain = secret;
      if (secret.startsWith('{')) {
        const opened = opts.dbEncryptionKeys?.length && str(f.id) ? decryptGotrueColumn(secret, str(f.id)!, opts.dbEncryptionKeys) : undefined;
        if (!opened) {
          totpEncrypted++;
          continue;
        }
        plain = opened;
      }
      set.add('mfa_factor', compact({ id: str(f.id), user_id: userId, type: 'totp' as const, secret_base32: plain.replace(/=+$/, '').toUpperCase(), digits: 6, period: 30, algorithm: 'SHA1' as const, verified: true, created_at: created }) as MfaFactorRecord);
    } else if (type === 'phone') {
      const phone = e164(f.phone);
      if (phone) set.add('mfa_factor', compact({ id: str(f.id), user_id: userId, type: 'phone' as const, phone, verified: true, created_at: created }) as MfaFactorRecord);
      else set.omit('mfa_factor', 'phone factor without a valid number');
    } else if (type === 'webauthn') {
      const cred = json(f.web_authn_credential);
      const pk = cred ? webauthnFactorPasskey(cred, userId, f, opts.rpId) : null;
      if (pk) set.add('passkey', pk, pk.credential_id);
      else if (cred && !opts.rpId) webauthnNoRp++;
      else set.omit('passkey', 'WebAuthn factor without its credential');
    }
  }
  if (totpEncrypted) set.omit('mfa_factor', opts.dbEncryptionKeys?.length ? 'TOTP secret that does not decrypt with the GoTrue column-encryption keys given (the user enrols again)' : 'TOTP secret encrypted with GoTrue column encryption: pass --set supabase-db-encryption-keys=<key_id>:<key>, else the user enrols again', totpEncrypted);
  for (const c of t('webauthn_credentials')) {
    const userId = str(c.user_id);
    if (!userId || !users.has(userId)) continue;
    if (!opts.rpId) {
      webauthnNoRp++;
      continue;
    }
    const credentialId = bytesB64url(c.credential_id);
    const publicKey = bytesB64url(c.public_key);
    if (!credentialId || !publicKey) continue;
    const transports = strs(jsonArray(c.transports));
    set.add('passkey', compact({
      id: str(c.id),
      user_id: userId,
      credential_id: credentialId,
      public_key: publicKey,
      sign_count: Number(str(c.sign_count) ?? 0) || 0,
      rp_id: opts.rpId,
      transports,
      aaguid: str(c.aaguid),
      backed_up: bool(c.backed_up),
      name: str(c.friendly_name),
      created_at: ts(c.created_at),
    }) as PasskeyRecord, credentialId);
  }
  if (webauthnNoRp) set.omit('passkey', 'no relying-party id given (pass --rp-id with the domain the passkeys were registered on)', webauthnNoRp);

  // Recovery codes: argon2id hashes, verified as they are.
  const codeSets = new Map(t('mfa_recovery_code_sets').map((s) => [str(s.id), str(s.user_id)] as const));
  const codesOf = new Map<string, PasswordHash[]>();
  for (const c of t('mfa_recovery_codes')) {
    const userId = codeSets.get(str(c.mfa_recovery_code_set_id));
    const hash = str(c.code_hash);
    if (!userId || !users.has(userId) || !hash || str(c.consumed_at)) continue;
    codesOf.set(userId, [...(codesOf.get(userId) ?? []), { algorithm: 'auto', hash }]);
  }
  for (const [userId, hashes] of codesOf) set.add('mfa_factor', { user_id: userId, type: 'backup_codes', backup_code_hashes: hashes, verified: true });

  // ── sessions ──
  const days = opts.sessionDays ?? 30;
  const sessions = new Map(t('sessions').map((s) => [str(s.id), s] as const));
  let expired = 0;
  for (const r of t('refresh_tokens')) {
    const token = str(r.token);
    const userId = str(r.user_id);
    if (!token || !userId || !users.has(userId) || bool(r.revoked)) continue;
    const s = sessions.get(str(r.session_id));
    const notAfter = ts(s?.not_after);
    const expiresAt = notAfter ?? (ts(s?.refreshed_at ?? s?.updated_at ?? r.updated_at) ?? opts.now) + days * DAY;
    if (expiresAt <= opts.now) {
      expired++;
      continue;
    }
    set.add('session', compact({
      id: str(r.id) ?? token.slice(0, 4),
      user_id: userId,
      // The SSR cookie holds this refresh token: the supabase_refresh_token bridge preset hashes it the same way.
      token_hash: sessionTokenHash(token),
      expires_at: expiresAt,
      mfa_verified: str(s?.aal) === 'aal2' || str(s?.aal) === 'aal3' || undefined,
      created_at: ts(r.created_at),
      ip: str(s?.ip),
      user_agent: str(s?.user_agent),
    }) as SessionRecord, token);
  }
  if (expired) set.omit('session', 'expired or past the session time-box', expired);
  if (t('sessions').length && !t('refresh_tokens').length) {
    set.warn('The dump has sessions but no refresh_tokens table, so no session was exported; the supabase bridge still exchanges Supabase access tokens.');
  }

  set.manifest.providers = [...new Set(set.list('identity').map((i) => i.provider))].sort();
  return set;
}

export function mapSupabaseUser(u: Obj, password: PasswordHash | undefined, now: number): UserRecord | null {
  const id = str(u.id)!;
  const email = str(u.email)?.toLowerCase();
  const phone = e164(u.phone);
  const meta = json(u.raw_user_meta_data ?? u.user_metadata) ?? {};
  const app = { ...(json(u.raw_app_meta_data ?? u.app_metadata) ?? {}) };
  const providers = strs(app.providers);
  delete app.provider;
  delete app.providers;
  const anonymous = bool(u.is_anonymous);
  if (!email && !phone && !anonymous && !providers.some((p) => !SIGN_IN_METHODS.has(p))) return null;
  const bannedUntil = ts(u.banned_until);
  const role = str(u.role);
  return compact({
    id,
    emails: email ? [{ email, verified: !!str(u.email_confirmed_at), primary: true }] : undefined,
    phones: phone ? [{ phone, verified: !!str(u.phone_confirmed_at), primary: true }] : undefined,
    name: str(meta.full_name) ?? str(meta.name),
    image_url: str(meta.avatar_url) ?? str(meta.picture),
    password,
    banned: bannedUntil !== undefined && bannedUntil > now ? true : undefined,
    // Supabase writes "infinity"-like far dates for a permanent ban; Atlas keeps an expiry only when it is real.
    ban_expires_at: bannedUntil !== undefined && bannedUntil > now && bannedUntil < now + 50 * 365 * DAY ? bannedUntil : undefined,
    anonymous: anonymous || undefined,
    // app_metadata is server-written and rides in the JWT; user_metadata is editable by the user.
    public_metadata: bag(app),
    unsafe_metadata: bag(meta),
    private_metadata: bag(compact({ supabase_role: role && role !== 'authenticated' ? role : undefined, supabase_sso_user: bool(u.is_sso_user) || undefined, supabase_providers: providers.length ? providers : undefined })),
    created_at: ts(u.created_at),
    last_sign_in_at: ts(u.last_sign_in_at),
  }) as UserRecord;
}

/** GoTrue's `attribute_mapping` (`{ keys: { email: { name: "…" } } }`) → attribute → SAML attribute name. */
function attributeMapping(m: Obj | undefined): Record<string, string> | undefined {
  const keys = m && isObj(m.keys) ? m.keys : undefined;
  if (!keys) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(keys)) {
    const name = isObj(v) ? str(v.name) ?? strs(v.names)[0] : undefined;
    if (name) out[k] = name;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A WebAuthn MFA factor's go-webauthn credential → a passkey record. */
function webauthnFactorPasskey(cred: Obj, userId: string, f: Obj, rpId: string | undefined): PasskeyRecord | null {
  if (!rpId) return null;
  const credentialId = bytesB64url(cred.id ?? cred.ID);
  const publicKey = bytesB64url(cred.publicKey ?? cred.PublicKey);
  if (!credentialId || !publicKey) return null;
  const auth = isObj(cred.authenticator) ? cred.authenticator : isObj(cred.Authenticator) ? cred.Authenticator : {};
  const flags = isObj(cred.flags) ? cred.flags : {};
  const aaguidRaw = str(f.web_authn_aaguid);
  return compact({
    id: str(f.id),
    user_id: userId,
    credential_id: credentialId,
    public_key: publicKey,
    sign_count: typeof auth.signCount === 'number' ? auth.signCount : 0,
    rp_id: rpId,
    transports: strs(cred.transport ?? cred.Transport),
    aaguid: aaguidRaw,
    backed_up: flags.backupState === true ? true : undefined,
    name: str(f.friendly_name),
    created_at: ts(f.created_at),
  }) as PasskeyRecord;
}
