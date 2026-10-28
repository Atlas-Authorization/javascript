import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { UserRecord } from '@atlasauth/migrate';
import { parseTable } from './pocketbase';
import { RecordSet, bag, compact, e164, isObj, objs, str, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorHttp } from './vendor-http';

/**
 * `atlas migrate export nhost` — an Nhost project's `auth` schema.
 *
 * Nhost tracks its auth tables in Hasura, so the export reads them through the
 * project's GraphQL endpoint with the admin secret (on this machine only):
 * `users` (bcrypt `passwordHash`, TOTP secret), `authUserProviders`,
 * `authUserSecurityKeys`, `authUserRoles` and `authRefreshTokens`. A
 * self-hosted project can instead hand over a dump of the `auth.*` tables
 * (`psql \copy … to 'users.csv' csv header`, or JSON), snake_case columns.
 *
 * What moves: users with verified email / phone, display name, avatar,
 * locale and metadata, disabled → banned, anonymous users; bcrypt hashes as
 * they are; social links; WebAuthn security keys (as passkeys, for the
 * relying-party id the project used); allowed roles as app roles; TOTP
 * secrets (plaintext on legacy hasura-auth, AES-256-GCM under
 * AUTH_ENCRYPTION_KEY on current versions — decrypted here when the key is
 * given, else those users enrol again); SMS second factors by phone; and live
 * refresh tokens. Nhost stores `\x` + hex(sha256(refresh token)), exactly the
 * `token_hash` the `nhost` bridge preset looks up, so signed-in users move
 * without a new sign-in. Personal access tokens are left out (reissue them).
 */

export interface NhostRows {
  users: Obj[];
  providers: Obj[];
  securityKeys: Obj[];
  userRoles: Obj[];
  refreshTokens: Obj[];
}

export interface NhostExportOptions {
  /** AUTH_ENCRYPTION_KEY (64 hex chars) to decrypt TOTP secrets. */
  encryptionKey?: string;
  /** The WebAuthn relying-party id security keys were registered for (nhost.toml auth.method.webauthn.relyingParty.id). */
  rpId?: string;
  origin?: string;
  now?: () => number;
}

/** Roles every Nhost user has implicitly: not carried as Atlas roles. */
const IMPLICIT_ROLES = new Set(['user', 'me', 'anonymous', 'public']);

export function exportNhost(rows: NhostRows, opts: NhostExportOptions = {}): RecordSet {
  const set = new RecordSet();
  const now = (opts.now ?? Date.now)();
  const key = opts.encryptionKey ? parseKey(opts.encryptionKey) : undefined;

  const rolesOf = new Map<string, Set<string>>();
  for (const r of rows.userRoles) {
    const userId = str(r.userId);
    const role = str(r.role);
    if (!userId || !role || IMPLICIT_ROLES.has(role)) continue;
    (rolesOf.get(userId) ?? rolesOf.set(userId, new Set()).get(userId)!).add(keyOf(role));
  }

  const ids = new Set<string>();
  const allRoles = new Set<string>();
  let totpLocked = 0;
  let totpBroken = 0;
  for (const u of rows.users) {
    const id = str(u.id);
    if (!id) continue;
    const user = mapUser(u, rolesOf.get(id));
    if (!user) {
      set.omit('user', 'user without an email or phone number who is not anonymous');
      continue;
    }
    ids.add(id);
    for (const r of user.roles ?? []) allRoles.add(r);
    set.add('user', compact(user));

    const mfa = str(u.activeMfaType);
    const secret = str(u.totpSecret);
    if (mfa === 'totp' && secret) {
      const plain = secret.length < 64 ? secret : key ? decryptTotp(secret, key) : undefined;
      if (plain && /^[A-Z2-7]+=*$/i.test(plain)) set.add('mfa_factor', { user_id: id, type: 'totp', secret_base32: plain.toUpperCase().replace(/=+$/, ''), digits: 6, period: 30, algorithm: 'SHA1', verified: true });
      else if (secret.length >= 64 && !key) totpLocked++;
      else totpBroken++;
    } else if (mfa === 'sms') {
      const phone = e164(u.phoneNumber);
      if (phone) set.add('mfa_factor', { user_id: id, type: 'phone', phone, verified: truthy(u.phoneNumberVerified) });
    }
  }
  for (const r of [...allRoles].sort()) set.add('role', { key: r, name: r, scope: 'app' }, r);
  if (totpLocked) set.omit('mfa_factor', 'TOTP secret encrypted with AUTH_ENCRYPTION_KEY: pass --set nhost-encryption-key=<hex> to carry it, else those users enrol again', totpLocked);
  if (totpBroken) set.omit('mfa_factor', 'TOTP secret that does not decrypt with the given AUTH_ENCRYPTION_KEY', totpBroken);

  for (const p of rows.providers) {
    const userId = str(p.userId);
    const provider = str(p.providerId);
    const providerUserId = str(p.providerUserId);
    if (!userId || !provider || !providerUserId || !ids.has(userId)) continue;
    set.add('identity', compact({ id: str(p.id), user_id: userId, provider, provider_user_id: providerUserId, kind: 'oauth' as const }), `${provider}:${providerUserId}`);
  }

  const keys = rows.securityKeys.filter((k) => ids.has(str(k.userId) ?? ''));
  if (keys.length && !opts.rpId) {
    set.omit('passkey', 'security key without a relying-party id: pass --set rp-id=<your WebAuthn rp id> (nhost.toml auth.method.webauthn.relyingParty.id)', keys.length);
  } else {
    for (const k of keys) {
      const credentialId = str(k.credentialId);
      const publicKey = byteaToBase64url(k.credentialPublicKey);
      if (!credentialId || !publicKey) {
        set.omit('passkey', 'security key without its credential id or public key');
        continue;
      }
      const transports = (str(k.transports) ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      set.add('passkey', compact({ id: str(k.id), user_id: str(k.userId)!, credential_id: credentialId, public_key: publicKey, sign_count: num(k.counter), rp_id: opts.rpId!, transports, name: str(k.nickname) }));
    }
  }

  let pats = 0;
  let expired = 0;
  for (const t of rows.refreshTokens) {
    const userId = str(t.userId);
    if (!userId || !ids.has(userId)) continue;
    if ((str(t.type) ?? 'regular') !== 'regular') {
      pats++;
      continue;
    }
    const expires = Date.parse(str(t.expiresAt) ?? '');
    if (!Number.isFinite(expires) || expires <= now) {
      expired++;
      continue;
    }
    const hash = refreshTokenHash(t);
    if (!hash) {
      set.omit('session', 'refresh token row without a readable hash');
      continue;
    }
    set.add('session', compact({ id: str(t.id) ?? hash.slice(0, 32), user_id: userId, token_hash: hash, expires_at: str(t.expiresAt)!, created_at: str(t.createdAt) }));
  }
  if (pats) set.omit('session', 'personal access token (reissue it as an Atlas API key)', pats);
  if (expired) set.omit('session', 'expired refresh token', expired);

  const providers = new Set(set.list('identity').map((i) => i.provider));
  set.manifest = { ...set.manifest, origin: opts.origin ?? 'nhost', providers: [...providers].sort(), ...(opts.rpId ? { rpId: opts.rpId } : {}) };
  return set;
}

function mapUser(u: Obj, roles: Set<string> | undefined): UserRecord | null {
  const email = str(u.email)?.toLowerCase();
  const phone = e164(u.phoneNumber);
  const anonymous = truthy(u.isAnonymous);
  if (!email && !phone && !anonymous) return null;
  const all = new Set(roles ?? []);
  const def = str(u.defaultRole);
  if (def && !IMPLICIT_ROLES.has(def)) all.add(keyOf(def));
  const hash = str(u.passwordHash);
  const meta = isObj(u.metadata) ? u.metadata : typeof u.metadata === 'string' ? safeJson(u.metadata) : undefined;
  const locale = str(u.locale);
  const user: UserRecord = {
    id: str(u.id)!,
    emails: email ? [{ email, verified: truthy(u.emailVerified), primary: true }] : undefined,
    phones: phone ? [{ phone, verified: truthy(u.phoneNumberVerified), primary: !email }] : undefined,
    name: str(u.displayName),
    image_url: str(u.avatarUrl),
    password: hash && /^\$2[aby]\$\d{2}\$/.test(hash) ? { algorithm: 'auto', hash } : undefined,
    roles: all.size ? [...all].sort() : undefined,
    banned: truthy(u.disabled) ? true : undefined,
    anonymous: anonymous && !email && !phone ? true : undefined,
    public_metadata: bag({ ...(isObj(meta) ? meta : {}), ...(locale ? { locale } : {}) }),
    created_at: str(u.createdAt),
    last_sign_in_at: str(u.lastSeen),
  };
  return user;
}

/** `\x` + hex(sha256(token)) as Nhost stores it → the bundle's lowercase hex. */
export function refreshTokenHash(t: Obj): string | undefined {
  const raw = str(t.refreshTokenHash);
  if (!raw) {
    // Legacy hasura-auth kept the token itself (a UUID) in refresh_token.
    const plain = str(t.refreshToken);
    return plain ? createHash('sha256').update(plain, 'utf8').digest('hex') : undefined;
  }
  const hex = raw.replace(/^\\x/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/**
 * Current Nhost encrypts TOTP secrets: AES-256-GCM, stored as
 * hex(nonce(12) || ciphertext || tag(16)), key = AUTH_ENCRYPTION_KEY (hex).
 */
export function decryptTotp(stored: string, key: Buffer): string | undefined {
  try {
    const raw = Buffer.from(stored, 'hex');
    if (raw.length < 12 + 16 + 1) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

function parseKey(hex: string): Buffer {
  const k = Buffer.from(hex.trim(), 'hex');
  if (k.length !== 32) throw new Error('The Nhost encryption key (AUTH_ENCRYPTION_KEY) must be 32 bytes as 64 hex characters.');
  return k;
}

/** Postgres bytea as Hasura / psql print it (`\x…` hex), or base64 → base64url. */
export function byteaToBase64url(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (/^\\x[0-9a-f]*$/i.test(s)) return Buffer.from(s.slice(2), 'hex').toString('base64url');
  return Buffer.from(s, 'base64').toString('base64url');
}

const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't' || v === 'true';
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

// ── readers ─────────────────────────────────────────────────────────────────

/** Nhost Cloud's GraphQL endpoint for a subdomain and region. */
export function nhostGraphqlUrl(o: { subdomain: string; region: string }): string {
  return `https://${o.subdomain}.graphql.${o.region}.nhost.run/v1`;
}

const PAGE = 1000;

const QUERIES = {
  users: 'id createdAt lastSeen disabled displayName avatarUrl locale email phoneNumber passwordHash emailVerified phoneNumberVerified defaultRole isAnonymous totpSecret activeMfaType metadata',
  authUserProviders: 'id userId providerId providerUserId',
  authUserSecurityKeys: 'id userId credentialId credentialPublicKey counter transports nickname',
  authUserRoles: 'userId role',
  authRefreshTokens: 'id userId createdAt expiresAt refreshTokenHash type',
} as const;

/** The auth tables through Hasura with the admin secret (sent only to the project). */
export async function fetchNhostRows(opts: { graphqlUrl: string; adminSecret: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; onProgress?: (m: string) => void }): Promise<NhostRows> {
  const http = new VendorHttp({ vendor: 'Nhost', baseUrl: opts.graphqlUrl, headers: { 'x-hasura-admin-secret': opts.adminSecret }, fetchImpl: opts.fetchImpl, sleep: opts.sleep });
  const progress = opts.onProgress ?? (() => undefined);
  const list = async (root: keyof typeof QUERIES, fields: string, order: string): Promise<Obj[]> => {
    const out: Obj[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const query = `query { ${root}(limit: ${PAGE}, offset: ${offset}, order_by: { ${order}: asc }) { ${fields} } }`;
      const { body } = await http.post<Obj>(opts.graphqlUrl, { query });
      const errors = isObj(body) ? objs(body.errors) : [];
      if (errors.length) throw new GraphqlError(str(errors[0]!.message) ?? 'GraphQL error');
      const rows = isObj(body) && isObj(body.data) ? objs(body.data[root]) : [];
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  };
  progress('users');
  const users = await list('users', QUERIES.users, 'createdAt');
  progress('social links');
  const providers = await list('authUserProviders', QUERIES.authUserProviders, 'id');
  progress('security keys');
  const securityKeys = await list('authUserSecurityKeys', QUERIES.authUserSecurityKeys, 'id');
  progress('roles');
  const userRoles = await list('authUserRoles', QUERIES.authUserRoles, 'userId');
  progress('refresh tokens');
  let refreshTokens: Obj[];
  try {
    refreshTokens = await list('authRefreshTokens', QUERIES.authRefreshTokens, 'createdAt');
  } catch (err) {
    // Projects older than personal access tokens have no `type` column.
    if (!(err instanceof GraphqlError) || !/type/.test(err.message)) throw err;
    refreshTokens = await list('authRefreshTokens', 'id userId createdAt expiresAt refreshTokenHash', 'createdAt');
  }
  return { users, providers, securityKeys, userRoles, refreshTokens };
}

export class GraphqlError extends Error {}

/** Table names a dump may use for each auth table (`auth.users.csv`, `users.json`, `auth_users.ndjson` …). */
const DUMP_TABLES: Record<keyof NhostRows, string[]> = {
  users: ['auth.users', 'auth_users', 'users'],
  providers: ['auth.user_providers', 'auth_user_providers', 'user_providers'],
  securityKeys: ['auth.user_security_keys', 'auth_user_security_keys', 'user_security_keys', 'auth.user_authenticators', 'user_authenticators'],
  userRoles: ['auth.user_roles', 'auth_user_roles', 'user_roles'],
  refreshTokens: ['auth.refresh_tokens', 'auth_refresh_tokens', 'refresh_tokens'],
};

/** A folder of `auth.*` table dumps (JSON, NDJSON or CSV with a header; snake_case columns). */
export function readNhostDump(dir: string): NhostRows {
  const byName = new Map<string, Obj[]>();
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    const ext = extname(file).toLowerCase();
    if (!statSync(path).isFile() || !['.json', '.ndjson', '.jsonl', '.csv'].includes(ext)) continue;
    byName.set(basename(file, extname(file)).toLowerCase(), parseTable(readFileSync(path, 'utf8'), ext).map(camelRow));
  }
  const pick = (k: keyof NhostRows) => {
    for (const n of DUMP_TABLES[k]) {
      const rows = byName.get(n);
      if (rows) return rows;
    }
    return [];
  };
  const rows: NhostRows = { users: pick('users'), providers: pick('providers'), securityKeys: pick('securityKeys'), userRoles: pick('userRoles'), refreshTokens: pick('refreshTokens') };
  if (!rows.users.length) throw new Error(`No auth.users table in ${dir} (expected users.json, auth.users.csv, …).`);
  return rows;
}

/** `phone_number_verified` → `phoneNumberVerified`; empty CSV cells drop out. */
function camelRow(r: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === '' || v === null) continue;
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}
