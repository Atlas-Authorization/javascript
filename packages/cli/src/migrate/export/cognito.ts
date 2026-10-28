import { createHash, createHmac } from 'node:crypto';
import type { IdentityRecord, MfaFactorRecord, SsoConnectionRecord, UserRecord } from '@atlasauth/migrate';
import { RecordSet, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorApiError } from './vendor-http';

/**
 * `atlas migrate export cognito` — an Amazon Cognito user pool onto the
 * canonical bundle models, read on this machine with the owner's AWS
 * credentials (SigV4-signed calls to the cognito-idp JSON API; the keys are
 * sent to AWS only, as a signature).
 *
 *   - users (ListUsers), keyed by `sub` — the subject Cognito tokens carry,
 *     so the bridge and lazy migration land on the same Atlas user; standard
 *     attributes map onto the user, `custom:*` attributes become public
 *     metadata, the Cognito username and status are kept privately;
 *   - federated and linked accounts from the `identities` attribute;
 *   - groups as app roles (ListGroups + ListUsersInGroup);
 *   - SAML / OIDC identity providers as enterprise connections;
 *   - SMS / email second factors (legacy MFAOptions, or every user's
 *     UserMFASettingList with `mfa`, which costs one AdminGetUser per user);
 *   - the pool's public signing keys, so old ID tokens keep verifying during
 *     the cutover.
 *
 * Cognito NEVER exports password hashes, TOTP secrets or passkeys. Passwords
 * move with the `cognito` lazy-migration preset (InitiateAuth with
 * USER_PASSWORD_AUTH on the user's first Atlas sign-in).
 *
 * Instead of the API, users can come from `aws cognito-idp list-users`
 * output (the CLI follows the pagination): no groups or connections then.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface CognitoExportOptions {
  userPoolId: string;
  /** Default: the region prefix of the pool id. */
  region?: string;
  credentials?: AwsCredentials;
  /** `aws cognito-idp list-users --output json` output, instead of calling ListUsers. */
  usersText?: string;
  /** Read every user's MFA settings (AdminGetUser per user — billed and rate limited). */
  mfa?: boolean;
  /** How groups move (default roles). */
  groups?: 'roles' | 'skip';
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  onProgress?: (message: string) => void;
}

const POOL_ID = /^([a-z]{2}(?:-[a-z]+)+-\d)_[0-9A-Za-z]+$/;

/** The region of a user pool id (`us-east-1_AbC123` → `us-east-1`), or undefined. */
export function regionOfPool(poolId: string): string | undefined {
  return POOL_ID.exec(poolId.trim())?.[1];
}

// ── AWS Signature Version 4 ─────────────────────────────────────────────────

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

/** `20150830T123600Z`. */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** The SigV4 signing key: HMAC chain over date, region, service. */
export function sigV4Key(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/**
 * Sign a request with AWS Signature Version 4 (header form). `headers` must
 * not yet carry `authorization`; the result adds `host`, `x-amz-date`, the
 * session token when there is one, and `authorization`. Only a path without
 * a query string is signed (every Cognito call is `POST /`).
 */
export function signAwsRequest(o: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
}): Record<string, string> {
  const url = new URL(o.url);
  const stamp = amzDate(o.now);
  const date = stamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers)) headers[k.toLowerCase()] = v;
  headers.host = url.host;
  headers['x-amz-date'] = stamp;
  if (o.credentials.sessionToken) headers['x-amz-security-token'] = o.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [o.method.toUpperCase(), url.pathname || '/', url.search.slice(1), canonicalHeaders, signedHeaders, sha256Hex(o.body)].join('\n');
  const scope = `${date}/${o.region}/${o.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonical)].join('\n');
  const signature = createHmac('sha256', sigV4Key(o.credentials.secretAccessKey, date, o.region, o.service)).update(toSign, 'utf8').digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${o.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

// ── the cognito-idp JSON API ────────────────────────────────────────────────

const RETRYABLE = new Set(['TooManyRequestsException', 'LimitExceededException', 'InternalErrorException', 'ThrottlingException']);

export class CognitoApi {
  readonly endpoint: string;

  constructor(
    private readonly o: { region: string; credentials: AwsCredentials; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date; attempts?: number },
  ) {
    this.endpoint = `https://cognito-idp.${o.region}.amazonaws.com/`;
  }

  /** One API call (`ListUsers`, `DescribeUserPool` …). Throttling and 5xx are retried. */
  async call<T = Obj>(action: string, input: Obj): Promise<T> {
    const fetchImpl = this.o.fetchImpl ?? fetch;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const attempts = Math.max(1, this.o.attempts ?? 6);
    const body = JSON.stringify(input);
    for (let attempt = 1; ; attempt++) {
      const headers = signAwsRequest({
        method: 'POST',
        url: this.endpoint,
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${action}` },
        body,
        region: this.o.region,
        service: 'cognito-idp',
        credentials: this.o.credentials,
        now: (this.o.now ?? (() => new Date()))(),
      });
      delete headers.host; // fetch sets it (and refuses a manual one)
      let res: Response;
      try {
        res = await fetchImpl(this.endpoint, { method: 'POST', headers, body });
      } catch (err) {
        if (attempt < attempts) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new VendorApiError('Cognito', 0, action, err instanceof Error ? err.message : String(err));
      }
      const text = await res.text();
      let parsed: unknown = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { message: text.slice(0, 200) };
      }
      if (res.ok) return parsed as T;
      const o = isObj(parsed) ? parsed : {};
      const type = (str(o.__type) ?? '').split('#').pop() ?? '';
      if ((res.status >= 500 || RETRYABLE.has(type)) && attempt < attempts) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new VendorApiError('Cognito', res.status, action, [type, str(o.message) ?? str(o.Message)].filter(Boolean).join(': '));
    }
  }

  /** Every page of a token-paged list. */
  async all(action: string, input: Obj, listKey: string, tokenKey: 'PaginationToken' | 'NextToken'): Promise<Obj[]> {
    const out: Obj[] = [];
    let token: string | undefined;
    do {
      const page = await this.call<Obj>(action, { ...input, ...(token ? { [tokenKey]: token } : {}) });
      out.push(...objs(page[listKey]));
      token = str(page[tokenKey]);
    } while (token);
    return out;
  }
}

function backoff(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 20_000);
}

// ── mapping ─────────────────────────────────────────────────────────────────

/** Attributes the user record carries itself (the rest of the standard ones go to private metadata). */
const MAPPED = new Set(['sub', 'email', 'email_verified', 'phone_number', 'phone_number_verified', 'given_name', 'family_name', 'name', 'picture', 'preferred_username', 'identities']);

/** Cognito provider names → the provider an identity record carries. */
const SOCIAL: Record<string, string> = { Google: 'google', Facebook: 'facebook', SignInWithApple: 'apple', LoginWithAmazon: 'amazon' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function attributesOf(u: Obj): Record<string, string> {
  const out: Record<string, string> = {};
  // ListUsers says Attributes, AdminGetUser says UserAttributes.
  for (const a of [...objs(u.Attributes), ...objs(u.UserAttributes)]) {
    const name = str(a.Name);
    if (name && typeof a.Value === 'string') out[name] = a.Value;
  }
  return out;
}

/** Epoch seconds (the API) or an ISO string (the AWS CLI) → a bundle timestamp. */
function cognitoTime(v: unknown): string | number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 1000);
  return str(v);
}

/** The `identities` attribute (a JSON string; `primary` / `dateCreated` typed loosely). */
export function parseIdentities(raw: string | undefined): Obj[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return objs(parsed);
  } catch {
    return [];
  }
}

/** Map one Cognito UserType onto a user record (null when it has no sub or no identifier). */
export function mapCognitoUser(u: Obj): UserRecord | null {
  const a = attributesOf(u);
  const sub = str(a.sub);
  if (!sub) return null;
  const cognitoUsername = str(u.Username);
  const federated = str(u.UserStatus) === 'EXTERNAL_PROVIDER';
  const email = str(a.email)?.toLowerCase();
  const phone = e164(a.phone_number);
  // A username Cognito users typed (not the generated sub / UUID, an email or a federated `Google_…` id).
  const typed = cognitoUsername && !UUID.test(cognitoUsername) && !cognitoUsername.includes('@') && !federated && !/^\+\d+$/.test(cognitoUsername) ? cognitoUsername : undefined;
  const username = str(a.preferred_username) ?? typed;
  const custom: Obj = {};
  const standard: Obj = {};
  for (const [k, v] of Object.entries(a)) {
    if (k.startsWith('custom:')) custom[k.slice(7)] = v;
    else if (k.startsWith('dev:')) continue;
    else if (!MAPPED.has(k)) standard[k] = v;
  }
  const user: UserRecord = compact({
    id: sub,
    emails: email ? [{ email, verified: a.email_verified === 'true', primary: true }] : undefined,
    phones: phone ? [{ phone, verified: a.phone_number_verified === 'true', primary: !email }] : undefined,
    username,
    first_name: str(a.given_name),
    last_name: str(a.family_name),
    name: str(a.name),
    image_url: str(a.picture),
    banned: u.Enabled === false ? true : undefined,
    public_metadata: Object.keys(custom).length ? custom : undefined,
    private_metadata: compact({ cognito_username: cognitoUsername, cognito_status: str(u.UserStatus), cognito_attributes: Object.keys(standard).length ? standard : undefined }) as Obj,
    created_at: cognitoTime(u.UserCreateDate),
  });
  if (!user.emails && !user.phones && !user.username) {
    // A pool keyed on a bare username nobody typed (federated users without an email): keep the Cognito username.
    if (!cognitoUsername) return null;
    user.username = cognitoUsername;
  }
  return user;
}

/** The identity records of one user's `identities` attribute. */
export function cognitoIdentities(userId: string, raw: string | undefined): IdentityRecord[] {
  const out: IdentityRecord[] = [];
  for (const i of parseIdentities(raw)) {
    const providerName = str(i.providerName);
    const providerUserId = str(i.userId);
    if (!providerName || !providerUserId) continue;
    const type = str(i.providerType) ?? providerName;
    const kind = type === 'SAML' ? 'saml' : type === 'OIDC' ? 'oidc' : 'oauth';
    out.push(
      compact({
        user_id: userId,
        provider: SOCIAL[providerName] ?? providerName,
        provider_user_id: providerUserId,
        kind: kind as IdentityRecord['kind'],
        sso_connection_id: kind === 'saml' || kind === 'oidc' ? providerName : undefined,
      }),
    );
  }
  return out;
}

/** SMS / email factors from legacy MFAOptions or a UserMFASettingList. */
export function cognitoFactors(userId: string, u: Obj, attrs: Record<string, string>): { factors: MfaFactorRecord[]; totp: boolean } {
  const settings = new Set(strs(u.UserMFASettingList));
  for (const o of objs(u.MFAOptions)) if (str(o.DeliveryMedium) === 'SMS') settings.add('SMS_MFA');
  const factors: MfaFactorRecord[] = [];
  const phone = e164(attrs.phone_number);
  if (settings.has('SMS_MFA') && phone) factors.push({ user_id: userId, type: 'phone', phone, verified: true });
  if (settings.has('EMAIL_OTP') && attrs.email) factors.push({ user_id: userId, type: 'email', verified: true });
  return { factors, totp: settings.has('SOFTWARE_TOKEN_MFA') };
}

/** The users of `aws cognito-idp list-users` output (`{ "Users": [...] }`, or a bare array). */
export function parseListUsersOutput(text: string): Obj[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The users file is not `aws cognito-idp list-users --output json` output.');
  }
  if (Array.isArray(parsed)) return objs(parsed);
  if (isObj(parsed) && Array.isArray(parsed.Users)) return objs(parsed.Users);
  throw new Error('The users file has no "Users" list (expected `aws cognito-idp list-users --output json` output).');
}

/** A SAML / OIDC identity provider → an SSO connection record (social providers are null). */
export function cognitoSsoConnection(idp: Obj): SsoConnectionRecord | null {
  const name = str(idp.ProviderName);
  const type = str(idp.ProviderType);
  if (!name || (type !== 'SAML' && type !== 'OIDC')) return null;
  const d = isObj(idp.ProviderDetails) ? idp.ProviderDetails : {};
  const mapping: Record<string, string> = {};
  if (isObj(idp.AttributeMapping)) for (const [k, v] of Object.entries(idp.AttributeMapping)) if (typeof v === 'string') mapping[k] = v;
  const domains = strs(idp.IdpIdentifiers).filter((x) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(x));
  if (type === 'SAML') {
    return compact({
      id: name,
      name,
      protocol: 'saml' as const,
      domains,
      saml: compact({ idp_metadata_url: str(d.MetadataURL), idp_metadata_xml: str(d.MetadataFile), attribute_mapping: Object.keys(mapping).length ? mapping : undefined }),
      enabled: true,
    });
  }
  const issuer = str(d.oidc_issuer);
  return compact({
    id: name,
    name,
    protocol: 'oidc' as const,
    domains,
    oidc: compact({
      issuer,
      discovery_url: issuer ? `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration` : undefined,
      client_id: str(d.client_id),
      client_secret: str(d.client_secret),
      scopes: str(d.authorize_scopes)?.split(/[\s,]+/).filter(Boolean),
    }),
    enabled: true,
  });
}

// ── the export ──────────────────────────────────────────────────────────────

export async function exportCognito(opts: CognitoExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const poolId = opts.userPoolId.trim();
  const region = opts.region ?? regionOfPool(poolId);
  if (!region) throw new Error(`Not a Cognito user pool id: ${opts.userPoolId} (expected <region>_<id>, e.g. us-east-1_AbC123xyz).`);
  if (!opts.usersText && !opts.credentials) throw new Error('Cognito export needs AWS credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) or a list-users output file.');
  const progress = opts.onProgress ?? (() => undefined);
  const api = opts.credentials ? new CognitoApi({ region, credentials: opts.credentials, fetchImpl: opts.fetchImpl, sleep: opts.sleep, now: opts.now }) : undefined;
  set.manifest.origin = `Cognito user pool ${poolId}`;

  // Groups → app roles.
  const groupKeys = new Map<string, string>();
  if (api && opts.groups !== 'skip') {
    progress('groups');
    for (const g of await api.all('ListGroups', { UserPoolId: poolId, Limit: 60 }, 'Groups', 'NextToken')) {
      const name = str(g.GroupName);
      if (!name) continue;
      const key = keyOf(name);
      groupKeys.set(name, key);
      set.add('role', compact({ key, name, description: str(g.Description), scope: 'app' as const }), key);
    }
  }

  // Identity providers → SSO connections.
  const providers = new Set<string>();
  if (api) {
    progress('identity providers');
    let idps: Obj[] = [];
    try {
      idps = await api.all('ListIdentityProviders', { UserPoolId: poolId, MaxResults: 60 }, 'Providers', 'NextToken');
    } catch (err) {
      if (!(err instanceof VendorApiError && (err.status === 400 || err.status === 403))) throw err;
      set.warn(`Could not list identity providers (${err.message}); enterprise connections were not exported.`);
    }
    for (const summary of idps) {
      const name = str(summary.ProviderName);
      if (!name) continue;
      providers.add(SOCIAL[name] ?? name);
      if (str(summary.ProviderType) !== 'SAML' && str(summary.ProviderType) !== 'OIDC') continue;
      const res = await api.call<Obj>('DescribeIdentityProvider', { UserPoolId: poolId, ProviderName: name });
      const conn = cognitoSsoConnection(isObj(res.IdentityProvider) ? res.IdentityProvider : {});
      if (conn) set.add('sso_connection', conn, conn.id);
    }
  }

  // Users.
  progress('users');
  const raw = opts.usersText !== undefined ? parseListUsersOutput(opts.usersText) : await api!.all('ListUsers', { UserPoolId: poolId, Limit: 60 }, 'Users', 'PaginationToken');
  const byUsername = new Map<string, string>();
  const status: Record<string, number> = {};
  let totpUsers = 0;
  for (const u of raw) {
    const user = mapCognitoUser(u);
    if (!user) {
      set.omit('user', 'no sub, or no email, phone number or username');
      continue;
    }
    const username = str(u.Username);
    if (username) byUsername.set(username, user.id);
    const st = str(u.UserStatus) ?? 'UNKNOWN';
    status[st] = (status[st] ?? 0) + 1;
    set.add('user', user, user.id);
    const attrs = attributesOf(u);
    for (const identity of cognitoIdentities(user.id, attrs.identities)) {
      set.add('identity', identity, `${identity.provider}:${identity.provider_user_id}`);
      providers.add(identity.provider);
    }
    let detail = u;
    if (opts.mfa && api && username && st !== 'EXTERNAL_PROVIDER') {
      detail = { ...u, ...(await api.call<Obj>('AdminGetUser', { UserPoolId: poolId, Username: username })) };
    }
    const { factors, totp } = cognitoFactors(user.id, detail, attrs);
    for (const f of factors) set.add('mfa_factor', f);
    if (totp) totpUsers++;
  }
  if (totpUsers) set.omit('mfa_factor', 'Cognito never exports TOTP secrets: these users enrol an authenticator app again in Atlas', totpUsers);
  if (!opts.mfa && api && raw.length) {
    set.warn('Only legacy SMS MFA settings were read. Pass the mfa option (one AdminGetUser per user, billed by AWS) to export every user\'s SMS and email factors and count TOTP users.');
  }

  // Group members → user roles.
  if (api && groupKeys.size) {
    progress('group members');
    const rolesOf = new Map<string, string[]>();
    for (const [name, key] of groupKeys) {
      for (const m of await api.all('ListUsersInGroup', { UserPoolId: poolId, GroupName: name, Limit: 60 }, 'Users', 'NextToken')) {
        const id = str(attributesOf(m).sub) ?? byUsername.get(str(m.Username) ?? '');
        if (!id) continue;
        const list = rolesOf.get(id) ?? [];
        list.push(key);
        rolesOf.set(id, list);
      }
    }
    for (const user of set.list('user')) {
      const roles = rolesOf.get(user.id);
      if (roles?.length) user.roles = [...new Set(roles)];
    }
  }

  // The pool's public signing keys (no credentials needed).
  try {
    const res = await (opts.fetchImpl ?? fetch)(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`);
    if (res.ok) {
      const body: unknown = await res.json();
      for (const jwk of objs(isObj(body) ? body.keys : undefined)) {
        const kid = str(jwk.kid);
        if (kid) set.add('jwks', { kid, jwk }, kid);
      }
    }
  } catch {
    set.warn('Could not read the user pool\'s JWKS; old tokens verify through the bridge only.');
  }

  if (set.count('user')) {
    set.warn('Cognito never exports password hashes. Turn on the cognito lazy-migration preset: each password is checked against Cognito (InitiateAuth, USER_PASSWORD_AUTH) on its first Atlas sign-in, then stored as Argon2id.');
    set.omit('password', 'Cognito does not export password hashes (lazy migration moves them)', set.count('user') - (status.EXTERNAL_PROVIDER ?? 0));
  }
  if (status.FORCE_CHANGE_PASSWORD) set.warn(`${status.FORCE_CHANGE_PASSWORD} user(s) still have an admin-set temporary password (FORCE_CHANGE_PASSWORD): Cognito answers lazy migration with a new-password challenge, so they reset their password in Atlas.`);
  if (status.RESET_REQUIRED) set.warn(`${status.RESET_REQUIRED} user(s) must reset their password (RESET_REQUIRED): they cannot move by lazy migration and reset it in Atlas.`);
  if (status.UNCONFIRMED) set.warn(`${status.UNCONFIRMED} user(s) never confirmed their sign-up (UNCONFIRMED): imported with unverified addresses.`);
  set.manifest.providers = [...providers].sort();
  set.manifest.settings = { user_pool_id: poolId, region, user_status: status };
  return set;
}
