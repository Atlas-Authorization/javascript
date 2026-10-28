import { gunzipSync } from 'node:zlib';
import type { IdentityRecord, PasswordHash, UserRecord } from '@atlasauth/migrate';
import { RecordSet, bag, compact, e164, isObj, objs, str, type Obj } from './record-set';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export auth0` — Auth0 (and Okta Customer Identity Cloud,
 * which is Auth0) onto the canonical bundle models.
 *
 * Read with a Management API token the owner holds (a machine-to-machine
 * application's client id + secret, or a token pasted from the dashboard);
 * the calls run on this machine and the credentials go nowhere else.
 *
 *   - users: through a user-export JOB (the only complete listing — user
 *     search stops at 1,000), or from an export file the owner already has;
 *   - password hashes and MFA secrets: Auth0 releases them ONLY through a
 *     support ticket. Pass the decrypted file with --auth0-hashes-file; rows are matched
 *     by user id (`_id.$oid` → `auth0|<oid>`) or email. Without it, enable the
 *     `auth0` lazy-migration preset so passwords move on first sign-in;
 *   - social and enterprise identities, app roles (role → users), organizations,
 *     members with their roles, pending invitations, enterprise connections
 *     (SAML / OIDC / Azure AD / ADFS / Okta / Ping / Google Workspace), and the
 *     tenant's public signing keys;
 *   - with --authentication-methods: per user, phone/email second factors and
 *     passkeys (public key only — Auth0 never returns a TOTP secret by API).
 *
 * Sessions are not exported: Auth0 issues JWTs, bridged by the `auth0`
 * bridge preset against the tenant's JWKS.
 */

export interface Auth0ExportOptions {
  /** The tenant's canonical domain (`acme.us.auth0.com`), not a custom domain. */
  domain: string;
  clientId?: string;
  clientSecret?: string;
  /** A Management API token, instead of client credentials. */
  token?: string;
  /** The text of a user export file (NDJSON or JSON array), instead of running an export job. */
  usersText?: string;
  /** The text of the decrypted password-hash / MFA export from Auth0 support (NDJSON or JSON). */
  hashesText?: string;
  /** Only this database / social connection's users (export job `connection_id`). */
  connectionId?: string;
  /** Read each user's authentication methods (phone/email factors, passkeys). One call per user. */
  authenticationMethods?: boolean;
  /** The WebAuthn relying party the passkeys were registered for (default: the domain). */
  rpId?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/** Fields requested from the export job (json format allows whole metadata objects). */
export const AUTH0_EXPORT_FIELDS = [
  'user_id',
  'email',
  'email_verified',
  'username',
  'phone_number',
  'phone_verified',
  'given_name',
  'family_name',
  'name',
  'nickname',
  'picture',
  'identities',
  'app_metadata',
  'user_metadata',
  'created_at',
  'last_login',
  'blocked',
] as const;

const ENTERPRISE_STRATEGIES = ['samlp', 'oidc', 'waad', 'adfs', 'okta', 'pingfederate', 'google-apps', 'ad'];

export async function exportAuth0(opts: Auth0ExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const domain = opts.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error(`Not an Auth0 domain: ${opts.domain}`);
  const progress = opts.onProgress ?? (() => undefined);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = opts.fetchImpl ?? fetch;

  let token = opts.token;
  const http = new VendorHttp({
    vendor: 'Auth0',
    baseUrl: `https://${domain}/api/v2`,
    headers: async () => ({ authorization: `Bearer ${(token ??= await managementToken(domain, opts, fetchImpl))}` }),
    fetchImpl,
    sleep,
  });

  // Offline: only the files (users + hashes), no Management API calls at all.
  const online = Boolean(opts.token || (opts.clientId && opts.clientSecret));
  if (!online && opts.usersText === undefined) {
    throw new Error('Auth0 export needs a Management API token (or M2M client id + secret), or a user export file.');
  }
  if (!online) set.warn('Exported from files only: organizations, roles and enterprise connections need Management API access.');
  const list = async (fn: () => Promise<Obj[]>): Promise<Obj[]> => (online ? fn() : []);

  // Enterprise connections first: identities point at them by name.
  progress('connections');
  const connectionIds = new Map<string, string>();
  for (const c of await list(() => pageAll(http, `/connections?${ENTERPRISE_STRATEGIES.map((s) => `strategy=${s}`).join('&')}`, 'connections'))) {
    const added = addConnection(set, c, domain);
    if (added) connectionIds.set(str(c.name)!, added);
  }

  progress('organizations');
  const orgs = await list(() => checkpointAll(http, '/organizations', 'organizations'));
  for (const o of orgs) {
    const id = str(o.id);
    const name = str(o.display_name) ?? str(o.name);
    if (!id || !name) continue;
    set.add(
      'organization',
      compact({
        id,
        name,
        slug: str(o.name),
        image_url: str(isObj(o.branding) ? o.branding.logo_url : undefined),
        public_metadata: bag(o.metadata),
      }),
    );
  }

  progress('roles');
  const roles = await list(() => pageAll(http, '/roles', 'roles'));
  const roleKeyById = new Map<string, string>();
  const userRoles = new Map<string, string[]>();
  for (const r of roles) {
    const id = str(r.id);
    const name = str(r.name);
    if (!id || !name) continue;
    const key = roleKey(name);
    roleKeyById.set(id, key);
    const permissions = (await pageAll(http, `/roles/${id}/permissions`, 'permissions'))
      .map((p) => str(p.permission_name))
      .filter((p): p is string => !!p);
    set.add('role', compact({ key, name, description: str(r.description), scope: 'app' as const, permissions }), `app:${key}`);
    if (orgs.length) set.add('role', compact({ key, name, description: str(r.description), scope: 'organization' as const, permissions }), `org:${key}`);
    for (const u of await checkpointAll(http, `/roles/${id}/users`, 'users')) {
      const uid = str(u.user_id);
      if (uid) userRoles.set(uid, [...(userRoles.get(uid) ?? []), key]);
    }
  }

  progress('users');
  const userLines = opts.usersText !== undefined ? parseLines(opts.usersText) : await runExportJob(http, opts, fetchImpl, sleep, progress);
  const secrets = opts.hashesText !== undefined ? indexHashes(parseLines(opts.hashesText)) : null;
  const userIds = new Set<string>();
  let withHash = 0;
  for (const u of userLines) {
    const id = str(u.user_id);
    if (!id) continue;
    const secret = secrets ? (secrets.byId.get(id) ?? secrets.byEmail.get(str(u.email)?.toLowerCase() ?? '')) : undefined;
    if (addUser(set, u, { roles: userRoles.get(id), secret, connectionIds })) {
      userIds.add(id);
      if (secret?.password) withHash++;
    }
  }
  const dbUsers = set.list('user').filter((u) => u.id.startsWith('auth0|')).length;
  if (!secrets && dbUsers > 0) {
    set.warn(
      `${dbUsers} database user(s) without password hashes: Auth0 releases hashes only through a support ticket. Import them later with --auth0-hashes-file, or turn on the auth0 lazy-migration preset so each password moves on its first sign-in.`,
    );
  } else if (secrets && withHash < dbUsers) {
    set.omit('password', 'no row in the hash export for this database user', dbUsers - withHash);
  }

  if (opts.authenticationMethods && online) {
    progress('authentication methods');
    for (const id of userIds) await addAuthenticationMethods(set, http, id, opts.rpId ?? domain);
  } else {
    set.warn('Second factors and passkeys were not read (pass --authentication-methods). Without them, users re-enrol MFA in Atlas.');
  }

  progress('organization members');
  for (const o of orgs) {
    const orgId = str(o.id);
    if (!orgId) continue;
    for (const m of await checkpointAll(http, `/organizations/${orgId}/members?fields=user_id,roles&include_fields=true`, 'members')) {
      const uid = str(m.user_id);
      if (!uid || !userIds.has(uid)) continue;
      const role = objs(m.roles).map((r) => roleKeyById.get(str(r.id) ?? '') ?? (str(r.name) ? roleKey(str(r.name)!) : undefined)).find(Boolean) ?? 'member';
      set.add('membership', { organization_id: orgId, user_id: uid, role }, `${orgId}:${uid}`);
      if (objs(m.roles).length > 1) set.warn(`Some organization members hold several Auth0 roles; Atlas seats each member with one role (the first).`);
    }
    for (const inv of await pageAll(http, `/organizations/${orgId}/invitations`, 'invitations')) {
      const id = str(inv.id);
      const email = str(isObj(inv.invitee) ? inv.invitee.email : undefined);
      if (!id || !email) continue;
      const roleIds = Array.isArray(inv.roles) ? inv.roles : [];
      set.add(
        'invitation',
        compact({
          id,
          organization_id: orgId,
          email,
          role: roleIds.map((r) => roleKeyById.get(String(r))).find(Boolean),
          status: 'pending' as const,
          expires_at: str(inv.expires_at),
          created_at: str(inv.created_at),
        }),
      );
    }
  }

  progress('signing keys');
  if (online) {
    try {
      const res = await fetchImpl(`https://${domain}/.well-known/jwks.json`, { headers: { accept: 'application/json' } });
      if (res.ok) {
        const body = (await res.json()) as { keys?: unknown };
        for (const k of objs(body.keys)) if (str(k.kid)) set.add('jwks', { kid: str(k.kid)!, jwk: k });
      }
    } catch {
      set.warn('The tenant JWKS could not be read; the bridge preset fetches it live instead.');
    }
  }

  set.manifest = {
    origin: domain,
    rpId: opts.authenticationMethods ? (opts.rpId ?? domain) : null,
    providers: [...new Set(set.list('identity').map((i) => i.provider))].sort(),
  };
  return set;
}

// ── tokens and paging ───────────────────────────────────────────────────────

export async function managementToken(domain: string, opts: Auth0ExportOptions, fetchImpl: typeof fetch): Promise<string> {
  if (!opts.clientId || !opts.clientSecret) {
    throw new Error('Auth0 export needs a Management API token, or the client id and secret of a machine-to-machine application authorized for the Management API.');
  }
  const res = await fetchImpl(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: opts.clientId, client_secret: opts.clientSecret, audience: `https://${domain}/api/v2/` }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new VendorApiError('Auth0', res.status, '/oauth/token', body.error_description ?? 'could not get a Management API token');
  }
  return body.access_token;
}

/** page/per_page listing with include_totals (Auth0's classic paging). */
async function pageAll(http: VendorHttp, path: string, key: string): Promise<Obj[]> {
  const out: Obj[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 0; ; page++) {
    const { body } = await http.get<unknown>(`${path}${sep}page=${page}&per_page=100&include_totals=true`);
    const rows = Array.isArray(body) ? body.filter(isObj) : isObj(body) ? objs(body[key]) : [];
    out.push(...rows);
    const total = isObj(body) && typeof body.total === 'number' ? body.total : undefined;
    if (rows.length < 100 || (total !== undefined && out.length >= total)) return out;
  }
}

/** Checkpoint paging (`from` / `take`, `next` in the body): no 1,000-row ceiling. */
async function checkpointAll(http: VendorHttp, path: string, key: string): Promise<Obj[]> {
  const out: Obj[] = [];
  const sep = path.includes('?') ? '&' : '?';
  let from: string | undefined;
  for (;;) {
    const { body } = await http.get<unknown>(`${path}${sep}take=100${from ? `&from=${encodeURIComponent(from)}` : ''}`);
    const rows = Array.isArray(body) ? body.filter(isObj) : isObj(body) ? objs(body[key]) : [];
    out.push(...rows);
    from = isObj(body) ? str(body.next) : undefined;
    if (!from || rows.length === 0) return out;
  }
}

async function runExportJob(
  http: VendorHttp,
  opts: Auth0ExportOptions,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  progress: (m: string) => void,
): Promise<Obj[]> {
  const body: Obj = { format: 'json', fields: AUTH0_EXPORT_FIELDS.map((name) => ({ name })) };
  if (opts.connectionId) body.connection_id = opts.connectionId;
  let job: Obj;
  try {
    job = (await http.post<Obj>('/jobs/users-exports', body)).body;
  } catch (err) {
    if (err instanceof VendorApiError && (err.status === 403 || err.status === 402)) {
      throw new Error(`Auth0 refused the user export job (${err.message}). Export jobs need a paid plan and the read:users scope; or download an export yourself and pass it with --auth0-users-file.`);
    }
    throw err;
  }
  const id = str(job.id);
  if (!id) throw new Error('Auth0 did not return an export job id.');
  for (let i = 0; ; i++) {
    const { body: status } = await http.get<Obj>(`/jobs/${id}`);
    const state = str(status.status);
    if (state === 'completed' && str(status.location)) {
      // The location is a short-lived pre-signed URL: no Auth0 credentials go with it.
      const res = await fetchImpl(str(status.location)!);
      if (!res.ok) throw new VendorApiError('Auth0', res.status, 'export download', 'the export file could not be downloaded');
      const raw = Buffer.from(await res.arrayBuffer());
      const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      return parseLines(text);
    }
    if (state === 'failed') throw new Error(`The Auth0 export job ${id} failed${str(status.summary) ? `: ${str(status.summary)}` : ''}.`);
    if (i % 6 === 0) progress(`waiting for export job ${id} (${state ?? 'pending'}${typeof status.time_left_seconds === 'number' ? `, ~${status.time_left_seconds}s left` : ''})`);
    await sleep(5000);
  }
}

/** NDJSON (Auth0's export format) or a JSON array / `{ users: [] }`. */
export function parseLines(text: string): Obj[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[')) return objs(JSON.parse(t));
  try {
    const one = JSON.parse(t) as unknown;
    if (isObj(one)) return Array.isArray(one.users) ? objs(one.users) : [one];
  } catch {
    // NDJSON: one object per line.
  }
  return t
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown)
    .filter(isObj);
}

// ── users ───────────────────────────────────────────────────────────────────

/** The support export, indexed: `_id.$oid` → `auth0|<oid>`, and by email. */
interface SecretRow {
  password?: PasswordHash;
  passwordReason?: string;
  totp?: string[];
  phones?: string[];
  emails?: string[];
}

function indexHashes(rows: Obj[]): { byId: Map<string, SecretRow>; byEmail: Map<string, SecretRow> } {
  const byId = new Map<string, SecretRow>();
  const byEmail = new Map<string, SecretRow>();
  for (const r of rows) {
    const oid = isObj(r._id) ? str(r._id.$oid) : str(r._id);
    const id = str(r.user_id) ?? (oid ? `auth0|${oid}` : undefined);
    const secret: SecretRow = {};
    const hash = str(r.passwordHash) ?? str(r.password_hash);
    if (hash) secret.password = { algorithm: 'auto', hash };
    else if (isObj(r.custom_password_hash)) {
      const mapped = auth0CustomHash(r.custom_password_hash);
      if ('reason' in mapped) secret.passwordReason = mapped.reason;
      else secret.password = mapped;
    }
    // MFA secrets, when support includes them, in the bulk-import `mfa_factors` shape.
    for (const f of objs(r.mfa_factors)) {
      const totp = isObj(f.totp) ? str(f.totp.secret) : undefined;
      if (totp) (secret.totp ??= []).push(totp);
      const phone = isObj(f.phone) ? str(f.phone.value) : undefined;
      if (phone) (secret.phones ??= []).push(phone);
      const email = isObj(f.email) ? str(f.email.value) : undefined;
      if (email) (secret.emails ??= []).push(email);
    }
    if (id) byId.set(id, secret);
    const email = str(r.email)?.toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, secret);
  }
  return { byId, byEmail };
}

function addUser(
  set: RecordSet,
  u: Obj,
  ctx: { roles?: string[]; secret?: SecretRow; connectionIds: Map<string, string> },
): boolean {
  const id = str(u.user_id)!;
  const email = str(u.email)?.toLowerCase();
  const phone = e164(u.phone_number);
  const user: UserRecord = compact({
    id,
    emails: email ? [{ email, verified: u.email_verified === true, primary: true }] : [],
    phones: phone ? [{ phone, verified: u.phone_verified === true, primary: !email }] : [],
    username: str(u.username),
    first_name: str(u.given_name),
    last_name: str(u.family_name),
    name: str(u.given_name) || str(u.family_name) ? undefined : str(u.name) && str(u.name) !== email ? str(u.name) : undefined,
    image_url: str(u.picture),
    roles: ctx.roles,
    banned: u.blocked === true ? true : undefined,
    // app_metadata is server-controlled in Auth0 (often holds entitlements): it
    // lands in the backend-only bag. user_metadata is user-editable.
    private_metadata: bag(u.app_metadata),
    unsafe_metadata: bag(u.user_metadata),
    created_at: str(u.created_at),
    last_sign_in_at: str(u.last_login),
  });
  if (ctx.secret?.password) user.password = ctx.secret.password;
  else if (ctx.secret?.passwordReason) set.omit('password', ctx.secret.passwordReason);
  if (!user.emails?.length && !user.phones?.length && !user.username) {
    set.omit('user', 'no email, phone number or username');
    return false;
  }
  set.add('user', user);

  for (const i of objs(u.identities)) {
    const provider = str(i.provider);
    const sub = str(i.user_id);
    if (!provider || !sub || provider === 'auth0' || provider === 'sms' || provider === 'email') continue;
    const connection = str(i.connection);
    const enterprise = connection ? ctx.connectionIds.get(connection) : undefined;
    set.add(
      'identity',
      compact<IdentityRecord>({
        user_id: id,
        provider: enterprise ? connection! : provider,
        provider_user_id: sub,
        kind: enterprise ? (provider === 'samlp' || provider === 'adfs' ? 'saml' : 'oidc') : i.isSocial === true ? 'oauth' : 'enterprise',
        sso_connection_id: enterprise,
        profile: bag(i.profileData),
      }),
    );
  }
  for (const secret of ctx.secret?.totp ?? []) {
    set.add('mfa_factor', { user_id: id, type: 'totp', secret_base32: secret.replace(/=+$/, '').toUpperCase(), digits: 6, period: 30, algorithm: 'SHA1', verified: true });
  }
  for (const p of ctx.secret?.phones ?? []) {
    const n = e164(p);
    if (n) set.add('mfa_factor', { user_id: id, type: 'phone', phone: n, verified: true }, `phone:${id}:${n}`);
  }
  for (const _ of ctx.secret?.emails ?? []) set.add('mfa_factor', { user_id: id, type: 'email', verified: true }, `email:${id}`);
  return true;
}

async function addAuthenticationMethods(set: RecordSet, http: VendorHttp, userId: string, rpId: string): Promise<void> {
  let methods: Obj[];
  try {
    methods = await pageAll(http, `/users/${encodeURIComponent(userId)}/authentication-methods`, 'authenticators');
  } catch (err) {
    if (err instanceof VendorApiError && (err.status === 403 || err.status === 404)) return;
    throw err;
  }
  for (const m of methods) {
    const type = str(m.type);
    if (m.confirmed === false) continue;
    if (type === 'phone' || type === 'sms') {
      const phone = e164(m.phone_number);
      if (phone) set.add('mfa_factor', { user_id: userId, type: 'phone', phone, verified: true, created_at: str(m.created_at) }, `phone:${userId}:${phone}`);
    } else if (type === 'email') {
      set.add('mfa_factor', { user_id: userId, type: 'email', verified: true, created_at: str(m.created_at) }, `email:${userId}`);
    } else if ((type === 'passkey' || type === 'webauthn-platform' || type === 'webauthn-roaming') && str(m.key_id) && str(m.public_key)) {
      set.add(
        'passkey',
        compact({
          id: str(m.id),
          user_id: userId,
          credential_id: b64url(str(m.key_id)!),
          public_key: b64url(str(m.public_key)!),
          rp_id: str(m.relying_party_identifier) ?? rpId,
          aaguid: str(m.aaguid),
          name: str(m.name),
          backed_up: m.credential_backed_up === true ? true : undefined,
          created_at: str(m.created_at),
        }),
      );
    } else if (type === 'totp' || type === 'guardian' || type === 'push' || type === 'recovery-code' || type === 'webauthn-roaming' || type === 'webauthn-platform') {
      set.omit('mfa_factor', `Auth0 does not return ${type} secrets by API (support export, or re-enrolment)`);
    }
  }
}

const b64url = (v: string) => v.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Auth0 role names are free text: `Billing Admin` → `billing_admin`. */
export function roleKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role';
}

/**
 * An Auth0 bulk-import `custom_password_hash` (users imported into Auth0 that
 * never signed in since keep it) → the Atlas registry's algorithm + params.
 */
export function auth0CustomHash(c: Obj): PasswordHash | { reason: string } {
  const algorithm = str(c.algorithm)?.toLowerCase();
  const hash = isObj(c.hash) ? c.hash : {};
  const value = str(hash.value);
  if (!algorithm || !value) return { reason: 'custom_password_hash without algorithm or hash value' };
  const salt = isObj(c.salt) ? c.salt : undefined;
  const pwEnc = isObj(c.password) ? str(c.password.encoding) : undefined;
  if (pwEnc && !['utf8', 'utf-8', 'ascii'].includes(pwEnc)) {
    return { reason: `custom_password_hash password.encoding "${pwEnc}" is not supported` };
  }
  const encoding = str(hash.encoding) ?? (algorithm === 'scrypt' ? 'hex' : 'hex');
  const saltParams: Record<string, string> = salt
    ? { salt_position: str(salt.position) ?? 'prefix', salt_encoding: str(salt.encoding) ?? 'utf8' }
    : {};
  switch (algorithm) {
    case 'bcrypt':
      return { algorithm: 'bcrypt', hash: value };
    case 'argon2':
      return { algorithm: 'argon2', hash: value };
    case 'pbkdf2':
      // A PHC string `$pbkdf2-<digest>$i=<iterations>,l=<keylen>$<salt>$<hash>`.
      return { algorithm: 'auto', hash: value };
    case 'ldap':
      // RFC 2307: Atlas verifies the SHA family ({SHA}, {SSHA}, {SSHA256}, {SSHA512}).
      return /^\{S?SHA(256|512)?\}/i.test(value) ? { algorithm: 'ldap_ssha', hash: value } : { reason: 'custom_password_hash ldap scheme other than {SHA}/{SSHA} is not supported' };
    case 'md5':
    case 'sha1':
    case 'sha256':
    case 'sha512': {
      const s = salt ? str(salt.value) : undefined;
      if (!s) return { algorithm, hash: value, params: { encoding } };
      return { algorithm: `${algorithm}_salted`, hash: value, salt: s, params: { encoding, ...saltParams } };
    }
    case 'hmac': {
      const digest = str(hash.digest)?.toLowerCase();
      const key = isObj(hash.key) ? str(hash.key.value) : undefined;
      if (digest !== 'sha256' || !key) return { reason: `custom_password_hash hmac with digest "${digest ?? '?'}" is not supported (sha256 only)` };
      if (salt) return { reason: 'custom_password_hash hmac with a salt is not supported' };
      return { algorithm: 'hmac_sha256', hash: value, params: { key, key_encoding: (isObj(hash.key) ? str(hash.key.encoding) : undefined) ?? 'utf8', encoding } };
    }
    case 'scrypt': {
      const s = salt ? str(salt.value) : undefined;
      const keylen = typeof c.keylen === 'number' ? c.keylen : undefined;
      if (!s || !keylen) return { reason: 'custom_password_hash scrypt needs salt and keylen' };
      return {
        algorithm: 'scrypt',
        hash: value,
        salt: s,
        params: {
          n: typeof c.cost === 'number' ? c.cost : 16384,
          r: typeof c.blockSize === 'number' ? c.blockSize : 8,
          p: typeof c.parallelization === 'number' ? c.parallelization : 1,
          key_length: keylen,
          encoding,
          salt_encoding: str(salt?.encoding) ?? 'utf8',
        },
      };
    }
    default:
      return { reason: `custom_password_hash algorithm "${algorithm}" is not supported` };
  }
}

// ── enterprise connections ──────────────────────────────────────────────────

function addConnection(set: RecordSet, c: Obj, domain: string): string | undefined {
  const id = str(c.id);
  const name = str(c.name);
  const strategy = str(c.strategy);
  if (!id || !name || !strategy) return undefined;
  const o = isObj(c.options) ? c.options : {};
  const domains = Array.isArray(o.domain_aliases) ? o.domain_aliases.map((d) => str(d)).filter((d): d is string => !!d) : [];
  if (strategy === 'samlp' || strategy === 'adfs' || strategy === 'pingfederate') {
    const cert = str(o.signingCert) ?? str(o.cert);
    set.add(
      'sso_connection',
      compact({
        id,
        name: str(c.display_name) ?? name,
        protocol: 'saml' as const,
        domains,
        saml: compact({
          idp_entity_id: str(o.entityId) ?? str(o.issuer),
          idp_sso_url: str(o.signInEndpoint) ?? str(o.pingFederateBaseUrl),
          idp_certificate: cert ? pemFromAuth0Cert(cert) : undefined,
          idp_metadata_url: str(o.metadataUrl) ?? str(o.adfs_server),
          idp_metadata_xml: str(o.metadataXml),
          sp_entity_id: `urn:auth0:${domain.split('.')[0]}:${name}`,
          sp_acs_url: `https://${domain}/login/callback?connection=${encodeURIComponent(name)}`,
          attribute_mapping: isObj(o.fieldsMap)
            ? (Object.fromEntries(Object.entries(o.fieldsMap).filter(([, v]) => typeof v === 'string')) as Record<string, string>)
            : undefined,
        }),
      }),
    );
    return id;
  }
  if (strategy === 'oidc' || strategy === 'okta' || strategy === 'waad' || strategy === 'google-apps') {
    const issuer =
      strategy === 'waad'
        ? str(o.tenant_domain)
          ? `https://login.microsoftonline.com/${str(o.tenant_id) ?? str(o.tenant_domain)}/v2.0`
          : undefined
        : strategy === 'google-apps'
          ? 'https://accounts.google.com'
          : str(o.issuer) ?? (str(o.domain) ? `https://${str(o.domain)}` : undefined);
    set.add(
      'sso_connection',
      compact({
        id,
        name: str(c.display_name) ?? name,
        protocol: 'oidc' as const,
        domains: strategy === 'google-apps' && str(o.domain) ? [...domains, str(o.domain)!] : domains,
        oidc: compact({
          issuer,
          discovery_url: str(o.discovery_url),
          client_id: str(o.client_id),
          client_secret: str(o.client_secret),
          scopes: str(o.scope)?.split(/\s+/),
        }),
      }),
    );
    if (!str(o.client_secret)) set.warn(`Enterprise connection ${name}: Auth0 does not return its client secret; enter it in Atlas after the import.`);
    return id;
  }
  set.warn(`Enterprise connection ${name} (${strategy}) has no Atlas counterpart and was not exported (LDAP/AD connector: use lazy migration).`);
  return undefined;
}

/** Auth0 returns the IdP signing certificate as base64 DER or PEM. */
function pemFromAuth0Cert(cert: string): string {
  if (cert.includes('BEGIN CERTIFICATE')) return cert;
  const body = cert.replace(/\s+/g, '');
  let der = body;
  // Some tenants store the PEM itself base64-encoded.
  try {
    const decoded = Buffer.from(body, 'base64').toString('utf8');
    if (decoded.includes('BEGIN CERTIFICATE')) return decoded;
  } catch {
    der = body;
  }
  return `-----BEGIN CERTIFICATE-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
}
