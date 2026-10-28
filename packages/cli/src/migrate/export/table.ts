import type { EmailAddress, PasswordHash, PhoneNumber, UserRecord } from '@atlasauth/migrate';
import { detectPasswordHash, isKnownAlgorithm } from './password-detect';
import { RecordSet, compact, e164, isObj, str, strs, type Obj } from './record-set';
import { keyOf } from './translate-kit';

/**
 * `atlas migrate user-table export` — your own user table as a CSV, TSV, JSON
 * array or NDJSON file (a `SELECT * FROM users` dump), for the sources with no
 * dedicated exporter. Columns are recognised by their usual names and can be
 * pointed elsewhere with `--set map=email=Mail,id=uid`.
 *
 * Passwords: a self-describing hash (`$2b$…`, `$argon2id$…`, `{SSHA}…`,
 * `$6$…`, Django / Werkzeug / passlib formats) needs no help. Anything else is
 * named with the picker, `--set hash-algorithm=<id>` — md5, sha1, sha256,
 * sha512 (with a salt column: md5_salted …), pbkdf2, scrypt, hmac_sha256,
 * phpass, … any id of Atlas's verifier registry — plus `--set salt-position=
 * prefix|suffix`, `--set hash-encoding=hex|base64` and `--set hash-params=
 * iterations=10000,digest=sha256`. `plaintext` hashes the column on this
 * machine (PBKDF2) before it is written, so no clear password leaves it.
 */

export interface TableExportOptions {
  /** Column overrides: canonical field → column name. */
  map?: Record<string, string>;
  hashAlgorithm?: string;
  saltPosition?: 'prefix' | 'suffix';
  hashEncoding?: string;
  hashParams?: Record<string, string | number | boolean>;
  /** Mark every address verified (default: only a truthy verified column). */
  trustEmails?: boolean;
  origin?: string;
}

// ── parsing ─────────────────────────────────────────────────────────────────

/** RFC 4180 CSV with a sniffed delimiter (`,` `;` tab `|`), quoted fields, doubled quotes, embedded newlines. */
export function parseDelimited(text: string): Obj[] {
  const src = text.replace(/^\ufeff/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const header = (rows.shift() ?? []).map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** Rows from CSV/TSV, a JSON array (of objects, or `{ users: [...] }`) or NDJSON. */
export function parseTable(text: string): Obj[] {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) return v.filter(isObj);
      if (isObj(v)) {
        const list = Object.values(v).find(Array.isArray);
        if (list) return (list as unknown[]).filter(isObj);
        return [v];
      }
    } catch {
      // NDJSON: one object per line
      return t.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
        try {
          const o = JSON.parse(l) as unknown;
          if (!isObj(o)) throw new Error('not an object');
          return o;
        } catch {
          throw new Error(`Line ${i + 1} is not a JSON object.`);
        }
      });
    }
  }
  return parseDelimited(t);
}

// ── column recognition ──────────────────────────────────────────────────────

const NAMES: Record<string, string[]> = {
  id: ['id', 'user_id', 'userid', 'uid', 'uuid', 'sub', 'external_id'],
  email: ['email', 'email_address', 'emailaddress', 'mail', 'e_mail'],
  email_verified: ['email_verified', 'emailverified', 'verified', 'is_verified', 'email_confirmed', 'email_confirmed_at', 'confirmed_at', 'email_verified_at'],
  username: ['username', 'user_name', 'login', 'handle', 'screen_name'],
  first_name: ['first_name', 'firstname', 'given_name', 'givenname', 'fname'],
  last_name: ['last_name', 'lastname', 'family_name', 'surname', 'lname'],
  name: ['name', 'full_name', 'fullname', 'display_name', 'displayname'],
  phone: ['phone', 'phone_number', 'phonenumber', 'mobile', 'mobile_phone', 'tel'],
  password: ['password_hash', 'passwordhash', 'encrypted_password', 'hashed_password', 'password_digest', 'pwd_hash', 'password', 'passwd', 'hash', 'pass'],
  salt: ['password_salt', 'salt', 'pwd_salt', 'passwordsalt'],
  created_at: ['created_at', 'createdat', 'created', 'date_joined', 'registered_at', 'signup_date'],
  last_sign_in_at: ['last_sign_in_at', 'last_login', 'last_login_at', 'last_seen', 'lastlogin'],
  roles: ['roles', 'role', 'groups'],
  disabled: ['disabled', 'banned', 'is_banned', 'blocked', 'is_blocked', 'suspended', 'locked'],
  active: ['active', 'is_active', 'enabled'],
  image_url: ['image_url', 'avatar', 'avatar_url', 'picture', 'photo'],
};

const truthy = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v ?? '').trim().toLowerCase();
  return ['1', 'true', 't', 'yes', 'y'].includes(s) || (s !== '' && !['0', 'false', 'f', 'no', 'n', 'null', 'nil', 'none'].includes(s) && /^\d{4}-|^\d{9,}$/.test(s));
};

function columnFinder(row: Obj, map: Record<string, string> = {}) {
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase().replace(/[\s-]+/g, '_'), k]));
  return (field: string): string | undefined => {
    const wanted = map[field];
    if (wanted) return Object.keys(row).find((k) => k === wanted) ?? lower.get(wanted.toLowerCase());
    for (const n of NAMES[field] ?? []) if (lower.has(n)) return lower.get(n);
    return undefined;
  };
}

const isoTime = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const n = /^\d{9,13}$/.test(s) ? Number(s) * (s.length >= 12 ? 1 : 1000) : Date.parse(s);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : undefined;
};

function passwordFor(hash: string, salt: string | undefined, o: TableExportOptions): { password?: PasswordHash; weak?: boolean; reason?: string } {
  const algorithm = o.hashAlgorithm?.toLowerCase();
  if (algorithm === 'plaintext') {
    const d = detectPasswordHash(hash, { plaintext: true });
    return d.ok ? { password: d.password } : { reason: d.reason };
  }
  if (!algorithm || algorithm === 'auto') {
    const d = detectPasswordHash(hash);
    if (d.ok) return { password: d.password, weak: d.weak };
    return { reason: `${d.reason}; name its algorithm with --set hash-algorithm=<id>` };
  }
  if (!isKnownAlgorithm(algorithm)) return { reason: `unknown hash algorithm "${algorithm}"` };
  const params: Record<string, string | number | boolean> = { ...(o.hashParams ?? {}) };
  if (o.saltPosition) params.salt_position = o.saltPosition;
  if (o.hashEncoding) params.encoding = o.hashEncoding;
  return { password: compact({ algorithm, hash, salt, params: Object.keys(params).length ? params : undefined } as PasswordHash) };
}

/** Parse `a=1,b=two,c=true` into typed params. */
export function parseKeyValues(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function typedParams(raw: string | undefined): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(parseKeyValues(raw)).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v]));
}

// ── mapping ─────────────────────────────────────────────────────────────────

export function mapTable(rows: Obj[], options: TableExportOptions = {}): RecordSet {
  const set = new RecordSet();
  set.manifest = { origin: options.origin ?? 'user table' };
  const ids = new Set<string>();
  let n = 0;
  const unusable = new Map<string, number>();
  let weak = 0;
  for (const row of rows) {
    n++;
    const col = columnFinder(row, options.map);
    const get = (f: string): unknown => {
      const c = col(f);
      return c === undefined ? undefined : row[c];
    };
    const emailRaw = str(get('email'))?.toLowerCase();
    const email = emailRaw?.includes('@') ? emailRaw : undefined;
    const phone = e164(get('phone'));
    const username = str(get('username'));
    if (!email && !phone && !username) {
      set.omit('user', 'no email, phone or username', 1);
      continue;
    }
    const id = str(get('id')) ?? email ?? username ?? String(n);
    if (ids.has(id)) {
      set.omit('user', 'duplicate id', 1);
      continue;
    }
    ids.add(id);
    const verifiedCol = col('email_verified');
    const emails: EmailAddress[] = email ? [{ email, verified: options.trustEmails === true || (verifiedCol !== undefined && truthy(row[verifiedCol])), primary: true }] : [];
    const phones: PhoneNumber[] = phone ? [{ phone, verified: false, primary: true }] : [];
    const record: UserRecord = compact({
      id,
      emails,
      phones,
      username,
      first_name: str(get('first_name')),
      last_name: str(get('last_name')),
      name: str(get('name')),
      image_url: str(get('image_url')),
      created_at: isoTime(get('created_at')),
      last_sign_in_at: isoTime(get('last_sign_in_at')),
    } as UserRecord);

    const roleValue = get('roles');
    const roles = (Array.isArray(roleValue) ? strs(roleValue) : (str(roleValue) ?? '').split(/[;,|]/)).map((r) => r.trim()).filter(Boolean).map(keyOf);
    for (const r of roles) set.add('role', { key: r, name: r, scope: 'app' }, r);
    if (roles.length) record.roles = [...new Set(roles)];

    if (truthy(get('disabled')) && col('disabled') !== undefined) {
      record.banned = true;
      record.ban_reason = 'Disabled in the source table';
    } else if (col('active') !== undefined && get('active') !== '' && get('active') !== undefined && !truthy(get('active'))) {
      record.banned = true;
      record.ban_reason = 'Inactive in the source table';
    }

    const hash = str(get('password'));
    if (hash) {
      const r = passwordFor(hash, str(get('salt')), options);
      if (r.password) {
        record.password = r.password;
        if (r.weak) weak++;
      } else unusable.set(r.reason!, (unusable.get(r.reason!) ?? 0) + 1);
    }
    set.add('user', record, id);
  }
  for (const [reason, count] of unusable) set.warn(`${count} password(s) left out: ${reason}.`);
  if (weak) set.warn(`${weak} password(s) use a weak legacy hash; Atlas re-hashes each to Argon2id on that user's first sign-in.`);
  return set;
}
