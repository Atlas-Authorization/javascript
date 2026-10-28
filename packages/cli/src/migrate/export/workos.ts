import type { UserRecord } from '@atlasauth/migrate';
import { parseCsv } from '../../import/csv';
import { RecordSet, bag, compact, isObj, objs, str, strs, type Obj } from './record-set';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate export workos` — a WorkOS environment (AuthKit + SSO +
 * Directory Sync) onto the canonical bundle models, read with an API key on
 * this machine.
 *
 *   - organizations (verified domains, metadata), environment roles and each
 *     organization's custom roles, memberships with their role slug, pending
 *     and past invitations;
 *   - users (verified email, names, avatar, metadata, last sign-in) with the
 *     OAuth identities WorkOS holds for them (provider user ids, so social
 *     sign-in relinks exactly);
 *   - SSO connections (SAML / OIDC) with the IdP signing certificates WorkOS
 *     returns; the IdP entity id, SSO URL and OIDC client secret are NOT
 *     available through the API, so the customer's IdP is reconfigured against
 *     the new Atlas connection;
 *   - password hashes: WorkOS publishes no export of them (only an import
 *     path). If WorkOS support gives you a hash file, pass it
 *     (--workos-hashes-file); otherwise turn on the `workos` lazy-migration
 *     preset, which checks each password against WorkOS on first sign-in.
 *
 * Not exportable: TOTP secrets and passkeys (users enrol again), API key
 * secrets (reissue as Atlas API keys), sessions (the `workos` bridge preset
 * exchanges the access token). Directory Sync directories are reconnected in
 * Atlas SCIM.
 */

export interface WorkosExportOptions {
  apiKey: string;
  /** For the manifest only (the client id appears in token issuers). */
  clientId?: string;
  /** API base (default https://api.workos.com). */
  baseUrl?: string;
  /** A password-hash export from WorkOS support (CSV or NDJSON), when the owner has one. */
  hashesText?: string;
  /** Also count TOTP / SMS / WebAuthn factors per user (one more request each) so the report says how many re-enrol. */
  countFactors?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

const PAGE = 100;

export async function exportWorkos(opts: WorkosExportOptions): Promise<RecordSet> {
  const set = new RecordSet();
  if (!/^sk_[A-Za-z0-9_]+$/.test(opts.apiKey)) {
    throw new Error('Not a WorkOS API key: it starts with sk_ (WORKOS_API_KEY).');
  }
  const progress = opts.onProgress ?? (() => undefined);
  const http = new VendorHttp({
    vendor: 'WorkOS',
    baseUrl: (opts.baseUrl ?? 'https://api.workos.com').replace(/\/+$/, ''),
    headers: { authorization: `Bearer ${opts.apiKey}` },
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });

  progress('organizations');
  const orgIds: string[] = [];
  for (const o of await listAll(http, '/organizations')) {
    const id = str(o.id);
    const name = str(o.name);
    if (!id || !name) continue;
    orgIds.push(id);
    set.add(
      'organization',
      compact({
        id,
        name,
        // Only domains WorkOS has verified let members join by domain.
        domains: objs(o.domains)
          .filter((d) => ['verified', 'legacy_verified'].includes(str(d.state) ?? ''))
          .map((d) => str(d.domain)?.toLowerCase())
          .filter((d): d is string => !!d),
        public_metadata: bag(o.metadata),
        private_metadata: str(o.external_id) ? { workos_external_id: str(o.external_id) } : undefined,
        created_at: str(o.created_at),
      }),
    );
  }

  progress('roles');
  const envRoles = await optional(http, '/authorization/roles');
  for (const r of objs(envRoles?.data)) addRole(set, r, undefined);
  for (const id of orgIds) {
    for (const r of objs((await optional(http, `/authorization/organizations/${encodeURIComponent(id)}/roles`))?.data)) {
      // The listing repeats the environment roles; only the organization's own are new.
      if (str(r.type) === 'OrganizationRole') addRole(set, r, id);
    }
  }

  progress('users');
  const hashes = opts.hashesText ? indexHashes(opts.hashesText) : null;
  let withHash = 0;
  let factorUsers = 0;
  let passkeyUsers = 0;
  for (const u of await listAll(http, '/user_management/users')) {
    const user = mapWorkosUser(u);
    if (!user) {
      set.omit('user', 'no email address');
      continue;
    }
    const h = hashes && (hashes.get(user.id) ?? hashes.get(user.emails![0]!.email) ?? (str(u.external_id) ? hashes.get(str(u.external_id)!) : undefined));
    if (h) {
      user.password = { algorithm: 'auto', hash: h };
      withHash++;
    }
    set.add('user', user);
    const email = user.emails![0]!;
    const identities = await optional(http, `/user_management/users/${encodeURIComponent(user.id)}/identities`);
    // The identities endpoint answers with a bare array.
    for (const i of objs(Array.isArray(identities) ? identities : identities?.data)) {
      const sub = str(i.idp_id);
      const provider = str(i.provider);
      if (!sub || !provider) continue;
      set.add(
        'identity',
        compact({ user_id: user.id, provider: providerKey(provider), provider_user_id: sub, kind: 'oauth' as const, email: email.email, email_verified: email.verified }),
        `${user.id}:${provider}:${sub}`,
      );
    }
    if (opts.countFactors) {
      const factors = objs((await optional(http, `/user_management/users/${encodeURIComponent(user.id)}/auth_factors`))?.data);
      if (factors.some((f) => ['totp', 'sms', 'generic_otp'].includes(str(f.type) ?? ''))) factorUsers++;
      if (factors.some((f) => str(f.type) === 'webauthn')) passkeyUsers++;
    }
  }
  if (factorUsers) set.omit('mfa_factor', 'WorkOS never returns TOTP secrets (they are shown only when a factor is enrolled); users enrol again in Atlas', factorUsers);
  if (passkeyUsers) set.omit('passkey', 'WorkOS does not export WebAuthn public keys; users register a passkey again in Atlas', passkeyUsers);
  if (!opts.countFactors && set.count('user') > 0) {
    set.warn('Second factors were not counted: WorkOS never exports TOTP secrets or passkeys, so users with a second factor enrol again (pass --set workos-factors=1 to count them).');
  }
  if (!hashes && set.count('user') > 0) {
    set.warn(
      'No password hashes: WorkOS has no password export. If WorkOS support provided one, pass it with --workos-hashes-file; otherwise turn on the workos lazy-migration preset so each password moves on its first sign-in.',
    );
  } else if (hashes && withHash === 0) {
    set.warn('The hash file matched no user (by user id, email or external id): check its columns.');
  }

  progress('memberships');
  let multiRole = false;
  for (const id of orgIds) {
    for (const m of await listAll(http, '/user_management/organization_memberships', { organization_id: id, statuses: 'active' })) {
      const userId = str(m.user_id);
      if (!userId) continue;
      const roles = [str(isObj(m.role) ? m.role.slug : undefined), ...objs(m.roles).map((r) => str(r.slug))].filter((s): s is string => !!s);
      const unique = [...new Set(roles)];
      if (unique.length > 1) multiRole = true;
      set.add(
        'membership',
        compact({ id: str(m.id), organization_id: id, user_id: userId, role: unique[0] ?? 'member', created_at: str(m.created_at) }),
        `${id}:${userId}`,
      );
    }
  }
  if (multiRole) set.warn('Some members hold several WorkOS roles; Atlas seats each member with one role (the first).');

  progress('invitations');
  for (const inv of await optionalAll(http, '/user_management/invitations')) {
    const id = str(inv.id);
    const email = str(inv.email)?.toLowerCase();
    if (!id || !email) continue;
    const state = str(inv.state);
    set.add(
      'invitation',
      compact({
        id,
        organization_id: str(inv.organization_id),
        email,
        role: str(inv.role_slug),
        status: state && ['pending', 'accepted', 'revoked', 'expired'].includes(state) ? (state as 'pending' | 'accepted' | 'revoked' | 'expired') : undefined,
        inviter_user_id: str(inv.inviter_user_id),
        expires_at: str(inv.expires_at),
        created_at: str(inv.created_at),
      }),
    );
  }

  progress('sso');
  let idpManual = 0;
  for (const c of await optionalAll(http, '/connections')) {
    const id = str(c.id);
    if (!id) continue;
    const type = str(c.connection_type) ?? '';
    const protocol = /oidc/i.test(type) ? ('oidc' as const) : ('saml' as const);
    let cert: string | undefined;
    if (protocol === 'saml') {
      const certs = await optional(http, `/connections/${encodeURIComponent(id)}/saml_idp_signing_certs`);
      cert = str(objs(certs?.data)[0]?.value);
    }
    idpManual++;
    set.add(
      'sso_connection',
      compact({
        id,
        name: str(c.name) ?? `${type || protocol} ${id}`,
        organization_id: str(c.organization_id),
        protocol,
        domains: objs(c.domains).map((d) => str(d.domain)?.toLowerCase()).filter((d): d is string => !!d),
        saml: protocol === 'saml' && cert ? { idp_certificate: cert } : undefined,
        enabled: str(c.state) ? str(c.state) === 'active' : undefined,
      }),
    );
  }
  if (idpManual) {
    set.warn(
      `${idpManual} SSO connection(s): WorkOS does not return the identity provider's entity id, SSO URL or OIDC client secret. Each customer's IdP admin sets the connection up again against the new Atlas service-provider details (or send them Atlas's metadata URL).`,
    );
  }

  progress('directories');
  const directories = await optionalAll(http, '/directories');
  if (directories.length) {
    set.warn(`${directories.length} Directory Sync directory(ies): reconnect each through Atlas SCIM provisioning (the directory's users and groups are re-provisioned by the identity provider).`);
  }

  progress('api keys');
  let keys = 0;
  for (const id of orgIds) keys += (await optionalAll(http, `/organizations/${encodeURIComponent(id)}/api_keys`)).length;
  if (keys) set.omit('api_key', 'WorkOS shows an API key secret only once: reissue them as Atlas API keys', keys);

  set.manifest = { origin: opts.clientId ?? 'api.workos.com', ...(opts.clientId ? { settings: { client_id: opts.clientId } } : {}) };
  return set;
}

function addRole(set: RecordSet, r: Obj, organizationId: string | undefined): void {
  const key = str(r.slug);
  if (!key) return;
  set.add(
    'role',
    compact({ key, name: str(r.name), description: str(r.description), scope: 'organization' as const, organization_id: organizationId, permissions: strs(r.permissions) }),
    `${organizationId ?? ''}:${key}`,
  );
}

/** One WorkOS user → a user record (a user always has an email). */
export function mapWorkosUser(u: Obj): UserRecord | null {
  const id = str(u.id);
  const email = str(u.email)?.toLowerCase();
  if (!id || !email) return null;
  const metadata = bag(u.metadata);
  return compact({
    id,
    emails: [{ email, verified: u.email_verified === true, primary: true }],
    first_name: str(u.first_name),
    last_name: str(u.last_name),
    image_url: str(u.profile_picture_url),
    public_metadata: metadata,
    private_metadata: str(u.external_id) ? { workos_external_id: str(u.external_id) } : undefined,
    created_at: str(u.created_at),
    last_sign_in_at: str(u.last_sign_in_at),
  }) as UserRecord;
}

/** `GoogleOAuth` → `google`, `GitHubOAuth` → `github`: the provider name an Atlas provider key is looked up by. */
export function providerKey(provider: string): string {
  return provider.replace(/OAuth$/i, '').toLowerCase();
}

/**
 * The support hash file, by user id, email and external id. Its layout is not
 * published: CSV with a hash column and an id / email column, or NDJSON.
 */
function indexHashes(text: string): Map<string, string> {
  const t = text.trim();
  const rows: Obj[] = t.startsWith('{') ? t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Obj) : parseCsv(t);
  const out = new Map<string, string>();
  for (const r of rows) {
    const keys = Object.keys(r);
    const hashKey = keys.find((k) => /hash/i.test(k) && !/type|algo/i.test(k));
    const hash = hashKey ? str(r[hashKey]) : undefined;
    if (!hash) continue;
    for (const k of keys) {
      const v = str(r[k]);
      if (!v) continue;
      if (/^(user_?id|id|external_?id)$/i.test(k)) out.set(v, hash);
      else if (/^email$/i.test(k)) out.set(v.toLowerCase(), hash);
    }
  }
  return out;
}

/** Every page of a WorkOS list endpoint (`{ data, list_metadata: { after } }`), in a stable order. */
async function listAll(http: VendorHttp, path: string, params: Record<string, string> = {}): Promise<Obj[]> {
  const out: Obj[] = [];
  let after: string | undefined;
  for (;;) {
    const q = new URLSearchParams({ limit: String(PAGE), order: 'asc', ...params });
    if (after) q.set('after', after);
    const body = (await http.get<Obj>(`${path}?${q.toString()}`)).body;
    out.push(...objs(body?.data));
    const next = isObj(body) && isObj(body.list_metadata) ? str(body.list_metadata.after) : undefined;
    if (!next || next === after) break;
    after = next;
  }
  return out;
}

/** A call whose absence (feature off, no permission, unknown path) is not an export failure. */
async function optional(http: VendorHttp, path: string): Promise<(Obj & { data?: unknown }) | null> {
  try {
    return (await http.get<Obj & { data?: unknown }>(path)).body;
  } catch (err) {
    if (err instanceof VendorApiError && [400, 403, 404].includes(err.status)) return null;
    throw err;
  }
}

/** {@link listAll} for an endpoint the environment may not have (feature off, no permission). */
async function optionalAll(http: VendorHttp, path: string, params: Record<string, string> = {}): Promise<Obj[]> {
  try {
    return await listAll(http, path, params);
  } catch (err) {
    if (err instanceof VendorApiError && [400, 403, 404].includes(err.status)) return [];
    throw err;
  }
}
