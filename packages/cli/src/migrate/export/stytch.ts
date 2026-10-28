import type { PasswordHash, UserRecord } from '@atlasauth/migrate';
import { parseCsv } from '../../import/csv';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export stytch` — Stytch (consumer and B2B) onto the canonical
 * bundle models, from the Stytch API with the project id and secret (on this
 * machine only).
 *
 *   consumer   `POST /v1/users/search` (cursor paging, 1000 per page): emails
 *              and phone numbers with their verified flags, name, OAuth
 *              providers, metadata, roles, lock state.
 *   B2B        `POST /v1/b2b/organizations/search`, then per organization
 *              `POST /v1/b2b/organizations/members/search`, `GET /v1/b2b/sso/{org}`
 *              and the RBAC policy (`GET /v1/b2b/rbac/policy`).
 *
 * Stytch members belong to ONE organization each (`member_id` is per
 * organization). Atlas users are people, so members sharing an email become one
 * user: the earliest member's id is the user id (the session JWT `sub` of that
 * member maps to it) and the others' ids are kept in `private_metadata`.
 *
 * Password hashes never leave Stytch through the API: they come from the export
 * Stytch support sends on request (support@stytch.com), given as `--stytch-hashes`
 * (CSV, JSON or NDJSON). Until then the `stytch` lazy-migration preset checks
 * passwords against Stytch on first sign-in. TOTP secrets, passkeys and crypto
 * wallets are not exported.
 */

export type StytchProduct = 'consumer' | 'b2b';

export interface StytchExportOptions {
  projectId: string;
  secret: string;
  /** Detected from the project when omitted. */
  product?: StytchProduct;
  /** Override `https://api.stytch.com` (live) / `https://test.stytch.com` (test), e.g. a custom domain. */
  baseUrl?: string;
  /** The support-provided password export (CSV, JSON array or NDJSON text). */
  hashesText?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/** The API host for a project id: live projects are on api.stytch.com, test projects on test.stytch.com. */
export function stytchBaseUrl(projectId: string): string {
  return projectId.startsWith('project-live-') ? 'https://api.stytch.com' : 'https://test.stytch.com';
}

/** HTTP Basic credentials for the project. */
export function stytchAuthorization(projectId: string, secret: string): string {
  return `Basic ${Buffer.from(`${projectId}:${secret}`).toString('base64')}`;
}

export function stytchHttp(o: Pick<StytchExportOptions, 'projectId' | 'secret' | 'baseUrl' | 'fetchImpl' | 'sleep'>): VendorHttp {
  return new VendorHttp({
    vendor: 'Stytch',
    baseUrl: (o.baseUrl ?? stytchBaseUrl(o.projectId)).replace(/\/+$/, ''),
    headers: { authorization: stytchAuthorization(o.projectId, o.secret) },
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
}

/** Is this a B2B project? Its organization search answers; a consumer project refuses the endpoint. */
export async function detectStytchProduct(http: VendorHttp): Promise<StytchProduct> {
  try {
    await http.post('/v1/b2b/organizations/search', { limit: 1 });
    return 'b2b';
  } catch (err) {
    if (err instanceof VendorApiError && [400, 401, 403, 404].includes(err.status)) return 'consumer';
    throw err;
  }
}

/** Stytch's cursor paging: `results_metadata.next_cursor` until it is null. */
export async function stytchSearch(http: VendorHttp, path: string, body: Obj, key: string): Promise<Obj[]> {
  const out: Obj[] = [];
  let cursor: string | undefined;
  for (;;) {
    const { body: res } = await http.post<Obj>(path, { ...body, limit: 1000, ...(cursor ? { cursor } : {}) });
    const rows = isObj(res) ? objs(res[key]) : [];
    out.push(...rows);
    const next = isObj(res) && isObj(res.results_metadata) ? str(res.results_metadata.next_cursor) : undefined;
    if (!next || next === cursor || rows.length === 0) return out;
    cursor = next;
  }
}

export async function exportStytch(opts: StytchExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const progress = opts.onProgress ?? (() => undefined);
  const http = stytchHttp(opts);
  const product = opts.product ?? (await detectStytchProduct(http));
  const hashes = opts.hashesText !== undefined ? parseStytchHashes(opts.hashesText) : [];

  if (product === 'b2b') await exportB2b(set, http, hashes, progress);
  else await exportConsumer(set, http, hashes, progress);

  if (opts.hashesText === undefined) {
    set.warn('No password hashes: Stytch only provides them through support (support@stytch.com). Pass the file with --stytch-hashes, or turn on the stytch lazy-migration preset so passwords move on first sign-in.');
  }
  set.warn('Stytch does not export TOTP secrets, passkeys (WebAuthn) or crypto wallets: those users enrol again in Atlas.');
  const providers = [...new Set(set.list('identity').map((i) => i.provider))].sort();
  set.manifest = { origin: opts.projectId, providers, settings: { product, project_id: opts.projectId } };
  return set;
}

// ── consumer ────────────────────────────────────────────────────────────────

async function exportConsumer(set: RecordSet, http: VendorHttp, hashes: Obj[], progress: (m: string) => void): Promise<void> {
  progress('users');
  const rows = await stytchSearch(http, '/v1/users/search', {}, 'results');
  const byId = new Map<string, UserRecord>();
  const byEmail = new Map<string, UserRecord>();
  const roleKeys = new Set<string>();
  for (const u of rows) {
    const user = mapStytchUser(u);
    if (!user) {
      set.omit('user', 'no email address or phone number');
      continue;
    }
    byId.set(user.id, user);
    for (const e of user.emails ?? []) byEmail.set(e.email, user);
    set.add('user', user, user.id);
    for (const r of user.roles ?? []) roleKeys.add(r);
    addOauth(set, user.id, objs(u.providers));
    countUnexportable(set, u);
  }
  for (const key of roleKeys) set.add('role', { key, scope: 'app' }, key);
  attachHashes(set, hashes, (row) => {
    const id = str(row.user_id) ?? str(row.id);
    const email = str(row.email)?.toLowerCase() ?? str(row.email_address)?.toLowerCase();
    return (id ? byId.get(id) : undefined) ?? (email ? byEmail.get(email) : undefined);
  });
}

/** One Stytch user object → a user record; null with nothing to sign in with. */
export function mapStytchUser(u: Obj): UserRecord | null {
  const id = str(u.user_id);
  if (!id) return null;
  const emails = objs(u.emails).flatMap((e, i) => {
    const email = str(e.email)?.toLowerCase();
    return email ? [{ email, verified: e.verified === true, primary: i === 0 }] : [];
  });
  const phones = objs(u.phone_numbers).flatMap((p, i) => {
    const phone = e164(p.phone_number);
    return phone ? [{ phone, verified: p.verified === true, primary: i === 0 && emails.length === 0 }] : [];
  });
  const name = isObj(u.name) ? u.name : {};
  const first = [str(name.first_name), str(name.middle_name)].filter(Boolean).join(' ') || undefined;
  const roles = strs(u.roles).length ? strs(u.roles) : objs(u.roles).map((r) => str(r.role_id)).filter((r): r is string => !!r);
  const user: UserRecord = compact({
    id,
    emails,
    phones,
    first_name: first,
    last_name: str(name.last_name),
    roles,
    locked: u.is_locked === true ? true : undefined,
    private_metadata: bag(compact({ ...(isObj(u.trusted_metadata) ? u.trusted_metadata : {}), stytch_external_id: str(u.external_id) })),
    unsafe_metadata: bag(u.untrusted_metadata),
    created_at: str(u.created_at),
  });
  return user.emails?.length || user.phones?.length ? user : null;
}

/** Social sign-ins: `providers` (consumer) / `oauth_registrations` (B2B). */
function addOauth(set: RecordSet, userId: string, regs: Obj[]): void {
  for (const p of regs) {
    const provider = str(p.provider_type)?.toLowerCase();
    const subject = str(p.provider_subject);
    if (!provider || !subject) continue;
    set.add('identity', compact({ user_id: userId, provider, provider_user_id: subject, kind: 'oauth' as const, profile: bag(compact({ picture: str(p.profile_picture_url), locale: str(p.locale) })) }), `${provider}:${subject}`);
  }
}

function countUnexportable(set: RecordSet, u: Obj): void {
  const totps = objs(u.totps).length;
  if (totps) set.omit('mfa_factor', 'Stytch does not export TOTP secrets; re-enrol in Atlas', totps);
  const passkeys = objs(u.webauthn_registrations).length + objs(u.biometric_registrations).length;
  if (passkeys) set.omit('passkey', 'Stytch does not export passkey public keys through the API; register again in Atlas', passkeys);
}

// ── B2B ─────────────────────────────────────────────────────────────────────

/** Stytch's built-in role ids → the Atlas membership roles. */
const BUILT_IN_ROLES: Record<string, string> = { stytch_admin: 'admin', stytch_member: 'member' };

export function stytchRoleKey(roleId: string): string {
  return BUILT_IN_ROLES[roleId] ?? roleId;
}

/** RBAC role objects (`{ role_id, description, permissions: [{ resource_id, actions }] }`) → role records. */
function addRoles(set: RecordSet, roles: Obj[], organizationId?: string): void {
  for (const r of roles) {
    const id = str(r.role_id);
    if (!id || id in BUILT_IN_ROLES) continue;
    const permissions = objs(r.permissions).flatMap((p) => strs(p.actions).map((a) => `${str(p.resource_id) ?? '*'}:${a}`));
    set.add(
      'role',
      compact({ key: id, description: str(r.description), scope: 'organization' as const, organization_id: organizationId, permissions }),
      `${organizationId ?? ''}|${id}`,
    );
  }
}

async function optional<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VendorApiError && [400, 403, 404].includes(err.status)) return fallback;
    throw err;
  }
}

async function exportB2b(set: RecordSet, http: VendorHttp, hashes: Obj[], progress: (m: string) => void): Promise<void> {
  progress('roles');
  const policy = await optional(async () => (await http.get<Obj>('/v1/b2b/rbac/policy')).body, null as Obj | null);
  if (policy && isObj(policy.policy)) addRoles(set, objs(policy.policy.roles));

  progress('organizations');
  const orgs = await stytchSearch(http, '/v1/b2b/organizations/search', {}, 'organizations');
  const orgDomains = new Map<string, string[]>();
  for (const o of orgs) {
    const id = str(o.organization_id);
    const name = str(o.organization_name);
    if (!id || !name) continue;
    // Claimed (verified) domains are the ones that grant membership; allowed-but-unclaimed ones stay in the metadata.
    const claimed = strs(o.claimed_email_domains).map((d) => d.toLowerCase());
    const allowed = strs(o.email_allowed_domains).map((d) => d.toLowerCase());
    orgDomains.set(id, [...new Set([...claimed, ...allowed])]);
    set.add(
      'organization',
      compact({
        id,
        name,
        slug: str(o.organization_slug),
        image_url: str(o.organization_logo_url),
        domains: claimed,
        private_metadata: bag(compact({ ...(isObj(o.trusted_metadata) ? o.trusted_metadata : {}), stytch_external_id: str(o.organization_external_id), stytch_mfa_policy: str(o.mfa_policy), stytch_allowed_auth_methods: strs(o.allowed_auth_methods) })),
        created_at: str(o.created_at),
      }),
      id,
    );
    addRoles(set, objs(o.custom_roles), id);
    if (allowed.length > claimed.length) set.warn(`Organization ${name}: ${allowed.length - claimed.length} allowed email domain(s) are not claimed (verified) in Stytch; add them in Atlas once verified.`);
    if (str(o.mfa_policy) === 'REQUIRED_FOR_ALL') set.warn(`Organization ${name} requires MFA for all members: set the matching MFA requirement in Atlas.`);
    if (isObj(o.scim_active_connection)) set.warn(`Organization ${name} has an active SCIM connection: recreate it in Atlas (Stytch does not export SCIM bearer tokens).`);
  }

  progress('SSO connections');
  const connectionProtocol = new Map<string, 'saml' | 'oidc'>();
  for (const o of orgs) {
    const orgId = str(o.organization_id);
    if (!orgId) continue;
    const sso = await optional(async () => (await http.get<Obj>(`/v1/b2b/sso/${encodeURIComponent(orgId)}`)).body, null as Obj | null);
    if (!isObj(sso)) continue;
    for (const c of objs(sso.saml_connections)) {
      const id = str(c.connection_id);
      if (!id) continue;
      connectionProtocol.set(id, 'saml');
      const cert = objs(c.verification_certificates).map((x) => str(x.certificate))[0] ?? str(c.x509_certificate);
      set.add(
        'sso_connection',
        compact({
          id,
          name: str(c.display_name),
          organization_id: orgId,
          protocol: 'saml' as const,
          domains: orgDomains.get(orgId),
          saml: compact({
            idp_entity_id: str(c.idp_entity_id),
            idp_sso_url: str(c.idp_sso_url),
            idp_certificate: cert,
            sp_entity_id: str(c.audience_uri),
            sp_acs_url: str(c.acs_url),
            attribute_mapping: isObj(c.attribute_mapping) ? stringMap(c.attribute_mapping) : undefined,
          }),
          enabled: c.status === undefined ? undefined : c.status === 'active',
        }),
        id,
      );
    }
    for (const c of objs(sso.oidc_connections)) {
      const id = str(c.connection_id);
      if (!id) continue;
      connectionProtocol.set(id, 'oidc');
      const name = str(c.display_name);
      set.add(
        'sso_connection',
        compact({
          id,
          name,
          organization_id: orgId,
          protocol: 'oidc' as const,
          domains: orgDomains.get(orgId),
          oidc: compact({ issuer: str(c.issuer), client_id: str(c.client_id), client_secret: str(c.client_secret), scopes: strs(c.custom_scopes) }),
          enabled: c.status === undefined ? undefined : c.status === 'active',
        }),
        id,
      );
      if (!str(c.client_secret)) set.warn(`OIDC connection ${name ?? id}: Stytch did not return its client secret; enter it in Atlas after the import.`);
    }
    const external = objs(sso.external_connections).length;
    if (external) set.omit('sso_connection', 'Stytch external SSO connections are managed outside Stytch; recreate them in Atlas', external);
  }

  progress('members');
  type Member = { m: Obj; org: string };
  const members: Member[] = [];
  for (const o of orgs) {
    const org = str(o.organization_id);
    if (!org) continue;
    for (const m of await stytchSearch(http, '/v1/b2b/organizations/members/search', { organization_ids: [org] }, 'members')) members.push({ m, org });
  }

  // One Atlas user per email: the earliest member's id is the user id.
  const when = (m: Obj) => Date.parse(str(m.created_at) ?? '') || 0;
  members.sort((a, b) => when(a.m) - when(b.m));
  const groups = new Map<string, Member[]>();
  for (const x of members) {
    const status = str(x.m.status);
    const email = str(x.m.email_address)?.toLowerCase();
    const id = str(x.m.member_id);
    if (!id || !email) continue;
    if (status === 'deleted') {
      set.omit('user', 'deleted member');
      continue;
    }
    if (status === 'invited') {
      const role = stytchRoleKey(str(objs(x.m.roles)[0]?.role_id) ?? 'stytch_member');
      set.add('invitation', compact({ id, organization_id: x.org, email, role, status: 'pending' as const, created_at: str(x.m.created_at) }), id);
      continue;
    }
    const g = groups.get(email) ?? [];
    g.push(x);
    groups.set(email, g);
  }

  const userByMember = new Map<string, UserRecord>();
  const userByEmail = new Map<string, UserRecord>();
  let merged = 0;
  for (const [email, g] of groups) {
    const primary = g[0]!;
    const userId = str(primary.m.member_id)!;
    const ids = g.map((x) => str(x.m.member_id)!);
    const verified = g.some((x) => x.m.email_address_verified === true);
    const phone = g.map((x) => e164(x.m.mfa_phone_number)).find((p) => p);
    const user: UserRecord = compact({
      id: userId,
      emails: [{ email, verified, primary: true }],
      name: str(primary.m.name),
      locked: g.every((x) => x.m.is_locked === true) ? true : undefined,
      private_metadata: bag(
        compact({
          ...(isObj(primary.m.trusted_metadata) ? primary.m.trusted_metadata : {}),
          stytch_member_ids: ids.length > 1 ? ids : undefined,
          stytch_external_id: str(primary.m.external_id),
          stytch_is_breakglass: g.some((x) => x.m.is_breakglass === true) ? true : undefined,
        }),
      ),
      unsafe_metadata: bag(primary.m.untrusted_metadata),
      created_at: str(primary.m.created_at),
    });
    set.add('user', user, userId);
    userByEmail.set(email, user);
    for (const x of g) {
      const mid = str(x.m.member_id)!;
      userByMember.set(mid, user);
      const roles = objs(x.m.roles).map((r) => str(r.role_id)).filter((r): r is string => !!r);
      set.add('membership', compact({ organization_id: x.org, user_id: userId, role: stytchRoleKey(roles[0] ?? 'stytch_member'), created_at: str(x.m.created_at) }), `${x.org}:${userId}`);
      if (roles.length > 1) set.warn('Some members hold several Stytch roles; Atlas seats each member with one role (the first).');
      addOauth(set, userId, objs(x.m.oauth_registrations));
      for (const s of objs(x.m.sso_registrations)) {
        const conn = str(s.connection_id);
        const subject = str(s.external_id);
        if (!subject) continue;
        const protocol = conn ? connectionProtocol.get(conn) : undefined;
        if (!conn || !protocol) {
          set.omit('identity', 'SSO sign-ins whose connection could not be read from Stytch relink by verified email');
          continue;
        }
        set.add('identity', compact({ user_id: userId, provider: protocol, provider_user_id: subject, kind: protocol, sso_connection_id: conn, email, email_verified: verified }), `sso:${conn}:${subject}`);
      }
      if (str(x.m.totp_registration_id)) set.omit('mfa_factor', 'Stytch does not export TOTP secrets; re-enrol in Atlas');
    }
    if (g.length > 1) merged += g.length - 1;
    if (phone && g.some((x) => x.m.mfa_enrolled === true)) {
      set.add('mfa_factor', { user_id: userId, type: 'phone', phone, verified: g.some((x) => x.m.mfa_phone_number_verified === true) }, `phone:${userId}`);
    }
  }
  if (merged) set.warn(`${merged} Stytch members share an email with a member of another organization: they became one Atlas user with a membership per organization. Only the earliest member's id maps to the user for the zero-logout bridge; the others sign in once.`);

  attachHashes(set, hashes, (row) => {
    const id = str(row.member_id) ?? str(row.user_id) ?? str(row.id);
    const email = str(row.email_address)?.toLowerCase() ?? str(row.email)?.toLowerCase();
    return (id ? userByMember.get(id) : undefined) ?? (email ? userByEmail.get(email) : undefined);
  });
}

function stringMap(o: Obj): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    const s = str(v);
    if (s) out[k] = s;
  }
  return out;
}

// ── password hashes (the support export) ────────────────────────────────────

/**
 * Parse the password export Stytch support sends: a JSON array (or an object
 * holding one under `users` / `members` / `results`), NDJSON, or CSV with a
 * header row. Keys are lower-cased; a nested `scrypt_config` etc. is flattened.
 */
export function parseStytchHashes(text: string): Obj[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let rows: Obj[];
  if (trimmed.startsWith('[') || (trimmed.startsWith('{') && !trimmed.includes('\n{'))) {
    const parsed = JSON.parse(trimmed) as unknown;
    rows = Array.isArray(parsed) ? objs(parsed) : isObj(parsed) ? (['users', 'members', 'results', 'passwords'].map((k) => objs(parsed[k])).find((l) => l.length) ?? [parsed]) : [];
  } else if (trimmed.startsWith('{')) {
    rows = trimmed
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as unknown)
      .filter(isObj);
  } else {
    rows = parseCsv(trimmed);
  }
  return rows.map(flatten);
}

function flatten(row: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(row)) {
    if (isObj(v)) for (const [k2, v2] of Object.entries(v)) out[k2.trim().toLowerCase()] ??= v2;
    else out[k.trim().toLowerCase()] = v;
  }
  return out;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/**
 * One row of the support export → the bundle's password hash. Field names
 * follow Stytch's own password-migration API (`hash`, `hash_type`, and the
 * `scrypt_config` / `pbkdf_2_config` / salt fields), which is the format the
 * export mirrors (UNCONFIRMED: Stytch support documents it per request).
 */
export function stytchPasswordHash(row: Obj): PasswordHash | { reason: string } {
  const hash = str(row.hash) ?? str(row.password_hash) ?? str(row.hashed_password);
  if (!hash) return { reason: 'empty Stytch password hash' };
  const type = (str(row.hash_type) ?? str(row.hash_algorithm) ?? str(row.algorithm) ?? '').toLowerCase().replace(/[-\s]/g, '_');
  const phc = hash.startsWith('$');
  switch (type) {
    case '':
      return phc ? { algorithm: 'auto', hash } : { reason: 'Stytch password hash without its hash_type' };
    case 'bcrypt':
      return { algorithm: 'bcrypt', hash };
    case 'argon_2i':
    case 'argon_2id':
    case 'argon2i':
    case 'argon2id':
    case 'argon2':
      return phc ? { algorithm: 'auto', hash } : { reason: 'Stytch Argon2 hash in the raw (non-encoded) form is not supported: ask support for the encoded form' };
    case 'phpass':
      return { algorithm: 'auto', hash };
    case 'scrypt': {
      if (phc) return { algorithm: 'auto', hash };
      const salt = str(row.salt);
      const n = num(row.n_parameter) ?? num(row.n);
      if (!salt || !n) return { reason: 'Stytch scrypt hash without salt or N parameter' };
      const keyLength = num(row.key_length);
      return {
        algorithm: 'scrypt',
        hash,
        salt,
        params: { n, r: num(row.r_parameter) ?? num(row.r) ?? 8, p: num(row.p_parameter) ?? num(row.p) ?? 1, ...(keyLength ? { key_length: keyLength } : {}), encoding: 'base64', salt_encoding: 'base64' },
      };
    }
    case 'pbkdf_2':
    case 'pbkdf2': {
      if (phc) return { algorithm: 'auto', hash };
      const salt = str(row.salt);
      const iterations = num(row.iteration_amount) ?? num(row.iterations);
      if (!salt || !iterations) return { reason: 'Stytch PBKDF2 hash without salt or iteration count' };
      const keyLength = num(row.key_length);
      const digest = (str(row.digest) ?? (str(row.algorithm) && str(row.algorithm)!.toLowerCase().startsWith('sha') ? str(row.algorithm) : undefined) ?? 'sha256')!.toLowerCase();
      return { algorithm: 'pbkdf2', hash, salt, params: { digest, iterations, ...(keyLength ? { key_length: keyLength } : {}), encoding: 'base64', salt_encoding: 'base64' } };
    }
    case 'md_5':
    case 'md5':
    case 'sha_1':
    case 'sha1':
    case 'sha_512':
    case 'sha512': {
      const base = type.replace('_', '');
      const prepend = str(row.prepend_salt);
      const append = str(row.append_salt);
      if (prepend && append) return { reason: `Stytch ${base} hash salted on both sides is not supported` };
      if (!prepend && !append) return { algorithm: base, hash };
      return { algorithm: `${base}_salted`, hash, salt: (prepend ?? append)!, params: { salt_position: prepend ? 'prefix' : 'suffix' } };
    }
    default:
      return { reason: `Stytch password hash type "${type}" is not supported` };
  }
}

/** Attach each row's hash to the user `find` returns; count what could not be placed. */
function attachHashes(set: RecordSet, rows: Obj[], find: (row: Obj) => UserRecord | undefined): void {
  let unmatched = 0;
  let attached = 0;
  for (const row of rows) {
    const user = find(row);
    if (!user) {
      unmatched++;
      continue;
    }
    if (user.password) continue;
    const mapped = stytchPasswordHash(row);
    if ('reason' in mapped) set.omit('password', mapped.reason);
    else {
      user.password = mapped;
      attached++;
    }
  }
  if (unmatched) set.warn(`${unmatched} row(s) of the Stytch password export matched no exported user and were left out.`);
  if (rows.length && attached === 0) set.warn('No password in the Stytch export could be attached to a user: check the id / email columns and the hash_type values.');
}
