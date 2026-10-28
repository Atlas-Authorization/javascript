import type { IdentityRecord, MfaFactorRecord, UserRecord } from '@atlasauth/migrate';
import { RecordSet, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { keyOf } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export azure-ad-b2c | entra-external-id` — an Azure AD B2C
 * tenant or a Microsoft Entra External ID (external) tenant onto the
 * canonical bundle models, through Microsoft Graph with an app registration
 * the owner creates (client credentials, User.Read.All). The client secret is
 * sent to Microsoft's token endpoint only, from this machine.
 *
 *   - consumer users with their sign-in identities: `emailAddress` → email,
 *     `userName` → username, `phoneNumber` → phone, `federated` → a social
 *     or OIDC identity; `mail` / `otherMails` / `mobilePhone` as extra
 *     (unverified) addresses; `extension_<app>_<name>` custom attributes →
 *     public metadata; `accountEnabled: false` → banned. Users are keyed by
 *     their directory OBJECT ID — the `sub` of B2C tokens (default user
 *     flows) and the `oid` of External ID tokens, which is what the bridge
 *     presets match on;
 *   - with authentication methods: SMS / email second factors (phoneMethods,
 *     emailMethods), and a count of authenticator-app users (no secret);
 *   - groups as app roles.
 *
 * Microsoft never exports passwords (the password is write-only in Graph),
 * TOTP secrets or FIDO2 keys. Passwords move by lazy migration: a ROPC user
 * flow on B2C, the native authentication API on External ID.
 */

export type AzureKind = 'b2c' | 'entra';

export interface AzureExportOptions {
  kind: AzureKind;
  /** Tenant id (GUID) or domain (`contoso.onmicrosoft.com`). */
  tenant: string;
  clientId?: string;
  clientSecret?: string;
  /** A Graph access token instead of client credentials. */
  accessToken?: string;
  /** Read each user's phone / email / software OATH methods (three calls per user). */
  authMethods?: boolean;
  groups?: 'roles' | 'skip';
  /** Also export directory (admin / work) accounts that only sign in with a userPrincipalName. */
  includeDirectoryUsers?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

export const GRAPH = 'https://graph.microsoft.com/v1.0';

/** The client-credentials token for Microsoft Graph (sent to login.microsoftonline.com only). */
export async function graphToken(tenant: string, clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' }).toString(),
  });
  const text = await res.text();
  let body: Obj = {};
  try {
    body = JSON.parse(text) as Obj;
  } catch {
    // not JSON: reported below
  }
  const token = str(body.access_token);
  if (!res.ok || !token) {
    const detail = (str(body.error_description) ?? str(body.error) ?? text.slice(0, 200)).split(/\r?\n/)[0];
    throw new VendorApiError('Microsoft Entra', res.status, '/oauth2/v2.0/token', detail ?? '');
  }
  return token;
}

/** Graph over {@link VendorHttp}: a bearer from a token or client credentials, fetched once. */
export function graphHttp(o: { tenant: string; clientId?: string; clientSecret?: string; accessToken?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): VendorHttp {
  if (!o.accessToken && !(o.clientId && o.clientSecret)) throw new Error('Microsoft Graph needs an app registration\'s client id and secret (or an access token).');
  let bearer = o.accessToken;
  return new VendorHttp({
    vendor: 'Microsoft Graph',
    baseUrl: GRAPH,
    headers: async () => ({ authorization: `Bearer ${(bearer ??= await graphToken(o.tenant, o.clientId!, o.clientSecret!, o.fetchImpl))}` }),
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
}

/** Every page of a Graph collection (`@odata.nextLink`). */
export async function graphAll(http: VendorHttp, path: string): Promise<Obj[]> {
  const out: Obj[] = [];
  let next: string | undefined = path;
  while (next) {
    const res: { body: unknown } = await http.get<unknown>(next);
    const body = isObj(res.body) ? res.body : {};
    out.push(...objs(body.value));
    next = str(body['@odata.nextLink']);
  }
  return out;
}

const USER_FIELDS = [
  'id',
  'displayName',
  'givenName',
  'surname',
  'mail',
  'otherMails',
  'mobilePhone',
  'identities',
  'accountEnabled',
  'createdDateTime',
  'userPrincipalName',
  'userType',
  'creationType',
  'passwordPolicies',
  'lastPasswordChangeDateTime',
  'preferredLanguage',
  'city',
  'country',
  'jobTitle',
];

/** Federated identity issuers → the provider an identity record carries. */
const ISSUERS: Array<[RegExp, string]> = [
  [/^(https?:\/\/)?(accounts\.)?google\.com\/?$/i, 'google'],
  [/^(https?:\/\/)?(www\.)?facebook\.com\/?$/i, 'facebook'],
  [/^(https?:\/\/)?appleid\.apple\.com\/?$/i, 'apple'],
  [/^(https?:\/\/)?(www\.)?amazon\.com\/?$/i, 'amazon'],
  [/^(https?:\/\/)?(www\.)?linkedin\.com\/?$/i, 'linkedin'],
  [/^(https?:\/\/)?(www\.)?(twitter|x)\.com\/?$/i, 'x'],
  [/^(https?:\/\/)?(www\.)?github\.com\/?$/i, 'github'],
  [/^(MicrosoftAccount|live\.com|https:\/\/login\.live\.com)\/?$/i, 'microsoft'],
  [/^https:\/\/login\.microsoftonline\.com\/9188040d-6c67-4c5b-b112-36a304b66dad\/v2\.0\/?$/i, 'microsoft'],
];

/** The provider name for a federated identity's issuer (a social key, or the issuer itself for an OIDC / enterprise IdP). */
export function providerOfIssuer(issuer: string): { provider: string; kind: IdentityRecord['kind'] } {
  for (const [re, key] of ISSUERS) if (re.test(issuer)) return { provider: key, kind: 'oauth' };
  return { provider: issuer, kind: /^https:\/\//.test(issuer) ? 'oidc' : 'oauth' };
}

/** The extension attributes on a user (`extension_<appId>_<name>`) by bare name. */
export function extensionAttributes(u: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(u)) {
    const m = /^extension_[0-9a-f]{32}_(.+)$/i.exec(k);
    if (m && v !== null && v !== undefined) out[m[1]!] = v;
  }
  return out;
}

/** True for directory (admin / work) accounts: no consumer sign-in identity, only a userPrincipalName. */
export function isDirectoryUser(u: Obj): boolean {
  const ids = objs(u.identities);
  if (str(u.creationType) === 'LocalAccount') return false;
  return !ids.some((i) => str(i.signInType) !== 'userPrincipalName');
}

/** Map one Graph user onto a user record and its federated identities. */
export function mapAzureUser(u: Obj): { user: UserRecord; identities: IdentityRecord[]; skippedIdentities: number } | null {
  const id = str(u.id);
  if (!id) return null;
  const emails: NonNullable<UserRecord['emails']> = [];
  const phones: NonNullable<UserRecord['phones']> = [];
  const identities: IdentityRecord[] = [];
  let username: string | undefined;
  let skippedIdentities = 0;
  const addEmail = (raw: unknown, verified: boolean) => {
    const e = str(raw)?.toLowerCase();
    if (!e || !e.includes('@')) return;
    const existing = emails.find((x) => x.email === e);
    if (existing) existing.verified ||= verified;
    else emails.push({ email: e, verified, primary: false });
  };
  const addPhone = (raw: unknown, verified: boolean) => {
    const p = e164(raw);
    if (!p) return;
    const existing = phones.find((x) => x.phone === p);
    if (existing) existing.verified ||= verified;
    else phones.push({ phone: p, verified, primary: false });
  };
  for (const ident of objs(u.identities)) {
    const type = str(ident.signInType) ?? '';
    const value = str(ident.issuerAssignedId);
    // Local sign-in names were verified by the user flow when the account was created (email / SMS code).
    if (/^emailAddress\d*$/.test(type)) addEmail(value, true);
    else if (type === 'userName') username ??= value;
    else if (type === 'phoneNumber') addPhone(value, true);
    else if (type === 'federated') {
      const issuer = str(ident.issuer);
      if (!issuer || !value) {
        skippedIdentities++;
        continue;
      }
      const { provider, kind } = providerOfIssuer(issuer);
      identities.push(compact({ user_id: id, provider, provider_user_id: value, kind, profile: { issuer } }));
    }
  }
  addEmail(u.mail, false);
  for (const m of strs(u.otherMails)) addEmail(m, false);
  addPhone(u.mobilePhone, false);
  if (emails[0]) emails[0].primary = true;
  if (phones[0] && !emails.length) phones[0].primary = true;
  const custom = extensionAttributes(u);
  const user: UserRecord = compact({
    id,
    emails: emails.length ? emails : undefined,
    phones: phones.length ? phones : undefined,
    username,
    first_name: str(u.givenName),
    last_name: str(u.surname),
    name: str(u.displayName) === 'unknown' ? undefined : str(u.displayName),
    banned: u.accountEnabled === false ? true : undefined,
    public_metadata: Object.keys(custom).length ? custom : undefined,
    private_metadata: compact({
      azure_user_principal_name: str(u.userPrincipalName),
      azure_creation_type: str(u.creationType),
      azure_password_policies: str(u.passwordPolicies),
      azure_profile: compact({ preferredLanguage: str(u.preferredLanguage), city: str(u.city), country: str(u.country), jobTitle: str(u.jobTitle) }),
    }) as Obj,
    created_at: str(u.createdDateTime),
  });
  if (user.private_metadata && !Object.keys(user.private_metadata.azure_profile as Obj).length) delete user.private_metadata.azure_profile;
  if (!user.emails && !user.phones && !user.username) {
    // A directory account (included on request) signs in by its userPrincipalName.
    const upn = str(u.userPrincipalName) ?? str(objs(u.identities).find((i) => str(i.signInType) === 'userPrincipalName')?.issuerAssignedId);
    if (upn) user.username = upn;
  }
  if (!user.emails && !user.phones && !user.username) {
    // A federated-only account without an email claim: keep the object id reachable as a username-less user through its identity.
    if (!identities.length) return null;
    user.username = `user_${id.replace(/-/g, '').slice(0, 20)}`;
  }
  return { user, identities, skippedIdentities };
}

/** Second factors from a user's authentication methods. */
export function azureFactors(userId: string, phoneMethods: Obj[], emailMethods: Obj[]): MfaFactorRecord[] {
  const out: MfaFactorRecord[] = [];
  for (const m of phoneMethods) {
    const phone = e164(m.phoneNumber);
    if (phone && str(m.phoneType) !== 'office') out.push({ user_id: userId, type: 'phone', phone, verified: true });
  }
  if (emailMethods.some((m) => str(m.emailAddress))) out.push({ user_id: userId, type: 'email', verified: true });
  return out;
}

export interface AzureTenantInfo {
  tenantId?: string;
  /** `contoso` of contoso.onmicrosoft.com. */
  tenantName?: string;
}

/** Tenant id and initial domain (needs Organization.Read.All or Directory.Read.All; empty when not granted). */
export async function azureTenantInfo(http: VendorHttp): Promise<AzureTenantInfo> {
  try {
    const orgs = await graphAll(http, '/organization?$select=id,verifiedDomains');
    const org = orgs[0];
    if (!org) return {};
    const initial = objs(org.verifiedDomains).find((d) => d.isInitial === true);
    return { tenantId: str(org.id), tenantName: str(initial?.name)?.replace(/\.onmicrosoft\.com$/i, '').toLowerCase() };
  } catch (err) {
    if (err instanceof VendorApiError && err.status === 403) return {};
    throw err;
  }
}

/** The extension attribute names registered for users (`extension_<app>_<name>`), for `$select`. */
export async function userExtensionNames(http: VendorHttp): Promise<string[]> {
  try {
    const res = await http.post<Obj>('/directoryObjects/getAvailableExtensionProperties', { isSyncedFromOnPremises: false });
    return objs(isObj(res.body) ? res.body.value : undefined)
      .filter((p) => strs(p.targetObjects).includes('User'))
      .map((p) => str(p.name))
      .filter((n): n is string => !!n && /^extension_[0-9a-f]{32}_/i.test(n));
  } catch (err) {
    if (err instanceof VendorApiError && [400, 401, 403, 404].includes(err.status)) return [];
    throw err;
  }
}

export async function exportAzure(opts: AzureExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  const label = opts.kind === 'b2c' ? 'Azure AD B2C' : 'Entra External ID';
  const progress = opts.onProgress ?? (() => undefined);
  const http = graphHttp(opts);

  const info = await azureTenantInfo(http);
  set.manifest.origin = `${label} tenant ${info.tenantName ? `${info.tenantName}.onmicrosoft.com` : opts.tenant}`;

  // Groups → app roles.
  const groups: Array<{ id: string; key: string }> = [];
  if (opts.groups !== 'skip') {
    progress('groups');
    try {
      for (const g of await graphAll(http, '/groups?$select=id,displayName,description&$top=999')) {
        const id = str(g.id);
        const name = str(g.displayName);
        if (!id || !name) continue;
        const key = keyOf(name);
        groups.push({ id, key });
        set.add('role', compact({ key, name, description: str(g.description), scope: 'app' as const }), key);
      }
    } catch (err) {
      if (!(err instanceof VendorApiError && err.status === 403)) throw err;
      set.warn('Groups were not exported: the app registration lacks GroupMember.Read.All (or Group.Read.All).');
    }
  }

  // Users.
  progress('users');
  const extensions = await userExtensionNames(http);
  const select = [...USER_FIELDS, ...extensions].join(',');
  const raw = await graphAll(http, `/users?$select=${select}&$top=999`);
  const providers = new Set<string>();
  let directory = 0;
  let skippedIdentities = 0;
  let totpUsers = 0;
  let fido2Users = 0;
  let methodsDenied = false;
  for (const u of raw) {
    if (!opts.includeDirectoryUsers && isDirectoryUser(u)) {
      directory++;
      continue;
    }
    const mapped = mapAzureUser(u);
    if (!mapped) {
      set.omit('user', 'no email, phone number, username or federated identity');
      continue;
    }
    set.add('user', mapped.user, mapped.user.id);
    for (const i of mapped.identities) {
      set.add('identity', i, `${i.provider}:${i.provider_user_id}`);
      providers.add(i.provider);
    }
    skippedIdentities += mapped.skippedIdentities;
    if (opts.authMethods && !methodsDenied) {
      const uid = encodeURIComponent(mapped.user.id);
      try {
        const phone = await graphAll(http, `/users/${uid}/authentication/phoneMethods`);
        const email = await graphAll(http, `/users/${uid}/authentication/emailMethods`);
        for (const f of azureFactors(mapped.user.id, phone, email)) set.add('mfa_factor', f);
        if ((await graphAll(http, `/users/${uid}/authentication/softwareOathMethods`)).length) totpUsers++;
        if ((await graphAll(http, `/users/${uid}/authentication/fido2Methods`)).length) fido2Users++;
      } catch (err) {
        if (!(err instanceof VendorApiError && (err.status === 403 || err.status === 401))) throw err;
        methodsDenied = true;
        set.warn('Authentication methods were not exported: grant the app registration UserAuthenticationMethod.Read.All.');
      }
    }
  }
  if (directory) set.omit('user', 'directory (admin / work) account that signs in with a userPrincipalName only', directory);
  if (skippedIdentities) set.omit('identity', 'federated identity without an issuer-assigned id (Graph keeps only an alternativeSecurityId); relinks by verified email on first sign-in', skippedIdentities);
  if (totpUsers) set.omit('mfa_factor', 'Microsoft never exports authenticator-app (software OATH) secrets: these users enrol again', totpUsers);
  if (fido2Users) set.omit('passkey', 'FIDO2 keys are bound to the Microsoft sign-in domain and never exported: these users register again', fido2Users);

  // Group members → user roles.
  if (groups.length) {
    progress('group members');
    const ids = new Set(set.list('user').map((u) => u.id));
    const rolesOf = new Map<string, string[]>();
    for (const g of groups) {
      for (const m of await graphAll(http, `/groups/${encodeURIComponent(g.id)}/members?$select=id&$top=999`)) {
        const id = str(m.id);
        if (!id || !ids.has(id)) continue;
        rolesOf.set(id, [...(rolesOf.get(id) ?? []), g.key]);
      }
    }
    for (const user of set.list('user')) {
      const roles = rolesOf.get(user.id);
      if (roles?.length) user.roles = [...new Set(roles)];
    }
  }

  if (set.count('user')) {
    set.warn(
      opts.kind === 'b2c'
        ? 'Azure AD B2C never exports passwords. Turn on the azure_ad_b2c lazy-migration preset with a ROPC user flow: each password is checked against B2C on its first Atlas sign-in, then stored as Argon2id. Accounts with MFA enforced in that flow, and federated accounts, cannot use ROPC.'
        : 'Entra External ID never exports passwords. Turn on the entra_external_id lazy-migration preset (native authentication): each password is checked against External ID on its first Atlas sign-in, then stored as Argon2id.',
    );
    set.warn(
      opts.kind === 'b2c'
        ? 'Users are keyed by their object id, the sub claim of default B2C user flows. If a custom policy issues another value as sub, map the bridge subject to the claim that carries the object id (oid).'
        : 'Users are keyed by their object id (the oid claim); the entra_external_id bridge preset matches on oid.',
    );
  }
  set.manifest.providers = [...providers].sort();
  set.manifest.settings = compact({ kind: opts.kind, tenant_id: info.tenantId, tenant_name: info.tenantName, extension_attributes: extensions.length ? extensions : undefined }) as Obj;
  return set;
}
