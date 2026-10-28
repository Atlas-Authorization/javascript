import type { IdentityRecord, MfaFactorRecord, PasskeyRecord, PasswordHash, SsoConnectionRecord, UserRecord } from '@atlasauth/migrate';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { keyOf, socialKey } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export keycloak` — a Keycloak (or Red Hat SSO / Red Hat build
 * of Keycloak) realm onto the canonical bundle models. Two ways in, both on
 * the owner's machine:
 *
 *   - a REALM EXPORT (`kc.sh export --realm <r> --file <f>` or `--dir <d>`,
 *     any `--users` strategy). The only path that carries password hashes
 *     (PBKDF2-SHA1/256/512, Argon2), TOTP secrets and recovery-code hashes:
 *     Keycloak writes every stored credential with its `secretData`.
 *   - the ADMIN REST API with an admin client (client credentials) or an
 *     admin user (admin-cli password grant). Keycloak strips `secretData`
 *     from every credential it returns, so users arrive without passwords or
 *     OTP secrets (the `keycloak` lazy-migration preset covers passwords);
 *     WebAuthn public keys DO come back (they live in `credentialData`).
 *
 * Both paths produce one {@link KeycloakSnapshot} (the realm-export shape) and
 * {@link mapKeycloak} maps it: users (the Keycloak user id is the `sub` of every
 * Keycloak token, so it is the user id), passwords, TOTP, recovery codes,
 * passkeys, social and brokered identities, SAML / OIDC identity providers as
 * SSO connections, realm and client roles (plus roles inherited through
 * groups), groups as roles or organizations, Keycloak 25+ organizations with
 * their members and (API) invitations.
 *
 * Credential formats: keycloak/keycloak server-spi `PasswordCredentialModel`,
 * `OTPCredentialModel`, `RecoveryAuthnCodesCredentialModel` and the WebAuthn
 * provider (services/…/credential/WebAuthnCredentialProvider.java).
 */

export interface KeycloakSnapshot {
  /** The realm representation (users, if any, are in `users`). */
  realm: Obj;
  /** UserRepresentation in the export shape: credentials, federatedIdentities, realmRoles, clientRoles, groups (paths). */
  users: Obj[];
  /** Users of a user-storage provider without local import (`<realm>-federated-users-*.json`). */
  federatedUsers: Obj[];
  /** Groups, as a tree (`subGroups`) or flat, each with its `path` and role mappings. */
  groups: Obj[];
  /** OrganizationRepresentation (Keycloak 25+), members by `username` (export) or `id` (API). */
  organizations: Obj[];
  /** Organization invitations (Admin API only), each with its `organizationId`. */
  invitations: Obj[];
  source: 'file' | 'api';
  /** The Keycloak base URL (with `/auth` on Keycloak 16 and older), when known. */
  baseUrl?: string;
}

export interface KeycloakMapOptions {
  /** How groups move: app roles (default), organizations, or not at all. */
  groupsAs?: 'roles' | 'organizations' | 'skip';
  /** The WebAuthn relying-party id when the realm leaves it empty (Keycloak then uses its own host name). */
  rpId?: string;
}

/** Realm roles every realm has; never imported as app roles. */
const BUILT_IN_ROLES = new Set(['offline_access', 'uma_authorization']);
/** Clients every realm has (their roles are Keycloak's own admin and account permissions). */
const BUILT_IN_CLIENTS = new Set(['account', 'account-console', 'admin-cli', 'broker', 'realm-management', 'security-admin-console']);
/** Brokered identity providers that are enterprise connections, not social sign-in. */
const ENTERPRISE = new Set(['saml', 'oidc', 'keycloak-oidc']);
/** Keycloak social provider ids that `socialKey` does not already know. */
const KC_SOCIAL: Record<string, string> = { 'linkedin-openid-connect': 'linkedin' };
/** User attributes the user record carries itself. */
const PHONE_ATTRS = ['phoneNumber', 'phone_number', 'phone', 'mobile'];
const CONSUMED_ATTRS = new Set([...PHONE_ATTRS, 'phoneNumberVerified', 'phone_number_verified', 'picture']);

// ── reading a realm export ──────────────────────────────────────────────────

/**
 * Assemble a snapshot from the JSON documents of a realm export: one realm
 * file (`--file`, a realm object or an array of realms), or a `--dir` export
 * (`<realm>-realm.json` plus `<realm>-users-<n>.json` / `<realm>-federated-users-<n>.json`
 * chunks, each `{ realm, users }`). `realmName` picks a realm when there are several.
 */
export function readKeycloakExport(docs: unknown[], realmName?: string): KeycloakSnapshot {
  const realms: Obj[] = [];
  const chunks: Obj[] = [];
  for (const doc of docs) {
    for (const d of Array.isArray(doc) ? doc.filter(isObj) : isObj(doc) ? [doc] : []) {
      // A users chunk carries only `realm` (the name) and the user lists.
      if (typeof d.realm === 'string' && Object.keys(d).every((k) => ['realm', 'users', 'federatedUsers'].includes(k))) chunks.push(d);
      else if (typeof d.realm === 'string') realms.push(d);
    }
  }
  if (!realms.length) throw new Error('No realm found in the Keycloak export (expected the JSON written by kc.sh export).');
  let realm: Obj | undefined;
  if (realmName) realm = realms.find((r) => r.realm === realmName);
  else if (realms.length === 1) realm = realms[0];
  else {
    // A full-server export also holds master: the one other realm is the app's.
    const apps = realms.filter((r) => r.realm !== 'master');
    if (apps.length === 1) realm = apps[0];
  }
  if (!realm) {
    throw new Error(
      realmName
        ? `Realm "${realmName}" is not in the export (found: ${realms.map((r) => String(r.realm)).join(', ')}).`
        : `The export holds several realms (${realms.map((r) => String(r.realm)).join(', ')}): name one with --set keycloak-realm=<realm>.`,
    );
  }
  const name = String(realm.realm);
  const mine = chunks.filter((c) => c.realm === name);
  const { users, federatedUsers, ...rest } = realm;
  return {
    realm: rest,
    users: [...objs(users), ...mine.flatMap((c) => objs(c.users))],
    federatedUsers: [...objs(federatedUsers), ...mine.flatMap((c) => objs(c.federatedUsers))],
    groups: objs(realm.groups),
    organizations: objs(realm.organizations),
    invitations: [],
    source: 'file',
  };
}

// ── reading the Admin REST API ──────────────────────────────────────────────

export interface KeycloakApiOptions {
  /** `https://sso.example.com` (Keycloak 16 and older: `https://sso.example.com/auth`). */
  baseUrl: string;
  realm: string;
  /** The realm the admin credential lives in (default: `master` for an admin user, the target realm for a client). */
  authRealm?: string;
  /** A confidential client with a service account (client credentials), or the client of an admin user (default `admin-cli`). */
  clientId?: string;
  clientSecret?: string;
  /** An admin user, signed in with the password grant. */
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** `https://sso.example.com/` → `https://sso.example.com`; a bare host gets https. */
export function keycloakBase(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(s) ? s : `https://${s}`;
}

/**
 * The Admin REST API (`{base}/admin/realms`) with an admin access token, fetched
 * on first use and again shortly before it expires. Paths start with `/<realm>`.
 */
export function keycloakAdminHttp(o: KeycloakApiOptions): VendorHttp {
  const base = keycloakBase(o.baseUrl);
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const byUser = !!(o.username && o.password);
  if (!byUser && !(o.clientId && o.clientSecret)) throw new Error('Keycloak Admin API needs an admin client (client id + secret) or an admin user (username + password).');
  const authRealm = o.authRealm ?? (byUser ? 'master' : o.realm);
  const tokenPath = `/realms/${encodeURIComponent(authRealm)}/protocol/openid-connect/token`;
  let cached: { value: string; until: number } | null = null;
  const token = async (): Promise<string> => {
    if (cached && cached.until > now()) return cached.value;
    const form = new URLSearchParams(
      byUser
        ? { grant_type: 'password', client_id: o.clientId ?? 'admin-cli', username: o.username!, password: o.password! }
        : { grant_type: 'client_credentials', client_id: o.clientId!, client_secret: o.clientSecret! },
    );
    if (byUser && o.clientSecret) form.set('client_secret', o.clientSecret);
    let res: Response;
    try {
      res = await fetchImpl(`${base}${tokenPath}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() });
    } catch (err) {
      throw new VendorApiError('Keycloak', 0, tokenPath, err instanceof Error ? err.message : String(err));
    }
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error_description?: unknown; error?: unknown } | null;
    if (res.status !== 200 || typeof body?.access_token !== 'string') {
      const detail = typeof body?.error_description === 'string' ? body.error_description : typeof body?.error === 'string' ? body.error : '';
      throw new VendorApiError('Keycloak', res.status, tokenPath, detail);
    }
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 60;
    cached = { value: body.access_token, until: now() + Math.max(ttl - 30, 5) * 1000 };
    return cached.value;
  };
  return new VendorHttp({
    vendor: 'Keycloak',
    baseUrl: `${base}/admin/realms`,
    headers: async () => ({ authorization: `Bearer ${await token()}` }),
    fetchImpl,
    sleep: o.sleep,
    now,
  });
}

/** Read a realm through the Admin REST API into the realm-export shape. */
export async function fetchKeycloakRealm(
  http: VendorHttp,
  o: { realm: string; baseUrl?: string; pageSize?: number; onProgress?: (m: string) => void; warn?: (m: string) => void },
): Promise<KeycloakSnapshot> {
  const r = `/${encodeURIComponent(o.realm)}`;
  const max = o.pageSize ?? 100;
  const progress = o.onProgress ?? (() => undefined);
  const warn = o.warn ?? (() => undefined);
  const list = async (path: string): Promise<Obj[]> => objs((await http.get<unknown>(path)).body);
  /** A listing the token may not be allowed to read, or the server too old to have. */
  const optional = async (path: string, what: string): Promise<Obj[]> => {
    try {
      return await list(path);
    } catch (err) {
      if (!(err instanceof VendorApiError) || ![403, 404].includes(err.status)) throw err;
      if (err.status === 403) warn(`${what} could not be read with this admin credential (403) and were skipped.`);
      return [];
    }
  };
  const paged = async (path: string): Promise<Obj[]> => {
    const out: Obj[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let first = 0; ; first += max) {
      const page = await list(`${path}${sep}first=${first}&max=${max}`);
      out.push(...page);
      if (page.length < max) return out;
    }
  };

  progress('realm');
  const realm = (await http.get<Obj>(r)).body;
  if (!isObj(realm)) throw new Error(`Keycloak returned no realm "${o.realm}".`);
  realm.identityProviders = await optional(`${r}/identity-provider/instances`, 'Identity providers');
  const clients = await optional(`${r}/clients`, 'Clients');
  realm.clients = clients;
  const clientRoles: Record<string, Obj[]> = {};
  for (const c of clients) {
    const clientId = str(c.clientId);
    if (!clientId || !str(c.id) || isBuiltInClient(clientId, o.realm)) continue;
    const roles = await optional(`${r}/clients/${encodeURIComponent(str(c.id)!)}/roles`, `Roles of client ${clientId}`);
    if (roles.length) clientRoles[clientId] = roles;
  }
  realm.roles = { realm: await optional(`${r}/roles?briefRepresentation=false`, 'Realm roles'), client: clientRoles };

  progress('users');
  const groups = new Map<string, Obj>();
  const users = await paged(`${r}/users?briefRepresentation=false`);
  for (const u of users) {
    const id = str(u.id);
    if (!id || str(u.serviceAccountClientId)) continue;
    const base = `${r}/users/${encodeURIComponent(id)}`;
    u.federatedIdentities = await list(`${base}/federated-identity`);
    const memberOf = await list(`${base}/groups?briefRepresentation=false`);
    u.groups = memberOf.map((g) => str(g.path)).filter((p): p is string => !!p);
    for (const g of memberOf) if (str(g.path)) groups.set(str(g.path)!, g);
    const mappings = (await http.get<Obj>(`${base}/role-mappings`)).body;
    u.realmRoles = objs(isObj(mappings) ? mappings.realmMappings : undefined).map((m) => str(m.name)).filter((n): n is string => !!n);
    const byClient: Record<string, string[]> = {};
    for (const [key, m] of Object.entries(isObj(mappings) && isObj(mappings.clientMappings) ? mappings.clientMappings : {})) {
      if (!isObj(m)) continue;
      const names = objs(m.mappings).map((x) => str(x.name)).filter((n): n is string => !!n);
      if (names.length) byClient[str(m.client) ?? key] = names;
    }
    u.clientRoles = byClient;
    u.credentials = await list(`${base}/credentials`);
  }
  // Roles reach a member through every ancestor group: read the parents nobody is a direct member of.
  for (const path of [...groups.keys()]) {
    const parts = path.split('/').filter(Boolean);
    for (let i = parts.length - 1; i > 0; i--) {
      const parent = `/${parts.slice(0, i).join('/')}`;
      if (groups.has(parent)) continue;
      try {
        const { body } = await http.get<Obj>(`${r}/group-by-path/${parts.slice(0, i).map(encodeURIComponent).join('/')}`);
        if (isObj(body)) groups.set(parent, { ...body, path: parent, subGroups: [] });
      } catch (err) {
        if (!(err instanceof VendorApiError)) throw err;
      }
    }
  }

  const organizations: Obj[] = [];
  const invitations: Obj[] = [];
  if (realm.organizationsEnabled === true) {
    progress('organizations');
    for (const org of await optional(`${r}/organizations?briefRepresentation=false&first=0&max=100000`, 'Organizations')) {
      const id = str(org.id);
      if (!id) continue;
      const path = `${r}/organizations/${encodeURIComponent(id)}`;
      org.members = await paged(`${path}/members`);
      organizations.push(org);
      // Invitations have an admin endpoint from Keycloak 26.2 on; older servers answer 404.
      for (const inv of await optional(`${path}/invitations?first=0&max=100000`, `Invitations of ${str(org.name) ?? id}`)) invitations.push({ organizationId: id, ...inv });
    }
  }

  return { realm, users, federatedUsers: [], groups: [...groups.values()], organizations, invitations, source: 'api', baseUrl: o.baseUrl ? keycloakBase(o.baseUrl) : undefined };
}

// ── mapping ─────────────────────────────────────────────────────────────────

/** Map a snapshot (realm export or API) onto canonical records. */
export function mapKeycloak(snap: KeycloakSnapshot, opts: KeycloakMapOptions = {}): RecordSet {
  const set = new RecordSet();
  const realm = snap.realm;
  const realmName = str(realm.realm) ?? 'realm';
  const groupsAs = opts.groupsAs ?? 'roles';
  const groups = indexGroups(snap.groups);

  // ── Keycloak organizations (25+) ──
  const orgIds = new Set<string>();
  const orgOfIdp = new Map<string, string>();
  for (const o of snap.organizations) {
    const id = str(o.id);
    const name = str(o.name);
    if (!id || !name) continue;
    orgIds.add(id);
    for (const idp of objs(o.identityProviders)) if (str(idp.alias)) orgOfIdp.set(str(idp.alias)!, id);
    set.add(
      'organization',
      compact({
        id,
        name,
        slug: str(o.alias),
        domains: objs(o.domains).map((d) => str(d.name)?.toLowerCase()).filter((d): d is string => !!d),
        public_metadata: bag(compact({ description: str(o.description), redirect_url: str(o.redirectUrl), ...unwrapAttributes(o.attributes) })),
        private_metadata: o.enabled === false ? { keycloak_enabled: false } : undefined,
      }),
    );
  }
  if (orgIds.size) set.add('role', { key: 'member', name: 'Member', scope: 'organization' }, 'org:member');

  // ── groups as organizations ──
  if (groupsAs === 'organizations') {
    for (const g of groups.values()) {
      set.add('organization', compact({ id: g.id, name: g.name, slug: g.path.split('/').filter(Boolean).map((s) => keyOf(s).replace(/_/g, '-')).join('-'), public_metadata: bag({ keycloak_group_path: g.path, ...unwrapAttributes(g.attributes) }) }));
    }
    if (groups.size) set.add('role', { key: 'member', name: 'Member', scope: 'organization' }, 'org:member');
  }

  // ── roles: realm roles, client roles, groups ──
  const roles = isObj(realm.roles) ? realm.roles : {};
  let composite = false;
  for (const role of objs(roles.realm)) {
    const name = str(role.name);
    if (!name || isBuiltInRole(name)) continue;
    if (role.composite === true) composite = true;
    set.add('role', compact({ key: keyOf(name), name, description: str(role.description), scope: 'app' as const }), keyOf(name));
  }
  for (const [clientId, list] of Object.entries(isObj(roles.client) ? roles.client : {})) {
    if (isBuiltInClient(clientId, realmName)) continue;
    for (const role of objs(list)) {
      const name = str(role.name);
      if (!name) continue;
      if (role.composite === true) composite = true;
      set.add('role', compact({ key: clientRoleKey(clientId, name), name: `${clientId}: ${name}`, description: str(role.description), scope: 'app' as const }), clientRoleKey(clientId, name));
    }
  }
  if (groupsAs === 'roles') {
    for (const g of groups.values()) set.add('role', { key: groupKey(g.path), name: g.path, description: 'Keycloak group', scope: 'app' }, groupKey(g.path));
  }
  if (composite) set.warn('Composite roles were imported as plain roles: a user holds the roles assigned to them and their groups, not the roles a composite role includes. Assign those in Atlas, or give the composite role the permissions it stood for.');

  // ── identity providers ──
  const idps = new Map<string, Obj>();
  for (const idp of objs(realm.identityProviders)) if (str(idp.alias)) idps.set(str(idp.alias)!, idp);
  const connections = new Set<string>();
  for (const [alias, idp] of idps) {
    const providerId = str(idp.providerId) ?? '';
    if (!ENTERPRISE.has(providerId)) continue;
    const orgId = str(idp.organizationId) ?? orgOfIdp.get(alias);
    const connection = ssoConnection(idp, {
      realm: realmName,
      baseUrl: snap.baseUrl,
      organizationId: orgId && orgIds.has(orgId) ? orgId : undefined,
      domains: [
        ...strs(isObj(idp.config) ? [idp.config['kc.org.domain']] : []),
        ...snap.organizations.filter((o) => str(o.id) === orgId).flatMap((o) => objs(o.domains).filter((d) => !str(d.identityProviderAlias) || str(d.identityProviderAlias) === alias).map((d) => str(d.name))),
      ],
      warn: (m) => set.warn(m),
    });
    set.add('sso_connection', connection);
    connections.add(alias);
  }

  // ── users ──
  const rpIds = {
    webauthn: str(realm.webAuthnPolicyRpId) ?? opts.rpId,
    passwordless: str(realm.webAuthnPolicyPasswordlessRpId) ?? str(realm.webAuthnPolicyRpId) ?? opts.rpId,
  };
  const userIdByName = new Map<string, string>();
  const counts = { password: 0, federated: 0, otpWithoutSecret: 0, temporary: 0 };
  const badHashes = new Map<string, number>();
  for (const u of snap.users) {
    if (str(u.serviceAccountClientId)) {
      set.omit('user', 'Keycloak service-account user (a client credential, not a person)');
      continue;
    }
    const user = mapKeycloakUser(u, realm);
    if (!user) {
      set.omit('user', 'no id, email or username');
      continue;
    }
    const id = user.id;
    if (str(u.username)) userIdByName.set(str(u.username)!.toLowerCase(), id);
    if (str(u.federationLink)) counts.federated++;
    if (strs(u.requiredActions).includes('UPDATE_PASSWORD')) counts.temporary++;

    const creds = objs(u.credentials);
    // Keycloak lists credentials by priority: the first password is the one it checks.
    const pw = creds.find((c) => str(c.type) === 'password');
    if (pw) {
      if (snap.source === 'api') counts.password++;
      else {
        const r = keycloakPassword(pw);
        if ('hash' in r) user.password = r.hash;
        else badHashes.set(r.problem, (badHashes.get(r.problem) ?? 0) + 1);
      }
    }
    user.roles = userRoleKeys(u, groups, realmName, groupsAs === 'roles');
    set.add('user', compact(user));

    for (const fi of objs(u.federatedIdentities)) {
      const identity = mapFederatedIdentity(fi, id, idps, connections);
      if (identity) set.add('identity', identity, `${identity.provider}:${identity.provider_user_id}`);
    }

    let hasOtp = false;
    for (const c of creds) {
      const type = str(c.type) ?? '';
      if (type === 'otp' || type === 'totp' || type === 'hotp') {
        hasOtp = true;
        if (snap.source === 'api') continue;
        const f = keycloakOtp(c);
        if ('factor' in f) set.add('mfa_factor', { user_id: id, ...f.factor }, `otp:${id}:${str(c.id) ?? set.count('mfa_factor')}`);
        else set.omit('mfa_factor', f.problem);
      } else if (type === 'recovery-authn-codes') {
        if (snap.source === 'api') {
          set.omit('mfa_factor', 'recovery codes: the Admin API does not return their hashes (use a realm export)');
          continue;
        }
        const f = keycloakRecoveryCodes(c);
        if (f) set.add('mfa_factor', { user_id: id, ...f }, `recovery:${id}`);
        else set.omit('mfa_factor', 'recovery codes: none left');
      } else if (type === 'webauthn' || type === 'webauthn-passwordless') {
        const rp = type === 'webauthn' ? rpIds.webauthn : rpIds.passwordless;
        const p = keycloakPasskey(c, rp);
        if ('passkey' in p) set.add('passkey', { user_id: id, ...p.passkey }, `passkey:${p.passkey.credential_id}`);
        else set.omit('passkey', p.problem);
      }
    }
    if (hasOtp && snap.source === 'api') counts.otpWithoutSecret++;
    else if (u.totp === true && !hasOtp && snap.source === 'api') counts.otpWithoutSecret++;

    if (groupsAs === 'organizations') {
      for (const path of strs(u.groups)) {
        const g = groups.get(path);
        if (g) set.add('membership', { organization_id: g.id, user_id: id, role: 'member' }, `${g.id}:${id}`);
      }
    }
  }

  // ── organization members and invitations ──
  for (const o of snap.organizations) {
    const orgId = str(o.id);
    if (!orgId || !orgIds.has(orgId)) continue;
    for (const m of objs(o.members)) {
      const uid = str(m.id) ?? (str(m.username) ? userIdByName.get(str(m.username)!.toLowerCase()) : undefined);
      if (!uid) {
        set.omit('membership', 'organization member not among the exported users');
        continue;
      }
      set.add('membership', { organization_id: orgId, user_id: uid, role: 'member' }, `${orgId}:${uid}`);
    }
  }
  for (const inv of snap.invitations) {
    const id = str(inv.id);
    const email = str(inv.email)?.toLowerCase();
    const orgId = str(inv.organizationId);
    if (!id || !email) continue;
    const status = str(inv.status)?.toUpperCase();
    set.add(
      'invitation',
      compact({
        id,
        organization_id: orgId && orgIds.has(orgId) ? orgId : undefined,
        email,
        role: 'member',
        status: status === 'EXPIRED' ? ('expired' as const) : ('pending' as const),
        // Keycloak keeps these as epoch seconds.
        expires_at: typeof inv.expiresAt === 'number' && inv.expiresAt > 0 ? inv.expiresAt * 1000 : undefined,
        created_at: typeof inv.sentDate === 'number' && inv.sentDate > 0 ? inv.sentDate * 1000 : undefined,
      }),
    );
  }

  if (snap.federatedUsers.length) set.omit('user', 'kept by a user-storage provider without import (no local profile): they move by lazy migration through Keycloak', snap.federatedUsers.length);

  // ── what could not move, in plain words ──
  if (counts.password) {
    set.warn(
      `${counts.password} user(s) have a Keycloak password, but the Admin API never returns password hashes. Export the realm with kc.sh export (the only path that carries hashes) or turn on the keycloak lazy-migration preset: each password is then checked against Keycloak on its first Atlas sign-in.`,
    );
  }
  if (counts.otpWithoutSecret) {
    set.warn(`${counts.otpWithoutSecret} user(s) use an authenticator app; the Admin API does not return OTP secrets. A realm export (kc.sh export) carries them; otherwise those users enrol again in Atlas.`);
  }
  if (counts.federated) {
    set.warn(`${counts.federated} user(s) are federated from LDAP / Kerberos (federationLink): Keycloak stores no password for them. Use the keycloak lazy-migration preset (Keycloak checks the password against the directory).`);
  }
  if (counts.temporary) set.warn(`${counts.temporary} user(s) must change their password at their next Keycloak sign-in (UPDATE_PASSWORD): their current password was set by an administrator.`);
  for (const [problem, n] of badHashes) set.warn(`${n} user(s) were imported without a password (${problem}); they reset it, or use lazy migration.`);
  if (snap.users.some((u) => objs(u.credentials).some((c) => str(c.type)?.startsWith('webauthn'))) && !rpIds.passwordless && !rpIds.webauthn) {
    set.warn('The realm sets no WebAuthn relying-party id (Keycloak then uses its own host name): pass --set keycloak-rp-id=<host> to carry passkeys.');
  }
  set.warn('Keycloak sessions are not exportable: the keycloak bridge preset exchanges Keycloak access and ID tokens for Atlas sessions instead.');

  const otpAlgorithm = str(realm.otpPolicyAlgorithm);
  set.manifest = {
    origin: snap.baseUrl ? `${snap.baseUrl}/realms/${realmName}` : `realm ${realmName}`,
    sourceVersion: str(realm.keycloakVersion) ?? null,
    rpId: rpIds.passwordless ?? rpIds.webauthn ?? null,
    providers: [...new Set(set.list('identity').map((i) => i.provider))].sort(),
    settings: compact({
      realm: realmName,
      source: snap.source === 'file' ? 'realm_export' : 'admin_api',
      groups_as: groupsAs,
      password_policy: str(realm.passwordPolicy),
      otp: str(realm.otpPolicyType)
        ? { type: str(realm.otpPolicyType), algorithm: otpAlgorithm ? otpAlgorithmOf(otpAlgorithm) : 'SHA1', digits: realm.otpPolicyDigits ?? 6, period: realm.otpPolicyPeriod ?? 30 }
        : undefined,
    }),
  };
  return set;
}

/** One Keycloak user → a user record without password and roles (null when it has nothing to sign in with). */
export function mapKeycloakUser(u: Obj, realm: Obj = {}): UserRecord | null {
  const id = str(u.id);
  if (!id) return null;
  const email = str(u.email)?.toLowerCase();
  const username = str(u.username)?.toLowerCase();
  const attrs = unwrapAttributes(u.attributes);
  const phoneRaw = PHONE_ATTRS.map((k) => attrs[k]).find((v) => typeof v === 'string');
  const phone = e164(phoneRaw);
  const phoneVerified = attrs.phoneNumberVerified === 'true' || attrs.phone_number_verified === 'true';
  const custom = Object.fromEntries(Object.entries(attrs).filter(([k]) => !CONSUMED_ATTRS.has(k)));
  const actions = strs(u.requiredActions);
  const user: UserRecord = compact({
    id,
    emails: email ? [{ email, verified: u.emailVerified === true, primary: true }] : [],
    phones: phone ? [{ phone, verified: phoneVerified, primary: !email }] : [],
    // With "email as username" the username is the address: keep it only when it is a real username.
    username: username && username !== email && realm.registrationEmailAsUsername !== true ? username : undefined,
    first_name: str(u.firstName),
    last_name: str(u.lastName),
    image_url: typeof attrs.picture === 'string' && /^https:\/\//.test(attrs.picture) ? attrs.picture : undefined,
    banned: u.enabled === false ? true : undefined,
    ban_reason: u.enabled === false ? 'Disabled in Keycloak' : undefined,
    private_metadata: bag({
      ...custom,
      ...(actions.length ? { keycloak_required_actions: actions } : {}),
      ...(str(u.federationLink) ? { keycloak_federation_link: str(u.federationLink) } : {}),
    }),
    created_at: typeof u.createdTimestamp === 'number' ? u.createdTimestamp : undefined,
  });
  return user.emails?.length || user.phones?.length || user.username ? user : null;
}

// ── credentials ─────────────────────────────────────────────────────────────

/** PBKDF2 provider ids → digest (`pbkdf2` is PBKDF2WithHmacSHA1). */
const PBKDF2: Record<string, string> = { pbkdf2: 'sha1', 'pbkdf2-sha1': 'sha1', 'pbkdf2-sha256': 'sha256', 'pbkdf2-sha512': 'sha512' };
/** Keycloak's Argon2 version names → the PHC `v=` value. */
const ARGON2_VERSIONS: Record<string, number> = { '1.3': 19, '1.0': 16 };

/**
 * A Keycloak password credential → an Atlas password hash. Keycloak 9+ keeps
 * `secretData` `{ value, salt }` and `credentialData` `{ algorithm,
 * hashIterations, additionalParameters }` as JSON strings; earlier exports
 * (and hand-written import files) put `hashedSaltedValue`, `salt`,
 * `hashIterations` and `algorithm` on the credential itself. Salts and values
 * are standard base64.
 */
export function keycloakPassword(cred: Obj): { hash: PasswordHash } | { problem: string } {
  const secret = jsonObj(cred.secretData);
  const data = jsonObj(cred.credentialData);
  const value = str(secret.value) ?? str(cred.hashedSaltedValue);
  const salt = str(secret.salt) ?? str(cred.salt);
  const algorithm = (str(data.algorithm) ?? str(cred.algorithm))?.toLowerCase();
  const iterations = Number(data.hashIterations ?? cred.hashIterations);
  if (!value) return { problem: 'no stored password value' };
  // Community bcrypt providers store the whole digest as the value.
  if (/^\$2[aby]\$\d{2}\$/.test(value)) return { hash: { algorithm: 'bcrypt', hash: value } };
  if (!algorithm) return { problem: 'the password credential names no algorithm' };
  const digest = PBKDF2[algorithm];
  if (digest) {
    if (!salt || !Number.isInteger(iterations) || iterations < 1) return { problem: `${algorithm} without a salt or iteration count` };
    // PBEKeySpec over the password's UTF-8 bytes; the key length is the decoded value's (512 bits, or 256 for pbkdf2-sha256 from Keycloak 24 on).
    return { hash: { algorithm: 'pbkdf2', hash: value, salt, params: { digest, iterations, encoding: 'base64', salt_encoding: 'base64' } } };
  }
  if (algorithm === 'argon2') {
    const extra = isObj(data.additionalParameters) ? data.additionalParameters : {};
    const first = (k: string): string | undefined => str(Array.isArray(extra[k]) ? (extra[k] as unknown[])[0] : extra[k]);
    const type = first('type') ?? 'id';
    const version = ARGON2_VERSIONS[first('version') ?? '1.3'];
    const memory = Number(first('memory') ?? 7168);
    const parallelism = Number(first('parallelism') ?? 1);
    const t = Number.isInteger(iterations) && iterations > 0 ? iterations : 5;
    if (!salt || !['id', 'i', 'd'].includes(type) || version === undefined || !Number.isInteger(memory) || !Number.isInteger(parallelism)) {
      return { problem: 'an Argon2 credential with parameters Keycloak never writes' };
    }
    // Keycloak's Argon2PasswordHashProvider (BouncyCastle, UTF-8 password) as the
    // PHC string the reference argon2 tool prints for the same inputs.
    const nopad = (s: string) => s.replace(/=+$/, '');
    return { hash: { algorithm: 'argon2', hash: `$argon2${type}$v=${version}$m=${memory},t=${t},p=${parallelism}$${nopad(salt)}$${nopad(value)}` } };
  }
  return { problem: `unsupported hash algorithm "${algorithm}"` };
}

/**
 * A Keycloak OTP credential → a TOTP factor. The secret is a plain string whose
 * UTF-8 BYTES are the HMAC key (OTPCredentialModel.getDecodedSecret); Keycloak
 * shows their base32 in the QR code. With `secretEncoding: "BASE32"` (secrets
 * imported from elsewhere) the value already is base32.
 */
export function keycloakOtp(cred: Obj): { factor: Omit<MfaFactorRecord, 'user_id'> } | { problem: string } {
  const secret = jsonObj(cred.secretData);
  const data = jsonObj(cred.credentialData);
  const raw = typeof secret.value === 'string' && secret.value ? secret.value : typeof cred.value === 'string' && cred.value ? cred.value : undefined;
  const subType = (str(data.subType) ?? (str(cred.type) === 'hotp' ? 'hotp' : 'totp')).toLowerCase();
  if (subType === 'hotp') return { problem: 'HOTP (counter-based) authenticators have no Atlas counterpart; re-enrol in Atlas' };
  if (!raw) return { problem: 'OTP credential without its secret' };
  const encoding = str(data.secretEncoding)?.toUpperCase();
  const secretBase32 = encoding === 'BASE32' ? raw.toUpperCase().replace(/[\s=]/g, '') : base32(Buffer.from(raw, 'utf8'));
  const digits = Number(data.digits ?? cred.digits ?? 6);
  const period = Number(data.period ?? cred.period ?? 30);
  return {
    factor: compact({
      type: 'totp' as const,
      secret_base32: secretBase32,
      digits: Number.isInteger(digits) && digits > 0 ? digits : 6,
      period: Number.isInteger(period) && period > 0 ? period : 30,
      algorithm: otpAlgorithmOf(str(data.algorithm) ?? str(cred.algorithm) ?? 'HmacSHA1'),
      verified: true,
      created_at: typeof cred.createdDate === 'number' ? cred.createdDate : undefined,
    }),
  };
}

/**
 * Recovery codes (`recovery-authn-codes`): Keycloak keeps base64 SHA-512 of
 * each remaining code (RecoveryAuthnCodesUtils.hashRawCode), in the order the
 * user must use them; Atlas accepts any remaining one.
 */
export function keycloakRecoveryCodes(cred: Obj): Omit<MfaFactorRecord, 'user_id'> | null {
  const codes = objs(jsonObj(cred.secretData).codes)
    .map((c) => str(c.encodedHashedValue))
    .filter((h): h is string => !!h);
  if (!codes.length) return null;
  return compact({
    type: 'backup_codes' as const,
    backup_code_hashes: codes.map((hash) => ({ algorithm: 'sha512', hash, params: { encoding: 'base64' } })),
    verified: true,
    created_at: typeof cred.createdDate === 'number' ? cred.createdDate : undefined,
  });
}

/**
 * A WebAuthn credential (`webauthn` second factor or `webauthn-passwordless`
 * passkey). `credentialId` is standard base64 and `credentialPublicKey` the
 * base64url COSE key (CredentialPublicKeyConverter); both become base64url.
 */
export function keycloakPasskey(cred: Obj, rpId: string | undefined): { passkey: Omit<PasskeyRecord, 'user_id'> } | { problem: string } {
  const data = jsonObj(cred.credentialData);
  const credentialId = str(data.credentialId);
  const publicKey = str(data.credentialPublicKey);
  if (!credentialId || !publicKey) return { problem: 'WebAuthn credential without its id or public key' };
  if (!rpId) return { problem: 'WebAuthn credential with no relying-party id (pass --set keycloak-rp-id=<host>)' };
  const aaguid = str(data.aaguid);
  const counter = Number(data.counter);
  return {
    passkey: compact({
      credential_id: base64url(credentialId),
      public_key: base64url(publicKey),
      sign_count: Number.isInteger(counter) && counter >= 0 ? counter : undefined,
      rp_id: rpId,
      transports: strs(data.transports).sort(),
      aaguid: aaguid && aaguid !== '00000000-0000-0000-0000-000000000000' ? aaguid : undefined,
      name: str(cred.userLabel),
      created_at: typeof cred.createdDate === 'number' ? cred.createdDate : undefined,
    }),
  };
}

// ── identities and connections ──────────────────────────────────────────────

function mapFederatedIdentity(fi: Obj, userId: string, idps: Map<string, Obj>, connections: Set<string>): IdentityRecord | null {
  const alias = str(fi.identityProvider);
  const subject = str(fi.userId);
  if (!alias || !subject) return null;
  const idp = idps.get(alias);
  const providerId = str(idp?.providerId) ?? alias;
  const userName = str(fi.userName);
  const email = userName?.includes('@') ? userName.toLowerCase() : undefined;
  if (connections.has(alias)) {
    return compact<IdentityRecord>({ user_id: userId, provider: alias, provider_user_id: subject, kind: providerId === 'saml' ? 'saml' : 'oidc', sso_connection_id: alias, email, profile: bag(compact({ username: userName })) });
  }
  const provider = KC_SOCIAL[providerId] ?? socialKey(providerId) ?? alias;
  return compact<IdentityRecord>({
    user_id: userId,
    provider,
    provider_user_id: subject,
    kind: idp ? 'oauth' : undefined,
    email,
    profile: bag(compact({ username: userName, keycloak_alias: alias !== provider ? alias : undefined })),
  });
}

function ssoConnection(
  idp: Obj,
  o: { realm: string; baseUrl?: string; organizationId?: string; domains: Array<string | undefined>; warn: (m: string) => void },
): SsoConnectionRecord {
  const alias = str(idp.alias)!;
  const name = str(idp.displayName) ?? alias;
  const config = isObj(idp.config) ? idp.config : {};
  const domains = [...new Set(o.domains.filter((d): d is string => !!d).map((d) => d.toLowerCase()))];
  const realmUrl = o.baseUrl ? `${o.baseUrl}/realms/${o.realm}` : undefined;
  if (str(idp.providerId) === 'saml') {
    const certs = (str(config.signingCertificate) ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    if (certs.length > 1) o.warn(`SAML identity provider ${name}: it has ${certs.length} signing certificates; the first was imported, add the others in Atlas.`);
    return compact({
      id: alias,
      name,
      organization_id: o.organizationId,
      protocol: 'saml' as const,
      domains,
      enabled: idp.enabled !== false,
      saml: compact({
        idp_entity_id: str(config.idpEntityId),
        idp_sso_url: str(config.singleSignOnServiceUrl),
        idp_certificate: certs[0] ? pem(certs[0]) : undefined,
        idp_metadata_url: str(config.metadataDescriptorUrl),
        // The IdP knows Keycloak by these: they change to Atlas's values at cutover.
        sp_entity_id: str(config.entityId) ?? realmUrl,
        sp_acs_url: realmUrl ? `${realmUrl}/broker/${alias}/endpoint` : undefined,
      }),
    });
  }
  const secret = str(config.clientSecret);
  // The Admin API masks secrets; a realm export keeps them, unless they live in a vault.
  const realSecret = secret && !/^\*+$/.test(secret) && !secret.startsWith('${vault.') ? secret : undefined;
  if (!realSecret) o.warn(`OIDC identity provider ${name}: its client secret was not available (masked or in a vault); enter it on the SSO connection after the import.`);
  const issuer = str(config.issuer);
  return compact({
    id: alias,
    name,
    organization_id: o.organizationId,
    protocol: 'oidc' as const,
    domains,
    enabled: idp.enabled !== false,
    oidc: compact({
      issuer,
      discovery_url: str(config.metadataDescriptorUrl) ?? (issuer ? `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration` : undefined),
      client_id: str(config.clientId),
      client_secret: realSecret,
      scopes: (str(config.defaultScope) ?? '').split(/[\s,]+/).filter(Boolean),
    }),
  });
}

// ── roles and groups ────────────────────────────────────────────────────────

interface GroupInfo {
  id: string;
  name: string;
  path: string;
  realmRoles: string[];
  clientRoles: Record<string, string[]>;
  attributes?: unknown;
}

/** Flatten a group tree (or a flat list) by path. */
function indexGroups(groups: Obj[], parent = '', out = new Map<string, GroupInfo>()): Map<string, GroupInfo> {
  for (const g of groups) {
    const name = str(g.name);
    if (!name) continue;
    const path = str(g.path) ?? `${parent}/${name}`;
    const clientRoles: Record<string, string[]> = {};
    for (const [client, list] of Object.entries(isObj(g.clientRoles) ? g.clientRoles : {})) clientRoles[client] = strs(list);
    out.set(path, { id: str(g.id) ?? path, name, path, realmRoles: strs(g.realmRoles), clientRoles, attributes: g.attributes });
    indexGroups(objs(g.subGroups), path, out);
  }
  return out;
}

/**
 * A user's app-role keys: realm and client roles mapped to the user, plus the
 * roles of every group they belong to and of that group's ancestors (Keycloak
 * hands a member all of those), plus one role per group with groups-as-roles.
 */
function userRoleKeys(u: Obj, groups: Map<string, GroupInfo>, realm: string, groupRoles: boolean): string[] {
  const keys = new Set<string>();
  const addRealm = (name: string) => {
    if (!isBuiltInRole(name)) keys.add(keyOf(name));
  };
  const addClient = (client: string, names: string[]) => {
    if (isBuiltInClient(client, realm)) return;
    for (const n of names) keys.add(clientRoleKey(client, n));
  };
  strs(u.realmRoles).forEach(addRealm);
  for (const [client, names] of Object.entries(isObj(u.clientRoles) ? u.clientRoles : {})) addClient(client, strs(names));
  for (const path of strs(u.groups)) {
    if (groupRoles) keys.add(groupKey(path));
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const g = groups.get(`/${parts.slice(0, i).join('/')}`);
      if (!g) continue;
      g.realmRoles.forEach(addRealm);
      for (const [client, names] of Object.entries(g.clientRoles)) addClient(client, names);
    }
  }
  return [...keys];
}

export function isBuiltInRole(name: string): boolean {
  return BUILT_IN_ROLES.has(name) || name.startsWith('default-roles-');
}

export function isBuiltInClient(clientId: string, realm: string): boolean {
  // The master realm has one `<realm>-realm` admin client per realm.
  return BUILT_IN_CLIENTS.has(clientId) || (realm === 'master' && clientId.endsWith('-realm'));
}

/** `acme-web` + `billing` → `acme_web:billing`. */
export function clientRoleKey(clientId: string, role: string): string {
  return `${keyOf(clientId)}:${keyOf(role)}`;
}

/** `/Engineering/Backend` → `group:engineering_backend`. */
export function groupKey(path: string): string {
  return `group:${keyOf(path.split('/').filter(Boolean).join('_'))}`;
}

// ── small helpers ───────────────────────────────────────────────────────────

/** Keycloak keeps credential data as JSON strings inside the JSON. */
function jsonObj(v: unknown): Obj {
  if (isObj(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const parsed = JSON.parse(v) as unknown;
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** `{ dept: ["R&D"], tags: ["a", "b"] }` → `{ dept: "R&D", tags: ["a", "b"] }`. */
function unwrapAttributes(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(isObj(v) ? v : {})) {
    const list = Array.isArray(raw) ? raw.filter((x) => x !== null && x !== undefined && x !== '') : raw === null || raw === undefined || raw === '' ? [] : [raw];
    if (list.length === 1) out[k] = list[0];
    else if (list.length > 1) out[k] = list;
  }
  return out;
}

const OTP_ALGORITHMS: Record<string, 'SHA1' | 'SHA256' | 'SHA512'> = { hmacsha1: 'SHA1', hmacsha256: 'SHA256', hmacsha512: 'SHA512', sha1: 'SHA1', sha256: 'SHA256', sha512: 'SHA512' };
/** `HmacSHA256` → `SHA256` (SHA1 for anything unknown, Keycloak's default). */
function otpAlgorithmOf(raw: string): 'SHA1' | 'SHA256' | 'SHA512' {
  return OTP_ALGORITHMS[raw.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? 'SHA1';
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 4648 base32, upper case, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32.charAt((value << (5 - bits)) & 31);
  return out;
}

/** Standard or URL-safe base64 (padded or not) → unpadded base64url. */
export function base64url(s: string): string {
  return s.replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pem(b64: string): string {
  const body = b64.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
}

// ── the exporter the plugin calls ───────────────────────────────────────────

export interface ExportKeycloakOptions extends KeycloakMapOptions {
  /** The JSON documents of a realm export (`kc.sh export`), when exporting from files. */
  exportDocs?: unknown[];
  realm?: string;
  /** The Admin API, when exporting live. */
  api?: Omit<KeycloakApiOptions, 'realm'>;
  onProgress?: (m: string) => void;
}

/** Export a realm from an export file (hashes and OTP secrets included) or the Admin API (no secrets). */
export async function exportKeycloak(o: ExportKeycloakOptions): Promise<RecordSet> {
  let snap: KeycloakSnapshot;
  if (o.exportDocs) {
    snap = readKeycloakExport(o.exportDocs, o.realm);
    if (o.api?.baseUrl) snap.baseUrl = keycloakBase(o.api.baseUrl);
  } else {
    if (!o.api || !o.realm) throw new Error('Keycloak: name the realm and give an admin credential, or a realm export.');
    const warnings: string[] = [];
    snap = await fetchKeycloakRealm(keycloakAdminHttp({ ...o.api, realm: o.realm }), { realm: o.realm, baseUrl: o.api.baseUrl, onProgress: o.onProgress, warn: (m) => warnings.push(m) });
    const set = mapKeycloak(snap, o);
    for (const w of warnings) set.warn(w);
    return set;
  }
  return mapKeycloak(snap, o);
}
