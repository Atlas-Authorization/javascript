import { createHash } from 'node:crypto';
import type { IdentityRecord, MfaFactorRecord, PasswordHash, UserRecord } from '@atlasauth/migrate';
import { bool, col, json, text, time, timeMs, type Row, type Tables } from './frameworks/tables';
import { RecordSet, bag, compact, e164, isObj, objs, str, strs, type Obj } from './record-set';
import { keyOf, socialKey } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export authentik` — a self-hosted authentik (goauthentik)
 * instance onto the canonical bundle models. Two ways in:
 *
 *   DATABASE DUMP (the full export): authentik's API never returns password
 *   hashes, TOTP seeds, recovery codes or WebAuthn public keys, so the owner
 *   dumps authentik's own PostgreSQL tables (one `<table>.csv|json|ndjson` per
 *   table, `psql \copy`) and the exporter reads them on this machine:
 *
 *     authentik_core_user              → user (Django password digest verbatim,
 *                                        `!…` unusable passwords dropped)
 *     authentik_install_id             → the hashed `sub` (see below); never
 *                                        written to the bundle (old installs
 *                                        use the SECRET_KEY as the install id)
 *     authentik_core_group (+ parentage, user_groups / user_ak_groups)
 *                                      → app roles (default) or organizations;
 *                                        superuser groups → the `admin` role
 *     authentik_rbac_role (+ user_roles, group_roles)
 *                                      → app roles `rbac:<name>`
 *     authentik_core_usersourceconnection (+ oauth / saml subtables, sources)
 *                                      → identities; SAML sources → SSO connections
 *     authentik_core_token             → API keys (sha256 of the plaintext key,
 *                                        so `api` and `app_password` tokens keep working)
 *     authentik_stages_authenticator_* → TOTP (hex seed → base32, 6/8 digits,
 *                                        its step), static recovery tokens,
 *                                        WebAuthn passkeys, SMS / email factors
 *
 *   API (no hashes): `/api/v3` with an API token — users, groups, roles,
 *   source links, API keys (`view_key`). Passwords then move by lazy
 *   migration (the `authentik` preset) and factors are re-enrolled.
 *
 * THE USER ID. Atlas keys imported users by the subject the vendor's tokens
 * carry. authentik's OAuth2/OIDC providers choose `sub` per provider
 * (`sub_mode`, core: authentik/providers/oauth2/id_token.py `_resolve_sub`):
 *   hashed_user_id (default) sha256(f"{pk}-{install_id}") hex — `User.uid`
 *   user_id   the integer pk          user_uuid   the user's uuid
 *   user_username / user_email        user_upn    attributes.upn, else uid
 * The export uses one mode (`--set authentik-sub-mode`, or the one every
 * provider in the dump uses) and keeps the other ids in private metadata.
 */

export type AuthentikSubMode = 'hashed_user_id' | 'user_id' | 'user_uuid' | 'user_username' | 'user_email' | 'user_upn';
export const AUTHENTIK_SUB_MODES: readonly AuthentikSubMode[] = ['hashed_user_id', 'user_id', 'user_uuid', 'user_username', 'user_email', 'user_upn'];

export interface AuthentikExportOptions {
  /** authentik's tables (a dump directory read with `readDumpDir`): the full export. */
  tables?: Tables;
  /** The authentik URL (`https://auth.example.com`): the API export, and the SAML ACS URLs. */
  baseUrl?: string;
  /** An authentik API token (Directory → Tokens, intent API) for the API export. */
  token?: string;
  /** Which `sub` the apps' tokens carry; default: the mode the providers use, else hashed_user_id. */
  subMode?: AuthentikSubMode;
  /** The install id for `hashed_user_id` when the dump has no `authentik_install_id` table. */
  installId?: string;
  groupsAs?: 'roles' | 'organizations' | 'skip';
  /** The WebAuthn RP id for passkeys registered before authentik stored one per device. */
  rpId?: string;
  /** authentik has no verified-email flag: treat every address as verified. Default false. */
  trustEmails?: boolean;
  /** Carry the stored upstream OAuth access tokens of social links. Default false. */
  oauthTokens?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

/** One user as the dump or the API has it (the API never has `password`). */
interface AkUser {
  pk: string;
  uuid?: string;
  /** `User.uid` when the API reported it. */
  uid?: string;
  username?: string;
  email?: string;
  name?: string;
  password?: string;
  isActive: boolean;
  type?: string;
  path?: string;
  attributes: Obj;
  lastLogin?: string | number;
  dateJoined?: string | number;
}

interface AkGroup {
  id: string;
  name: string;
  isSuperuser: boolean;
  parents: string[];
  attributes?: Obj;
}

const SERVICE_TYPES = new Set(['service_account', 'internal_service_account']);

/** authentik's OAuth source types that are generic OIDC rather than a social network. */
const OIDC_SOURCE_TYPES = new Set(['openidconnect', 'okta', 'keycloak', 'authentik', 'entraid_oidc']);
/** Source types Atlas has under another key. */
const SOURCE_ALIASES: Record<string, string> = { azuread: 'microsoft', entraid: 'microsoft', mailcow: '', patreon: '', plex: '' };

export async function exportAuthentik(opts: AuthentikExportOptions): Promise<RecordSet> {
  if (opts.tables) return exportAuthentikDump(opts.tables, opts);
  if (!opts.baseUrl || !opts.token) {
    throw new Error('authentik export needs a database dump directory (AUTHENTIK_DUMP) or the authentik URL and an API token (AUTHENTIK_URL, AUTHENTIK_TOKEN).');
  }
  return exportAuthentikApi(opts);
}

// ── the user id ─────────────────────────────────────────────────────────────

/** `User.uid` (authentik/core/models.py): sha256 of "<pk>-<install id>", hex. */
export function authentikUid(pk: string, installId: string): string {
  return createHash('sha256').update(`${pk}-${installId}`, 'utf8').digest('hex');
}

/** The id a user's tokens carry as `sub` under a provider's sub_mode; undefined when the user has none. */
export function authentikSubject(u: AkUser, mode: AuthentikSubMode, installId?: string): string | undefined {
  const uid = u.uid ?? (installId ? authentikUid(u.pk, installId) : undefined);
  switch (mode) {
    case 'hashed_user_id':
      return uid;
    case 'user_id':
      return u.pk;
    case 'user_uuid':
      return u.uuid;
    case 'user_username':
      return u.username;
    case 'user_email':
      return u.email;
    case 'user_upn':
      return str(u.attributes.upn) ?? uid;
  }
}

// ── passwords ───────────────────────────────────────────────────────────────

const DJANGO_ARGON2 = /^argon2(\$argon2(?:id|i|d))\$(v=\d+\$)?(m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+)$/;
const DJANGO_BCRYPT = /^bcrypt\$(\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53})$/;
const DJANGO_SCRYPT = /^scrypt\$(\d+)\$([^$]+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)$/;

/**
 * A Django password digest (authentik uses Django's default hashers) as a
 * bundle password, in a form Atlas's registry verifies:
 *   pbkdf2_sha256$… / pbkdf2_sha1$…  → pbkdf2_django (verbatim)
 *   bcrypt_sha256$$2b$…              → bcrypt_sha256_django (verbatim)
 *   argon2$argon2id$v=19$…           → argon2, the argon2-cffi PHC string
 *                                      (a version-less hash is Argon2 v1.0: `v=16`)
 *   bcrypt$$2b$…                     → bcrypt, the plain bcrypt digest
 *   scrypt$<n>$<salt>$<r>$<p>$<hash> → scrypt with its parameters (64-byte key)
 * Null for an unusable (`!…`) or unknown digest.
 */
export function djangoPassword(digest: string | undefined): PasswordHash | null {
  const d = digest?.trim();
  if (!d || d.startsWith('!')) return null;
  if (/^pbkdf2_sha(1|256)\$\d+\$[^$]+\$.+$/.test(d)) return { algorithm: 'pbkdf2_django', hash: d };
  if (/^bcrypt_sha256\$\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(d)) return { algorithm: 'bcrypt_sha256_django', hash: d };
  const a = DJANGO_ARGON2.exec(d);
  if (a) return { algorithm: 'argon2', hash: `${a[1]}$${a[2] ?? 'v=16$'}${a[3]}` };
  const b = DJANGO_BCRYPT.exec(d);
  if (b) return { algorithm: 'bcrypt', hash: b[1]! };
  const s = DJANGO_SCRYPT.exec(d);
  if (s) {
    return {
      algorithm: 'scrypt',
      hash: s[5]!,
      salt: s[2]!,
      params: { n: Number(s[1]), r: Number(s[3]), p: Number(s[4]), encoding: 'base64', salt_encoding: 'utf8' },
    };
  }
  return null;
}

// ── TOTP ────────────────────────────────────────────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, unpadded. */
export function base32(bytes: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// ── shared mapping ──────────────────────────────────────────────────────────

interface MapContext {
  set: RecordSet;
  subMode: AuthentikSubMode;
  installId?: string;
  trustEmails: boolean;
  /** authentik pk → bundle user id, for every exported user. */
  ids: Map<string, string>;
  used: Set<string>;
}

/** One authentik user → a user record (null, with the reason omitted, when it is left out). */
function addUser(c: MapContext, u: AkUser, roles: string[] | undefined): void {
  if (u.username === 'AnonymousUser') return; // django-guardian's placeholder, never a person
  if (u.type && SERVICE_TYPES.has(u.type)) {
    c.set.omit('user', 'service account (tokens only, no sign-in): recreate it as an Atlas machine client');
    return;
  }
  const id = authentikSubject(u, c.subMode, c.installId);
  if (!id) {
    c.set.omit('user', c.subMode === 'user_email' ? 'no email address (the sub mode is user_email)' : `no ${c.subMode} value`);
    return;
  }
  const email = u.email?.toLowerCase();
  if (!email && !u.username) {
    c.set.omit('user', 'no email or username');
    return;
  }
  if (c.used.has(id)) {
    c.set.omit('user', `two users share the same ${c.subMode} (the first one is kept)`);
    return;
  }
  const verified = c.trustEmails || u.attributes.email_verified === true || u.attributes.email_verified === 'true';
  const attributes = Object.fromEntries(Object.entries(u.attributes).filter(([k]) => k !== 'email_verified'));
  const uid = u.uid ?? (c.installId ? authentikUid(u.pk, c.installId) : undefined);
  const password = djangoPassword(u.password);
  const user: UserRecord = compact({
    id,
    emails: email ? [{ email, verified, primary: true }] : undefined,
    username: u.username && u.username.toLowerCase() !== email ? u.username : undefined,
    name: u.name,
    password: password ?? undefined,
    roles: roles?.length ? roles : undefined,
    banned: u.isActive ? undefined : true,
    ban_reason: u.isActive ? undefined : 'Deactivated in authentik (is_active false)',
    private_metadata: bag({
      ...(Object.keys(attributes).length ? { authentik_attributes: attributes } : {}),
      authentik_pk: u.pk,
      ...(u.uuid ? { authentik_uuid: u.uuid } : {}),
      ...(uid ? { authentik_uid: uid } : {}),
      ...(u.path && u.path !== 'users' ? { authentik_path: u.path } : {}),
      ...(u.type && u.type !== 'internal' ? { authentik_type: u.type } : {}),
    }),
    created_at: u.dateJoined,
    last_sign_in_at: u.lastLogin,
  });
  c.ids.set(u.pk, id);
  c.used.add(id);
  c.set.add('user', user);
}

/** Groups (with their ancestors) → role keys / organizations; returns pk → role keys for the users. */
class GroupMapper {
  readonly key = new Map<string, string>();
  private readonly byId = new Map<string, AkGroup>();

  constructor(
    private readonly set: RecordSet,
    private readonly groups: AkGroup[],
    private readonly mode: 'roles' | 'organizations' | 'skip',
  ) {
    const used = new Set<string>();
    for (const g of groups) {
      this.byId.set(g.id, g);
      let key = keyOf(g.name);
      while (used.has(key)) key = `${key}_${g.id.replace(/-/g, '').slice(0, 6)}`;
      used.add(key);
      this.key.set(g.id, key);
    }
  }

  write(): void {
    if (this.mode === 'skip') return;
    for (const g of this.groups) {
      const parents = g.parents.map((p) => this.byId.get(p)?.name).filter((n): n is string => !!n);
      if (this.mode === 'organizations') {
        this.set.add('organization', compact({
          id: g.id,
          name: g.name,
          slug: this.key.get(g.id)!.replace(/[_:]/g, '-'),
          public_metadata: bag({ ...(parents.length ? { authentik_parent_groups: parents } : {}), ...(g.isSuperuser ? { authentik_superuser: true } : {}) }),
          private_metadata: bag(g.attributes),
        }));
      } else {
        this.set.add('role', compact({ key: this.key.get(g.id)!, name: g.name, description: parents.length ? `Child of ${parents.join(', ')} in authentik` : undefined, scope: 'app' as const }));
      }
    }
    if (this.mode === 'organizations' && this.groups.length) this.set.add('role', { key: 'member', name: 'Member', scope: 'organization' }, 'member');
    if (this.groups.some((g) => g.parents.length)) {
      this.set.warn('authentik group hierarchy is flattened: each group moves on its own (its parents are noted on it), and a member of a child group is not made a member of the parents.');
    }
  }

  /** A group and every ancestor (cycles are cut). */
  ancestry(id: string, seen = new Set<string>()): string[] {
    if (seen.has(id)) return [];
    seen.add(id);
    const g = this.byId.get(id);
    if (!g) return [];
    return [id, ...g.parents.flatMap((p) => this.ancestry(p, seen))];
  }

  /** Superuser through a group or one of its ancestors (authentik's `all_groups()`). */
  superuser(groupIds: string[]): boolean {
    return groupIds.some((id) => this.ancestry(id).some((a) => this.byId.get(a)?.isSuperuser));
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }
}

/** Identity provider name + kind for an authentik source. */
function sourceProvider(slug: string, providerType: string | undefined): { provider: string; kind: IdentityRecord['kind'] } {
  const type = providerType?.toLowerCase();
  if (type && OIDC_SOURCE_TYPES.has(type)) return { provider: slug, kind: 'oidc' };
  const alias = type !== undefined ? SOURCE_ALIASES[type] : undefined;
  if (alias) return { provider: alias, kind: 'oauth' };
  const social = type && alias === undefined ? socialKey(type) : null;
  return { provider: social ?? slug, kind: 'oauth' };
}

/** Every user's role keys from groups and RBAC roles. */
function rolesFor(
  groups: GroupMapper,
  groupsAs: 'roles' | 'organizations' | 'skip',
  memberOf: string[],
  rbac: string[],
): string[] {
  const out: string[] = [];
  if (groupsAs === 'roles') for (const g of memberOf) if (groups.key.has(g)) out.push(groups.key.get(g)!);
  if (groups.superuser(memberOf)) out.push('admin');
  out.push(...rbac);
  return [...new Set(out)];
}

const pushTo = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);

// ── database dump ───────────────────────────────────────────────────────────

/** A sub mode every OAuth2 provider in the dump agrees on, else undefined (several, or none). */
function providersSubMode(tables: Tables): { mode?: AuthentikSubMode; modes: string[] } {
  const modes = [...new Set(tables.rows('authentik_providers_oauth2_oauth2provider').map((r) => text(col(r, 'sub_mode')) ?? 'hashed_user_id'))].sort();
  const only = modes.length === 1 ? modes[0] : undefined;
  return { mode: only && (AUTHENTIK_SUB_MODES as readonly string[]).includes(only) ? (only as AuthentikSubMode) : undefined, modes };
}

export function exportAuthentikDump(tables: Tables, opts: Omit<AuthentikExportOptions, 'tables'> = {}): RecordSet {
  const set = new RecordSet();
  const now = (opts.now ?? new Date()).getTime();
  const userRows = tables.rows('authentik_core_user');
  if (!userRows.length) {
    set.warn('No authentik_core_user rows in the dump: dump authentik\'s database tables (see the guide) and pass the directory.');
    return set;
  }
  const providers = providersSubMode(tables);
  const subMode = opts.subMode ?? providers.mode ?? 'hashed_user_id';
  if (providers.modes.length > 1) {
    set.warn(`authentik providers use different sub modes (${providers.modes.join(', ')}): users are keyed by ${subMode}; tokens from the other providers do not bridge (their ids are kept in private metadata).`);
  } else if (opts.subMode && providers.mode && providers.mode !== opts.subMode) {
    set.warn(`The dump's OAuth2 providers use sub mode ${providers.mode}, but the export keys users by ${opts.subMode}: bridged tokens will not match.`);
  }
  const installId = opts.installId ?? text(col(tables.rows('authentik_install_id')[0] ?? {}, 'id'));
  if (!installId && subMode === 'hashed_user_id') {
    throw new Error(
      'The authentik install id is needed for the hashed user ids your tokens carry: dump the authentik_install_id table too, or pass --set authentik-install-id=<id> (SELECT id FROM authentik_install_id).',
    );
  }
  const groupsAs = opts.groupsAs ?? 'roles';

  // Groups: the parent column (before 2025.10) or the parentage table (since).
  const parentage = new Map<string, string[]>();
  for (const r of tables.rows('authentik_core_groupparentage')) {
    const child = text(col(r, 'child_id'));
    const parent = text(col(r, 'parent_id'));
    if (child && parent) pushTo(parentage, child, parent);
  }
  const groups: AkGroup[] = [];
  for (const r of tables.rows('authentik_core_group')) {
    const id = text(col(r, 'group_uuid', 'id'));
    const name = text(col(r, 'name'));
    if (!id || !name) continue;
    const legacyParent = text(col(r, 'parent_id'));
    groups.push({ id, name, isSuperuser: bool(col(r, 'is_superuser')), parents: parentage.get(id) ?? (legacyParent ? [legacyParent] : []), attributes: bag(json(col(r, 'attributes'))) });
  }
  const gm = new GroupMapper(set, groups, groupsAs);
  gm.write();

  // User ↔ group: `ak_groups` until 2026.2 renamed it `groups` (the old `groups` table pointed at Django's auth_group).
  const memberRows = tables.find('authentik_core_user_ak_groups')?.rows ?? tables.rows('authentik_core_user_groups');
  const memberOf = new Map<string, string[]>();
  for (const r of memberRows) {
    const uid = text(col(r, 'user_id'));
    const gid = text(col(r, 'group_id'));
    if (uid && gid && gm.has(gid)) pushTo(memberOf, uid, gid);
  }

  // RBAC roles: assigned to users directly, to groups (many-to-many, or one group per role before 2025.10).
  const roleKey = new Map<string, string>();
  const roleGroups = new Map<string, string[]>();
  for (const r of tables.rows('authentik_rbac_role')) {
    const id = text(col(r, 'uuid', 'id'));
    const name = text(col(r, 'name'));
    if (!id || !name) continue;
    const key = `rbac:${keyOf(name)}`;
    roleKey.set(id, key);
    set.add('role', { key, name, description: 'authentik RBAC role (authentik admin permissions do not carry over)', scope: 'app' }, key);
    const g = text(col(r, 'group_id'));
    if (g) pushTo(roleGroups, g, id);
  }
  for (const r of tables.rows('authentik_core_group_roles')) {
    const g = text(col(r, 'group_id'));
    const role = text(col(r, 'role_id'));
    if (g && role) pushTo(roleGroups, g, role);
  }
  const userRoles = new Map<string, string[]>();
  for (const r of tables.rows('authentik_core_user_roles', 'authentik_rbac_role_users')) {
    const u = text(col(r, 'user_id'));
    const role = text(col(r, 'role_id'));
    if (u && role) pushTo(userRoles, u, role);
  }

  const c: MapContext = { set, subMode, installId, trustEmails: opts.trustEmails === true, ids: new Map(), used: new Set() };
  let unusable = 0;
  for (const r of userRows) {
    const pk = text(col(r, 'id', 'pk'));
    if (!pk) continue;
    const digest = text(col(r, 'password'));
    const groupsOfUser = memberOf.get(pk) ?? [];
    const rbacIds = new Set([...(userRoles.get(pk) ?? []), ...groupsOfUser.flatMap((g) => gm.ancestry(g)).flatMap((g) => roleGroups.get(g) ?? [])]);
    const rbac = [...roleKey.entries()].filter(([id]) => rbacIds.has(id)).map(([, k]) => k);
    addUser(
      c,
      {
        pk,
        uuid: text(col(r, 'uuid')),
        username: text(col(r, 'username')),
        email: text(col(r, 'email')),
        name: text(col(r, 'name')),
        password: digest,
        isActive: col(r, 'is_active') === undefined ? true : bool(col(r, 'is_active')),
        type: text(col(r, 'type')),
        path: text(col(r, 'path')),
        attributes: json(col(r, 'attributes')) ?? {},
        lastLogin: time(col(r, 'last_login')),
        dateJoined: time(col(r, 'date_joined')),
      },
      rolesFor(gm, groupsAs, groupsOfUser, rbac),
    );
    if (!c.ids.has(pk)) continue;
    if (!digest || digest.startsWith('!')) unusable++;
    else if (!djangoPassword(digest)) {
      set.warn('Some password hashes are in a Django format Atlas cannot verify (legacy MD5 / SHA1 / crypt hashers): those users sign in through lazy migration or reset their password.');
    }
  }
  if (unusable) set.warn(`${unusable} user(s) had no usable password (source-only accounts, or set_unusable_password): they sign in through their linked identities or reset their password.`);
  if (groupsAs === 'organizations') {
    for (const [pk, gids] of memberOf) {
      const id = c.ids.get(pk);
      if (id) for (const g of gids) set.add('membership', { organization_id: g, user_id: id, role: 'member' }, `${g}:${id}`);
    }
  }
  if (set.list('user').some((u) => u.roles?.includes('admin'))) set.add('role', { key: 'admin', name: 'Admin', description: 'Members of an authentik superuser group', scope: 'app' }, 'admin');

  addDumpSources(set, tables, c, opts);
  addDumpTokens(set, tables, c, now);
  addDumpFactors(set, tables, c, opts);

  set.manifest = {
    ...set.manifest,
    origin: opts.baseUrl ? hostOf(opts.baseUrl) : 'authentik database dump',
    providers: [...new Set(set.list('identity').map((i) => i.provider))].sort(),
    settings: { sub_mode: subMode, groups_as: groupsAs, ...(providers.modes.length ? { provider_sub_modes: providers.modes } : {}) },
  };
  return set;
}

function addDumpSources(set: RecordSet, tables: Tables, c: MapContext, opts: AuthentikExportOptions): void {
  const sources = new Map<string, Row>();
  for (const r of tables.rows('authentik_core_source')) {
    const id = text(col(r, 'pbm_uuid', 'id'));
    if (id) sources.set(id, r);
  }
  const oauth = new Map(tables.rows('authentik_sources_oauth_oauthsource').map((r) => [text(col(r, 'source_ptr_id')) ?? '', r] as const));
  const saml = new Map(tables.rows('authentik_sources_saml_samlsource').map((r) => [text(col(r, 'source_ptr_id')) ?? '', r] as const));
  const certs = new Map(tables.rows('authentik_crypto_certificatekeypair').map((r) => [text(col(r, 'kp_uuid', 'id')) ?? '', r] as const));

  for (const [id, s] of saml) {
    const base = sources.get(id) ?? {};
    const slug = text(col(base, 'slug')) ?? id;
    const cert = text(col(certs.get(text(col(s, 'verification_kp_id')) ?? '') ?? {}, 'certificate_data'));
    set.add('sso_connection', compact({
      id,
      name: text(col(base, 'name')) ?? slug,
      protocol: 'saml' as const,
      enabled: col(base, 'enabled') === undefined ? true : bool(col(base, 'enabled')),
      saml: compact({
        idp_sso_url: text(col(s, 'sso_url')),
        idp_certificate: cert,
        // authentik's `issuer` is ITS entity id (the SP side); the IdP must be repointed at Atlas's.
        sp_entity_id: text(col(s, 'issuer')),
        sp_acs_url: opts.baseUrl ? `${opts.baseUrl.replace(/\/+$/, '')}/source/saml/${slug}/acs/` : undefined,
      }),
    }));
  }

  const oauthConn = new Map(tables.rows('authentik_sources_oauth_useroauthsourceconnection').map((r) => [text(col(r, 'usersourceconnection_ptr_id')) ?? '', r] as const));
  const samlConn = new Map(tables.rows('authentik_sources_saml_usersamlsourceconnection').map((r) => [text(col(r, 'usersourceconnection_ptr_id')) ?? '', r] as const));
  let federated = 0;
  for (const r of tables.rows('authentik_core_usersourceconnection')) {
    const connId = text(col(r, 'id'));
    const userId = c.ids.get(text(col(r, 'user_id')) ?? '');
    const sourceId = text(col(r, 'source_id')) ?? '';
    if (!connId || !userId) {
      set.omit('identity', 'source link of a user not in the export');
      continue;
    }
    const o = oauthConn.get(connId);
    const sm = samlConn.get(connId);
    // `identifier` moved from the subtables to the base table in 2025.2.
    const identifier = text(col(r, 'identifier')) ?? text(col(o ?? sm ?? {}, 'identifier'));
    const source = sources.get(sourceId) ?? {};
    const slug = text(col(source, 'slug')) ?? sourceId;
    if (!identifier) {
      set.omit('identity', 'source link without an identifier');
      continue;
    }
    if (saml.has(sourceId) || sm) {
      set.add('identity', compact({ user_id: userId, provider: slug, provider_user_id: identifier, kind: 'saml' as const, sso_connection_id: saml.has(sourceId) ? sourceId : undefined }));
      continue;
    }
    const os = oauth.get(sourceId);
    if (!os && !o) {
      // LDAP / Kerberos / Plex / SCIM links: the account lives in that directory.
      federated++;
      continue;
    }
    const { provider, kind } = sourceProvider(slug, text(col(os ?? {}, 'provider_type')));
    set.add('identity', compact({
      user_id: userId,
      provider,
      provider_user_id: identifier,
      kind,
      access_token: opts.oauthTokens ? text(col(o ?? {}, 'access_token')) : undefined,
      refresh_token: opts.oauthTokens ? text(col(o ?? {}, 'refresh_token')) : undefined,
      expires_at: opts.oauthTokens ? time(col(o ?? {}, 'expires')) : undefined,
      profile: { authentik_source: slug },
    }));
  }
  if (federated) {
    set.omit('identity', 'LDAP / Kerberos / other directory source link: the password lives in that directory (lazy migration against authentik covers these users)', federated);
  }
}

function addDumpTokens(set: RecordSet, tables: Tables, c: MapContext, now: number): void {
  for (const r of tables.rows('authentik_core_token')) {
    const intent = text(col(r, 'intent'));
    if (intent !== 'api' && intent !== 'app_password') {
      set.omit('api_key', 'recovery / verification token (single-use links, not API keys)');
      continue;
    }
    if (text(col(r, 'managed'))) {
      set.omit('api_key', 'token managed by authentik (outposts, internal service accounts)');
      continue;
    }
    const userId = c.ids.get(text(col(r, 'user_id')) ?? '');
    if (!userId) {
      set.omit('api_key', 'token of a user not in the export (service accounts: issue an Atlas machine credential)');
      continue;
    }
    const expiring = col(r, 'expiring') === undefined ? true : bool(col(r, 'expiring'));
    const expires = expiring ? timeMs(col(r, 'expires')) : undefined;
    if (expires !== undefined && expires <= now) {
      set.omit('api_key', 'expired');
      continue;
    }
    const key = text(col(r, 'key'));
    const identifier = text(col(r, 'identifier'));
    if (!key || !identifier) {
      set.omit('api_key', 'token without its key');
      continue;
    }
    set.add('api_key', compact({
      id: text(col(r, 'token_uuid')) ?? identifier,
      user_id: userId,
      name: text(col(r, 'description')) ? `${identifier} (${text(col(r, 'description'))})` : identifier,
      hash: createHash('sha256').update(key, 'utf8').digest('hex'),
      hash_algorithm: 'sha256' as const,
      start: key.slice(0, 4),
      scopes: intent === 'app_password' ? ['authentik:app_password'] : undefined,
      expires_at: expires !== undefined ? new Date(expires).toISOString() : undefined,
    }));
  }
}

function addDumpFactors(set: RecordSet, tables: Tables, c: MapContext, opts: AuthentikExportOptions): void {
  const owner = (r: Row) => c.ids.get(text(col(r, 'user_id')) ?? '');
  const confirmed = (r: Row) => col(r, 'confirmed') === undefined || bool(col(r, 'confirmed'));

  for (const r of tables.rows('authentik_stages_authenticator_totp_totpdevice')) {
    const userId = owner(r);
    if (!userId) continue;
    if (!confirmed(r)) {
      set.omit('mfa_factor', 'TOTP device never confirmed');
      continue;
    }
    const hex = text(col(r, 'key'));
    if (!hex || !/^([0-9a-f]{2})+$/i.test(hex)) {
      set.omit('mfa_factor', 'TOTP device without a hex seed');
      continue;
    }
    const digits = Number(col(r, 'digits') ?? 6);
    const period = Number(col(r, 'step') ?? 30);
    if (Number(col(r, 't0') ?? 0) !== 0) set.warn('Some TOTP devices count steps from a non-zero t0: Atlas counts from the Unix epoch, so those users re-enrol if their codes are refused.');
    const factor: MfaFactorRecord = compact({
      id: `totp_${text(col(r, 'id')) ?? userId}`,
      user_id: userId,
      type: 'totp' as const,
      secret_base32: base32(Buffer.from(hex, 'hex')),
      digits: digits === 8 ? 8 : 6,
      period: Number.isFinite(period) && period > 0 ? period : 30,
      algorithm: 'SHA1' as const,
      verified: true,
      created_at: time(col(r, 'created')),
    });
    set.add('mfa_factor', factor);
  }

  // Static (recovery) tokens are stored in plaintext and deleted when used: what is left is unused.
  const tokens = new Map<string, string[]>();
  for (const t of tables.rows('authentik_stages_authenticator_static_statictoken')) {
    const device = text(col(t, 'device_id'));
    const token = text(col(t, 'token'));
    if (device && token) pushTo(tokens, device, token);
  }
  for (const r of tables.rows('authentik_stages_authenticator_static_staticdevice')) {
    const userId = owner(r);
    const codes = tokens.get(text(col(r, 'id')) ?? '') ?? [];
    if (!userId || !confirmed(r)) continue;
    if (!codes.length) {
      set.omit('mfa_factor', 'recovery-code device with no unused codes');
      continue;
    }
    set.add('mfa_factor', { id: `static_${text(col(r, 'id'))}`, user_id: userId, type: 'backup_codes', backup_codes: codes, verified: true });
  }

  for (const r of tables.rows('authentik_stages_authenticator_sms_smsdevice')) {
    const userId = owner(r);
    const phone = e164(col(r, 'phone_number'));
    if (!userId || !confirmed(r)) continue;
    if (!phone) {
      set.omit('mfa_factor', 'SMS device without an E.164 number (hashed numbers cannot move)');
      continue;
    }
    set.add('mfa_factor', { id: `sms_${text(col(r, 'id'))}`, user_id: userId, type: 'phone', phone, verified: true });
  }
  for (const r of tables.rows('authentik_stages_authenticator_email_emaildevice')) {
    const userId = owner(r);
    if (!userId || !confirmed(r)) continue;
    set.add('mfa_factor', { id: `email_${text(col(r, 'id'))}`, user_id: userId, type: 'email', verified: true });
  }
  const duo = tables.rows('authentik_stages_authenticator_duo_duodevice').filter((r) => owner(r)).length;
  if (duo) set.omit('mfa_factor', 'Duo device (the enrolment lives at Duo): users enrol an Atlas factor', duo);

  let noRp = 0;
  const rps = new Set<string>();
  for (const r of tables.rows('authentik_stages_authenticator_webauthn_webauthndevice')) {
    const userId = owner(r);
    if (!userId) continue;
    const credentialId = b64url(col(r, 'credential_id'));
    const publicKey = b64url(col(r, 'public_key'));
    const rpId = text(col(r, 'rp_id')) ?? opts.rpId;
    if (!credentialId || !publicKey) {
      set.omit('passkey', 'WebAuthn device without its credential id or public key');
      continue;
    }
    if (!rpId) {
      noRp++;
      continue;
    }
    rps.add(rpId);
    const aaguid = text(col(r, 'aaguid'));
    set.add('passkey', compact({
      id: `webauthn_${text(col(r, 'id'))}`,
      user_id: userId,
      credential_id: credentialId,
      public_key: publicKey,
      sign_count: Number(col(r, 'sign_count') ?? 0) || 0,
      rp_id: rpId,
      aaguid: aaguid && aaguid !== '00000000-0000-0000-0000-000000000000' ? aaguid : undefined,
      name: text(col(r, 'name')),
      created_at: time(col(r, 'created_on')),
    }));
  }
  if (noRp) set.omit('passkey', 'registered before authentik stored the RP id: pass --set rp-id=<authentik host>', noRp);
  if (rps.size === 1) set.manifest.rpId = [...rps][0]!;
  if (rps.size) set.warn(`Passkeys only work on the domain they were registered for (${[...rps].join(', ')}): serve Atlas sign-in there, or users register them again.`);
}

/** authentik stores WebAuthn ids/keys as base64url; accept padded / standard base64 too. */
function b64url(v: unknown): string | undefined {
  const s = text(v);
  if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return undefined;
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64url');
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

// ── API ─────────────────────────────────────────────────────────────────────

/** Every page of an authentik list endpoint (`{ pagination: { next }, results }`, next = 0 on the last page). */
export async function authentikList(http: VendorHttp, path: string): Promise<Obj[]> {
  const out: Obj[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1, guard = 0; page > 0 && guard < 10_000; guard++) {
    const { body } = await http.get<{ pagination?: { next?: number }; results?: unknown }>(`${path}${sep}page=${page}&page_size=100`);
    out.push(...objs(body?.results));
    const next = Number(body?.pagination?.next ?? 0);
    page = Number.isFinite(next) && next > page ? next : 0;
  }
  return out;
}

/** A list endpoint the token may not reach (or an older authentik lacks): empty, with a warning. */
async function optionalList(set: RecordSet, http: VendorHttp, path: string, what: string): Promise<Obj[]> {
  try {
    return await authentikList(http, path);
  } catch (err) {
    if (err instanceof VendorApiError && [403, 404].includes(err.status)) {
      set.warn(`${what} could not be read with this token (${err.status}): skipped.`);
      return [];
    }
    throw err;
  }
}

export async function exportAuthentikApi(opts: AuthentikExportOptions): Promise<RecordSet> {
  const base = opts.baseUrl!.replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/.test(base)) throw new Error(`Not an authentik URL: ${opts.baseUrl}`);
  const set = new RecordSet();
  const now = (opts.now ?? new Date()).getTime();
  const progress = opts.onProgress ?? (() => undefined);
  const http = new VendorHttp({ vendor: 'authentik', baseUrl: `${base}/api/v3`, headers: { authorization: `Bearer ${opts.token}` }, fetchImpl: opts.fetchImpl, sleep: opts.sleep });
  const groupsAs = opts.groupsAs ?? 'roles';
  const subMode = opts.subMode ?? 'hashed_user_id';

  progress('groups');
  const rawGroups = groupsAs === 'skip' ? [] : await authentikList(http, '/core/groups/?include_users=false');
  const groups: AkGroup[] = rawGroups
    .map((g) => ({
      id: str(g.pk) ?? '',
      name: str(g.name) ?? '',
      isSuperuser: g.is_superuser === true,
      // `parents` (a list) since 2025.10, `parent` before.
      parents: Array.isArray(g.parents) ? strs(g.parents) : str(g.parent) ? [str(g.parent)!] : [],
      attributes: bag(g.attributes),
    }))
    .filter((g) => g.id && g.name);
  const gm = new GroupMapper(set, groups, groupsAs);
  gm.write();

  progress('roles');
  const roleKey = new Map<string, string>();
  for (const r of await optionalList(set, http, '/rbac/roles/', 'RBAC roles')) {
    const id = str(r.pk);
    const name = str(r.name);
    if (!id || !name) continue;
    const key = `rbac:${keyOf(name)}`;
    roleKey.set(id, key);
    set.add('role', { key, name, description: 'authentik RBAC role (authentik admin permissions do not carry over)', scope: 'app' }, key);
  }
  const groupRoles = new Map(rawGroups.map((g) => [str(g.pk) ?? '', strs(g.roles)] as const));

  progress('users');
  const c: MapContext = { set, subMode, installId: opts.installId, trustEmails: opts.trustEmails === true, ids: new Map(), used: new Set() };
  const memberOf = new Map<string, string[]>();
  for (const u of await authentikList(http, '/core/users/?include_groups=false')) {
    const pk = str(u.pk);
    if (!pk) continue;
    const gids = strs(u.groups).filter((g) => gm.has(g));
    memberOf.set(pk, gids);
    const rbacIds = new Set([...strs(u.roles), ...gids.flatMap((g) => gm.ancestry(g)).flatMap((g) => groupRoles.get(g) ?? [])]);
    const rbac = [...roleKey.entries()].filter(([id]) => rbacIds.has(id)).map(([, k]) => k);
    addUser(
      c,
      {
        pk,
        uuid: str(u.uuid),
        uid: str(u.uid),
        username: str(u.username),
        email: str(u.email),
        name: str(u.name),
        isActive: u.is_active !== false,
        type: str(u.type),
        path: str(u.path),
        attributes: isObj(u.attributes) ? u.attributes : {},
        lastLogin: str(u.last_login),
        dateJoined: str(u.date_joined),
      },
      rolesFor(gm, groupsAs, gids, rbac),
    );
  }
  if (groupsAs === 'organizations') {
    for (const [pk, gids] of memberOf) {
      const id = c.ids.get(pk);
      if (id) for (const g of gids) set.add('membership', { organization_id: g, user_id: id, role: 'member' }, `${g}:${id}`);
    }
  }
  if (set.list('user').some((u) => u.roles?.includes('admin'))) set.add('role', { key: 'admin', name: 'Admin', description: 'Members of an authentik superuser group', scope: 'app' }, 'admin');
  if (c.ids.size) {
    set.warn(
      "authentik's API never returns password hashes or authenticator secrets: turn on the authentik lazy-migration preset (passwords are checked against authentik's flow executor on first sign-in), or export from a database dump to move hashes, TOTP seeds, recovery codes and passkeys.",
    );
  }

  progress('sources');
  const oauthSources = new Map((await optionalList(set, http, '/sources/oauth/', 'OAuth sources')).map((s) => [str(s.slug) ?? '', s] as const));
  for (const s of await optionalList(set, http, '/sources/saml/', 'SAML sources')) {
    const id = str(s.pk);
    const slug = str(s.slug);
    if (!id || !slug) continue;
    let cert: string | undefined;
    const kp = str(s.verification_kp);
    if (kp) {
      try {
        const { body } = await http.get<{ data?: string }>(`/crypto/certificatekeypairs/${encodeURIComponent(kp)}/view_certificate/`);
        cert = str(body?.data);
      } catch (err) {
        if (!(err instanceof VendorApiError)) throw err;
      }
    }
    set.add('sso_connection', compact({
      id,
      name: str(s.name) ?? slug,
      protocol: 'saml' as const,
      enabled: s.enabled !== false,
      saml: compact({ idp_sso_url: str(s.sso_url), idp_certificate: cert, sp_entity_id: str(s.issuer), sp_acs_url: `${base}/source/saml/${slug}/acs/` }),
    }));
  }
  const samlIds = new Set(set.list('sso_connection').map((s) => s.id));
  for (const [path, kind] of [
    ['/sources/user_connections/oauth/', 'oauth'],
    ['/sources/user_connections/saml/', 'saml'],
  ] as const) {
    for (const conn of await optionalList(set, http, path, `${kind.toUpperCase()} source links`)) {
      const userId = c.ids.get(str(conn.user) ?? '');
      const source = isObj(conn.source_obj) ? conn.source_obj : isObj(conn.source) ? conn.source : {};
      const slug = str(source.slug);
      const identifier = str(conn.identifier);
      if (!userId || !slug || !identifier) {
        set.omit('identity', 'source link of a user not in the export');
        continue;
      }
      if (kind === 'saml') {
        const sid = str(source.pk);
        set.add('identity', compact({ user_id: userId, provider: slug, provider_user_id: identifier, kind: 'saml' as const, sso_connection_id: sid && samlIds.has(sid) ? sid : undefined }));
        continue;
      }
      const { provider, kind: k } = sourceProvider(slug, str(oauthSources.get(slug)?.provider_type) ?? str(source.provider_type));
      set.add('identity', { user_id: userId, provider, provider_user_id: identifier, kind: k, profile: { authentik_source: slug } });
    }
  }

  progress('tokens');
  for (const t of await optionalList(set, http, '/core/tokens/', 'Tokens')) {
    const intent = str(t.intent);
    const identifier = str(t.identifier);
    if (intent !== 'api' && intent !== 'app_password') {
      set.omit('api_key', 'recovery / verification token (single-use links, not API keys)');
      continue;
    }
    if (str(t.managed)) {
      set.omit('api_key', 'token managed by authentik (outposts, internal service accounts)');
      continue;
    }
    const userId = c.ids.get(str(t.user) ?? '');
    if (!userId || !identifier) {
      set.omit('api_key', 'token of a user not in the export (service accounts: issue an Atlas machine credential)');
      continue;
    }
    const expires = t.expiring !== false && str(t.expires) ? Date.parse(str(t.expires)!) : undefined;
    if (expires !== undefined && Number.isFinite(expires) && expires <= now) {
      set.omit('api_key', 'expired');
      continue;
    }
    let key: string | undefined;
    try {
      const { body } = await http.get<{ key?: string }>(`/core/tokens/${encodeURIComponent(identifier)}/view_key/`);
      key = str(body?.key);
    } catch (err) {
      if (!(err instanceof VendorApiError)) throw err;
    }
    if (!key) {
      set.omit('api_key', 'the token key was not readable (view_key needs the "View token key" permission)');
      continue;
    }
    set.add('api_key', compact({
      id: identifier,
      user_id: userId,
      name: str(t.description) ? `${identifier} (${str(t.description)})` : identifier,
      hash: createHash('sha256').update(key, 'utf8').digest('hex'),
      hash_algorithm: 'sha256' as const,
      start: key.slice(0, 4),
      scopes: intent === 'app_password' ? ['authentik:app_password'] : undefined,
      expires_at: expires !== undefined && Number.isFinite(expires) ? new Date(expires).toISOString() : undefined,
    }));
  }

  progress('authenticators');
  for (const [path, label] of [
    ['/authenticators/admin/totp/', 'TOTP device'],
    ['/authenticators/admin/static/', 'recovery-code device'],
    ['/authenticators/admin/webauthn/', 'WebAuthn device'],
  ] as const) {
    const n = (await optionalList(set, http, path, `${label}s`)).length;
    if (n) set.omit(path.includes('webauthn') ? 'passkey' : 'mfa_factor', `${label}: the API never returns its secret (export from a database dump to move it; otherwise users re-enrol)`, n);
  }

  set.manifest = {
    origin: hostOf(base),
    providers: [...new Set(set.list('identity').map((i) => i.provider))].sort(),
    settings: { sub_mode: subMode, groups_as: groupsAs },
  };
  return set;
}
