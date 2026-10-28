import { parseCsv } from './csv';

/**
 * Vendor export → Atlas bulk-import rows. Each mapper reads the file format the
 * vendor's own export produces and returns the rows `POST /v1/user_imports`
 * accepts, plus warnings for what could not be carried over. Pure functions of
 * the parsed file, so every mapping is tested from a fixture with no network.
 */

export const VENDORS = [
  'auth0',
  'clerk',
  'supabase',
  'firebase',
  'cognito',
  'authjs',
  'workos',
  'better-auth',
] as const;
export type Vendor = (typeof VENDORS)[number];

export interface ImportMembershipRow {
  organization_id?: string;
  organization_external_id?: string;
  organization_slug?: string;
  organization_name?: string;
  role?: string;
}

/** One row of the Atlas import body. Only fields with a value are set. */
export interface ImportRow {
  email_address: string;
  email_verified?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  external_id?: string;
  created_at?: string | number;
  password_hash?: string;
  password_salt?: string;
  password_hasher?: string;
  phone_numbers?: Array<{ phone_number: string; verified?: boolean }>;
  external_accounts?: Array<{ provider: string; provider_user_id: string; email?: string }>;
  organization_memberships?: ImportMembershipRow[];
  public_metadata?: Record<string, unknown>;
  private_metadata?: Record<string, unknown>;
  unsafe_metadata?: Record<string, unknown>;
}

export interface MappedExport {
  rows: ImportRow[];
  /** Human-readable notes: records skipped, data that cannot move, follow-ups. */
  warnings: string[];
}

/** Parse the file text: a JSON document, newline-delimited JSON, or CSV. */
export function parseExport(text: string, fileName = ''): unknown {
  const trimmed = text.trim();
  if (fileName.toLowerCase().endsWith('.csv')) return parseCsv(text);
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not one JSON document: maybe one object per line (Auth0's export job).
      const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
      if (lines.every((l) => l.trim().startsWith('{'))) return lines.map((l) => JSON.parse(l));
      throw new Error('The file is not valid JSON, NDJSON or CSV.');
    }
  }
  return parseCsv(text);
}

// ── helpers ─────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const s = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
const truthy = (v: unknown): boolean =>
  v === true || v === 1 || (typeof v === 'string' && ['true', '1', 'yes', 't'].includes(v.trim().toLowerCase()));
const json = (v: unknown): Obj | undefined => {
  if (isObj(v)) return Object.keys(v).length ? v : undefined;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(v) as unknown;
      return isObj(parsed) && Object.keys(parsed).length ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};
/** A list from either an array field or a top-level wrapper key. */
const listOf = (doc: unknown, ...keys: string[]): Obj[] => {
  if (Array.isArray(doc)) return doc.filter(isObj);
  if (isObj(doc)) {
    for (const k of keys) {
      const v = doc[k];
      if (Array.isArray(v)) return v.filter(isObj);
    }
    // A one-line NDJSON export parses as a single record.
    if (keys.length && typeof doc.email === 'string') return [doc];
  }
  return [];
};
function splitName(name: string | undefined): { first_name?: string; last_name?: string } {
  if (!name) return {};
  const [first, ...rest] = name.trim().split(/\s+/);
  return { first_name: first, ...(rest.length ? { last_name: rest.join(' ') } : {}) };
}
/** Drop undefined fields so the request body only carries what the export had. */
function clean(row: ImportRow): ImportRow {
  for (const k of Object.keys(row) as Array<keyof ImportRow>) {
    const v = row[k];
    if (v === undefined || (Array.isArray(v) && v.length === 0)) delete row[k];
  }
  return row;
}

/** Social provider names used by vendors → Atlas provider keys. */
const PROVIDER_ALIASES: Record<string, string> = {
  'google-oauth2': 'google',
  'google.com': 'google',
  oauth_google: 'google',
  'facebook.com': 'facebook',
  oauth_facebook: 'facebook',
  'github.com': 'github',
  oauth_github: 'github',
  'apple.com': 'apple',
  oauth_apple: 'apple',
  'twitter.com': 'twitter',
  oauth_twitter: 'twitter',
  'microsoft.com': 'microsoft',
  windowslive: 'microsoft',
  oauth_microsoft: 'microsoft',
  'linkedin-openid': 'linkedin',
  oauth_linkedin_oidc: 'linkedin',
  oauth_linkedin: 'linkedin',
  oauth_discord: 'discord',
  oauth_gitlab: 'gitlab',
  oauth_slack: 'slack',
  azure: 'microsoft',
  GoogleOAuth: 'google',
  MicrosoftOAuth: 'microsoft',
  GitHubOAuth: 'github',
  AppleOAuth: 'apple',
};
export function atlasProvider(raw: string): string {
  return PROVIDER_ALIASES[raw] ?? PROVIDER_ALIASES[raw.toLowerCase()] ?? raw.replace(/^oauth_/, '').toLowerCase();
}

// ── per-vendor mappers ──────────────────────────────────────────────────────

/** Auth0: the user export job (NDJSON/JSON); bcrypt hashes from the password export are merged by email. */
function mapAuth0(doc: unknown): MappedExport {
  const warnings: string[] = [];
  const records = listOf(doc, 'users');
  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const r of records) {
    const email = s(r.email);
    if (!email) {
      skipped++;
      continue;
    }
    const identities = Array.isArray(r.identities) ? r.identities.filter(isObj) : [];
    const social = identities.filter((i) => truthy(i.isSocial) && s(i.provider) && s(i.user_id));
    // The password export (via Auth0 support) carries `passwordHash`; merged in when present.
    const hash = s(r.passwordHash) ?? s(r.password_hash);
    rows.push(
      clean({
        email_address: email,
        email_verified: truthy(r.email_verified),
        first_name: s(r.given_name) ?? splitName(s(r.name)).first_name,
        last_name: s(r.family_name) ?? (s(r.given_name) ? undefined : splitName(s(r.name)).last_name),
        username: s(r.username),
        external_id: s(r.user_id),
        created_at: s(r.created_at),
        password_hash: hash,
        phone_numbers: s(r.phone_number) ? [{ phone_number: s(r.phone_number)!, verified: truthy(r.phone_verified) }] : [],
        external_accounts: social.map((i) => ({ provider: atlasProvider(s(i.provider)!), provider_user_id: s(i.user_id)! })),
        public_metadata: json(r.app_metadata),
        unsafe_metadata: json(r.user_metadata),
      }),
    );
  }
  if (skipped) warnings.push(`${skipped} record(s) without an email address were skipped (phone-only or username-only users).`);
  if (!rows.some((r) => r.password_hash)) {
    warnings.push(
      'No password hashes found. Request the password hash export from Auth0 support and merge it with --hashes, or enable lazy migration so passwords move on first sign-in.',
    );
  }
  return { rows, warnings };
}

/** Clerk: the dashboard CSV export, or users JSON from the Backend API. */
function mapClerk(doc: unknown): MappedExport {
  const warnings: string[] = [];
  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const r of listOf(doc, 'data', 'users')) {
    // JSON (API) shape.
    if (Array.isArray(r.email_addresses)) {
      const emails = r.email_addresses.filter(isObj);
      const primary = emails.find((e) => e.id === r.primary_email_address_id) ?? emails[0];
      const email = s(primary?.email_address);
      if (!email) {
        skipped++;
        continue;
      }
      const verified = isObj(primary?.verification) && primary!.verification.status === 'verified';
      const phones = (Array.isArray(r.phone_numbers) ? r.phone_numbers.filter(isObj) : [])
        .filter((p) => s(p.phone_number))
        .map((p) => ({
          phone_number: s(p.phone_number)!,
          verified: isObj(p.verification) && p.verification.status === 'verified',
        }));
      const ext = (Array.isArray(r.external_accounts) ? r.external_accounts.filter(isObj) : [])
        .filter((e) => s(e.provider) && s(e.provider_user_id))
        .map((e) => ({ provider: atlasProvider(s(e.provider)!), provider_user_id: s(e.provider_user_id)!, email: s(e.email_address) }));
      const memberships = (Array.isArray(r.organization_memberships) ? r.organization_memberships.filter(isObj) : []).map(
        (m) => {
          const org = isObj(m.organization) ? m.organization : {};
          return {
            organization_external_id: s(org.id) ?? s(m.organization_id),
            organization_slug: s(org.slug),
            organization_name: s(org.name),
            role: s(m.role)?.replace(/^org:/, ''),
          };
        },
      );
      rows.push(
        clean({
          email_address: email,
          email_verified: verified,
          first_name: s(r.first_name),
          last_name: s(r.last_name),
          username: s(r.username),
          external_id: s(r.id),
          created_at: typeof r.created_at === 'number' ? r.created_at : s(r.created_at),
          password_hash: s(r.password_digest),
          password_hasher: s(r.password_hasher),
          phone_numbers: phones,
          external_accounts: ext,
          organization_memberships: memberships,
          public_metadata: json(r.public_metadata),
          private_metadata: json(r.private_metadata),
          unsafe_metadata: json(r.unsafe_metadata),
        }),
      );
      continue;
    }
    // CSV (dashboard export) shape.
    const verifiedEmails = (s(r.verified_email_addresses) ?? '').split(/[|,]/).map((e) => e.trim()).filter(Boolean);
    const email = s(r.primary_email_address) ?? verifiedEmails[0] ?? s(r.unverified_email_addresses)?.split(/[|,]/)[0];
    if (!email) {
      skipped++;
      continue;
    }
    const verifiedPhones = (s(r.verified_phone_numbers) ?? '').split(/[|,]/).map((p) => p.trim()).filter(Boolean);
    const phone = s(r.primary_phone_number);
    rows.push(
      clean({
        email_address: email,
        email_verified: verifiedEmails.includes(email),
        first_name: s(r.first_name),
        last_name: s(r.last_name),
        username: s(r.username),
        external_id: s(r.id),
        password_hash: s(r.password_digest),
        password_hasher: s(r.password_hasher),
        phone_numbers: phone ? [{ phone_number: phone, verified: verifiedPhones.includes(phone) }] : [],
      }),
    );
    if (s(r.totp_secret)) warnings.push(`User ${s(r.id) ?? email} has a TOTP secret; it is imported only through the API's mfa field, so they will re-enrol.`);
  }
  if (skipped) warnings.push(`${skipped} record(s) without an email address were skipped.`);
  return { rows, warnings };
}

/** Supabase: rows of auth.users (CSV or JSON), optionally with nested `identities`. */
function mapSupabase(doc: unknown): MappedExport {
  const warnings: string[] = [];
  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const r of listOf(doc, 'users')) {
    const email = s(r.email);
    if (!email) {
      skipped++;
      continue;
    }
    const meta = json(r.raw_user_meta_data) ?? json(r.user_metadata);
    const appMeta = json(r.raw_app_meta_data) ?? json(r.app_metadata);
    const identities = Array.isArray(r.identities) ? r.identities.filter(isObj) : [];
    const name = s(meta?.full_name) ?? s(meta?.name);
    rows.push(
      clean({
        email_address: email,
        email_verified: Boolean(s(r.email_confirmed_at) ?? s(r.confirmed_at)),
        ...splitName(name),
        external_id: s(r.id),
        created_at: s(r.created_at),
        password_hash: s(r.encrypted_password),
        phone_numbers: s(r.phone) ? [{ phone_number: s(r.phone)!.startsWith('+') ? s(r.phone)! : `+${s(r.phone)}`, verified: Boolean(s(r.phone_confirmed_at)) }] : [],
        external_accounts: identities
          .filter((i) => s(i.provider) && s(i.provider) !== 'email' && s(i.provider) !== 'phone' && (s(i.provider_id) ?? s(i.id)))
          .map((i) => ({ provider: atlasProvider(s(i.provider)!), provider_user_id: (s(i.provider_id) ?? s(i.id))! })),
        // Supabase's own bookkeeping keys (`provider`, `providers`) stay behind.
        public_metadata: json(
          appMeta ? Object.fromEntries(Object.entries(appMeta).filter(([k]) => k !== 'provider' && k !== 'providers')) : undefined,
        ),
        unsafe_metadata: meta,
      }),
    );
  }
  if (skipped) warnings.push(`${skipped} record(s) without an email address were skipped.`);
  return { rows, warnings };
}

/** Firebase: `firebase auth:export users.json --format=json`. Hash parameters come from the console. */
function mapFirebase(doc: unknown): MappedExport {
  const warnings: string[] = [];
  const rows: ImportRow[] = [];
  let skipped = 0;
  let disabled = 0;
  for (const r of listOf(doc, 'users')) {
    const email = s(r.email);
    if (!email) {
      skipped++;
      continue;
    }
    if (truthy(r.disabled)) disabled++;
    const providers = Array.isArray(r.providerUserInfo) ? r.providerUserInfo.filter(isObj) : [];
    const hash = s(r.passwordHash);
    rows.push(
      clean({
        email_address: email,
        email_verified: truthy(r.emailVerified),
        ...splitName(s(r.displayName)),
        external_id: s(r.localId),
        created_at: s(r.createdAt) ? Number(s(r.createdAt)) : undefined,
        password_hash: hash,
        password_salt: hash ? (s(r.salt) ?? '') : undefined,
        password_hasher: hash ? 'firebase_scrypt' : undefined,
        phone_numbers: s(r.phoneNumber) ? [{ phone_number: s(r.phoneNumber)!, verified: true }] : [],
        external_accounts: providers
          .filter((p) => s(p.providerId) && s(p.providerId) !== 'password' && s(p.providerId) !== 'phone' && s(p.rawId))
          .map((p) => ({ provider: atlasProvider(s(p.providerId)!), provider_user_id: s(p.rawId)!, email: s(p.email) })),
        public_metadata: json(r.customAttributes),
      }),
    );
  }
  if (skipped) warnings.push(`${skipped} record(s) without an email address were skipped.`);
  if (disabled) warnings.push(`${disabled} user(s) were disabled in Firebase; ban them in Atlas after the import if they should stay blocked.`);
  if (rows.some((r) => r.password_hash)) {
    warnings.push('Firebase password hashes need the project hash parameters: pass --hash-config with signer_key, salt_separator, rounds and mem_cost.');
  }
  return { rows, warnings };
}

/** Amazon Cognito: `aws cognito-idp list-users` JSON, or the user-pool CSV format. Hashes cannot be exported. */
function mapCognito(doc: unknown): MappedExport {
  const warnings: string[] = [
    'Cognito never exports password hashes. Use lazy migration (verify on first sign-in against your user pool) or send password resets.',
  ];
  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const r of listOf(doc, 'Users', 'users')) {
    const attrs: Obj = { ...r };
    const list = Array.isArray(r.Attributes) ? r.Attributes : Array.isArray(r.UserAttributes) ? r.UserAttributes : [];
    for (const a of list.filter(isObj)) if (s(a.Name)) attrs[s(a.Name)!] = a.Value;
    const email = s(attrs.email);
    if (!email) {
      skipped++;
      continue;
    }
    const custom = Object.fromEntries(
      Object.entries(attrs)
        .filter(([k]) => k.startsWith('custom:'))
        .map(([k, v]) => [k.slice('custom:'.length), v]),
    );
    rows.push(
      clean({
        email_address: email,
        email_verified: truthy(attrs.email_verified),
        first_name: s(attrs.given_name) ?? splitName(s(attrs.name)).first_name,
        last_name: s(attrs.family_name) ?? (s(attrs.given_name) ? undefined : splitName(s(attrs.name)).last_name),
        username: s(attrs.preferred_username),
        external_id: s(attrs.sub) ?? s(r.Username) ?? s(attrs['cognito:username']),
        created_at: s(r.UserCreateDate),
        phone_numbers: s(attrs.phone_number) ? [{ phone_number: s(attrs.phone_number)!, verified: truthy(attrs.phone_number_verified) }] : [],
        public_metadata: Object.keys(custom).length ? custom : undefined,
      }),
    );
  }
  if (skipped) warnings.push(`${skipped} record(s) without an email address were skipped.`);
  return { rows, warnings };
}

/** Auth.js account types that are not a social identity (password, magic link, passkey). */
const NON_SOCIAL_AUTHJS = new Set(['credentials', 'email', 'webauthn']);

/** Auth.js / NextAuth: the adapter's `users` and `accounts` tables (JSON), or users with nested accounts. */
function mapAuthJs(doc: unknown): MappedExport {
  const warnings: string[] = [];
  const users = listOf(doc, 'users', 'User', 'user');
  const accounts = isObj(doc) ? listOf(doc.accounts ?? doc.Account ?? doc.account) : [];
  const byUser = new Map<string, Obj[]>();
  for (const a of accounts) {
    const uid = s(a.userId) ?? s(a.user_id);
    if (uid) byUser.set(uid, [...(byUser.get(uid) ?? []), a]);
  }
  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const u of users) {
    const email = s(u.email);
    if (!email) {
      skipped++;
      continue;
    }
    const linked = [...(Array.isArray(u.accounts) ? u.accounts.filter(isObj) : []), ...(byUser.get(s(u.id) ?? '') ?? [])];
    rows.push(
      clean({
        email_address: email,
        email_verified: Boolean(s(u.emailVerified) ?? s(u.email_verified)),
        ...splitName(s(u.name)),
        external_id: s(u.id),
        created_at: s(u.createdAt) ?? s(u.created_at),
        password_hash: s(u.password) ?? s(u.passwordHash) ?? s(u.hashedPassword) ?? s(u.password_hash),
        external_accounts: linked
          .filter((a) => !NON_SOCIAL_AUTHJS.has(s(a.type) ?? 'oauth') && s(a.provider) && (s(a.providerAccountId) ?? s(a.provider_account_id)))
          .map((a) => ({
            provider: atlasProvider(s(a.provider)!),
            provider_user_id: (s(a.providerAccountId) ?? s(a.provider_account_id))!,
          })),
      }),
    );
  }
  if (skipped) warnings.push(`${skipped} record(s) without an email address were skipped.`);
  return { rows, warnings };
}

/** WorkOS: User Management users (API list JSON), optionally with nested organization memberships. */
function mapWorkos(doc: unknown): MappedExport {
  const warnings: string[] = [];
  const rows: ImportRow[] = [];
  const memberships = isObj(doc) ? listOf(doc.organization_memberships) : [];
  const byUser = new Map<string, Obj[]>();
  for (const m of memberships) {
    const uid = s(m.user_id);
    if (uid) byUser.set(uid, [...(byUser.get(uid) ?? []), m]);
  }
  // OAuth identities (`GET /user_management/users/:id/identities`), top-level
  // with a user_id, or nested on each user.
  const identities = isObj(doc) ? listOf(doc.identities) : [];
  const idsByUser = new Map<string, Obj[]>();
  for (const i of identities) {
    const uid = s(i.user_id);
    if (uid) idsByUser.set(uid, [...(idsByUser.get(uid) ?? []), i]);
  }
  let skipped = 0;
  for (const u of listOf(doc, 'data', 'users')) {
    const email = s(u.email);
    if (!email) {
      skipped++;
      continue;
    }
    const ms = [...(Array.isArray(u.organization_memberships) ? u.organization_memberships.filter(isObj) : []), ...(byUser.get(s(u.id) ?? '') ?? [])];
    const ids = [...(Array.isArray(u.identities) ? u.identities.filter(isObj) : []), ...(idsByUser.get(s(u.id) ?? '') ?? [])];
    rows.push(
      clean({
        email_address: email,
        email_verified: truthy(u.email_verified),
        first_name: s(u.first_name),
        last_name: s(u.last_name),
        external_id: s(u.external_id) ?? s(u.id),
        created_at: s(u.created_at),
        password_hash: s(u.password_hash),
        external_accounts: ids
          .filter((i) => s(i.provider) && s(i.idp_id))
          .map((i) => ({ provider: atlasProvider(s(i.provider)!), provider_user_id: s(i.idp_id)! })),
        organization_memberships: ms.map((m) => ({
          organization_external_id: s(m.organization_id),
          organization_name: s(m.organization_name),
          role: isObj(m.role) ? s(m.role.slug) : s(m.role),
        })),
        public_metadata: json(u.metadata),
      }),
    );
  }
  if (skipped) warnings.push(`${skipped} record(s) without an email address were skipped.`);
  return { rows, warnings };
}

/** Better Auth: a JSON dump of its tables (user, account, member, organization, twoFactor). */
function mapBetterAuth(doc: unknown): MappedExport {
  const warnings: string[] = [];
  const t = (name: string) => (isObj(doc) ? listOf(doc[name] ?? doc[`${name}s`]) : []);
  const users = Array.isArray(doc) ? listOf(doc) : t('user');
  const accounts = t('account');
  const members = t('member');
  const orgs = new Map(t('organization').map((o) => [s(o.id) ?? '', o]));
  const accountsBy = new Map<string, Obj[]>();
  for (const a of accounts) {
    const uid = s(a.userId) ?? s(a.user_id);
    if (uid) accountsBy.set(uid, [...(accountsBy.get(uid) ?? []), a]);
  }
  const membersBy = new Map<string, Obj[]>();
  for (const m of members) {
    const uid = s(m.userId) ?? s(m.user_id);
    if (uid) membersBy.set(uid, [...(membersBy.get(uid) ?? []), m]);
  }
  if (t('twoFactor').length) {
    warnings.push(
      `${t('twoFactor').length} user(s) had two-factor enabled. Better Auth encrypts TOTP secrets with your app secret, so they re-enrol after the move.`,
    );
  }
  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const u of users) {
    const email = s(u.email);
    const uid = s(u.id) ?? '';
    if (!email) {
      skipped++;
      continue;
    }
    const linked = accountsBy.get(uid) ?? [];
    const credential = linked.find((a) => (s(a.providerId) ?? s(a.provider_id)) === 'credential');
    rows.push(
      clean({
        email_address: email,
        email_verified: truthy(u.emailVerified ?? u.email_verified),
        ...splitName(s(u.name)),
        username: s(u.username),
        external_id: uid || undefined,
        created_at: s(u.createdAt) ?? s(u.created_at),
        password_hash: s(credential?.password),
        phone_numbers: s(u.phoneNumber) ? [{ phone_number: s(u.phoneNumber)!, verified: truthy(u.phoneNumberVerified) }] : [],
        external_accounts: linked
          .filter((a) => a !== credential && s(a.providerId ?? a.provider_id) && s(a.accountId ?? a.account_id))
          .map((a) => ({ provider: atlasProvider(s(a.providerId ?? a.provider_id)!), provider_user_id: s(a.accountId ?? a.account_id)! })),
        organization_memberships: (membersBy.get(uid) ?? []).map((m) => {
          const orgId = s(m.organizationId) ?? s(m.organization_id);
          const org = orgs.get(orgId ?? '');
          return {
            organization_external_id: orgId,
            organization_slug: s(org?.slug),
            organization_name: s(org?.name),
            role: s(m.role)?.split(',')[0],
          };
        }),
      }),
    );
  }
  if (skipped) warnings.push(`${skipped} record(s) without an email address were skipped.`);
  return { rows, warnings };
}

const MAPPERS: Record<Vendor, (doc: unknown) => MappedExport> = {
  auth0: mapAuth0,
  clerk: mapClerk,
  supabase: mapSupabase,
  firebase: mapFirebase,
  cognito: mapCognito,
  authjs: mapAuthJs,
  workos: mapWorkos,
  'better-auth': mapBetterAuth,
};

/**
 * Map a parsed vendor export. `hashes` is an optional second file of password
 * hashes keyed by email (Auth0's support export, WorkOS's, or any `{email,
 * password_hash}` list), merged onto the rows.
 */
export function mapExport(vendor: Vendor, doc: unknown, hashes?: unknown): MappedExport {
  const mapped = MAPPERS[vendor](doc);
  if (hashes !== undefined) {
    const byEmail = new Map<string, Obj>();
    for (const h of listOf(hashes, 'users', 'data')) {
      const email = s(h.email)?.toLowerCase();
      if (email) byEmail.set(email, h);
    }
    let merged = 0;
    for (const row of mapped.rows) {
      const h = byEmail.get(row.email_address.toLowerCase());
      const hash = h && (s(h.passwordHash) ?? s(h.password_hash) ?? s(h.password_digest));
      if (hash) {
        row.password_hash = hash;
        const type = s(h!.password_hash_type) ?? s(h!.password_hasher);
        if (type) row.password_hasher = type;
        merged++;
      }
    }
    mapped.warnings = mapped.warnings.filter((w) => !w.startsWith('No password hashes found'));
    mapped.warnings.push(`Merged ${merged} password hash(es) from the hash file.`);
  }
  return mapped;
}

/** A one-screen summary of what an import would do (the dry run). */
export function summarize(rows: ImportRow[]): Record<string, number> {
  const orgs = new Set<string>();
  for (const r of rows)
    for (const m of r.organization_memberships ?? [])
      orgs.add(m.organization_external_id ?? m.organization_slug ?? m.organization_id ?? '');
  orgs.delete('');
  return {
    users: rows.length,
    verified_emails: rows.filter((r) => r.email_verified).length,
    with_password_hash: rows.filter((r) => r.password_hash).length,
    with_social_accounts: rows.filter((r) => r.external_accounts?.length).length,
    with_phone_numbers: rows.filter((r) => r.phone_numbers?.length).length,
    with_org_memberships: rows.filter((r) => r.organization_memberships?.length).length,
    organizations: orgs.size,
  };
}
