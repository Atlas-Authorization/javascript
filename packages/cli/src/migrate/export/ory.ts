import type { IdentityRecord, MfaFactorRecord, PasskeyRecord, PasswordHash, UserRecord } from '@atlasauth/migrate';
import { base64url, bool, col, json, sha256Hex, text, time, timeMs, type Tables } from './frameworks/tables';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { VendorHttp, nextLink } from './vendor-http';

/**
 * `atlas migrate export ory` — Ory Kratos (self-hosted, or Ory Network) onto
 * the canonical bundle models. Two ways in, both on the owner's machine:
 *
 *   - a DATABASE DUMP of Kratos (`<table>.json|ndjson|csv` per table, see
 *     frameworks/tables.ts): `identities`, `identity_credentials` (+ `_types`,
 *     `_identifiers`), `identity_verifiable_addresses` and `sessions`. The
 *     complete path: password hashes (every format Kratos verifies), TOTP
 *     seeds, unused recovery codes, WebAuthn / passkey credentials, social
 *     links and live session tokens. Ory Network projects cannot be dumped.
 *   - the ADMIN API (`GET /admin/identities`, paged with the `Link` header's
 *     page_token) with the admin URL of a self-hosted Kratos or an Ory Network
 *     project's API key. It never returns password hashes, TOTP seeds, recovery
 *     codes, WebAuthn credentials or session tokens: those users sign in once
 *     against Kratos through the `ory` lazy preset (passwords) and re-enrol
 *     their second factor; the session bridge asks Kratos to vouch for the
 *     session (remote mode).
 *
 * The Kratos identity id is the user id: it is the `identity.id` of every
 * session (`/sessions/whoami`) and the `sub` Hydra issues by default.
 *
 * Schemas: github.com/ory/kratos `persistence/sql/migrations` (tables),
 * `identity/credentials_*.go` (credential configs), `hash/hash_comparator.go`
 * (password formats); Admin API: `identity.Identity` JSON.
 */

export interface OryTablesOptions {
  /** The WebAuthn relying-party id (`selfservice.methods.passkey.config.rp.id` / `webauthn…rp.id`); passkeys need it. */
  rpId?: string;
  /** A multi-project database (Ory Network style): the `nid` to export. */
  networkId?: string;
  /** Export sessions that are active and unexpired at this time (default now). */
  now?: number;
}

export interface OryApiOptions {
  /** Kratos admin URL (`http://kratos:4434`) or `https://<slug>.projects.oryapis.com`. */
  adminUrl: string;
  /** Ory Network project API key (`ory_pat_…`), sent as `Authorization: Bearer`. */
  apiKey?: string;
  rpId?: string;
  pageSize?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/** Kratos' TOTP parameters (pquerna/otp defaults; not configurable). */
const TOTP = { digits: 6, period: 30, algorithm: 'SHA1' as const };

const NO_PASSKEY_RP =
  'Passkeys were left out: pass the relying-party id they were registered for (--set ory-rp-id=<…rp.id from kratos.yml>, e.g. example.com).';
const NO_IDENTIFIER = 'Identity with no email address, phone number or username';

// ── password hashes ─────────────────────────────────────────────────────────

const B64 = '[A-Za-z0-9+/]*={0,2}';
const PF_DIGEST = new RegExp(`^\\$(md5|sha1|sha256|sha512)\\$pf=${B64}\\$${B64}\\$${B64}$`);
const HMAC = new RegExp(`^\\$hmac-(md5|sha1|sha224|sha256|sha384|sha512)\\$${B64}\\$${B64}$`);

/**
 * A Kratos `hashed_password` as a bundle password; null when Atlas cannot
 * verify the format (`$hmac-md4$`, unknown schemes), whose users then move by
 * lazy migration. Formats: hash/hash_comparator.go.
 */
export function oryPasswordHash(raw: unknown): PasswordHash | null {
  const d = text(raw);
  if (!d) return null;
  if (/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(d)) return { algorithm: 'bcrypt', hash: d };
  if (/^\$argon2(id|i|d)\$/.test(d)) return { algorithm: 'argon2', hash: d };
  // {SSHA}, {SSHA256}, {SSHA512}, {SHA…}: self-describing LDAP digests.
  if (/^\{(SSHA|SSHA256|SSHA512|SHA|SHA256|SHA512)\}[A-Za-z0-9+/=]+$/i.test(d)) return { algorithm: 'auto', hash: d };
  // The two Kratos-only formats the registry recognises by themselves.
  if (PF_DIGEST.test(d) || HMAC.test(d)) return { algorithm: 'auto', hash: d };

  // $pbkdf2-sha256$i=100000,l=32$<salt>$<hash>: unpadded standard base64 (not passlib ab64).
  let m = /^\$pbkdf2-(sha1|sha256|sha384|sha512)\$i=(\d+),l=(\d+)\$([^$]+)\$([^$]+)$/.exec(d);
  if (m) {
    return { algorithm: 'pbkdf2', hash: m[5]!, salt: m[4]!, params: { digest: m[1]!, iterations: Number(m[2]), key_length: Number(m[3]), encoding: 'base64', salt_encoding: 'base64' } };
  }
  // $scrypt$ln=<N>,r=<r>,p=<p>$<salt>$<hash>: Kratos writes N itself in `ln`.
  m = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(d);
  if (m) return { algorithm: 'scrypt', hash: m[5]!, salt: m[4]!, params: { n: Number(m[1]), r: Number(m[2]), p: Number(m[3]), encoding: 'base64', salt_encoding: 'base64' } };
  // $firescrypt$ln=<mem_cost>,r=<rounds>,p=1$<salt>$<hash>$<salt separator>$<signer key>.
  m = /^\$firescrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)\$([^$]*)\$([^$]+)$/.exec(d);
  if (m) {
    if (m[3] !== '1') return null;
    return { algorithm: 'scrypt_firebase', hash: m[5]!, salt: m[4]!, params: { rounds: Number(m[2]), mem_cost: Number(m[1]), salt_separator: m[6]!, signer_key: m[7]! } };
  }
  // $md5$<base64 digest> (the salted/templated forms are $md5$pf=…, handled above).
  m = /^\$md5\$([A-Za-z0-9+/]+={0,2})$/.exec(d);
  if (m) return { algorithm: 'md5', hash: m[1]!, params: { encoding: 'base64' } };
  // $md5-crypt$, $sha256-crypt$, $sha512-crypt$: the crypt(3) strings under Kratos' prefix.
  m = /^\$(md5|sha256|sha512)-crypt\$(.+)$/.exec(d);
  if (m) return { algorithm: 'auto', hash: `$${{ md5: '1', sha256: '5', sha512: '6' }[m[1] as 'md5' | 'sha256' | 'sha512']}$${m[2]}` };
  if (/^\$(1|5|6)\$/.test(d)) return { algorithm: 'auto', hash: d };
  return null;
}

// ── the identity, however it was read ───────────────────────────────────────

interface OryCredential {
  identifiers: string[];
  config?: Obj;
}

/** An identity as both readers present it (the Admin API's JSON, assembled from the tables). */
interface OryIdentity {
  id: string;
  schemaId?: string;
  state?: string;
  traits: Obj;
  addresses: Array<{ value: string; via: string; verified: boolean }>;
  publicMetadata?: Obj;
  adminMetadata?: Obj;
  createdAt?: unknown;
  organizationId?: string;
  credentials: Map<string, OryCredential>;
}

interface OrySession {
  id: string;
  identityId: string;
  token?: string;
  active: boolean;
  expiresAt?: number;
  authenticatedAt?: unknown;
  aal?: string;
}

interface MapOptions {
  source: 'database' | 'api';
  rpId?: string;
  sessions?: OrySession[];
  now: number;
  origin: string;
}

const EMAIL_KEYS = ['email', 'email_address', 'emailaddress', 'mail', 'e-mail'];
const USERNAME_KEYS = ['username', 'user_name', 'login', 'handle', 'nickname'];
const PHONE_KEYS = ['phone', 'phone_number', 'phonenumber', 'mobile', 'tel'];
const IMAGE_KEYS = ['picture', 'avatar', 'avatar_url', 'image', 'photo'];
const FIRST_KEYS = ['first_name', 'firstname', 'given_name', 'givenname'];
const LAST_KEYS = ['last_name', 'lastname', 'family_name', 'familyname', 'surname'];

/** A top-level trait by any of its usual names (case-insensitive); returns the real key too. */
function trait(traits: Obj, keys: string[]): { key: string; value: unknown } | undefined {
  for (const k of Object.keys(traits)) if (keys.includes(k.toLowerCase())) return { key: k, value: traits[k] };
  return undefined;
}

/** Group a Go-style `{Time, Valid}` or plain nullable timestamp: the time when it is set. */
function nullTime(v: unknown): string | undefined {
  if (isObj(v)) return v.Valid === true ? str(v.Time) : undefined;
  const s = str(v);
  return s && !s.startsWith('0001-') ? s : undefined;
}

/** 16 bytes (base64) as an AAGUID UUID; undefined for the all-zero AAGUID or anything else. */
function aaguid(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s)) return /^[0-]+$/.test(s) ? undefined : s.toLowerCase();
  const bytes = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length !== 16 || bytes.every((b) => b === 0)) return undefined;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A `totp_url` (`otpauth://totp/Issuer:account?secret=…`) as a factor. */
function totpFactor(url: unknown): Omit<MfaFactorRecord, 'user_id'> | null {
  const raw = str(url);
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const secret = u.searchParams.get('secret')?.replace(/\s|=+$/g, '').toUpperCase();
  if (u.protocol !== 'otpauth:' || !secret || !/^[A-Z2-7]+$/.test(secret)) return null;
  const alg = (u.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
  const digits = Number(u.searchParams.get('digits') ?? TOTP.digits);
  const period = Number(u.searchParams.get('period') ?? TOTP.period);
  return {
    type: 'totp',
    secret_base32: secret,
    digits: Number.isInteger(digits) && digits >= 6 && digits <= 8 ? digits : TOTP.digits,
    period: Number.isInteger(period) && period > 0 ? period : TOTP.period,
    algorithm: alg === 'SHA256' || alg === 'SHA512' ? alg : 'SHA1',
    verified: true,
  };
}

/** WebAuthn / passkey credential configs (`{ credentials: [{ id, public_key, authenticator, … }] }`). */
function passkeys(userId: string, config: Obj, rpId: string, set: RecordSet): { mfaOnly: number } {
  let mfaOnly = 0;
  for (const c of objs(config.credentials)) {
    const credentialId = base64url(c.id);
    const publicKey = base64url(c.public_key);
    if (!credentialId || !publicKey) {
      set.omit('passkey', 'WebAuthn credential without an id or public key');
      continue;
    }
    const auth = isObj(c.authenticator) ? c.authenticator : {};
    const flags = isObj(c.flags) ? c.flags : {};
    const count = Number(auth.sign_count);
    // go-webauthn nests the backup flags; older Kratos kept them beside the credential.
    const backup = flags.backup_state ?? c.backup_state;
    // `is_passwordless: false` is a security key registered as a second factor only.
    if (c.is_passwordless === false) mfaOnly++;
    set.add(
      'passkey',
      compact<PasskeyRecord>({
        id: credentialId,
        user_id: userId,
        credential_id: credentialId,
        public_key: publicKey,
        sign_count: Number.isFinite(count) && count > 0 ? count : undefined,
        rp_id: rpId,
        transports: strs(c.transport ?? c.transports),
        aaguid: aaguid(auth.aaguid),
        backed_up: backup === undefined ? undefined : bool(backup),
        name: str(c.display_name),
        created_at: time(c.added_at),
      }),
      credentialId,
    );
  }
  return { mfaOnly };
}

/** The recovery codes still unused (`used_at` null / invalid); plaintext, as Kratos keeps them. */
function recoveryCodes(config: Obj): string[] {
  return objs(config.recovery_codes)
    .filter((c) => nullTime(c.used_at) === undefined)
    .map((c) => str(c.code))
    .filter((c): c is string => c !== undefined);
}

function mapIdentities(list: OryIdentity[], o: MapOptions): RecordSet {
  const set = new RecordSet();
  const providers = new Set<string>();
  const exported = new Set<string>();
  let withPassword = 0;
  let withTotp = 0;
  let withRecovery = 0;
  let withWebauthn = 0;
  let unsupportedHash = 0;
  let missingHash = 0;
  let migrationHook = 0;
  let credentialsWithoutRp = 0;
  let mfaOnly = 0;
  let inOrganization = 0;
  let codeOnly = 0;

  for (const i of list) {
    // ── identifiers ──
    const emails: Array<{ email: string; verified: boolean; primary: boolean }> = [];
    const seenEmail = new Set<string>();
    const addEmail = (raw: unknown, verified: boolean) => {
      const email = str(raw)?.toLowerCase();
      if (!email || !email.includes('@') || seenEmail.has(email)) return;
      seenEmail.add(email);
      emails.push({ email, verified, primary: emails.length === 0 });
    };
    for (const a of i.addresses) if (a.via === 'email') addEmail(a.value, a.verified);
    const consumed = new Set<string>();
    const tEmail = trait(i.traits, EMAIL_KEYS);
    if (tEmail) {
      consumed.add(tEmail.key);
      addEmail(tEmail.value, false);
    }
    const phones: Array<{ phone: string; verified: boolean; primary: boolean }> = [];
    const addPhone = (raw: unknown, verified: boolean) => {
      const phone = e164(raw);
      if (phone && !phones.some((p) => p.phone === phone)) phones.push({ phone, verified, primary: phones.length === 0 });
    };
    for (const a of i.addresses) if (a.via === 'sms' || a.via === 'phone') addPhone(a.value, a.verified);
    const tPhone = trait(i.traits, PHONE_KEYS);
    if (tPhone) {
      consumed.add(tPhone.key);
      addPhone(tPhone.value, false);
    }
    const tUser = trait(i.traits, USERNAME_KEYS);
    if (tUser) consumed.add(tUser.key);
    const password = i.credentials.get('password');
    // A password identifier that is neither of the above is the sign-in name.
    const username = str(tUser?.value) ?? (emails.length || phones.length ? undefined : password?.identifiers[0]);

    if (!emails.length && !phones.length && !username) {
      set.omit('user', NO_IDENTIFIER);
      continue;
    }

    // ── profile ──
    const tName = trait(i.traits, ['name', 'full_name', 'fullname', 'display_name', 'displayname']);
    let first = str(trait(i.traits, FIRST_KEYS)?.value);
    let last = str(trait(i.traits, LAST_KEYS)?.value);
    const nameValue = tName?.value;
    let full: string | undefined;
    if (isObj(nameValue)) {
      first ??= str(trait(nameValue, ['first', 'first_name', 'given', 'given_name'])?.value);
      last ??= str(trait(nameValue, ['last', 'last_name', 'family', 'family_name', 'surname'])?.value);
      full = str(trait(nameValue, ['full', 'full_name', 'display'])?.value);
    } else {
      full = str(nameValue);
    }
    if (tName) consumed.add(tName.key);
    for (const k of Object.keys(i.traits)) if ([...FIRST_KEYS, ...LAST_KEYS].includes(k.toLowerCase())) consumed.add(k);
    const tImage = trait(i.traits, IMAGE_KEYS);
    if (tImage) consumed.add(tImage.key);
    const image = str(tImage?.value);
    const rest: Obj = {};
    for (const [k, v] of Object.entries(i.traits)) if (!consumed.has(k)) rest[k] = v;

    // ── password ──
    let pw: PasswordHash | undefined;
    if (password) {
      withPassword++;
      const hashed = str(password.config?.hashed_password);
      if (hashed) {
        const mapped = oryPasswordHash(hashed);
        if (mapped) pw = mapped;
        else unsupportedHash++;
      } else if (password.config?.use_password_migration_hook === true) migrationHook++;
      else if (o.source === 'database') missingHash++;
    }

    const meta = bag(i.adminMetadata);
    const private_metadata = i.schemaId && i.schemaId !== 'default' ? { ...(meta ?? {}), ory_schema_id: i.schemaId } : meta;
    set.add(
      'user',
      compact<UserRecord>({
        id: i.id,
        emails,
        phones,
        username,
        first_name: first,
        last_name: last,
        name: full,
        image_url: image,
        password: pw,
        banned: i.state === 'inactive' ? true : undefined,
        ban_reason: i.state === 'inactive' ? 'Deactivated in Ory' : undefined,
        public_metadata: bag(i.publicMetadata),
        private_metadata,
        unsafe_metadata: bag(rest) ? { ory_traits: rest } : undefined,
        created_at: time(i.createdAt),
      }),
      i.id,
    );
    exported.add(i.id);
    if (i.organizationId) inOrganization++;

    // ── social links ──
    const oidc = i.credentials.get('oidc');
    if (oidc) {
      const links = objs(oidc.config?.providers).map((p) => ({ provider: str(p.provider), subject: str(p.subject) }));
      // The Admin API without config: identifiers are `<provider>:<subject>`.
      if (!links.length) {
        for (const id of oidc.identifiers) {
          const at = id.indexOf(':');
          if (at > 0) links.push({ provider: id.slice(0, at), subject: id.slice(at + 1) });
        }
      }
      for (const l of links) {
        if (!l.provider || !l.subject) continue;
        providers.add(l.provider);
        set.add(
          'identity',
          compact<IdentityRecord>({ user_id: i.id, provider: l.provider, provider_user_id: l.subject, email: emails[0]?.email }),
          `${l.provider}\u0000${l.subject}`,
        );
      }
    }

    // ── second factors ──
    const totp = i.credentials.get('totp');
    if (totp) {
      withTotp++;
      const factor = totpFactor(totp.config?.totp_url);
      if (factor) set.add('mfa_factor', { ...factor, user_id: i.id });
    }
    const lookup = i.credentials.get('lookup_secret');
    if (lookup) {
      withRecovery++;
      const codes = recoveryCodes(lookup.config ?? {});
      if (codes.length) set.add('mfa_factor', { user_id: i.id, type: 'backup_codes', backup_codes: codes, verified: true });
    }
    if (i.credentials.has('code') && i.credentials.size === 1) codeOnly++;

    // ── passkeys and security keys (type `webauthn` before Kratos 1.2, `passkey` after) ──
    for (const type of ['webauthn', 'passkey']) {
      const c = i.credentials.get(type);
      if (!c) continue;
      withWebauthn++;
      if (!c.config) continue; // the Admin API: counted, not exportable
      if (!o.rpId) {
        credentialsWithoutRp += objs(c.config.credentials).length;
        continue;
      }
      mfaOnly += passkeys(i.id, c.config, o.rpId, set).mfaOnly;
    }
  }

  // ── sessions (the database only) ──
  let inactive = 0;
  for (const s of o.sessions ?? []) {
    if (!exported.has(s.identityId)) continue;
    if (!s.active || !s.expiresAt || s.expiresAt <= o.now || !s.token) {
      inactive++;
      continue;
    }
    set.add(
      'session',
      compact({
        id: s.id,
        user_id: s.identityId,
        token_hash: sha256Hex(s.token),
        expires_at: s.expiresAt,
        mfa_verified: s.aal === 'aal2' ? true : undefined,
        created_at: time(s.authenticatedAt),
      }),
      s.id,
    );
  }
  if (inactive) set.omit('session', 'Session already expired, signed out or without a token', inactive);

  // ── what moved, what did not ──
  if (o.source === 'api') {
    if (withPassword) {
      set.warn(`${withPassword} identit${withPassword === 1 ? 'y has' : 'ies have'} a password: the Admin API never returns password hashes, so they move by lazy migration (preset ory) on each user's first Atlas sign-in — or export from the database instead.`);
    }
    if (withTotp || withRecovery) set.warn(`${withTotp} TOTP and ${withRecovery} recovery-code credential(s): the Admin API never returns them, so those users enrol an authenticator again in Atlas (a database dump carries the seeds).`);
    if (withWebauthn) {
      set.omit('passkey', 'The Ory Admin API never returns WebAuthn / passkey credentials (export from the database)', withWebauthn);
      set.warn(`${withWebauthn} identit${withWebauthn === 1 ? 'y has' : 'ies have'} a passkey or security key: the Admin API does not return them, so users register one again (a database dump carries them).`);
    }
    set.warn('Session tokens are not exported (the Admin API has none): the bridge asks Ory to vouch for the session instead (preset ory_whoami / ory_whoami_token).');
  } else {
    if (unsupportedHash) set.warn(`${unsupportedHash} password hash(es) are in a format Atlas cannot verify (for example $hmac-md4$): those users move by lazy migration (preset ory) or reset their password.`);
    if (missingHash) set.warn(`${missingHash} identit${missingHash === 1 ? 'y has' : 'ies have'} a password credential without a stored hash: they move by lazy migration (preset ory).`);
  }
  if (migrationHook) set.warn(`${migrationHook} identit${migrationHook === 1 ? 'y has' : 'ies have'} a password still held by your password-migration webhook (use_password_migration_hook): Atlas never saw a hash, so these move by lazy migration (preset ory).`);
  if (credentialsWithoutRp) {
    set.omit('passkey', 'No relying-party id given (--set ory-rp-id)', credentialsWithoutRp);
    set.warn(NO_PASSKEY_RP);
  }
  if (mfaOnly) {
    set.warn(`${mfaOnly} WebAuthn credential(s) were security keys used only as a second factor. They move as passkeys bound to the same relying-party id; Atlas can also accept them as a first factor.`);
  }
  if (inOrganization) set.warn(`${inOrganization} identit${inOrganization === 1 ? 'y belongs' : 'ies belong'} to Ory Network organizations (enterprise SSO): organizations are not exported; their SSO connections are recreated in Atlas by hand.`);
  if (codeOnly) set.warn(`${codeOnly} identit${codeOnly === 1 ? 'y signs' : 'ies sign'} in only with an emailed or texted code: they work in Atlas through its one-time-code strategy with no further step.`);

  set.manifest = compact({ origin: o.origin, rpId: o.rpId, providers: [...providers].sort(), settings: { totp: { ...TOTP } } });
  return set;
}

// ── a database dump ─────────────────────────────────────────────────────────

/** Credential type names Kratos stores in `identity_credential_types.name`. */
function typeOfConfig(config: Obj | undefined): string | undefined {
  if (!config) return undefined;
  if ('hashed_password' in config) return 'password';
  if ('totp_url' in config) return 'totp';
  if ('recovery_codes' in config) return 'lookup_secret';
  if ('providers' in config) return 'oidc';
  if ('credentials' in config) return 'webauthn';
  return undefined;
}

export function exportOryTables(tables: Tables, opts: OryTablesOptions = {}): RecordSet {
  const nidOf = (r: Record<string, unknown>) => text(col(r, 'nid'));
  const identities = tables.rows('identities');
  const nids = new Set(identities.map(nidOf).filter((n): n is string => !!n));
  if (!opts.networkId && nids.size > 1) {
    throw new Error(`The dump holds several Ory projects (nid ${[...nids].join(', ')}): name one with --set ory-nid=<id>.`);
  }
  const mine = <T extends Record<string, unknown>>(rows: T[]): T[] => (opts.networkId ? rows.filter((r) => nidOf(r) === opts.networkId) : rows);

  const typeNames = new Map<string, string>();
  for (const t of tables.rows('identity_credential_types')) {
    const id = text(col(t, 'id'));
    const name = text(col(t, 'name'));
    if (id && name) typeNames.set(id, name);
  }
  const identifiers = new Map<string, string[]>();
  for (const r of mine(tables.rows('identity_credential_identifiers'))) {
    const cid = text(col(r, 'identity_credential_id'));
    const identifier = text(col(r, 'identifier'));
    if (cid && identifier) identifiers.set(cid, [...(identifiers.get(cid) ?? []), identifier.toLowerCase()]);
  }
  const byIdentity = new Map<string, OryIdentity>();
  for (const r of mine(identities)) {
    const id = text(col(r, 'id'));
    if (!id) continue;
    byIdentity.set(id, {
      id,
      schemaId: text(col(r, 'schema_id')),
      state: text(col(r, 'state')),
      traits: json(col(r, 'traits')) ?? {},
      addresses: [],
      publicMetadata: json(col(r, 'metadata_public')),
      adminMetadata: json(col(r, 'metadata_admin')),
      createdAt: col(r, 'created_at'),
      organizationId: text(col(r, 'organization_id')),
      credentials: new Map(),
    });
  }
  for (const r of mine(tables.rows('identity_verifiable_addresses'))) {
    const identity = byIdentity.get(text(col(r, 'identity_id')) ?? '');
    const value = text(col(r, 'value'));
    if (!identity || !value) continue;
    identity.addresses.push({ value, via: (text(col(r, 'via')) ?? 'email').toLowerCase(), verified: bool(col(r, 'verified')) || text(col(r, 'status')) === 'completed' });
  }
  for (const r of mine(tables.rows('identity_credentials'))) {
    const identity = byIdentity.get(text(col(r, 'identity_id')) ?? '');
    if (!identity) continue;
    const config = json(col(r, 'config'));
    const type = typeNames.get(text(col(r, 'identity_credential_type_id')) ?? '') ?? text(col(r, 'type', 'type_name')) ?? typeOfConfig(config);
    if (!type) continue;
    identity.credentials.set(type, { identifiers: identifiers.get(text(col(r, 'id')) ?? '') ?? [], config });
  }
  const sessions: OrySession[] = [];
  for (const r of mine(tables.rows('sessions'))) {
    const id = text(col(r, 'id'));
    const identityId = text(col(r, 'identity_id'));
    if (!id || !identityId) continue;
    sessions.push({
      id,
      identityId,
      token: text(col(r, 'token')),
      active: bool(col(r, 'active')),
      expiresAt: timeMs(col(r, 'expires_at')),
      authenticatedAt: col(r, 'authenticated_at'),
      aal: text(col(r, 'aal', 'authenticator_assurance_level')),
    });
  }
  return mapIdentities([...byIdentity.values()], { source: 'database', rpId: opts.rpId, sessions, now: opts.now ?? Date.now(), origin: 'Ory Kratos database dump' });
}

// ── the Admin API ───────────────────────────────────────────────────────────

/** The Admin API's identity JSON as an {@link OryIdentity}. */
export function oryIdentityFromApi(raw: Obj): OryIdentity | null {
  const id = str(raw.id);
  if (!id) return null;
  const credentials = new Map<string, OryCredential>();
  if (isObj(raw.credentials)) {
    for (const [type, c] of Object.entries(raw.credentials)) {
      if (isObj(c)) credentials.set(type, { identifiers: strs(c.identifiers).map((s) => s.toLowerCase()), config: isObj(c.config) ? c.config : undefined });
    }
  }
  return {
    id,
    schemaId: str(raw.schema_id),
    state: str(raw.state),
    traits: isObj(raw.traits) ? raw.traits : {},
    addresses: objs(raw.verifiable_addresses).flatMap((a) => {
      const value = str(a.value);
      return value ? [{ value, via: (str(a.via) ?? 'email').toLowerCase(), verified: a.verified === true }] : [];
    }),
    publicMetadata: isObj(raw.metadata_public) ? raw.metadata_public : undefined,
    adminMetadata: isObj(raw.metadata_admin) ? raw.metadata_admin : undefined,
    createdAt: raw.created_at,
    organizationId: str(raw.organization_id),
    credentials,
  };
}

/** The `page_token` of a Link header's `rel="next"` URL (Kratos pages with tokens). */
export function nextPageToken(link: string | null): string | null {
  const next = nextLink(link);
  if (!next) return null;
  try {
    return new URL(next, 'https://kratos.invalid').searchParams.get('page_token');
  } catch {
    return null;
  }
}

export async function exportOryApi(o: OryApiOptions): Promise<RecordSet> {
  const progress = o.onProgress ?? (() => undefined);
  const base = /^https?:\/\//.test(o.adminUrl.trim()) ? o.adminUrl.trim().replace(/\/+$/, '') : `https://${o.adminUrl.trim().replace(/\/+$/, '')}`;
  const http = new VendorHttp({ vendor: 'Ory', baseUrl: base, headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}, fetchImpl: o.fetchImpl, sleep: o.sleep });
  const size = o.pageSize ?? 250;
  const list: OryIdentity[] = [];
  const seenTokens = new Set<string>();
  let path = `/admin/identities?page_size=${size}&include_credential=oidc`;
  for (;;) {
    progress(`identities (${list.length} so far)`);
    const res = await http.get<unknown>(path);
    for (const raw of objs(res.body)) {
      const i = oryIdentityFromApi(raw);
      if (i) list.push(i);
    }
    const token = nextPageToken(res.headers.get('link'));
    if (!token || seenTokens.has(token)) break;
    seenTokens.add(token);
    path = `/admin/identities?page_size=${size}&include_credential=oidc&page_token=${encodeURIComponent(token)}`;
  }
  return mapIdentities(list, { source: 'api', rpId: o.rpId, now: Date.now(), origin: `Ory Admin API ${base.replace(/^https?:\/\//, '')}` });
}
