import type { IdentityRecord, MfaFactorRecord, PasswordHash, SsoConnectionRecord, UserRecord } from '@atlasauth/migrate';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { socialKey } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export zitadel` — a ZITADEL instance (ZITADEL Cloud or
 * self-hosted) onto the canonical bundle models. Two ways in, both on the
 * owner's machine, and both read ZITADEL's own EXPORT document (the
 * `ImportData` the `zitadel export` command and `POST /admin/v1/export` write,
 * with `withPasswords` / `withOtp` on):
 *
 *   - the FILE a `zitadel export` run (or a saved admin export response) wrote;
 *   - the ADMIN API, `POST /admin/v1/export` with a service-user token that has
 *     the IAM_OWNER role. When the export endpoint is refused or missing (older
 *     versions, a user that is only IAM_OWNER_VIEWER) the exporter falls back to
 *     listing users with the v2 user API: profile, email and phone, but no
 *     password hashes, TOTP seeds or social links.
 *
 * The export carries, per organization: the human users with their hashed
 * password (the exact `$2a$…`, `$argon2id$…`, `$scrypt$…`, `$pbkdf2-…` string
 * ZITADEL verifies), TOTP secret, social-login links, profile, verified email
 * and phone; project roles and user grants; organization members and domains;
 * identity providers. The ZITADEL user id is the `sub` of every ZITADEL token,
 * so it is the user id here.
 *
 * Not exportable: passkeys and U2F keys (ZITADEL keeps them only in its event
 * store), machine users' keys, and live sessions (ZITADEL sessions are opaque;
 * the bridge accepts ID tokens and JWT access tokens instead).
 *
 * Schemas: github.com/zitadel/zitadel proto/zitadel/admin.proto
 * (`ImportDataOrg`, `ExportDataRequest`) and management.proto
 * (`ImportHumanUserRequest`).
 */

export interface ZitadelSnapshot {
  /** `ImportDataOrg` objects (camelCase from the API, either case from a file). */
  orgs: Obj[];
  /** Identity provider templates (`POST /admin/v1/idps/templates/_search`), to type the links an export names only by id. */
  idpTemplates: Obj[];
  source: 'file' | 'api' | 'users';
  /** The instance URL (`https://acme-abc123.zitadel.cloud`), when known. */
  instance?: string;
}

export interface ZitadelMapOptions {
  /** Organizations become Atlas organizations: `all`, `skip`, or `auto` (when the instance has more than one). */
  orgs?: 'auto' | 'all' | 'skip';
}

/** A field by its camelCase name, falling back to snake_case (the files `zitadel export` writes use either). */
export function g(o: Obj | undefined, camel: string): unknown {
  if (!o) return undefined;
  if (o[camel] !== undefined) return o[camel];
  return o[camel.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)];
}
const gs = (o: Obj | undefined, camel: string) => str(g(o, camel));
const go = (o: Obj | undefined, camel: string): Obj | undefined => {
  const v = g(o, camel);
  return isObj(v) ? v : undefined;
};
const gl = (o: Obj | undefined, camel: string): Obj[] => objs(g(o, camel));

// ── reading an export file ──────────────────────────────────────────────────

/** The orgs in an export document: `{ orgs: [...] }`, a bare array, or one org object. */
export function readZitadelExport(doc: unknown): ZitadelSnapshot {
  let orgs: Obj[] = [];
  if (Array.isArray(doc)) orgs = objs(doc);
  else if (isObj(doc)) {
    const list = g(doc, 'orgs');
    if (Array.isArray(list)) orgs = objs(list);
    else if (g(doc, 'humanUsers') !== undefined || g(doc, 'orgId') !== undefined) orgs = [doc];
  }
  if (!orgs.length) throw new Error('No organizations found in the ZITADEL export (expected the JSON written by `zitadel export`: { "orgs": [ … ] }).');
  return { orgs, idpTemplates: [], source: 'file' };
}

// ── password hashes ─────────────────────────────────────────────────────────

/**
 * A ZITADEL `hashedPassword` ({ value, algorithm }) as a bundle password; null
 * when Atlas cannot verify it. ZITADEL stores the self-describing encoding its
 * hasher (passwap) verifies, so those are recognised by Atlas on their own
 * ("auto"); the one bare form (a hex MD5) is mapped by the algorithm hint.
 */
export function zitadelPassword(hashed: unknown): PasswordHash | null {
  const h = isObj(hashed) ? hashed : undefined;
  const value = str(h?.value) ?? (typeof hashed === 'string' ? str(hashed) : undefined);
  if (!value) return null;
  const hint = (str(h?.algorithm) ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value)) return { algorithm: 'bcrypt', hash: value };
  if (/^\$argon2(id|i|d)\$/.test(value)) return { algorithm: 'argon2', hash: value };
  // $scrypt$ln=…, $pbkdf2-sha256$i=…, $1$ (md5-crypt), $5$ / $6$ (sha-crypt), $P$ / $H$ (phpass).
  if (/^\$(scrypt|pbkdf2-sha(1|256|512))\$/.test(value) || /^\$(1|5|6)\$/.test(value) || /^\$[PH]\$/.test(value)) return { algorithm: 'auto', hash: value };
  if ((hint === 'md5' || hint === 'md5plain') && /^[0-9a-f]{32}$/i.test(value)) return { algorithm: 'md5', hash: value.toLowerCase(), params: { encoding: 'hex' } };
  return null;
}

// ── identity providers ──────────────────────────────────────────────────────

export interface Idp {
  id: string;
  name: string;
  /** `google`, `github`, `oidc`, `saml`, `jwt`, `ldap` … */
  kind: string;
  config: Obj;
}

/** `genericOidcIdps` → `oidc`, `googleIdps` → `google`, `azureAdIdps` → `microsoft`. */
function kindOfKey(key: string): string {
  const k = key.toLowerCase().replace(/idps?$/, '').replace(/^generic/, '').replace(/provider$/, '');
  if (k.startsWith('azure')) return 'microsoft';
  if (k.startsWith('gitlab')) return 'gitlab';
  if (k.startsWith('github')) return 'github';
  return k || 'oidc';
}

function kindOfType(type: string): string {
  return kindOfKey(type.replace(/^IDP_TYPE_/, '').replace(/_/g, '').toLowerCase());
}

/** The identity providers an export names, keyed by config id; templates from the API fill gaps. */
export function collectIdps(snap: ZitadelSnapshot): Map<string, Idp> {
  const out = new Map<string, Idp>();
  for (const org of snap.orgs) {
    for (const [key, list] of Object.entries(org)) {
      if (!/idps$/i.test(key) || !Array.isArray(list)) continue;
      for (const entry of objs(list)) {
        const id = str(g(entry, 'idpId')) ?? str(entry.id);
        if (!id) continue;
        const config = go(entry, 'idp') ?? entry;
        out.set(id, { id, name: gs(config, 'name') ?? id, kind: kindOfKey(key), config });
      }
    }
  }
  for (const t of snap.idpTemplates) {
    const id = str(t.id);
    if (!id || out.has(id)) continue;
    const type = str(t.type) ?? '';
    // The template object nests its settings under the type's own key (`oidc`, `google`, `saml` …).
    const tail = type.replace(/^IDP_TYPE_/, '').toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const nested = go(t, tail) ?? Object.entries(t).find(([k, v]) => k !== 'details' && isObj(v))?.[1];
    out.set(id, { id, name: str(t.name) ?? id, kind: type ? kindOfType(type) : 'oidc', config: isObj(nested) ? nested : t });
  }
  return out;
}

/** An IdP as an SSO connection (OIDC or SAML); null for kinds Atlas has no connection type for. */
function ssoConnection(idp: Idp, organizationId: string | undefined): SsoConnectionRecord | null {
  if (idp.kind === 'oidc') {
    const issuer = gs(idp.config, 'issuer');
    return compact<SsoConnectionRecord>({
      id: idp.id,
      name: idp.name,
      organization_id: organizationId,
      protocol: 'oidc',
      oidc: compact({ issuer, discovery_url: issuer ? `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration` : undefined, client_id: gs(idp.config, 'clientId'), scopes: strs(g(idp.config, 'scopes')) }),
      enabled: true,
    });
  }
  if (idp.kind === 'saml') {
    const xml = gs(idp.config, 'metadataXml');
    // bytes arrive base64-encoded from the API; a file may hold the XML itself.
    const metadata = xml && !xml.trimStart().startsWith('<') ? Buffer.from(xml, 'base64').toString('utf8') : xml;
    return compact<SsoConnectionRecord>({
      id: idp.id,
      name: idp.name,
      organization_id: organizationId,
      protocol: 'saml',
      saml: compact({ idp_metadata_xml: metadata, idp_metadata_url: gs(idp.config, 'metadataUrl') }),
      enabled: true,
    });
  }
  return null;
}

// ── mapping ─────────────────────────────────────────────────────────────────

/** ZITADEL TOTP defaults (pquerna/otp: SHA1, 6 digits, 30 seconds). */
const TOTP = { digits: 6, period: 30, algorithm: 'SHA1' as const };
const NOT_EXPORTABLE = 'ZITADEL keeps passkeys and security keys only in its event store; users register a passkey again.';

/** Metadata values are base64 bytes; JSON when they parse, else text. */
function decodeMetadata(value: unknown): unknown {
  const s = str(value);
  if (!s) return undefined;
  const text = Buffer.from(s, 'base64').toString('utf8');
  // eslint-disable-next-line no-control-regex -- intentionally detects control characters (non-text payload)
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) return s;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function mapZitadel(snap: ZitadelSnapshot, opts: ZitadelMapOptions = {}): RecordSet {
  const set = new RecordSet();
  const idps = collectIdps(snap);
  const providers = new Set<string>();
  const withOrgs = opts.orgs === 'all' || (opts.orgs !== 'skip' && snap.orgs.filter((o) => gs(go(o, 'org'), 'name')).length > 1);
  let hashes = 0;
  let unsupported = 0;
  let withTotp = 0;
  let badOtp = 0;
  let machine = 0;
  let unknownLinks = 0;
  let otherOrgRoles = 0;
  const seenUsers = new Set<string>();

  for (const org of snap.orgs) {
    const orgId = gs(org, 'orgId') ?? gs(org, 'id');
    const orgName = gs(go(org, 'org'), 'name') ?? gs(org, 'name');
    if (withOrgs && orgId && orgName) {
      const domains = gl(org, 'domains').flatMap((d) => (g(d, 'isVerified') === true && gs(d, 'domainName') ? [gs(d, 'domainName')!.toLowerCase()] : []));
      set.add('organization', compact({ id: orgId, name: orgName, domains }), orgId);
    }

    // project roles → app roles; user grants → the roles users hold
    for (const r of gl(org, 'projectRoles')) {
      const key = gs(r, 'roleKey');
      if (key) set.add('role', compact({ key, name: gs(r, 'displayName'), description: gs(r, 'group'), scope: 'app' as const }), key);
    }
    const grants = new Map<string, Set<string>>();
    for (const grant of gl(org, 'userGrants')) {
      const userId = gs(grant, 'userId');
      if (!userId) continue;
      const roles = grants.get(userId) ?? new Set<string>();
      for (const k of strs(g(grant, 'roleKeys'))) roles.add(k);
      grants.set(userId, roles);
    }
    const orgRoles = new Map<string, string[]>();
    for (const m of gl(org, 'orgMembers')) {
      const userId = gs(m, 'userId');
      if (userId) orgRoles.set(userId, strs(g(m, 'roles')));
    }
    const metadata = new Map<string, Obj>();
    for (const entry of gl(org, 'userMetadata')) {
      const userId = gs(entry, 'userId');
      if (!userId) continue;
      const bag_: Obj = metadata.get(userId) ?? {};
      for (const item of isObj(g(entry, 'metadata')) ? [g(entry, 'metadata') as Obj] : gl(entry, 'metadata')) {
        const key = gs(item, 'key');
        const value = decodeMetadata(g(item, 'value'));
        if (key && value !== undefined) bag_[key] = value;
      }
      metadata.set(userId, bag_);
    }
    machine += gl(org, 'machineUsers').length;

    for (const entry of gl(org, 'humanUsers')) {
      const id = gs(entry, 'userId');
      const u = go(entry, 'user') ?? entry;
      if (!id) continue;
      if (seenUsers.has(id)) continue;
      const profile = go(u, 'profile');
      const email = go(u, 'email');
      const phone = go(u, 'phone');
      const address = gs(email, 'email')?.toLowerCase();
      const userName = gs(u, 'userName');
      const number = e164(gs(phone, 'phone'));
      if (!address && !number && !userName) {
        set.omit('user', 'User with no email address, phone number or username');
        continue;
      }
      seenUsers.add(id);

      let password: PasswordHash | undefined;
      const hashed = g(u, 'hashedPassword');
      if (hashed !== undefined) {
        hashes++;
        const mapped = zitadelPassword(hashed);
        if (mapped) password = mapped;
        else unsupported++;
      }
      const roles = [...(grants.get(id) ?? [])];
      const meta = bag(metadata.get(id));
      set.add(
        'user',
        compact<UserRecord>({
          id,
          emails: address ? [{ email: address, verified: g(email, 'isEmailVerified') === true, primary: true }] : [],
          phones: number ? [{ phone: number, verified: g(phone, 'isPhoneVerified') === true, primary: true }] : [],
          username: userName && userName.toLowerCase() !== address ? userName : undefined,
          first_name: gs(profile, 'firstName'),
          last_name: gs(profile, 'lastName'),
          name: gs(profile, 'displayName') ?? gs(profile, 'nickName'),
          password,
          roles,
          private_metadata: meta ? { zitadel_metadata: meta } : undefined,
        }),
        id,
      );

      // TOTP secret (exported only with `withOtp`)
      const otp = gs(u, 'otpCode');
      if (otp) {
        withTotp++;
        const secret = otp.replace(/\s|=+$/g, '').toUpperCase();
        if (/^[A-Z2-7]+$/.test(secret)) {
          const factor: MfaFactorRecord = { user_id: id, type: 'totp', secret_base32: secret, ...TOTP, verified: true };
          set.add('mfa_factor', factor);
        } else badOtp++;
      }

      // social and enterprise links
      for (const link of gl(u, 'idps')) {
        const configId = gs(link, 'configId');
        const externalId = gs(link, 'externalUserId');
        if (!configId || !externalId) continue;
        const idp = idps.get(configId);
        if (!idp) {
          unknownLinks++;
          continue;
        }
        const social = socialKey(idp.kind);
        const sso = social ? null : ssoConnection(idp, withOrgs ? orgId : undefined);
        const provider = social ?? idp.name;
        providers.add(provider);
        set.add(
          'identity',
          compact<IdentityRecord>({
            user_id: id,
            provider,
            provider_user_id: externalId,
            kind: social ? 'oauth' : idp.kind === 'saml' ? 'saml' : idp.kind === 'oidc' ? 'oidc' : undefined,
            sso_connection_id: sso ? idp.id : undefined,
            email: address,
          }),
          `${configId}\u0000${externalId}`,
        );
      }

      // membership in the organization
      if (withOrgs && orgId) {
        const orgRole = orgRoles.get(id) ?? [];
        if (orgRole.some((r) => r !== 'ORG_OWNER')) otherOrgRoles++;
        set.add('membership', { organization_id: orgId, user_id: id, role: orgRole.includes('ORG_OWNER') ? 'admin' : 'member' }, `${orgId}\u0000${id}`);
      }
    }

    // SSO connections the organization owns
    for (const idp of idps.values()) {
      if (idp.kind !== 'oidc' && idp.kind !== 'saml') continue;
      const owns = Object.entries(org).some(([key, list]) => /idps$/i.test(key) && Array.isArray(list) && objs(list).some((e) => (gs(e, 'idpId') ?? str(e.id)) === idp.id));
      if (!owns) continue;
      const record = ssoConnection(idp, withOrgs ? orgId : undefined);
      if (record) set.add('sso_connection', record, idp.id);
    }
  }
  // Templates the API listed that no org file carried.
  for (const idp of idps.values()) {
    if (idp.kind !== 'oidc' && idp.kind !== 'saml') continue;
    const record = ssoConnection(idp, undefined);
    if (record) set.add('sso_connection', record, idp.id);
  }

  if (machine) set.omit('machine_user', 'Machine (service) users are not exported: recreate service accounts as Atlas API keys or M2M clients', machine);
  if (unsupported) set.warn(`${unsupported} password hash(es) are in a format Atlas cannot verify: those users move by lazy migration (preset zitadel) or reset their password.`);
  if (snap.source !== 'users') {
    if (!hashes) set.warn('The export carries no password hashes: run it with passwords included (`withPasswords`), or users move by lazy migration (preset zitadel).');
    if (!withTotp) set.warn('The export carries no TOTP secrets (run it with `withOtp`): users who use an authenticator enrol again in Atlas.');
  } else {
    set.warn('Users were listed through the v2 user API: it never returns password hashes, TOTP secrets or social links, so passwords move by lazy migration (preset zitadel), authenticator users enrol again and social users sign in once with their provider (linked by verified email). Use an IAM_OWNER service user to export everything.');
  }
  if (badOtp) set.warn(`${badOtp} TOTP secret(s) were not valid base32 and were left out; those users enrol an authenticator again.`);
  if (unknownLinks) set.warn(`${unknownLinks} social link(s) point at an identity provider the export does not describe and were left out: those users sign in once with their provider and are linked by verified email.`);
  if (otherOrgRoles) set.warn(`${otherOrgRoles} organization member(s) hold ZITADEL roles other than ORG_OWNER: they join as members; only owners become admins.`);
  set.warn(NOT_EXPORTABLE);
  set.manifest = compact({ origin: snap.instance ? `ZITADEL ${snap.instance.replace(/^https?:\/\//, '')}` : snap.source === 'file' ? 'ZITADEL export file' : 'ZITADEL', providers: [...providers].sort(), settings: { totp: { ...TOTP } } });
  return set;
}

// ── the API ─────────────────────────────────────────────────────────────────

export interface ZitadelApiOptions {
  /** `https://acme-abc123.zitadel.cloud` or your own domain; a bare host gets https. */
  instance: string;
  /** A service user's personal access token (IAM_OWNER, or IAM_OWNER_VIEWER for the no-secrets fallback). */
  token: string;
  pageSize?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

export function zitadelBase(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(s) ? s : `https://${s}`;
}

export function zitadelHttp(o: Pick<ZitadelApiOptions, 'instance' | 'token' | 'fetchImpl' | 'sleep'>): VendorHttp {
  return new VendorHttp({ vendor: 'ZITADEL', baseUrl: zitadelBase(o.instance), headers: { authorization: `Bearer ${o.token}` }, fetchImpl: o.fetchImpl, sleep: o.sleep });
}

/** Identity provider templates, to type the links; best effort (an older instance or a narrow role answers 4xx). */
export async function fetchIdpTemplates(http: VendorHttp): Promise<Obj[]> {
  try {
    const { body } = await http.post<unknown>('/admin/v1/idps/templates/_search', {});
    return isObj(body) ? objs(body.result) : [];
  } catch (err) {
    if (err instanceof VendorApiError && err.status > 0 && err.status < 500) return [];
    throw err;
  }
}

/** A v2 user (`POST /v2/users`) in the import shape the mapper reads. */
function fromV2User(u: Obj): { orgId?: string; entry: Obj } | null {
  const id = str(u.userId);
  const human = isObj(u.human) ? u.human : undefined;
  if (!id || !human) return null;
  const profile = isObj(human.profile) ? human.profile : {};
  const email = isObj(human.email) ? human.email : {};
  const phone = isObj(human.phone) ? human.phone : {};
  return {
    orgId: isObj(u.details) ? str(u.details.resourceOwner) : undefined,
    entry: {
      userId: id,
      user: {
        userName: str(u.username),
        profile: { firstName: str(profile.givenName), lastName: str(profile.familyName), displayName: str(profile.displayName), nickName: str(profile.nickName) },
        email: { email: str(email.email), isEmailVerified: email.isVerified === true },
        phone: { phone: str(phone.phone), isPhoneVerified: phone.isVerified === true },
      },
    },
  };
}

export async function fetchZitadel(o: ZitadelApiOptions): Promise<ZitadelSnapshot> {
  const progress = o.onProgress ?? (() => undefined);
  const http = zitadelHttp(o);
  const instance = zitadelBase(o.instance);
  progress('the instance export');
  try {
    const { body } = await http.post<unknown>('/admin/v1/export', { withPasswords: true, withOtp: true, responseOutput: true });
    const snap = readZitadelExport(body);
    progress('identity providers');
    return { ...snap, idpTemplates: await fetchIdpTemplates(http), source: 'api', instance };
  } catch (err) {
    // The export endpoint is IAM_OWNER-only and absent from old versions: fall back to listing users.
    if (!(err instanceof VendorApiError) || ![403, 404, 405, 501].includes(err.status)) throw err;
  }

  const size = o.pageSize ?? 100;
  const orgsById = new Map<string, Obj>();
  for (let offset = 0; ; offset += size) {
    progress(`organizations (${orgsById.size} so far)`);
    const { body } = await http.post<unknown>('/admin/v1/orgs/_search', { query: { offset: String(offset), limit: size } });
    const page = isObj(body) ? objs(body.result) : [];
    for (const org of page) {
      const id = str(org.id);
      if (id) orgsById.set(id, { orgId: id, org: { name: str(org.name) }, humanUsers: [] });
    }
    if (page.length < size) break;
  }
  const fallbackOrg = (id: string | undefined): Obj => {
    const key = id ?? '';
    if (!orgsById.has(key)) orgsById.set(key, { orgId: id, humanUsers: [] });
    return orgsById.get(key)!;
  };
  let users = 0;
  for (let offset = 0; ; offset += size) {
    progress(`users (${users} so far)`);
    const { body } = await http.post<unknown>('/v2/users', {
      query: { offset: String(offset), limit: size, asc: true },
      queries: [{ typeQuery: { type: 'TYPE_HUMAN' } }],
    });
    const page = isObj(body) ? objs(body.result) : [];
    for (const u of page) {
      const mapped = fromV2User(u);
      if (!mapped) continue;
      users++;
      (fallbackOrg(mapped.orgId).humanUsers as Obj[]).push(mapped.entry);
    }
    if (page.length < size) break;
  }
  return { orgs: [...orgsById.values()], idpTemplates: await fetchIdpTemplates(http), source: 'users', instance };
}

export async function exportZitadelApi(o: ZitadelApiOptions & ZitadelMapOptions): Promise<RecordSet> {
  return mapZitadel(await fetchZitadel(o), { orgs: o.orgs });
}
