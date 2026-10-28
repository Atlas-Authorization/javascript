import { createDecipheriv } from 'node:crypto';
import {
  FrameworkExport,
  bool,
  col,
  selfDescribingHash,
  sha256Hex,
  splitName,
  text,
  time,
  timeMs,
  type Row,
  type Tables,
} from './tables';

/**
 * Lucia → canonical records. Lucia never owned a schema the way an adapter
 * library does, so three generations are recognised:
 *
 *   - v1 / v2: `auth_user`, `user_key` / `auth_key` (key id `<provider>:<provider
 *     user id>`, `hashed_password` on email/username keys, Lucia's own
 *     `s2:` scrypt) and `user_session` / `auth_session` (`active_expires`,
 *     `idle_expires` in epoch ms);
 *   - v3: your `user` table, `session(id, user_id, expires_at)`, OAuth links in
 *     a table you named (`oauth_account(provider_id, provider_user_id, user_id)`
 *     by the docs) or `<provider>_id` columns on the user (`github_id`), and a
 *     password column you filled with oslo's Argon2id / Scrypt / Bcrypt;
 *   - the current Lucia guide (sessions you implement): `session.id` is
 *     hex(sha256(token)); TOTP keys in `totp_credential.key` and the recovery
 *     code in `user.recovery_code`, both AES-128-GCM encrypted under your
 *     ENCRYPTION_KEY; passkeys in `passkey_credential` with a SEC1 public key.
 */
export interface LuciaExportOptions {
  /** How session rows store the cookie token: `none` (v2/v3, the id IS the token) or `sha256-hex` (the guide). Auto-detected. */
  sessionIdHashing?: 'none' | 'sha256-hex';
  /** The guide's ENCRYPTION_KEY (base64), to read encrypted TOTP keys and recovery codes. */
  encryptionKey?: string;
  /** WebAuthn RP id, for passkey_credential rows. */
  rpId?: string;
  /** Include live sessions. Default true. */
  sessions?: boolean;
  /** Table name overrides. */
  userTable?: string;
  sessionTable?: string;
  oauthTable?: string;
  now?: Date;
}

const PASSWORD_COLUMNS = ['password_hash', 'hashed_password', 'passwordHash', 'hashedPassword', 'password'];
const PROVIDER_COLUMNS: Record<string, string> = {
  github_id: 'github',
  google_id: 'google',
  discord_id: 'discord',
  apple_id: 'apple',
  gitlab_id: 'gitlab',
  twitter_id: 'twitter',
  facebook_id: 'facebook',
  microsoft_id: 'microsoft',
  twitch_id: 'twitch',
  spotify_id: 'spotify',
};

export function exportLucia(tables: Tables, options: LuciaExportOptions = {}): FrameworkExport {
  const out = new FrameworkExport();
  const now = (options.now ?? new Date()).getTime();
  const userTable = tables.find(...(options.userTable ? [options.userTable] : ['auth_user', 'user', 'users', 'User']));
  if (!userTable) {
    out.warn('No user table found (looked for auth_user, user, users; pass --user-table).');
    return out;
  }
  const keyTable = tables.find('user_key', 'auth_key', 'key');
  const generation = keyTable ? 'v2' : 'v3';
  out.manifest.sourceVersion = generation === 'v2' ? 'lucia v1/v2' : 'lucia v3 / guide';

  // v2 keys: email/username keys carry the password; others are OAuth links.
  const keysByUser = new Map<string, Row[]>();
  for (const k of keyTable?.rows ?? []) {
    const uid = text(col(k, 'user_id', 'userId'));
    if (!uid) continue;
    const list = keysByUser.get(uid) ?? [];
    list.push(k);
    keysByUser.set(uid, list);
  }

  const key = options.encryptionKey ? Buffer.from(options.encryptionKey, 'base64') : undefined;
  const userIds = new Set<string>();
  const providers = new Set<string>();
  let unknownHashes = 0;
  for (const row of userTable.rows) {
    const id = text(col(row, 'id', '_id'));
    if (!id) {
      out.omit('user', 'row without an id');
      continue;
    }
    let email = text(col(row, 'email', 'email_address'))?.toLowerCase();
    let username = text(col(row, 'username'));
    let digest = text(col(row, ...PASSWORD_COLUMNS));
    const identities: Array<{ provider: string; subject: string }> = [];
    for (const k of keysByUser.get(id) ?? []) {
      const keyId = text(col(k, 'id'));
      if (!keyId || !keyId.includes(':')) continue;
      const provider = keyId.slice(0, keyId.indexOf(':'));
      const subject = keyId.slice(keyId.indexOf(':') + 1);
      if (provider === 'email') {
        email ??= subject.toLowerCase();
        digest ??= text(col(k, 'hashed_password'));
      } else if (provider === 'username') {
        username ??= subject;
        digest ??= text(col(k, 'hashed_password'));
      } else identities.push({ provider, subject });
    }
    for (const [column, provider] of Object.entries(PROVIDER_COLUMNS)) {
      const subject = text(row[column]);
      if (subject) identities.push({ provider, subject });
    }
    if (!email && !username) {
      out.omit('user', 'no email or username');
      continue;
    }
    let password: { algorithm: string; hash: string } | undefined;
    if (digest) {
      password = selfDescribingHash(digest) ?? undefined;
      if (!password) unknownHashes++;
    }
    const name = text(col(row, 'name', 'display_name'));
    userIds.add(id);
    out.add('user', {
      id,
      emails: email ? [{ email, verified: bool(col(row, 'email_verified', 'emailVerified')), primary: true }] : undefined,
      username,
      name,
      ...splitName(name),
      password,
      created_at: time(col(row, 'created_at', 'createdAt')),
    });
    for (const i of identities) {
      providers.add(i.provider);
      out.add('identity', { user_id: id, provider: i.provider, provider_user_id: i.subject, kind: 'oauth' });
    }
    // The guide's recovery code: one encrypted code on the user row.
    const recovery = col(row, 'recovery_code');
    if (recovery !== undefined && key) {
      const code = decryptGuideValue(recovery, key);
      if (code) out.add('mfa_factor', { user_id: id, type: 'backup_codes', backup_codes: [code.toString('utf8')] });
      else out.omit('mfa_factor', 'recovery code that does not decrypt under the ENCRYPTION_KEY given');
    }
  }
  if (unknownHashes) out.warn(`${unknownHashes} password value(s) are not a format Atlas verifies: those users reset their password or migrate lazily.`);

  const oauth = tables.find(...(options.oauthTable ? [options.oauthTable] : ['oauth_account', 'oauth_accounts', 'account']));
  for (const row of oauth?.rows ?? []) {
    const userId = text(col(row, 'user_id', 'userId'));
    const provider = text(col(row, 'provider_id', 'provider'));
    const subject = text(col(row, 'provider_user_id', 'providerUserId'));
    if (!userId || !provider || !subject || !userIds.has(userId)) {
      out.omit('identity', 'oauth account row without a known user, provider or provider user id');
      continue;
    }
    providers.add(provider);
    out.add('identity', { user_id: userId, provider, provider_user_id: subject, kind: 'oauth' });
  }
  out.manifest.providers = [...providers].sort();

  // The guide's TOTP credentials.
  const totp = tables.rows('totp_credential', 'totp_credentials');
  if (totp.length && !key) {
    out.omit('mfa_factor', 'TOTP keys are encrypted: pass --encryption-key (your ENCRYPTION_KEY) to carry them', totp.length);
  }
  for (const row of key ? totp : []) {
    const userId = text(col(row, 'user_id', 'userId'));
    const secret = decryptGuideValue(col(row, 'key'), key!);
    if (!userId || !userIds.has(userId) || !secret) {
      out.omit('mfa_factor', 'TOTP row without a known user, or a key that does not decrypt');
      continue;
    }
    out.add('mfa_factor', { user_id: userId, type: 'totp', secret_base32: base32(secret), digits: 6, period: 30, algorithm: 'SHA1', verified: true });
  }

  // The guide's passkeys: SEC1 P-256 public keys (COSE alg -7) are re-encoded as COSE.
  const passkeys = tables.rows('passkey_credential', 'passkey_credentials');
  if (passkeys.length && !options.rpId) {
    out.omit('passkey', 'no RP id given (--rp-id): a passkey only works on the domain it was registered for', passkeys.length);
  }
  for (const row of options.rpId ? passkeys : []) {
    const userId = text(col(row, 'user_id', 'userId'));
    const credentialId = bytesOf(col(row, 'id'));
    const alg = Number(col(row, 'algorithm', 'algorithm_id'));
    const cose = alg === -7 ? coseFromSec1(bytesOf(col(row, 'public_key'))) : null;
    if (!userId || !userIds.has(userId) || !credentialId || !cose) {
      out.omit('passkey', alg === -7 ? 'passkey row without a known user or a readable key' : 'passkey with an algorithm other than ES256 (re-register it)');
      continue;
    }
    out.add('passkey', {
      user_id: userId,
      credential_id: credentialId.toString('base64url'),
      public_key: cose.toString('base64url'),
      rp_id: options.rpId!,
      name: text(col(row, 'name')),
    });
  }
  if (options.rpId) out.manifest.rpId = options.rpId;

  if (options.sessions !== false) {
    const sessions = tables.find(...(options.sessionTable ? [options.sessionTable] : ['user_session', 'auth_session', 'session', 'sessions']));
    const hashing = options.sessionIdHashing ?? detectHashing(sessions?.rows ?? []);
    for (const row of sessions?.rows ?? []) {
      const sid = text(col(row, 'id'));
      const userId = text(col(row, 'user_id', 'userId'));
      // v2 sessions stay usable until idle_expires (Lucia renews them on use).
      const expires = timeMs(col(row, 'idle_expires', 'expires_at', 'expiresAt', 'active_expires'));
      if (!sid || !userId || !userIds.has(userId) || expires === undefined) {
        out.omit('session', 'session row without an id, a known user or an expiry');
        continue;
      }
      if (expires <= now) {
        out.omit('session', 'expired');
        continue;
      }
      out.add('session', {
        id: sid.slice(0, 64),
        user_id: userId,
        // The bridge hashes the cookie token: for guide sessions the stored id already is that hash.
        token_hash: hashing === 'sha256-hex' ? sid.toLowerCase() : sha256Hex(sid),
        expires_at: new Date(expires).toISOString(),
      });
    }
    out.manifest.settings = { session_cookie: 'auth_session', session_id_hashing: hashing };
  }
  return out;
}

/** Guide sessions store 64-char lowercase hex ids; Lucia v2/v3 ids are 15–40 char alphanumerics. */
function detectHashing(rows: Row[]): 'none' | 'sha256-hex' {
  if (!rows.length) return 'none';
  return rows.every((r) => /^[0-9a-f]{64}$/.test(String(col(r, 'id') ?? ''))) ? 'sha256-hex' : 'none';
}

/** A bytes column from a dump: `\x…` hex (Postgres), plain hex, or base64. */
function bytesOf(v: unknown): Buffer | null {
  if (Buffer.isBuffer(v)) return v;
  const s = text(v);
  if (!s) return null;
  if (/^\\x[0-9a-f]*$/i.test(s)) return Buffer.from(s.slice(2), 'hex');
  if (/^([0-9a-f]{2})+$/i.test(s) && s.length >= 32) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return null;
}

/** The guide's `encrypt()`: iv(16) ‖ ciphertext ‖ tag(16), AES-128-GCM (AES-256 for a 32-byte key). */
export function decryptGuideValue(v: unknown, key: Buffer): Buffer | null {
  const data = bytesOf(v);
  if (!data || data.length < 33 || (key.length !== 16 && key.length !== 32)) return null;
  try {
    const decipher = createDecipheriv(key.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm', key, data.subarray(0, 16));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(16, data.length - 16)), decipher.final()]);
  } catch {
    return null;
  }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * An uncompressed SEC1 P-256 key (0x04 ‖ x ‖ y) as a COSE_Key:
 * {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}, CBOR-encoded.
 */
export function coseFromSec1(key: Buffer | null): Buffer | null {
  if (!key || key.length !== 65 || key[0] !== 0x04) return null;
  const x = key.subarray(1, 33);
  const y = key.subarray(33, 65);
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
}
