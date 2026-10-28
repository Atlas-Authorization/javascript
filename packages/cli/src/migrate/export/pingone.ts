import type { EmailAddress, IdentityRecord, PhoneNumber, SsoConnectionRecord, UserRecord } from '@atlasauth/migrate';
import { RecordSet, bag, compact, e164, isObj, objs, str, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate ping-identity export` — a PingOne environment through its
 * management API with a worker application (client id + secret, on this
 * machine): users (login, email and verification, name, phones, enabled /
 * locked state, population, last sign-on), groups (as roles, with their
 * members), external-IdP identities and the environment's SAML / OIDC identity
 * providers (as SSO connections).
 *
 * PingOne never returns password hashes, TOTP secrets or FIDO2 credentials:
 * passwords move by lazy migration (the `ping_identity` preset checks them with
 * PingOne's password-check call), second factors are enrolled again.
 */

/** auth.pingone.<tld> / api.pingone.<tld> for a region code. */
export function pingRegion(region: string | undefined): string {
  const r = (region ?? 'com').toLowerCase().replace(/^\./, '');
  if (!/^(com|eu|asia|ca|com\.au|sg)$/.test(r)) throw new Error(`Unknown PingOne region "${region}" (use com, eu, asia, ca, com.au or sg).`);
  return r;
}

export interface PingOneExportOptions {
  environmentId: string;
  clientId: string;
  clientSecret: string;
  region?: string;
  /** Read each user's group memberships (one call per user; off for very large environments). */
  groups?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/** A client-credentials access token for the worker application. */
export async function pingOneToken(o: Pick<PingOneExportOptions, 'environmentId' | 'clientId' | 'clientSecret' | 'region' | 'fetchImpl'>): Promise<string> {
  const f = o.fetchImpl ?? fetch;
  const res = await f(`https://auth.pingone.${pingRegion(o.region)}/${o.environmentId}/as/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  const body = (await res.json().catch(() => null)) as Obj | null;
  const token = str(body?.access_token);
  if (res.status !== 200 || !token) throw new Error(`PingOne refused the worker application's credentials (${res.status}${str(body?.error_description) ? `: ${str(body?.error_description)}` : ''}).`);
  return token;
}

export function pingOneHttp(o: PingOneExportOptions, token: string): VendorHttp {
  return new VendorHttp({
    vendor: 'PingOne',
    baseUrl: `https://api.pingone.${pingRegion(o.region)}/v1/environments/${o.environmentId}`,
    headers: { authorization: `Bearer ${token}` },
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
}

/** Every item of a PingOne collection (`_embedded.<key>`, next page in `_links.next.href`). */
export async function pingOneList(http: VendorHttp, path: string, key: string): Promise<Obj[]> {
  const out: Obj[] = [];
  let next: string | undefined = path;
  while (next) {
    const res: { body: unknown } = await http.get<unknown>(next);
    const body = isObj(res.body) ? res.body : {};
    out.push(...objs(isObj(body._embedded) ? body._embedded[key] : undefined));
    const href: unknown = isObj(body._links) && isObj(body._links.next) ? body._links.next.href : undefined;
    next = typeof href === 'string' ? href : undefined;
  }
  return out;
}

async function listOrEmpty(http: VendorHttp, path: string, key: string): Promise<Obj[]> {
  try {
    return await pingOneList(http, path, key);
  } catch (err) {
    if (err instanceof VendorApiError && [403, 404].includes(err.status)) return [];
    throw err;
  }
}

/** A PingOne identity provider → an SSO connection (SAML / OIDC); other types are social logins. */
export function ssoConnectionOf(idp: Obj): SsoConnectionRecord | null {
  const type = str(idp.type);
  const id = str(idp.id);
  if (!id) return null;
  if (type === 'SAML') {
    const certs = isObj(idp.idpVerification) ? objs(idp.idpVerification.certificates) : [];
    return compact<SsoConnectionRecord>({
      id,
      name: str(idp.name),
      protocol: 'saml',
      enabled: idp.enabled !== false,
      saml: compact({
        idp_entity_id: str(idp.idpEntityId),
        idp_sso_url: str(idp.ssoEndpoint),
        sp_entity_id: str(idp.spEntityId),
        // The signing certificate itself is not in the list answer: fetch the certificate id's key from PingOne or paste the IdP metadata.
        idp_certificate: str(certs[0]?.certificate),
      }),
    } as SsoConnectionRecord);
  }
  if (type === 'OPENID_CONNECT') {
    return compact<SsoConnectionRecord>({
      id,
      name: str(idp.name),
      protocol: 'oidc',
      enabled: idp.enabled !== false,
      oidc: compact({
        issuer: str(idp.issuer),
        discovery_url: str(idp.discoveryEndpoint),
        client_id: str(idp.clientId),
        scopes: Array.isArray(idp.scopes) ? (idp.scopes as unknown[]).map(String) : undefined,
      }),
    } as SsoConnectionRecord);
  }
  return null;
}

export async function exportPingOne(o: PingOneExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const say = o.onProgress ?? (() => undefined);
  set.manifest = { origin: `PingOne environment ${o.environmentId}` };
  const http = pingOneHttp(o, await pingOneToken(o));

  say('identity providers');
  const connections = new Set<string>();
  for (const idp of await listOrEmpty(http, '/identityProviders', 'identityProviders')) {
    const sso = ssoConnectionOf(idp);
    if (sso) {
      set.add('sso_connection', sso, sso.id);
      connections.add(sso.id);
    } else if (str(idp.type)) set.warn(`Social identity provider "${str(idp.name) ?? str(idp.type)}" (${str(idp.type)}) is configured in Atlas as an OAuth provider (atlas migrate ping-identity config), not imported as a connection.`);
  }

  say('groups');
  const groups = await listOrEmpty(http, '/groups', 'groups');
  const roleOf = new Map<string, string>();
  for (const g of groups) {
    const id = str(g.id);
    const name = str(g.name);
    if (!id || !name) continue;
    const key = keyOf(name);
    roleOf.set(id, key);
    set.add('role', { key, name, scope: 'app', description: str(g.description) }, key);
  }

  say('users');
  const users = await pingOneList(http, '/users?limit=100', 'users');
  let i = 0;
  for (const u of users) {
    const id = str(u.id);
    if (!id) continue;
    if (++i % 500 === 0) say(`  ${i} of ${users.length} users`);
    const name = isObj(u.name) ? u.name : {};
    const email = str(u.email)?.toLowerCase();
    const emails: EmailAddress[] = email ? [{ email, verified: u.emailVerified === true || str(u.verifyStatus) === 'VERIFIED', primary: true }] : [];
    const phones: PhoneNumber[] = [];
    for (const raw of [u.mobilePhone, u.primaryPhone]) {
      const p = e164(raw);
      if (p && !phones.some((x) => x.phone === p)) phones.push({ phone: p, verified: false, primary: phones.length === 0 });
    }
    const account = isObj(u.account) ? u.account : {};
    const lifecycle = isObj(u.lifecycle) ? u.lifecycle : {};
    const record: UserRecord = compact({
      id,
      emails,
      phones,
      username: str(u.username),
      first_name: str(name.given),
      last_name: str(name.family),
      name: str(name.formatted),
      created_at: str(u.createdAt),
      last_sign_in_at: isObj(u.lastSignOn) ? str(u.lastSignOn.at) : undefined,
      private_metadata: { pingone: compact({ population: isObj(u.population) ? str(u.population.id) : undefined, type: str(u.type), mfa_enabled: u.mfaEnabled === true ? true : undefined }) },
    } as UserRecord);
    if (u.enabled === false) {
      record.banned = true;
      record.ban_reason = 'Disabled in PingOne';
    } else if (str(account.status) === 'LOCKED') record.locked = true;
    if (['ACCOUNT_DISABLED', 'DISABLED'].includes(str(lifecycle.status) ?? '')) record.banned = true;
    if (!record.emails?.length && !record.phones?.length && !record.username) {
      set.omit('user', 'no email, phone or username', 1);
      continue;
    }
    if (o.groups !== false && roleOf.size) {
      const memberOf = await listOrEmpty(http, `/users/${encodeURIComponent(id)}/memberOfGroups`, 'groups');
      const roles = memberOf.map((g) => roleOf.get(str(g.id) ?? '')).filter((r): r is string => !!r);
      if (roles.length) record.roles = roles;
    }
    set.add('user', record, id);

    // A user who signs in through an external IdP keeps that link.
    const ext = isObj(u.identityProvider) ? u.identityProvider : undefined;
    const extType = str(ext?.type);
    if (ext && extType && extType !== 'PING_ONE') {
      const link: IdentityRecord = compact({
        user_id: id,
        provider: extType.toLowerCase(),
        provider_user_id: str(ext.id) ?? id,
        kind: connections.has(str(ext.id) ?? '') ? 'enterprise' : 'oauth',
        sso_connection_id: connections.has(str(ext.id) ?? '') ? str(ext.id) : undefined,
        email,
        profile: bag({ external_id: str(u.externalId) }),
      } as IdentityRecord);
      set.add('identity', link);
    }
  }

  set.omit('password', 'PingOne never exports password hashes', users.length);
  set.omit('mfa_factor', 'PingOne never exports TOTP secrets or FIDO2 credentials', 0);
  set.warn('Passwords move by lazy migration (preset ping_identity); users enrol their second factor again.');
  return set;
}
