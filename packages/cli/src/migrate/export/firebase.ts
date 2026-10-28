import { createSign } from 'node:crypto';
import type { IdentityRecord, MfaFactorRecord, PasswordHash, SsoConnectionRecord, UserRecord } from '@atlasauth/migrate';
import { parseCsv } from '../../import/csv';
import { RecordSet, bag, compact, e164, isObj, objs, str, type Obj } from './record-set';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export firebase` — Firebase Authentication and Google Cloud
 * Identity Platform (including multi-tenant projects) onto the canonical
 * bundle models.
 *
 * Two inputs, both on the owner's machine:
 *   - the Identity Toolkit Admin REST API (`accounts:batchGet`, the same call
 *     the Admin SDK's `listUsers` makes) with a service-account key file or
 *     an OAuth access token. The key signs a JWT assertion locally; it is
 *     exchanged for an access token at Google and never goes anywhere else.
 *     This is the complete export: every provider link (OIDC and SAML too),
 *     the second factors and the tenants.
 *   - a `firebase auth:export` file (JSON or CSV). It is smaller: the CLI keeps
 *     ten social providers only, drops OIDC / SAML / phone links, cannot
 *     export a tenant, and its CSV has no second factors.
 *
 * Password hashes are Firebase's modified scrypt; they verify in Atlas with
 * the project's hash parameters (signer key, salt separator, rounds, memory
 * cost), read from the project config with the same credentials or passed as
 * flags (Console → Authentication → Users → ⋮ → Password hash parameters).
 * Every tenant has its own parameters.
 *
 * Firebase never exports TOTP secrets (the enrollment has no fields): those
 * users enrol again. SMS second factors move by phone number. Sessions are
 * not exported: the `firebase` bridge preset exchanges a Firebase ID token.
 */

export interface FirebaseHashParams {
  signer_key: string;
  salt_separator: string;
  rounds: number;
  mem_cost: number;
}

export interface FirebaseServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
  token_uri?: string;
}

export interface FirebaseExportOptions {
  /** The Firebase / Google Cloud project id. */
  projectId: string;
  /** A service-account key file's JSON (Firebase Authentication Admin or Identity Platform Viewer + hash access). */
  serviceAccountJson?: string;
  /** An OAuth 2.0 access token instead (`gcloud auth print-access-token`). */
  accessToken?: string;
  /** A `firebase auth:export` file (JSON or CSV), instead of the API. */
  usersText?: string;
  usersFileName?: string;
  /** Project-level users (default), one tenant id, or `all` (every tenant, each as an organization). */
  tenant?: string;
  /** Hash parameters from flags; win over what the API reports. */
  hashParams?: Partial<FirebaseHashParams>;
  /** Export anonymous users too (default: left out). */
  includeAnonymous?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (message: string) => void;
}

const API = 'https://identitytoolkit.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/identitytoolkit';
/** `base64("REDACTED")`: what the API returns for a hash the caller may not read. */
const REDACTED = 'UkVEQUNURUQ=';
const PAGE = 1000;

/** Firebase provider ids → the provider name identity records carry (Atlas's key where one exists). */
const SOCIAL: Record<string, string> = {
  'google.com': 'google',
  'facebook.com': 'facebook',
  'twitter.com': 'x',
  'github.com': 'github',
  'apple.com': 'apple',
  'microsoft.com': 'microsoft',
  'linkedin.com': 'linkedin',
  'yahoo.com': 'yahoo',
};

/** Providers that are sign-in methods, not linked accounts. */
const NOT_IDENTITIES = new Set(['password', 'phone', 'emailLink', 'anonymous', 'custom']);

/** Firebase's `-_` alphabet → standard base64 (the CLI does the same; the Admin SDK does not). */
export const stdBase64 = (v: string): string => v.trim().replace(/-/g, '+').replace(/_/g, '/');

const ms = (v: unknown): number | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
};

// ── access ─────────────────────────────────────────────────────────────────

export function parseServiceAccount(text: string): FirebaseServiceAccount {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('The service-account key file is not JSON.');
  }
  if (!isObj(doc) || doc.type !== 'service_account' || !str(doc.client_email) || !str(doc.private_key)) {
    throw new Error('That is not a service-account key file (it needs type "service_account", client_email and private_key).');
  }
  return {
    client_email: str(doc.client_email)!,
    private_key: String(doc.private_key),
    private_key_id: str(doc.private_key_id),
    project_id: str(doc.project_id),
    token_uri: str(doc.token_uri),
  };
}

/** The RS256 JWT assertion of the OAuth 2.0 JWT-bearer grant, signed locally with the service account's key. */
export function serviceAccountAssertion(sa: FirebaseServiceAccount, nowSeconds: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = { alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) };
  const claims = { iss: sa.client_email, sub: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 };
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = createSign('RSA-SHA256').update(input).sign(sa.private_key).toString('base64url');
  return `${input}.${sig}`;
}

/** Exchange the assertion for an access token — at Google, the only place the key's signature goes. */
export async function serviceAccountToken(sa: FirebaseServiceAccount, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<string> {
  const url = sa.token_uri ?? TOKEN_URL;
  if (!/^https:\/\/[a-z0-9.-]+\.googleapis\.com\//.test(url)) throw new Error(`Refusing the service account's token_uri ${url}: not a googleapis.com address.`);
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(sa, Math.floor(now() / 1000)) }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Obj;
  if (!res.ok || !str(body.access_token)) {
    throw new VendorApiError('Google OAuth', res.status, '/token', str(body.error_description) ?? str(body.error) ?? '');
  }
  return str(body.access_token)!;
}

export function firebaseHttp(o: { accessToken?: string; serviceAccount?: FirebaseServiceAccount; projectId: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number }): VendorHttp {
  if (!o.accessToken && !o.serviceAccount) throw new Error('Firebase: pass a service-account key file or an access token.');
  let bearer = o.accessToken;
  return new VendorHttp({
    vendor: 'Firebase',
    baseUrl: API,
    headers: async () => ({
      authorization: `Bearer ${(bearer ??= await serviceAccountToken(o.serviceAccount!, o.fetchImpl, o.now))}`,
      // Bills quota to the project being exported (needed with user credentials from gcloud).
      'x-goog-user-project': o.projectId,
    }),
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
}

/** The scope of a call: the project, or one tenant of it. */
const scopePath = (projectId: string, tenant?: string) => `projects/${encodeURIComponent(projectId)}${tenant ? `/tenants/${encodeURIComponent(tenant)}` : ''}`;

/** A project's (or tenant's) password hash parameters, from the admin v2 config. Null when the caller cannot read them. */
export async function fetchHashConfig(http: VendorHttp, projectId: string, tenant?: string): Promise<{ params: Partial<FirebaseHashParams>; algorithm?: string } | null> {
  try {
    const { body } = await http.get<Obj>(tenant ? `/v2/${scopePath(projectId, tenant)}` : `/v2/${scopePath(projectId)}/config`);
    // The project config nests it under signIn; a Tenant carries it at the top level.
    const hc = isObj(body.hashConfig) ? body.hashConfig : isObj(body.signIn) && isObj(body.signIn.hashConfig) ? body.signIn.hashConfig : null;
    if (!hc) return null;
    return { params: hashParamsOf(hc), algorithm: str(hc.algorithm) };
  } catch (err) {
    if (err instanceof VendorApiError && [403, 404].includes(err.status)) return null;
    throw err;
  }
}

/** `signIn.hashConfig` (or the console's names) → the registry's scrypt_firebase params. */
export function hashParamsOf(hc: Obj): Partial<FirebaseHashParams> {
  const n = (v: unknown) => (typeof v === 'number' ? v : str(v) ? Number(str(v)) : undefined);
  return compact({
    signer_key: str(hc.signerKey ?? hc.signer_key ?? hc.base64_signer_key) && stdBase64(str(hc.signerKey ?? hc.signer_key ?? hc.base64_signer_key)!),
    salt_separator: str(hc.saltSeparator ?? hc.salt_separator ?? hc.base64_salt_separator) !== undefined ? stdBase64(str(hc.saltSeparator ?? hc.salt_separator ?? hc.base64_salt_separator)!) : undefined,
    rounds: n(hc.rounds),
    mem_cost: n(hc.memoryCost ?? hc.memCost ?? hc.mem_cost),
  }) as Partial<FirebaseHashParams>;
}

function completeParams(p: Partial<FirebaseHashParams>): FirebaseHashParams | null {
  if (!p.signer_key || !p.rounds || !p.mem_cost) return null;
  return { signer_key: p.signer_key, salt_separator: p.salt_separator ?? '', rounds: p.rounds, mem_cost: p.mem_cost };
}

async function pages(http: VendorHttp, path: string, key: string, size: number): Promise<Obj[]> {
  const out: Obj[] = [];
  let token: string | undefined;
  const sep = path.includes('?') ? '&' : '?';
  for (let guard = 0; guard < 100_000; guard++) {
    const q = `${sep}${key === 'users' ? 'maxResults' : 'pageSize'}=${size}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`;
    const { body } = await http.get<Obj>(`${path}${q}`);
    out.push(...objs(body?.[key]));
    token = str(body?.nextPageToken);
    if (!token) break;
  }
  return out;
}

// ── export ─────────────────────────────────────────────────────────────────

export async function exportFirebase(opts: FirebaseExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const progress = opts.onProgress ?? (() => undefined);
  const projectId = opts.projectId.trim();
  if (!/^[a-z0-9][a-z0-9-]{3,62}$/.test(projectId)) throw new Error(`Not a Firebase project id: ${opts.projectId}`);
  set.manifest.origin = `firebase project ${projectId}`;
  const flagParams = opts.hashParams ?? {};

  if (opts.usersText !== undefined) {
    if (opts.tenant) throw new Error('Firebase: an auth:export file holds project-level users only (the CLI cannot export a tenant); use the API for tenants.');
    progress('users file');
    const users = parseFirebaseExport(opts.usersText, opts.usersFileName);
    const params = completeParams(flagParams);
    if (!params) warnNoParams(set);
    addUsers(set, users, { params, includeAnonymous: opts.includeAnonymous === true });
    if (/\.csv$/i.test(opts.usersFileName ?? '') || !opts.usersText.trim().startsWith('{')) {
      set.warn('The auth:export CSV has no second factors and keeps ten social providers only: export through the API (a service account) to move SMS second factors and OIDC / SAML links.');
    } else {
      set.warn('auth:export keeps ten social providers only and drops OIDC, SAML and phone links: export through the API (a service account) for those.');
    }
    settle(set, params);
    return set;
  }

  const http = firebaseHttp({
    accessToken: opts.accessToken,
    serviceAccount: opts.serviceAccountJson ? parseServiceAccount(opts.serviceAccountJson) : undefined,
    projectId,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    now: opts.now,
  });

  const scopes: Array<{ tenant?: string; name?: string }> = [];
  if (opts.tenant === 'all') {
    progress('tenants');
    const tenants = await pages(http, `/v2/${scopePath(projectId)}/tenants`, 'tenants', 1000);
    for (const t of tenants) {
      const id = str(t.name)?.split('/').pop();
      if (id) scopes.push({ tenant: id, name: str(t.displayName) ?? id });
    }
    if (!scopes.length) set.warn('The project has no Identity Platform tenants; nothing was exported. Run without the tenant option for project-level users.');
    else set.add('role', { key: 'member', name: 'Member', scope: 'organization' });
  } else {
    scopes.push({ tenant: opts.tenant || undefined });
  }

  let anyParams: FirebaseHashParams | null = null;
  for (const scope of scopes) {
    const label = scope.tenant ? `tenant ${scope.tenant}` : 'project';
    progress(`${label} hash parameters`);
    const fetched = await fetchHashConfig(http, projectId, scope.tenant);
    if (fetched?.algorithm && fetched.algorithm !== 'SCRYPT') set.warn(`The ${label} reports hash algorithm ${fetched.algorithm}; Firebase stores its own passwords with SCRYPT, so the hashes are read as Firebase scrypt.`);
    const params = completeParams({ ...fetched?.params, ...flagParams });
    if (!params) warnNoParams(set, label);
    anyParams ??= params;

    progress(`${label} SAML and OIDC providers`);
    const connections = await enterpriseConnections(http, projectId, scope.tenant);
    for (const c of connections) set.add('sso_connection', c, c.id);

    if (opts.tenant === 'all' && scope.tenant) {
      set.add('organization', { id: scope.tenant, name: scope.name ?? scope.tenant, public_metadata: { firebase_tenant_id: scope.tenant } });
    }

    progress(`${label} users`);
    const users = await pages(http, `/v1/${scopePath(projectId, scope.tenant)}/accounts:batchGet`, 'users', PAGE);
    const added = addUsers(set, users, { params, includeAnonymous: opts.includeAnonymous === true, tenant: scope.tenant, connections: new Set(connections.map((c) => c.id)) });
    if (opts.tenant === 'all' && scope.tenant) {
      for (const uid of added) set.add('membership', { organization_id: scope.tenant, user_id: uid, role: 'member' }, `${scope.tenant}:${uid}`);
    }
  }
  if (opts.tenant === 'all' && scopes.length) {
    set.warn('Each Identity Platform tenant is a separate user pool: it becomes an organization here, and an email address used in two tenants is reported as a conflict at import. To keep tenants apart, export each one (tenant=<id>) into its own Atlas instance instead.');
  }
  settle(set, anyParams);
  return set;
}

function warnNoParams(set: RecordSet, label = 'project'): void {
  set.warn(
    `The ${label}'s password hash parameters were not available, so password hashes were left out. Pass them (--set firebase-signer-key=… firebase-salt-separator=… firebase-rounds=… firebase-mem-cost=…, from Console → Authentication → Users → ⋮ → Password hash parameters), or let the firebase lazy-migration preset check passwords on first sign-in.`,
  );
}

function settle(set: RecordSet, params: FirebaseHashParams | null): void {
  set.manifest.providers = [...new Set(set.list('identity').map((i) => i.provider))].sort();
  // Never the signer key: the manifest is shown in the dashboard. Each password carries its own parameters, sealed.
  if (params) set.manifest.settings = { password_hash: { algorithm: 'scrypt_firebase', rounds: params.rounds, mem_cost: params.mem_cost, salt_separator: params.salt_separator } };
}

/** SAML providers (and OIDC ones, for the record) the identities can point at. */
async function enterpriseConnections(http: VendorHttp, projectId: string, tenant?: string): Promise<SsoConnectionRecord[]> {
  const out: SsoConnectionRecord[] = [];
  const list = async (kind: string): Promise<Obj[]> => {
    try {
      return await pages(http, `/v2/${scopePath(projectId, tenant)}/${kind}`, kind, 100);
    } catch (err) {
      if (err instanceof VendorApiError && [400, 403, 404].includes(err.status)) return [];
      throw err;
    }
  };
  for (const c of await list('inboundSamlConfigs')) {
    const id = str(c.name)?.split('/').pop();
    if (!id) continue;
    const idp = isObj(c.idpConfig) ? c.idpConfig : {};
    const sp = isObj(c.spConfig) ? c.spConfig : {};
    const cert = objs(idp.idpCertificates).map((x) => str(x.x509Certificate)).find(Boolean);
    out.push(
      compact({
        id,
        name: str(c.displayName) ?? id,
        protocol: 'saml' as const,
        enabled: c.enabled === true,
        saml: compact({ idp_entity_id: str(idp.idpEntityId), idp_sso_url: str(idp.ssoUrl), idp_certificate: cert, sp_entity_id: str(sp.spEntityId), sp_acs_url: str(sp.callbackUri) }),
      }),
    );
  }
  return out;
}

/**
 * Add users (REST UserInfo or auth:export JSON — the same keys — or rows from
 * the CSV mapped onto them) with their identities and second factors. Returns
 * the uids added.
 */
function addUsers(
  set: RecordSet,
  users: Obj[],
  ctx: { params: FirebaseHashParams | null; includeAnonymous: boolean; tenant?: string; connections?: Set<string> },
): string[] {
  const added: string[] = [];
  let redacted = 0;
  let otherVersion = 0;
  for (const u of users) {
    const uid = str(u.localId ?? u.uid);
    if (!uid) {
      set.omit('user', 'no uid');
      continue;
    }
    const mapped = mapFirebaseUser(u, ctx);
    if (mapped.redacted) redacted++;
    if (mapped.otherVersion) otherVersion++;
    if (!mapped.user) {
      set.omit('user', mapped.anonymous ? 'anonymous user (left out unless firebase-anonymous=include)' : 'no email, phone number or linked account');
      continue;
    }
    set.add('user', mapped.user, uid);
    added.push(uid);
    for (const i of mapped.identities) {
      if (i.kind === 'saml' && i.sso_connection_id && ctx.connections && !ctx.connections.has(i.sso_connection_id)) delete i.sso_connection_id;
      set.add('identity', i, `${i.provider}:${i.provider_user_id}`);
    }
    for (const f of mapped.factors) set.add('mfa_factor', f);
    if (mapped.totp) set.omit('mfa_factor', 'TOTP enrollment: Firebase never exports the secret (the user enrols again)', mapped.totp);
  }
  if (redacted) set.warn(`${redacted} password hash(es) came back as REDACTED: the credentials lack permission to read hashes (firebaseauth.configs.getHashConfig / firebaseauth.users.get with an owner or Firebase Authentication Admin role). Those users move by lazy migration.`);
  if (otherVersion) set.warn(`${otherVersion} password hash(es) are not Firebase scrypt (users imported into Firebase with another algorithm who never signed in since); they were left out and move by lazy migration.`);
  return added;
}

export interface MappedFirebaseUser {
  user: UserRecord | null;
  identities: IdentityRecord[];
  factors: MfaFactorRecord[];
  totp: number;
  anonymous: boolean;
  redacted: boolean;
  otherVersion: boolean;
}

export function mapFirebaseUser(u: Obj, ctx: { params: FirebaseHashParams | null; includeAnonymous?: boolean; tenant?: string }): MappedFirebaseUser {
  const uid = str(u.localId ?? u.uid)!;
  const out: MappedFirebaseUser = { user: null, identities: [], factors: [], totp: 0, anonymous: false, redacted: false, otherVersion: false };
  const email = str(u.email)?.toLowerCase();
  const phone = e164(u.phoneNumber);
  const providers = objs(u.providerUserInfo ?? u.providerData);

  for (const p of providers) {
    const pid = str(p.providerId);
    if (!pid || NOT_IDENTITIES.has(pid)) continue;
    const subject = str(p.rawId ?? p.federatedId ?? p.uid);
    if (!subject) continue;
    const kind = pid.startsWith('saml.') ? 'saml' : pid.startsWith('oidc.') ? 'oidc' : 'oauth';
    out.identities.push(
      compact({
        user_id: uid,
        provider: SOCIAL[pid] ?? pid,
        provider_user_id: subject,
        kind,
        sso_connection_id: kind === 'saml' ? pid : undefined,
        email: str(p.email)?.toLowerCase(),
        profile: bag(compact({ display_name: str(p.displayName), photo_url: str(p.photoUrl ?? p.photoURL), screen_name: str(p.screenName), firebase_provider_id: pid })),
      }) as IdentityRecord,
    );
  }

  for (const m of objs(u.mfaInfo ?? (isObj(u.multiFactor) ? u.multiFactor.enrolledFactors : undefined))) {
    const created = ms(m.enrolledAt ?? m.enrollmentTime);
    const id = str(m.mfaEnrollmentId ?? m.uid);
    const factorPhone = e164(m.unobfuscatedPhoneInfo ?? m.phoneInfo ?? m.phoneNumber);
    if (factorPhone) out.factors.push(compact({ id, user_id: uid, type: 'phone' as const, phone: factorPhone, verified: true, created_at: created }));
    else if (isObj(m.emailInfo) && str(m.emailInfo.emailAddress)) out.factors.push(compact({ id, user_id: uid, type: 'email' as const, verified: true, created_at: created }));
    else if ('totpInfo' in m || m.factorId === 'totp') out.totp++;
  }

  if (!email && !phone && !out.identities.length) {
    out.anonymous = true;
    if (!ctx.includeAnonymous) return out;
  }

  let password: PasswordHash | undefined;
  const rawHash = str(u.passwordHash);
  const version = typeof u.version === 'number' ? u.version : undefined;
  if (rawHash === REDACTED) out.redacted = true;
  else if (rawHash && version !== undefined && version !== 0) out.otherVersion = true;
  else if (rawHash && ctx.params) {
    password = {
      algorithm: 'scrypt_firebase',
      hash: stdBase64(rawHash),
      salt: stdBase64(str(u.salt ?? u.passwordSalt) ?? ''),
      params: { ...ctx.params },
    };
  }

  const custom = parseClaims(u.customAttributes ?? u.customClaims);
  const name = str(u.displayName);
  out.user = compact({
    id: uid,
    emails: email ? [{ email, verified: truthy(u.emailVerified), primary: true }] : undefined,
    // Firebase verifies a phone number by SMS before it is set.
    phones: phone ? [{ phone, verified: true, primary: true }] : undefined,
    name,
    image_url: str(u.photoUrl ?? u.photoURL),
    password,
    banned: truthy(u.disabled) || undefined,
    anonymous: out.anonymous || undefined,
    public_metadata: bag(custom),
    private_metadata: bag(
      compact({
        firebase_tenant_id: ctx.tenant ?? str(u.tenantId),
        valid_since: str(u.validSince),
        password_updated_at: ms(u.passwordUpdatedAt),
        last_refresh_at: str(u.lastRefreshAt),
        email_link_signin: u.emailLinkSignin === true ? true : undefined,
        initial_email: str(u.initialEmail),
      }),
    ),
    created_at: ms(u.createdAt ?? (isObj(u.metadata) ? u.metadata.creationTime : undefined)),
    last_sign_in_at: ms(u.lastSignedInAt ?? u.lastLoginAt ?? (isObj(u.metadata) ? u.metadata.lastSignInTime : undefined)),
  }) as UserRecord;
  return out;
}

const truthy = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && ['true', '1'].includes(v.trim().toLowerCase()));

/** Custom claims: a JSON string in the export and REST, an object from the Admin SDK. */
function parseClaims(v: unknown): Obj | undefined {
  if (isObj(v)) return v;
  const s = str(v);
  if (!s) return undefined;
  try {
    const parsed = JSON.parse(s);
    return isObj(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ── auth:export files ──────────────────────────────────────────────────────

/** The positional providers of the auth:export CSV (columns 7-22, four per provider; created-at starts at column 23). */
const CSV_PROVIDERS = ['google.com', 'facebook.com', 'twitter.com', 'github.com'];

/** `firebase auth:export` JSON (`{"users": [...]}`) or its header-less 52-column CSV → UserInfo-shaped objects. */
export function parseFirebaseExport(text: string, fileName = ''): Obj[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const doc = JSON.parse(trimmed) as unknown;
    if (Array.isArray(doc)) return objs(doc);
    if (isObj(doc) && Array.isArray(doc.users)) return objs(doc.users);
    throw new Error('The Firebase export file is JSON but has no "users" array.');
  }
  if (fileName && !/\.csv$/i.test(fileName)) throw new Error('The Firebase export file must be the JSON or CSV auth:export writes.');
  // The CSV has no header row: give parseCsv one.
  const header = Array.from({ length: 53 }, (_, i) => `c${i}`).join(',');
  return parseCsv(`${header}\n${trimmed}\n`).map((r) => {
    const c = (i: number) => r[`c${i}`] ?? '';
    const providerUserInfo: Obj[] = [];
    CSV_PROVIDERS.forEach((providerId, k) => {
      const base = 7 + k * 4;
      if (c(base)) providerUserInfo.push({ providerId, rawId: c(base), email: c(base + 1), displayName: c(base + 2), photoUrl: c(base + 3) });
    });
    return {
      localId: c(0),
      email: c(1),
      emailVerified: c(2),
      passwordHash: c(3),
      salt: c(4),
      displayName: c(5),
      photoUrl: c(6),
      createdAt: c(23),
      lastSignedInAt: c(24),
      phoneNumber: c(25),
      disabled: c(26),
      customAttributes: c(27),
      providerUserInfo,
    };
  });
}
