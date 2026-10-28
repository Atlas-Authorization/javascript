/**
 * The Atlas migration bundle, schema v1: what every vendor exporter writes and
 * Atlas imports through `/v1/migrations/{source}/imports`.
 *
 * Plaintext layer (never written to disk): newline-delimited JSON entries.
 *   1. one `manifest` entry naming the source vendor,
 *   2. any number of `record` entries, each one row of one CANONICAL model, in
 *      {@link CANONICAL_MODEL_ORDER} (a row a later model references comes
 *      first: organizations and users before memberships, users before
 *      identities, factors, passkeys and sessions),
 *   3. one `end` entry carrying the per-model counts, so the reader can prove it
 *      saw every row the exporter wrote.
 *
 * Transport layer (on disk and in transit): see transport.ts. The plaintext is
 * cut into chunks, each sealed with AES-256-GCM under a key only the Atlas
 * instance can derive.
 *
 * The records are vendor-neutral: an exporter maps its vendor's shapes onto
 * these models, so one Atlas pipeline imports every vendor. Ids in a record are
 * the SOURCE's ids (`user.id` is the Auth0 `user_id`, the Clerk `user_…` id);
 * Atlas keeps a source id → Atlas id map, so re-importing is an idempotent
 * upsert and references between records (`membership.user_id`) use source ids.
 *
 * Versioning: {@link MIGRATION_BUNDLE_VERSION} is bumped only on an incompatible
 * change. Adding an optional field or a model is compatible: a reader skips a
 * model it does not know with a `model_unsupported` reason instead of failing.
 */

/** The bundle format identifier, checked by the reader. */
export const MIGRATION_BUNDLE_FORMAT = 'atlas-migration-bundle';
/** Bump on an incompatible change to the entries below. */
export const MIGRATION_BUNDLE_VERSION = 1;

/**
 * Every source Atlas knows, as the `{source}` path segment and the manifest's
 * `source`. `better_auth` bundles keep their own format (see
 * `@atlasauth/better-auth-migrate`) and are routed to their own mapper;
 * `custom` is for a homegrown user store mapped by hand onto the canonical models.
 */
export const MIGRATION_SOURCES = [
  'better_auth',
  'auth0',
  'clerk',
  'cognito',
  'firebase',
  'supabase',
  'workos',
  'authjs',
  'okta',
  'stytch',
  'keycloak',
  'fusionauth',
  'kinde',
  'descope',
  'lucia',
  'passport',
  'iron_session',
  'devise',
  'django',
  'ory',
  'frontegg',
  'azure_ad_b2c',
  'entra_external_id',
  'appwrite',
  'pocketbase',
  'nhost',
  'zitadel',
  'logto',
  'supertokens',
  'authentik',
  'hanko',
  'propelauth',
  'magic',
  'userfront',
  'corbado',
  'ping_identity',
  'onelogin',
  'saml',
  'oidc',
  'ldap',
  'custom',
] as const;
export type MigrationSource = (typeof MIGRATION_SOURCES)[number];

export function isMigrationSource(value: unknown): value is MigrationSource {
  return typeof value === 'string' && (MIGRATION_SOURCES as readonly string[]).includes(value);
}

/**
 * The CLI spells vendors in kebab case (`atlas migrate better-auth`); the API in
 * snake case. Accepts either (and a few common aliases); null when unknown.
 */
export function sourceFromVendor(vendor: string): MigrationSource | null {
  const v = vendor.trim().toLowerCase().replace(/[-\s.]+/g, '_');
  const aliases: Record<string, MigrationSource> = {
    betterauth: 'better_auth',
    nextauth: 'authjs',
    next_auth: 'authjs',
    auth_js: 'authjs',
    aws_cognito: 'cognito',
    amazon_cognito: 'cognito',
    firebase_auth: 'firebase',
    supabase_auth: 'supabase',
    gotrue: 'supabase',
    ory_kratos: 'ory',
    kratos: 'ory',
    workos_authkit: 'workos',
    authkit: 'workos',
    passport_js: 'passport',
    passportjs: 'passport',
    express_session: 'passport',
    ironsession: 'iron_session',
    next_iron_session: 'iron_session',
    rails: 'devise',
    devise_rails: 'devise',
    django_allauth: 'django',
    allauth: 'django',
    django_contrib_auth: 'django',
    identity_platform: 'firebase',
    google_identity_platform: 'firebase',
    amplify: 'cognito',
    aws_amplify: 'cognito',
    b2c: 'azure_ad_b2c',
    azure_b2c: 'azure_ad_b2c',
    aad_b2c: 'azure_ad_b2c',
    entra: 'entra_external_id',
    entra_id: 'entra_external_id',
    external_id: 'entra_external_id',
    ciam: 'entra_external_id',
    hasura_auth: 'nhost',
    nhost_auth: 'nhost',
    pb: 'pocketbase',
    ory_hydra: 'ory',
    hydra: 'ory',
    ory_network: 'ory',
    red_hat_sso: 'keycloak',
    rhsso: 'keycloak',
    rhbk: 'keycloak',
    super_tokens: 'supertokens',
    goauthentik: 'authentik',
    teamhanko: 'hanko',
    hanko_io: 'hanko',
    fusion_auth: 'fusionauth',
    logto_io: 'logto',
    workos_sso: 'workos',
    stytch_b2b: 'stytch',
    stytch_consumer: 'stytch',
    propel_auth: 'propelauth',
    magic_link: 'magic',
    magiclink: 'magic',
    magic_sdk: 'magic',
    ping: 'ping_identity',
    pingone: 'ping_identity',
    ping_one: 'ping_identity',
    pingfederate: 'ping_identity',
    ping_federate: 'ping_identity',
    pingdirectory: 'ldap',
    ping_directory: 'ldap',
    ping_aic: 'ping_identity',
    pingone_aic: 'ping_identity',
    forgerock: 'ping_identity',
    one_login: 'onelogin',
    saml_idp: 'saml',
    generic_saml: 'saml',
    openid_connect: 'oidc',
    generic_oidc: 'oidc',
    active_directory: 'ldap',
    openldap: 'ldap',
    '389ds': 'ldap',
    ldif: 'ldap',
  };
  const s = aliases[v] ?? v;
  return isMigrationSource(s) ? s : null;
}

/** The kebab-case CLI spelling of a source (`better_auth` → `better-auth`). */
export function vendorOfSource(source: MigrationSource): string {
  return source.replace(/_/g, '-');
}

/**
 * The canonical models, in the order an exporter MUST write them. A reader
 * resolves a reference (`membership.user_id`) through rows it has already seen,
 * so a model comes after every model it points at.
 */
export const CANONICAL_MODEL_ORDER = [
  'organization',
  'role',
  // Before users and identities: an SSO identity points at its connection.
  'sso_connection',
  'user',
  'identity',
  'mfa_factor',
  'passkey',
  'membership',
  'invitation',
  'api_key',
  'jwks',
  'session',
] as const;
export type CanonicalModel = (typeof CANONICAL_MODEL_ORDER)[number];

export function isCanonicalModel(model: unknown): model is CanonicalModel {
  return typeof model === 'string' && (CANONICAL_MODEL_ORDER as readonly string[]).includes(model);
}

/** ISO-8601 string or Unix milliseconds. */
export type Timestamp = string | number;

/** Free-form JSON object. */
export type JsonObject = Record<string, unknown>;

// ── records ─────────────────────────────────────────────────────────────────

export interface OrganizationRecord {
  id: string;
  name: string;
  slug?: string;
  image_url?: string;
  /** Verified email domains (members join by domain). */
  domains?: string[];
  max_members?: number;
  public_metadata?: JsonObject;
  private_metadata?: JsonObject;
  created_at?: Timestamp;
}

/**
 * A role. `scope: 'organization'` roles are organization roles (custom roles of
 * one organization when `organization_id` is set, otherwise instance-wide org
 * roles); `scope: 'app'` roles are Atlas app roles assigned to users directly.
 */
export interface RoleRecord {
  /** Stable key, e.g. `admin` or `org:billing_manager`. */
  key: string;
  name?: string;
  description?: string;
  scope: 'organization' | 'app';
  organization_id?: string;
  /** Permission keys (`resource:action`). */
  permissions?: string[];
}

/**
 * A password hash with the algorithm that made it. `algorithm` is an id from
 * Atlas's password-hash verifier registry (see {@link PASSWORD_HASH_ALGORITHMS});
 * `auto` means `hash` is a self-describing digest (`$2b$…`, `$argon2id$…`,
 * `pbkdf2_sha256$…`) Atlas recognises on its own. Atlas verifies it on the
 * user's first sign-in and re-hashes the password to Argon2id.
 */
export interface PasswordHash {
  algorithm: string;
  /** The hash as the vendor exported it (encoding per `params.encoding`, default the algorithm's own). */
  hash: string;
  salt?: string;
  /** Algorithm parameters: iterations, key length, memory cost, signer key, salt position, encoding … */
  params?: Record<string, string | number | boolean>;
}

export interface EmailAddress {
  email: string;
  verified: boolean;
  primary?: boolean;
}

export interface PhoneNumber {
  /** E.164. */
  phone: string;
  verified: boolean;
  primary?: boolean;
}

export interface UserRecord {
  id: string;
  /** At least one email or phone or username (or `anonymous: true`). */
  emails?: EmailAddress[];
  phones?: PhoneNumber[];
  username?: string;
  first_name?: string;
  last_name?: string;
  /** Full display name, split into first/last when those are absent. */
  name?: string;
  image_url?: string;
  password?: PasswordHash;
  /** App-role keys (see `role` records with scope `app`). */
  roles?: string[];
  banned?: boolean;
  ban_reason?: string;
  ban_expires_at?: Timestamp;
  /** Locked by the source (too many attempts): imported as a lock, not a ban. */
  locked?: boolean;
  anonymous?: boolean;
  public_metadata?: JsonObject;
  private_metadata?: JsonObject;
  unsafe_metadata?: JsonObject;
  created_at?: Timestamp;
  last_sign_in_at?: Timestamp;
}

/** A social / OIDC / enterprise identity linked to a user. */
export interface IdentityRecord {
  id?: string;
  user_id: string;
  /** The source's provider name (`google-oauth2`, `oauth_github`, `Google` …); mapped to an Atlas provider key. */
  provider: string;
  /** The provider's subject for this user. */
  provider_user_id: string;
  kind?: 'oauth' | 'oidc' | 'saml' | 'enterprise';
  /** When kind is saml/enterprise: the source id of the `sso_connection` it signs in through. */
  sso_connection_id?: string;
  email?: string;
  email_verified?: boolean;
  access_token?: string;
  refresh_token?: string;
  expires_at?: Timestamp;
  scopes?: string[];
  profile?: JsonObject;
}

/** A second factor. Secrets are plaintext inside the sealed bundle only. */
export interface MfaFactorRecord {
  id?: string;
  user_id: string;
  type: 'totp' | 'hotp' | 'backup_codes' | 'phone' | 'email';
  /** TOTP or HOTP: the shared secret in base32. */
  secret_base32?: string;
  digits?: number;
  period?: number;
  algorithm?: 'SHA1' | 'SHA256' | 'SHA512';
  /** hotp: the next counter the token will produce (default 0). */
  counter?: number;
  /** backup_codes: the remaining unused codes, plaintext (or `backup_code_hashes`). */
  backup_codes?: string[];
  /** backup_codes when the source only kept hashes: `{ algorithm, hash, salt? }` each. */
  backup_code_hashes?: PasswordHash[];
  /** phone: E.164 number receiving the codes. */
  phone?: string;
  verified?: boolean;
  created_at?: Timestamp;
}

/** A WebAuthn credential. Binary fields are base64url. */
export interface PasskeyRecord {
  id?: string;
  user_id: string;
  credential_id: string;
  /** COSE public key. */
  public_key: string;
  sign_count?: number;
  /** The relying-party id the credential was registered for. A passkey only works there. */
  rp_id: string;
  transports?: string[];
  aaguid?: string;
  backed_up?: boolean;
  name?: string;
  created_at?: Timestamp;
}

export interface MembershipRecord {
  id?: string;
  organization_id: string;
  user_id: string;
  /** Role key (a `role` record key, or `admin` / `member`). */
  role: string;
  created_at?: Timestamp;
}

export interface InvitationRecord {
  id: string;
  organization_id?: string;
  email: string;
  role?: string;
  status?: 'pending' | 'accepted' | 'revoked' | 'expired';
  inviter_user_id?: string;
  expires_at?: Timestamp;
  created_at?: Timestamp;
}

/**
 * An API key the source issued to a user or an organization. Only a key whose
 * hash Atlas can check (`sha256` of the full key) keeps working; others are
 * reported as `api_key_reissue`.
 */
export interface ApiKeyRecord {
  id: string;
  user_id?: string;
  organization_id?: string;
  name?: string;
  /** The key hash, hex. */
  hash: string;
  hash_algorithm: 'sha256' | 'sha512' | 'bcrypt' | 'unknown';
  /** The visible prefix/start of the key, for display. */
  start?: string;
  scopes?: string[];
  expires_at?: Timestamp;
  last_used_at?: Timestamp;
  created_at?: Timestamp;
}

export interface SsoConnectionRecord {
  id: string;
  name?: string;
  organization_id?: string;
  protocol: 'saml' | 'oidc';
  domains?: string[];
  saml?: {
    idp_entity_id?: string;
    idp_sso_url?: string;
    idp_certificate?: string;
    idp_metadata_url?: string;
    idp_metadata_xml?: string;
    /** Source SP entity id / ACS — the IdP must be updated when these change. */
    sp_entity_id?: string;
    sp_acs_url?: string;
    attribute_mapping?: Record<string, string>;
  };
  oidc?: {
    issuer?: string;
    discovery_url?: string;
    client_id?: string;
    client_secret?: string;
    scopes?: string[];
  };
  enabled?: boolean;
}

/** A public signing key of the source's JWTs, published in the instance JWKS during cutover. */
export interface JwksRecord {
  kid: string;
  jwk: JsonObject;
}

/**
 * A live session, for the zero-logout bridge. Atlas stores only the hash: the
 * bridge hashes the token the browser presents the same way and looks it up.
 * `token_hash` is lowercase hex sha256 of the token as the bridge will see it
 * (for a JWT session: of its `jti`, or the source's session id claim, per the
 * bridge preset's `session_key`).
 */
export interface SessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  /** The source had already passed a second factor for this session. */
  mfa_verified?: boolean;
  created_at?: Timestamp;
  ip?: string;
  user_agent?: string;
}

/** The data each canonical model carries. */
export interface CanonicalRecordData {
  organization: OrganizationRecord;
  role: RoleRecord;
  user: UserRecord;
  identity: IdentityRecord;
  mfa_factor: MfaFactorRecord;
  passkey: PasskeyRecord;
  membership: MembershipRecord;
  invitation: InvitationRecord;
  api_key: ApiKeyRecord;
  sso_connection: SsoConnectionRecord;
  jwks: JwksRecord;
  session: SessionRecord;
}

// ── entries ─────────────────────────────────────────────────────────────────

/** What the exporter learned about the source, written first. */
export interface MigrationManifest {
  type: 'manifest';
  format: typeof MIGRATION_BUNDLE_FORMAT;
  formatVersion: number;
  source: MigrationSource;
  exportedAt: string;
  exporter: { name: string; version: string };
  /** Where the data came from (tenant domain, project id, user pool id …) — shown in the dashboard, never a credential. */
  origin?: string | null;
  /** The source's own version, when it reports one. */
  sourceVersion?: string | null;
  /** The WebAuthn relying-party id passkeys were registered against. */
  rpId?: string | null;
  /** Social / enterprise providers configured at the source (provider names as the identity records use them). */
  providers?: string[];
  /** Source-specific settings the importer may need (hash parameters, TOTP settings …). */
  settings?: JsonObject;
  /** Things the exporter could not do, in plain words. */
  warnings: string[];
}

export interface MigrationRecord<M extends CanonicalModel = CanonicalModel> {
  type: 'record';
  model: M;
  data: CanonicalRecordData[M];
}

/** The last entry: how many rows of each model were written. */
export interface MigrationEnd {
  type: 'end';
  counts: Record<string, number>;
  /** Rows the exporter left out on purpose (expired sessions, deleted users …), with why. */
  omitted: Record<string, { count: number; reason: string }>;
}

export type MigrationEntry = MigrationManifest | MigrationRecord | MigrationEnd;

// ── validation ──────────────────────────────────────────────────────────────

/** A record problem the writer refuses and the reader skips (`invalid_record`). */
export interface RecordIssue {
  field: string;
  message: string;
}

const str = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Check a record's required fields (the shape the pipeline cannot do without).
 * Returns the problems; an empty list means the record is well-formed. Unknown
 * extra fields are allowed (forward compatible).
 */
export function validateRecord(model: string, data: unknown): RecordIssue[] {
  if (!isCanonicalModel(model)) return [{ field: 'model', message: `Unknown model "${model}".` }];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [{ field: 'data', message: 'A record needs a data object.' }];
  const d = data as Record<string, unknown>;
  const issues: RecordIssue[] = [];
  const need = (field: string) => {
    if (!str(d[field])) issues.push({ field, message: `${model}.${field} is required.` });
  };
  switch (model) {
    case 'organization':
      need('id');
      need('name');
      break;
    case 'role':
      need('key');
      if (d.scope !== 'organization' && d.scope !== 'app') issues.push({ field: 'scope', message: 'role.scope must be "organization" or "app".' });
      break;
    case 'user': {
      need('id');
      const emails = Array.isArray(d.emails) ? d.emails : [];
      const phones = Array.isArray(d.phones) ? d.phones : [];
      for (const [i, e] of emails.entries()) {
        if (!e || typeof e !== 'object' || !str((e as EmailAddress).email) || !(e as EmailAddress).email.includes('@')) {
          issues.push({ field: `emails[${i}]`, message: 'An email needs a valid address.' });
        }
      }
      for (const [i, p] of phones.entries()) {
        if (!p || typeof p !== 'object' || !/^\+[1-9]\d{6,14}$/.test(String((p as PhoneNumber).phone ?? ''))) {
          issues.push({ field: `phones[${i}]`, message: 'A phone number must be E.164 (+15551234567).' });
        }
      }
      if (!emails.length && !phones.length && !str(d.username) && d.anonymous !== true) {
        issues.push({ field: 'emails', message: 'A user needs an email, a phone number, a username, or anonymous: true.' });
      }
      if (d.password !== undefined) issues.push(...validatePasswordHash(d.password, 'password'));
      break;
    }
    case 'identity':
      need('user_id');
      need('provider');
      need('provider_user_id');
      break;
    case 'mfa_factor':
      need('user_id');
      if (!['totp', 'hotp', 'backup_codes', 'phone', 'email'].includes(String(d.type))) issues.push({ field: 'type', message: 'mfa_factor.type must be totp, hotp, backup_codes, phone or email.' });
      if ((d.type === 'totp' || d.type === 'hotp') && !str(d.secret_base32)) issues.push({ field: 'secret_base32', message: 'A TOTP or HOTP factor needs its base32 secret.' });
      if (d.type === 'backup_codes' && !Array.isArray(d.backup_codes) && !Array.isArray(d.backup_code_hashes)) {
        issues.push({ field: 'backup_codes', message: 'A backup_codes factor needs backup_codes or backup_code_hashes.' });
      }
      break;
    case 'passkey':
      need('user_id');
      need('credential_id');
      need('public_key');
      need('rp_id');
      break;
    case 'membership':
      need('organization_id');
      need('user_id');
      need('role');
      break;
    case 'invitation':
      need('id');
      need('email');
      break;
    case 'api_key':
      need('id');
      need('hash');
      if (!['sha256', 'sha512', 'bcrypt', 'unknown'].includes(String(d.hash_algorithm))) issues.push({ field: 'hash_algorithm', message: 'api_key.hash_algorithm must be sha256, sha512, bcrypt or unknown.' });
      break;
    case 'sso_connection':
      need('id');
      if (d.protocol !== 'saml' && d.protocol !== 'oidc') issues.push({ field: 'protocol', message: 'sso_connection.protocol must be "saml" or "oidc".' });
      break;
    case 'jwks':
      need('kid');
      if (!d.jwk || typeof d.jwk !== 'object') issues.push({ field: 'jwk', message: 'jwks.jwk must be a JWK object.' });
      break;
    case 'session':
      need('id');
      need('user_id');
      if (typeof d.token_hash !== 'string' || !HEX64.test(d.token_hash)) issues.push({ field: 'token_hash', message: 'session.token_hash must be lowercase hex sha256.' });
      if (d.expires_at === undefined || d.expires_at === null) issues.push({ field: 'expires_at', message: 'session.expires_at is required.' });
      break;
  }
  return issues;
}

export function validatePasswordHash(v: unknown, field = 'password'): RecordIssue[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [{ field, message: `${field} must be { algorithm, hash, salt?, params? }.` }];
  const p = v as Record<string, unknown>;
  const issues: RecordIssue[] = [];
  if (!str(p.algorithm)) issues.push({ field: `${field}.algorithm`, message: `${field}.algorithm is required (an Atlas hash algorithm id, or "auto").` });
  if (!str(p.hash)) issues.push({ field: `${field}.hash`, message: `${field}.hash is required.` });
  if (p.salt !== undefined && typeof p.salt !== 'string') issues.push({ field: `${field}.salt`, message: `${field}.salt must be a string.` });
  if (p.params !== undefined && (typeof p.params !== 'object' || p.params === null || Array.isArray(p.params))) {
    issues.push({ field: `${field}.params`, message: `${field}.params must be an object.` });
  }
  return issues;
}

/**
 * The password-hash algorithm ids Atlas's verifier registry knows (the ids a
 * {@link PasswordHash} may name). Kept in step with the server registry by a
 * test; an exporter that meets an algorithm not listed here writes the user
 * without `password` and reports it (lazy migration or a reset covers them).
 */
export const PASSWORD_HASH_ALGORITHMS = [
  'auto',
  'argon2',
  'bcrypt',
  'bcrypt_sha256_django',
  'pbkdf2_django',
  'pbkdf2_phc',
  'pbkdf2',
  'scrypt_phc',
  'scrypt',
  'scrypt_firebase',
  'scrypt_better_auth',
  'scrypt_werkzeug',
  'pbkdf2_werkzeug',
  'md5',
  'md5_salted',
  'sha1',
  'sha1_salted',
  'sha256',
  'sha256_salted',
  'sha512',
  'sha512_salted',
  'hmac_sha256',
  'phpass',
  'ldap_ssha',
  'sha512_symfony',
  'md5_crypt',
  'sha_crypt',
  'aspnet_identity',
  'argon2_django',
  'bcrypt_django',
  'scrypt_django',
  'md5_django',
  'sha1_django',
  'scrypt_lucia',
  'bcrypt_pepper',
  'sha224',
  'sha384',
  'sha512_224',
  'sha512_256',
  'sha3_224',
  'sha3_256',
  'sha3_384',
  'sha3_512',
  // Open-source IdP exports (core passwords/index-oss.ts).
  'argon2_raw',
  'pbkdf2_passwap',
  'ory_pf_digest',
  'ory_hmac',
  'logto_legacy',
  'fusionauth_salted',
  'fusionauth_phpass',
  'apr1_crypt',
  'ldap_digest',
  'ldap_pbkdf2',
  'ldap_crypt',
] as const;
export type PasswordHashAlgorithm = (typeof PASSWORD_HASH_ALGORITHMS)[number];
