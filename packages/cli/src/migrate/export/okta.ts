import type { IdentityRecord, UserRecord } from '@atlasauth/migrate';
import { RecordSet, bag, compact, e164, isObj, objs, str, type Obj } from './record-set';
import { VendorApiError, VendorHttp, nextLink } from './vendor-http';

/**
 * `atlas migrate export okta` — Okta Workforce Identity Cloud and Okta
 * Customer Identity Solution orgs onto the canonical bundle models.
 *
 * Read with an API token (`SSWS …`) or an OAuth access token with the
 * okta.users.read / okta.groups.read / okta.idps.read scopes, on this machine.
 *
 *   - users (every status but DEPROVISIONED) with their profile; custom
 *     profile attributes land in private metadata;
 *   - groups, as app roles (default) or as organizations;
 *   - identity providers: social IdPs become identities on their linked
 *     users, SAML 2.0 / OIDC IdPs become enterprise connections (with the
 *     signing certificate);
 *   - with --factors: SMS / voice / email second factors (no secret is
 *     needed for those). TOTP seeds, Okta Verify and WebAuthn credentials
 *     never leave Okta — those users re-enrol.
 *
 * Okta NEVER exports password hashes, by API or support. Passwords move with
 * the `okta` lazy-migration preset: Atlas checks a password against Okta
 * (Authn API or the password grant) on the user's first sign-in.
 */

export interface OktaExportOptions {
  /** `acme.okta.com` (or a custom domain serving the API). */
  domain: string;
  /** An Okta API token. */
  apiToken?: string;
  /** An OAuth 2.0 access token for the Okta management API, instead of an API token. */
  accessToken?: string;
  /** How groups move: as Atlas app roles (default) or as organizations. */
  groupsAs?: 'roles' | 'organizations' | 'skip';
  /** Read each user's factors (one call per user). */
  factors?: boolean;
  /** The authorization server whose signing keys go in the bundle (default `default`). */
  authorizationServerId?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/** Profile attributes the user record carries itself; the rest are custom. */
const BASE_PROFILE = new Set([
  'login',
  'email',
  'secondEmail',
  'firstName',
  'lastName',
  'displayName',
  'nickName',
  'mobilePhone',
  'primaryPhone',
  'profileUrl',
]);

/** Okta social IdP types → the provider name an identity record carries. */
const SOCIAL: Record<string, string> = {
  GOOGLE: 'google',
  FACEBOOK: 'facebook',
  MICROSOFT: 'microsoft',
  APPLE: 'apple',
  LINKEDIN: 'linkedin',
  GITHUB: 'github',
  GITLAB: 'gitlab',
  AMAZON: 'amazon',
  DISCORD: 'discord',
  PAYPAL: 'paypal',
  SALESFORCE: 'salesforce',
  SPOTIFY: 'spotify',
  XERO: 'xero',
  YAHOO: 'yahoo',
};

export async function exportOkta(opts: OktaExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const domain = opts.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error(`Not an Okta domain: ${opts.domain}`);
  if (!opts.apiToken && !opts.accessToken) throw new Error('Okta export needs an API token (OKTA_API_TOKEN) or an OAuth access token for the management API.');
  const progress = opts.onProgress ?? (() => undefined);
  const http = new VendorHttp({
    vendor: 'Okta',
    baseUrl: `https://${domain}/api/v1`,
    headers: { authorization: opts.apiToken ? `SSWS ${opts.apiToken}` : `Bearer ${opts.accessToken}` },
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  const groupsAs = opts.groupsAs ?? 'roles';

  progress('groups');
  const groups = groupsAs === 'skip' ? [] : (await linkAll(http, '/groups?limit=200')).filter((g) => str(g.type) !== 'BUILT_IN');
  const groupKey = new Map<string, string>();
  const keysUsed = new Set<string>();
  for (const g of groups) {
    const id = str(g.id);
    const name = str(isObj(g.profile) ? g.profile.name : undefined);
    if (!id || !name) continue;
    let key = slug(name);
    while (keysUsed.has(key)) key = `${key}_${id.slice(-4).toLowerCase()}`;
    keysUsed.add(key);
    groupKey.set(id, key);
    const description = str(isObj(g.profile) ? g.profile.description : undefined);
    if (groupsAs === 'organizations') {
      set.add('organization', compact({ id, name, slug: key.replace(/_/g, '-'), public_metadata: description ? { description } : undefined, created_at: str(g.created) }));
    } else {
      set.add('role', compact({ key, name, description, scope: 'app' as const }));
    }
  }
  if (groupsAs === 'organizations') {
    set.add('role', { key: 'member', name: 'Member', scope: 'organization' });
  }

  progress('users');
  const users = await linkAll(http, '/users?limit=200');
  const userIds = new Set<string>();
  for (const u of users) {
    const user = mapOktaUser(u);
    if (!user) {
      set.omit('user', 'no email, phone number or login');
      continue;
    }
    userIds.add(user.id);
    set.add('user', user);
  }
  if (userIds.size) {
    set.warn(
      'Okta never exports password hashes. Turn on the okta lazy-migration preset: each password is checked against Okta on its first sign-in in Atlas, then stored as Argon2id.',
    );
  }

  // Group memberships: roles on the user, or organization memberships.
  if (groups.length) {
    progress('group members');
    const rolesOf = new Map<string, string[]>();
    for (const g of groups) {
      const id = str(g.id);
      const key = id ? groupKey.get(id) : undefined;
      if (!id || !key) continue;
      for (const m of await linkAll(http, `/groups/${id}/users?limit=1000`)) {
        const uid = str(m.id);
        if (!uid || !userIds.has(uid)) continue;
        if (groupsAs === 'organizations') set.add('membership', { organization_id: id, user_id: uid, role: 'member' }, `${id}:${uid}`);
        else rolesOf.set(uid, [...(rolesOf.get(uid) ?? []), key]);
      }
    }
    for (const user of set.list('user')) {
      const roles = rolesOf.get(user.id);
      if (roles?.length) user.roles = roles;
    }
  }

  progress('identity providers');
  await addIdps(set, http, userIds, domain);

  if (opts.factors) {
    progress('factors');
    for (const id of userIds) await addFactors(set, http, id);
  } else {
    set.warn('Second factors were not read (pass --factors to carry SMS / voice / email factors). TOTP seeds and Okta Verify never leave Okta.');
  }

  progress('signing keys');
  const server = opts.authorizationServerId ?? 'default';
  try {
    const { body } = await http.get<{ keys?: unknown }>(`https://${domain}/oauth2/${server}/v1/keys`);
    for (const k of objs(body?.keys)) if (str(k.kid)) set.add('jwks', { kid: str(k.kid)!, jwk: k });
  } catch (err) {
    if (!(err instanceof VendorApiError)) throw err;
    set.warn(`The ${server} authorization server's keys could not be read; the bridge preset fetches them live.`);
  }

  set.manifest = {
    origin: domain,
    providers: [...new Set(set.list('identity').map((i) => i.provider))].sort(),
    settings: { groups_as: groupsAs, authorization_server: server },
  };
  return set;
}

/** One Okta user → a user record (null when it has nothing to sign in with). */
export function mapOktaUser(u: Obj): UserRecord | null {
  const id = str(u.id);
  const status = str(u.status);
  if (!id || status === 'DEPROVISIONED') return null;
  const p = isObj(u.profile) ? u.profile : {};
  const credentials = isObj(u.credentials) ? u.credentials : {};
  // Okta reports verified addresses under credentials.emails when it has them;
  // otherwise an ACTIVE user has proven the primary address during activation.
  const credEmails = objs(credentials.emails);
  const verifiedSet = new Set(credEmails.filter((e) => str(e.status) === 'VERIFIED').map((e) => str(e.value)?.toLowerCase()));
  const activated = status !== 'STAGED' && status !== 'PROVISIONED';
  const primary = str(p.email)?.toLowerCase();
  const second = str(p.secondEmail)?.toLowerCase();
  const emails = [
    ...(primary ? [{ email: primary, verified: credEmails.length ? verifiedSet.has(primary) : activated, primary: true }] : []),
    ...(second && second !== primary ? [{ email: second, verified: verifiedSet.has(second), primary: false }] : []),
  ];
  const phones = [...new Set([e164(p.mobilePhone), e164(p.primaryPhone)].filter((x): x is string => !!x))].map((phone, i) => ({
    phone,
    verified: false,
    primary: !emails.length && i === 0,
  }));
  const login = str(p.login);
  const custom = Object.fromEntries(Object.entries(p).filter(([k, v]) => !BASE_PROFILE.has(k) && v !== null && v !== undefined && v !== ''));
  const user: UserRecord = compact({
    id,
    emails,
    phones,
    // The Okta login is often the email; keep it as the username only when it is not.
    username: login && login.toLowerCase() !== primary ? login : undefined,
    first_name: str(p.firstName),
    last_name: str(p.lastName),
    name: !str(p.firstName) && !str(p.lastName) ? str(p.displayName) : undefined,
    banned: status === 'SUSPENDED' ? true : undefined,
    ban_reason: status === 'SUSPENDED' ? 'Suspended in Okta' : undefined,
    locked: status === 'LOCKED_OUT' ? true : undefined,
    private_metadata: bag({ ...custom, ...(status && status !== 'ACTIVE' ? { okta_status: status } : {}) }),
    created_at: str(u.created),
    last_sign_in_at: str(u.lastLogin),
  });
  return user.emails?.length || user.phones?.length || user.username ? user : null;
}

async function addIdps(set: RecordSet, http: VendorHttp, userIds: Set<string>, domain: string): Promise<void> {
  let idps: Obj[];
  try {
    idps = await linkAll(http, '/idps?limit=200');
  } catch (err) {
    if (err instanceof VendorApiError && (err.status === 403 || err.status === 401)) {
      set.warn('Identity providers were not readable with this token (okta.idps.read): social links and SAML/OIDC connections were skipped.');
      return;
    }
    throw err;
  }
  for (const idp of idps) {
    const id = str(idp.id);
    const type = str(idp.type);
    if (!id || !type || str(idp.status) === 'INACTIVE') continue;
    const name = str(idp.name) ?? type;
    let provider: string;
    let kind: IdentityRecord['kind'];
    let connectionId: string | undefined;
    if (SOCIAL[type]) {
      provider = SOCIAL[type]!;
      kind = 'oauth';
    } else if (type === 'SAML2' || type === 'OIDC') {
      connectionId = await addEnterpriseIdp(set, http, idp, domain);
      if (!connectionId) continue;
      provider = name;
      kind = type === 'SAML2' ? 'saml' : 'oidc';
    } else {
      set.warn(`Identity provider ${name} (${type}) has no Atlas counterpart and was skipped.`);
      continue;
    }
    for (const link of await linkAll(http, `/idps/${id}/users?limit=200`)) {
      const uid = str(link.id);
      const external = str(link.externalId);
      if (!uid || !external || !userIds.has(uid)) continue;
      set.add('identity', compact<IdentityRecord>({ user_id: uid, provider, provider_user_id: external, kind, sso_connection_id: connectionId, profile: bag(link.profile) }));
    }
  }
}

async function addEnterpriseIdp(set: RecordSet, http: VendorHttp, idp: Obj, domain: string): Promise<string | undefined> {
  const id = str(idp.id)!;
  const name = str(idp.name) ?? id;
  const protocol = isObj(idp.protocol) ? idp.protocol : {};
  const endpoints = isObj(protocol.endpoints) ? protocol.endpoints : {};
  const credentials = isObj(protocol.credentials) ? protocol.credentials : {};
  // Okta routes users to an IdP by routing rules, not by a domain on the IdP:
  // the Atlas connection's domains are set after the import.
  const domains: string[] = [];
  if (str(idp.type) === 'SAML2') {
    const trust = isObj(credentials.trust) ? credentials.trust : {};
    const kid = str(trust.kid);
    let cert: string | undefined;
    if (kid) {
      try {
        const { body } = await http.get<Obj>(`/idps/credentials/keys/${kid}`);
        const x5c = Array.isArray(body?.x5c) ? str(body.x5c[0]) : undefined;
        if (x5c) cert = `-----BEGIN CERTIFICATE-----\n${x5c.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
      } catch (err) {
        if (!(err instanceof VendorApiError)) throw err;
      }
    }
    const sso = isObj(endpoints.sso) ? endpoints.sso : {};
    const acs = isObj(endpoints.acs) ? endpoints.acs : {};
    set.add(
      'sso_connection',
      compact({
        id,
        name,
        protocol: 'saml' as const,
        domains,
        enabled: str(idp.status) !== 'INACTIVE',
        saml: compact({
          idp_entity_id: str(trust.issuer),
          idp_sso_url: str(sso.url),
          idp_certificate: cert,
          sp_entity_id: str(trust.audience),
          sp_acs_url: str(acs.url) ?? `https://${domain}/sso/saml2/${id}`,
        }),
      }),
    );
    if (!cert) set.warn(`SAML identity provider ${name}: its signing certificate could not be read; add it in Atlas.`);
    return id;
  }
  const issuer = isObj(protocol.issuer) ? str(protocol.issuer.url) : undefined;
  const client = isObj(credentials.client) ? credentials.client : {};
  set.add(
    'sso_connection',
    compact({
      id,
      name,
      protocol: 'oidc' as const,
      domains,
      enabled: str(idp.status) !== 'INACTIVE',
      oidc: compact({ issuer, client_id: str(client.client_id), scopes: Array.isArray(protocol.scopes) ? protocol.scopes.map(String) : undefined }),
    }),
  );
  set.warn(`OIDC identity provider ${name}: Okta does not return its client secret; enter it in Atlas after the import.`);
  return id;
}

async function addFactors(set: RecordSet, http: VendorHttp, userId: string): Promise<void> {
  let factors: Obj[];
  try {
    factors = objs((await http.get<unknown>(`/users/${userId}/factors`)).body);
  } catch (err) {
    if (err instanceof VendorApiError && (err.status === 403 || err.status === 404)) return;
    throw err;
  }
  for (const f of factors) {
    if (str(f.status) !== 'ACTIVE') continue;
    const type = str(f.factorType);
    const profile = isObj(f.profile) ? f.profile : {};
    if (type === 'sms' || type === 'call') {
      const phone = e164(profile.phoneNumber);
      if (phone) set.add('mfa_factor', { user_id: userId, type: 'phone', phone, verified: true, created_at: str(f.created) }, `phone:${userId}:${phone}`);
    } else if (type === 'email') {
      set.add('mfa_factor', { user_id: userId, type: 'email', verified: true, created_at: str(f.created) }, `email:${userId}`);
    } else if (type) {
      set.omit('mfa_factor', `Okta does not export ${type} secrets; re-enrol in Atlas`);
    }
  }
}

/** Follow `Link: <…>; rel="next"` until the last page. */
async function linkAll(http: VendorHttp, path: string): Promise<Obj[]> {
  const out: Obj[] = [];
  let next: string | null = path;
  while (next) {
    const res: { body: unknown; headers: Headers } = await http.get<unknown>(next);
    out.push(...objs(res.body));
    next = nextLink(res.headers.get('link'));
  }
  return out;
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'group';
}
