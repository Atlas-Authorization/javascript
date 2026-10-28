import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { PASSWORD_HASH_ALGORITHMS, type PasswordHash } from '@atlasauth/migrate';

/**
 * Recognise a password hash by its shape, on the owner's machine, so an
 * exporter writes `{ algorithm, hash }` Atlas can verify — or leaves the
 * password out and says why (lazy migration covers those users). Mirrors the
 * self-describing formats of Atlas's verifier registry; the server checks again
 * on import.
 */

export type DetectedHash = { ok: true; password: PasswordHash; weak: boolean } | { ok: false; reason: string };

const SHAPES: Array<{ re: RegExp; algorithm: string; weak?: boolean }> = [
  { re: /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, algorithm: 'bcrypt' },
  { re: /^\$argon2(id|i|d)\$/, algorithm: 'argon2' },
  { re: /^\$6\$(rounds=\d{1,9}\$)?[^$]{0,16}\$[./0-9A-Za-z]{86}$/, algorithm: 'sha_crypt' },
  { re: /^\$5\$(rounds=\d{1,9}\$)?[^$]{0,16}\$[./0-9A-Za-z]{43}$/, algorithm: 'sha_crypt' },
  { re: /^\$(1|apr1)\$[^$]{0,8}\$[./0-9A-Za-z]{22}$/, algorithm: 'md5_crypt', weak: true },
  { re: /^pbkdf2_(sha1|sha256|sha512)\$\d+\$[^$]+\$.+$/, algorithm: 'pbkdf2_django' },
  { re: /^bcrypt_sha256\$\$2[aby]\$/, algorithm: 'bcrypt_sha256_django' },
  { re: /^\$pbkdf2-(sha1|sha256|sha512)\$\d+\$[^$]*\$.+$/, algorithm: 'pbkdf2_phc' },
  { re: /^\$scrypt\$ln=\d+,r=\d+,p=\d+\$/, algorithm: 'scrypt_phc' },
  { re: /^pbkdf2:(sha1|sha256|sha512)(:\d+)?\$[^$]+\$[0-9a-f]+$/, algorithm: 'pbkdf2_werkzeug' },
  { re: /^scrypt:\d+:\d+:\d+\$[^$]+\$[0-9a-f]+$/, algorithm: 'scrypt_werkzeug' },
  { re: /^\$[PH]\$[./0-9A-Za-z]{31}$/, algorithm: 'phpass', weak: true },
  { re: /^\{(SSHA|SHA|SSHA256|SSHA512|SHA256|SHA512)\}[A-Za-z0-9+/=]+$/i, algorithm: 'ldap_ssha', weak: true },
  { re: /^\{(MD5|SMD5|SHA384|SSHA384)\}[A-Za-z0-9+/=]+$/i, algorithm: 'ldap_digest', weak: true },
  { re: /^\{PBKDF2(-(SHA1|SHA256|SHA512))?\}\d+\$/i, algorithm: 'ldap_pbkdf2' },
  { re: /^\{PBKDF2_SHA256\}[A-Za-z0-9+/=]+$/i, algorithm: 'ldap_pbkdf2' },
];

/** `{CRYPT}` / `{BCRYPT}` / `{ARGON2}` around one of the crypt-style shapes above. */
const WRAPPED = /^\{(CRYPT|BCRYPT|ARGON2)\}(\$.+)$/i;

/** Directory schemes that are not hashes Atlas can check (pass-through or Kerberos). */
const DELEGATED = /^\{(SASL|K5KEY|KERBEROS|UNIX|NS-MTA-MD5|RADIUS|TOTP)\}/i;

/**
 * Identify a self-describing hash. `{CLEARTEXT}` (and a plaintext value when
 * `plaintext` is allowed) is hashed here with PBKDF2 before it is written, so
 * no password is ever stored in the clear (Atlas re-hashes it to Argon2id on
 * the first sign-in).
 */
export function detectPasswordHash(raw: string | undefined, options: { plaintext?: boolean } = {}): DetectedHash {
  const value = raw?.trim();
  if (!value) return { ok: false, reason: 'no password' };
  for (const s of SHAPES) if (s.re.test(value)) return { ok: true, password: { algorithm: s.algorithm, hash: value }, weak: s.weak === true };
  const wrapped = WRAPPED.exec(value);
  if (wrapped) {
    const inner = wrapped[2]!;
    const known = SHAPES.find((s) => s.re.test(inner) && ['bcrypt', 'argon2', 'sha_crypt', 'sha_crypt', 'md5_crypt'].includes(s.algorithm));
    if (known) return { ok: true, password: { algorithm: 'ldap_crypt', hash: value }, weak: known.weak === true };
    return { ok: false, reason: `{${wrapped[1]!.toUpperCase()}} hash in a format Atlas cannot verify` };
  }
  if (/^\{CRYPT\}/i.test(value)) return { ok: false, reason: 'traditional DES {CRYPT} hash (not verifiable)' };
  if (DELEGATED.test(value)) return { ok: false, reason: `${/^\{[^}]+\}/.exec(value)![0]} is checked by another service (pass-through authentication)` };
  const clear = /^\{CLEARTEXT\}(.*)$/i.exec(value);
  if (clear) return hashPlaintext(clear[1]!);
  if (/^\{[A-Z0-9_-]+\}/i.test(value)) return { ok: false, reason: `unsupported scheme ${/^\{[^}]+\}/.exec(value)![0]}` };
  if (options.plaintext) return hashPlaintext(value);
  return { ok: false, reason: 'unrecognised hash format (name its algorithm)' };
}

/** PBKDF2-SHA256 rounds for a plaintext password hashed on export (re-hashed to Argon2id on first sign-in). */
export const PLAINTEXT_PBKDF2_ITERATIONS = 10_000;

function hashPlaintext(password: string): DetectedHash {
  if (!password) return { ok: false, reason: 'empty password' };
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, PLAINTEXT_PBKDF2_ITERATIONS, 32, 'sha256');
  return {
    ok: true,
    password: { algorithm: 'pbkdf2', hash: hash.toString('base64'), salt: salt.toString('base64'), params: { digest: 'sha256', iterations: PLAINTEXT_PBKDF2_ITERATIONS, encoding: 'base64', salt_encoding: 'base64' } },
    weak: false,
  };
}

/** Whether Atlas's registry has a verifier id (or `auto`). */
export function isKnownAlgorithm(id: string): boolean {
  return (PASSWORD_HASH_ALGORITHMS as readonly string[]).includes(id);
}
