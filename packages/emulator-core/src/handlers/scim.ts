/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { bytesToB64url, sha256 } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, randomToken } from '../store';
import { engineState } from './support';
import { listReply, need } from './util';
import { presentUser } from './users';

/**
 * SCIM 2.0 server (RFC 7643/7644) over the engine's users: `/scim/v2/{ServiceProviderConfig,ResourceTypes,Schemas,Users,Groups}`
 * (and the `/scim/v2/d/:directoryId` alias), authenticated with a SCIM token minted at `POST /v1/scim_tokens`, which names the
 * organization it provisions into. A read-only token (`scopes: ["read"]`) refuses every write with 403. Errors use the SCIM
 * error schema (`urn:ietf:params:scim:api:messages:2.0:Error`). Bulk (RFC 7644 3.7), `sortBy`/`sortOrder` on the Users and Groups lists and weak ETags with
 * `If-Match` / `If-None-Match` preconditions (3.14) are served too, with the limits ServiceProviderConfig states.
 */
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const JSON_SCIM = { 'content-type': 'application/scim+json' };


const BULK_REQUEST = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest';
const BULK_RESPONSE = 'urn:ietf:params:scim:api:messages:2.0:BulkResponse';
export const BULK_MAX_OPERATIONS = 100;
export const BULK_MAX_PAYLOAD = 1_048_576;

/** The weak ETag of a resource: a hash of its body without `meta.version`, so the tag changes exactly when the resource does. */
const etagOf = async (resource: Obj): Promise<string> => {
  const copy = JSON.parse(JSON.stringify(resource));
  if (copy.meta) delete copy.meta.version;
  return `W/"${bytesToB64url(await sha256(JSON.stringify(copy))).slice(0, 27)}"`;
};
const weakEquals = (a: string, b: string): boolean => a.replace(/^W\//, '') === b.replace(/^W\//, '');

/** Attributes a list may be sorted by, per resource (lower-case paths). A complex attribute sorts by a sub-attribute; `emails` sorts by its primary value. */
const SORTABLE: Record<'User' | 'Group', string[]> = {
  User: ['id', 'externalid', 'username', 'displayname', 'active', 'name.givenname', 'name.familyname', 'name.formatted', 'emails', 'emails.value', 'meta.created', 'meta.lastmodified'],
  Group: ['id', 'externalid', 'displayname', 'meta.created', 'meta.lastmodified'],
};
function sortValue(resource: Obj, path: string): unknown {
  let cur: any = resource;
  for (const seg of path.split('.')) {
    if (Array.isArray(cur)) cur = (cur.find((x: Obj) => x.primary === true) ?? cur[0]) ?? undefined;
    if (cur == null || typeof cur !== 'object') return null;
    const key = Object.keys(cur).find((k) => k.toLowerCase() === seg.toLowerCase());
    cur = key === undefined ? null : cur[key];
  }
  if (Array.isArray(cur)) cur = (cur.find((x: Obj) => x.primary === true) ?? cur[0])?.value ?? null;
  return cur ?? null;
}
/** Sort presented resources like the real list: case-insensitive text, nulls last ascending and first descending, ties by id in the same direction. */
function sortResources(by: string | null, order: string | null, rows: Obj[], kind: 'User' | 'Group'): Obj[] | Reply {
  const dir = order === null || order === '' ? 'ascending' : order.toLowerCase();
  if (dir !== 'ascending' && dir !== 'descending') return scimError(400, 'sortOrder must be "ascending" or "descending".', 'invalidValue');
  if (by === null || by === '') return rows;
  const path = by.trim();
  if (!path || path.length > 512 || /[\s()[\]"]/.test(path)) return scimError(400, `Invalid sortBy "${by}".`, 'invalidValue');
  const norm = path.toLowerCase();
  if (norm === 'name' || norm === 'meta') return scimError(400, `Sort by a sub-attribute of ${path}.`, 'invalidValue');
  if (!SORTABLE[kind].includes(norm)) return scimError(400, `Sorting by ${path} is not supported.`, 'invalidValue');
  const key = (r: Obj): string | number | null => {
    const v = sortValue(r, path);
    return v === null ? null : typeof v === 'string' ? v.toLowerCase() : typeof v === 'boolean' ? Number(v) : (v as number);
  };
  const sign = dir === 'descending' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) {
      if (ka === null) return sign;
      if (kb === null) return -sign;
      return (ka < kb ? -1 : 1) * sign;
    }
    return (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0) * sign;
  });
}

const scimError = (status: number, detail: string, scimType?: string): Reply => ({ status, headers: JSON_SCIM, body: { schemas: [ERR], status: String(status), ...(scimType ? { scimType } : {}), detail } });

const presentToken = (t: Obj): Obj => ({
  object: 'scim_token',
  id: t.id,
  name: t.name ?? null,
  organization_id: t.organization_id,
  connection_id: t.connection_id ?? null,
  prefix: t.prefix,
  scopes: t.scopes ?? null,
  role_mappings: t.role_mappings ?? null,
  revoked: t.revoked === true,
  created_at: t.created_at,
});

interface Auth {
  token: Obj;
  orgId: string;
  canWrite: boolean;
}
/** The requests the SCIM endpoint answered for an organization's token, for the IT-admin request log. */
export const scimRequestLog = engineState((e: Engine) => new Table('scim_requests', e.clock.now, 'scimreq'));

function authenticate(e: Engine, c: RouteContext): Auth | Reply {
  const bearer = /^Bearer\s+(.+)$/i.exec(c.request.headers.get('authorization') ?? '')?.[1];
  const token = bearer ? e.db.scimTokens.find((t) => t.secret === bearer && !t.revoked) : undefined;
  if (!token) return scimError(401, 'A valid SCIM token is required.');
  return { token, orgId: token.organization_id, canWrite: !Array.isArray(token.scopes) || token.scopes.includes('write') };
}

const primaryEmail = (u: Obj): Obj | undefined => (u.emails as Obj[]).find((m) => m.id === u.primary_email_address_id) ?? (u.emails as Obj[])[0];

function scimUser(e: Engine, u: Obj, base: string): Obj {
  const mail = primaryEmail(u);
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    externalId: u.external_id ?? undefined,
    userName: mail?.email_address ?? u.username ?? u.id,
    name: { givenName: u.first_name ?? undefined, familyName: u.last_name ?? undefined, formatted: [u.first_name, u.last_name].filter(Boolean).join(' ') || undefined },
    displayName: [u.first_name, u.last_name].filter(Boolean).join(' ') || undefined,
    emails: (u.emails as Obj[]).map((m) => ({ value: m.email_address, primary: m.id === u.primary_email_address_id })),
    active: u.scim_active !== false && u.banned !== true,
    meta: { resourceType: 'User', created: new Date(u.created_at).toISOString(), lastModified: new Date(u.updated_at).toISOString(), location: `${base}/Users/${u.id}` },
  };
}
const scimGroup = (e: Engine, g: Obj, base: string): Obj => ({
  schemas: [GROUP_SCHEMA],
  id: g.id,
  externalId: g.external_id ?? undefined,
  displayName: g.display_name,
  members: (g.members as string[]).map((id) => ({ value: id, $ref: `${base}/Users/${id}` })),
  meta: { resourceType: 'Group', created: new Date(g.created_at).toISOString(), lastModified: new Date(g.updated_at).toISOString(), location: `${base}/Groups/${g.id}` },
});

/** The small filter subset IdPs use: `attr eq "value"`, joined by `and`; `attr co/sw` too. */
function matcher(filter: string | null): ((o: Obj) => boolean) | Reply {
  if (!filter) return () => true;
  const parts = filter.split(/\s+and\s+/i).map((p) => /^([\w.]+)\s+(eq|ne|co|sw|ew|pr)(?:\s+"((?:[^"\\]|\\.)*)")?$/i.exec(p.trim()));
  if (parts.some((p) => !p)) return scimError(400, `Unsupported filter: ${filter}`, 'invalidFilter');
  return (o) =>
    parts.every((p) => {
      const [, attr, op, val] = p!;
      const have = String((o as Obj)[attr!] ?? '').toLowerCase();
      const want = (val ?? '').toLowerCase();
      return { eq: have === want, ne: have !== want, co: have.includes(want), sw: have.startsWith(want), ew: have.endsWith(want), pr: have !== '' }[op!.toLowerCase() as 'eq'];
    });
}

export function scimHandlers(): RouteDef[] {
  const base = (c: RouteContext): string => `${c.engine.issuer}${new URL(c.request.url).pathname.startsWith('/scim/v2/d/') ? `/scim/v2/d/${c.params.directoryId}` : '/scim/v2'}`;
  /** Run a handler with the token resolved; `write` demands a write-capable token. */
  const guard = (write: boolean, fn: (c: RouteContext, a: Auth, base: string) => Reply | Promise<Reply>) => (c: RouteContext): Reply | Promise<Reply> => {
    const a = authenticate(c.engine, c);
    if (!('orgId' in a)) return a;
    if (write && !a.canWrite) return scimError(403, 'This SCIM token is read-only.');
    return fn(c, a, base(c));
  };
  const page = (c: RouteContext, items: Obj[], present: (o: Obj) => Obj, kind: 'User' | 'Group'): Reply => {
    const sorted = sortResources(c.query.get('sortBy'), c.query.get('sortOrder'), items.map(present), kind);
    if (!Array.isArray(sorted)) return sorted;
    const start = Math.max(Number(c.query.get('startIndex') ?? 1) || 1, 1);
    const count = Math.min(Math.max(Number(c.query.get('count') ?? 100) || 0, 0), 200);
    const slice = sorted.slice(start - 1, start - 1 + count);
    return { headers: JSON_SCIM, body: { schemas: [LIST], totalResults: sorted.length, startIndex: start, itemsPerPage: slice.length, Resources: slice } };
  };
  const memberUsers = (e: Engine, orgId: string): Obj[] =>
    e.db.memberships
      .filter((m) => m.organization_id === orgId)
      .flatMap((m) => {
        const u = e.db.users.get(m.user_id);
        return u && !u.deleted ? [u] : [];
      });

  const userRoutes = (prefix: string): RouteDef[] => [
    {
      method: 'GET',
      pattern: `${prefix}/Users`,
      public: true,
      handler: guard(false, (c, a, b) => {
        const m = matcher(c.query.get('filter'));
        if (typeof m !== 'function') return m;
        const flat = (u: Obj): Obj => ({ ...u, userName: primaryEmail(u)?.email_address, externalId: u.external_id, id: u.id, active: u.scim_active !== false });
        return page(c, memberUsers(c.engine, a.orgId).filter((u) => m(flat(u))), (u) => scimUser(c.engine, u, b), 'User');
      }),
    },
    {
      method: 'POST',
      pattern: `${prefix}/Users`,
      public: true,
      handler: guard(true, (c, a, b) => {
        const e = c.engine;
        const userName = String(c.body.userName ?? '').trim();
        const addr = (c.body.emails as Obj[] | undefined)?.find((m) => m.primary)?.value ?? (c.body.emails as Obj[] | undefined)?.[0]?.value ?? userName;
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(addr))) return scimError(400, 'userName or emails[].value must be an email address.', 'invalidValue');
        const taken = e.db.users.all().find((u) => !u.deleted && (u.emails as Obj[]).some((m) => m.email_address.toLowerCase() === String(addr).toLowerCase()));
        if (taken) return scimError(409, `${addr} is already in use.`, 'uniqueness');
        const now = e.clock.now();
        const mail = { id: e.db.newId('idn'), email_address: String(addr), verified: true };
        const u = e.db.users.insert({
          username: null,
          first_name: c.body.name?.givenName ?? null,
          last_name: c.body.name?.familyName ?? null,
          image_url: null,
          external_id: c.body.externalId ?? null,
          emails: [mail],
          primary_email_address_id: mail.id,
          has_password: false,
          public_metadata: {},
          unsafe_metadata: {},
          private_metadata: {},
          banned: false,
          locked: false,
          scim_active: c.body.active !== false,
          created_at: now,
          updated_at: now,
          version: 1,
        });
        const role = (a.token.role_mappings as Obj[] | null)?.find((r) => (c.body.roles as Obj[] | undefined)?.some((x) => x.value === r.value))?.role ?? 'org:member';
        const mem = e.db.memberships.insert({ organization_id: a.orgId, user_id: u.id, role, role_source: 'scim', created_at: now });
        e.changed({ type: 'user.created', data: presentUser(e, u), resource: 'user', id: u.id, op: 'create' });
        e.changed({ type: 'organization_membership.created', data: { id: mem.id, organization_id: a.orgId, user_id: u.id, role }, resource: 'membership', id: mem.id, op: 'create' });
        e.webhooks.emit('scim_user.created', { object: 'scim_user', id: u.id, organization_id: a.orgId, scim_token_id: a.token.id });
        return { status: 201, headers: { ...JSON_SCIM, location: `${b}/Users/${u.id}` }, body: scimUser(e, u, b) };
      }),
    },
    {
      method: 'GET',
      pattern: `${prefix}/Users/:uid`,
      public: true,
      handler: guard(false, (c, a, b) => {
        const u = memberUsers(c.engine, a.orgId).find((x) => x.id === c.params.uid);
        return u ? { headers: JSON_SCIM, body: scimUser(c.engine, u, b) } : scimError(404, 'User not found.');
      }),
    },
    ...(['PUT', 'PATCH'] as const).map(
      (method): RouteDef => ({
        method,
        pattern: `${prefix}/Users/:uid`,
        public: true,
        handler: guard(true, (c, a, b) => {
          const e = c.engine;
          const u = memberUsers(e, a.orgId).find((x) => x.id === c.params.uid);
          if (!u) return scimError(404, 'User not found.');
          const apply = (path: string, value: any): void => {
            if (path === 'active') u.scim_active = value === true || value === 'true';
            else if (path === 'name.givenName') u.first_name = value;
            else if (path === 'name.familyName') u.last_name = value;
            else if (path === 'externalId') u.external_id = value;
          };
          if (method === 'PUT') {
            apply('active', c.body.active ?? true);
            apply('name.givenName', c.body.name?.givenName ?? null);
            apply('name.familyName', c.body.name?.familyName ?? null);
            apply('externalId', c.body.externalId ?? null);
          } else {
            if (!Array.isArray(c.body.Operations)) return scimError(400, 'Operations is required.', 'invalidSyntax');
            for (const op of c.body.Operations as Obj[]) {
              const verb = String(op.op ?? '').toLowerCase();
              if (verb !== 'replace' && verb !== 'add' && verb !== 'remove') return scimError(400, `Unsupported op ${op.op}.`, 'invalidSyntax');
              if (op.path) apply(String(op.path), verb === 'remove' ? null : op.value);
              else for (const [k, v] of Object.entries((op.value ?? {}) as Obj)) apply(k, v);
            }
          }
          u.updated_at = e.clock.now();
          u.version = (u.version ?? 0) + 1;
          const inactive = u.scim_active === false;
          e.changed({ type: 'user.updated', data: presentUser(e, u), resource: 'user', id: u.id, op: 'update' });
          e.webhooks.emit(inactive ? 'scim_user.deactivated' : 'scim_user.updated', { object: 'scim_user', id: u.id, organization_id: a.orgId, scim_token_id: a.token.id });
          return { headers: JSON_SCIM, body: scimUser(e, u, b) };
        }),
      }),
    ),
    {
      method: 'DELETE',
      pattern: `${prefix}/Users/:uid`,
      public: true,
      handler: guard(true, (c, a) => {
        const e = c.engine;
        const mem = e.db.memberships.find((m) => m.organization_id === a.orgId && m.user_id === c.params.uid);
        if (!mem) return scimError(404, 'User not found.');
        // De-provisioning removes the membership; the user account itself stays (it may belong elsewhere).
        e.db.memberships.delete(mem.id);
        e.changed({ type: 'organization_membership.deleted', data: { id: mem.id, organization_id: a.orgId, user_id: mem.user_id }, resource: 'membership', id: mem.id, op: 'delete' });
        e.webhooks.emit('scim_user.deactivated', { object: 'scim_user', id: mem.user_id, organization_id: a.orgId, scim_token_id: a.token.id });
        return { status: 204 };
      }),
    },
    // ── groups ──
    {
      method: 'GET',
      pattern: `${prefix}/Groups`,
      public: true,
      handler: guard(false, (c, a, b) => {
        const m = matcher(c.query.get('filter'));
        if (typeof m !== 'function') return m;
        return page(c, c.engine.db.scimGroups.filter((g) => g.organization_id === a.orgId && m({ displayName: g.display_name, externalId: g.external_id, id: g.id })), (g) => scimGroup(c.engine, g, b), 'Group');
      }),
    },
    {
      method: 'POST',
      pattern: `${prefix}/Groups`,
      public: true,
      handler: guard(true, (c, a, b) => {
        const e = c.engine;
        const name = String(c.body.displayName ?? '').trim();
        if (!name) return scimError(400, 'displayName is required.', 'invalidValue');
        if (e.db.scimGroups.find((g) => g.organization_id === a.orgId && g.display_name === name)) return scimError(409, 'A group with that displayName exists.', 'uniqueness');
        const now = e.clock.now();
        const g = e.db.scimGroups.insert({ organization_id: a.orgId, display_name: name, external_id: c.body.externalId ?? null, members: ((c.body.members as Obj[]) ?? []).map((m) => String(m.value)), created_at: now, updated_at: now });
        e.webhooks.emit('scim_group.created', { object: 'scim_group', id: g.id, organization_id: a.orgId, display_name: name });
        return { status: 201, headers: { ...JSON_SCIM, location: `${b}/Groups/${g.id}` }, body: scimGroup(e, g, b) };
      }),
    },
    {
      method: 'GET',
      pattern: `${prefix}/Groups/:gid`,
      public: true,
      handler: guard(false, (c, a, b) => {
        const g = c.engine.db.scimGroups.get(c.params.gid);
        return g && g.organization_id === a.orgId ? { headers: JSON_SCIM, body: scimGroup(c.engine, g, b) } : scimError(404, 'Group not found.');
      }),
    },
    {
      method: 'PATCH',
      pattern: `${prefix}/Groups/:gid`,
      public: true,
      handler: guard(true, (c, a, b) => {
        const e = c.engine;
        const g = e.db.scimGroups.get(c.params.gid);
        if (!g || g.organization_id !== a.orgId) return scimError(404, 'Group not found.');
        if (!Array.isArray(c.body.Operations)) return scimError(400, 'Operations is required.', 'invalidSyntax');
        for (const op of c.body.Operations as Obj[]) {
          const verb = String(op.op ?? '').toLowerCase();
          const path = String(op.path ?? 'members');
          if (path === 'displayName') g.display_name = String(op.value);
          else if (path.startsWith('members')) {
            const given = ((Array.isArray(op.value) ? op.value : []) as Obj[]).map((m) => String(m.value));
            const quoted = /members\[value eq "([^"]+)"\]/.exec(path)?.[1];
            if (verb === 'add') {
              for (const id of given) {
                if (g.members.includes(id)) continue;
                g.members.push(id);
                e.webhooks.emit('scim_group.member_added', { object: 'scim_group', id: g.id, user_id: id });
              }
            } else if (verb === 'remove') {
              const drop = quoted ? [quoted] : given.length ? given : [...g.members];
              g.members = g.members.filter((id: string) => !drop.includes(id));
              for (const id of drop) e.webhooks.emit('scim_group.member_removed', { object: 'scim_group', id: g.id, user_id: id });
            } else if (verb === 'replace') g.members = given;
          }
        }
        g.updated_at = e.clock.now();
        e.webhooks.emit('scim_group.updated', { object: 'scim_group', id: g.id, organization_id: a.orgId, display_name: g.display_name });
        return { headers: JSON_SCIM, body: scimGroup(e, g, b) };
      }),
    },
    {
      method: 'DELETE',
      pattern: `${prefix}/Groups/:gid`,
      public: true,
      handler: guard(true, (c, a) => {
        const g = c.engine.db.scimGroups.get(c.params.gid);
        if (!g || g.organization_id !== a.orgId) return scimError(404, 'Group not found.');
        c.engine.db.scimGroups.delete(g.id);
        c.engine.webhooks.emit('scim_group.deleted', { object: 'scim_group', id: g.id, organization_id: a.orgId });
        return { status: 204 };
      }),
    },
    // ── Bulk (RFC 7644 3.7): each operation runs through the server's own routes, so auth, read-only and validation rules are the same as a direct call ──
    {
      method: 'POST',
      pattern: `${prefix}/Bulk`,
      public: true,
      handler: guard(true, async (c) => {
        const e = c.engine;
        const body = c.body as { schemas?: string[]; failOnErrors?: number; Operations?: Array<{ method?: string; bulkId?: string; version?: string; path?: string; data?: unknown }> };
        if (JSON.stringify(body).length > BULK_MAX_PAYLOAD) return scimError(413, `A bulk request is at most ${BULK_MAX_PAYLOAD} bytes.`, 'tooLarge');
        if (!Array.isArray(body.schemas) || !body.schemas.includes(BULK_REQUEST)) return scimError(400, `A bulk request must declare the ${BULK_REQUEST} schema.`, 'invalidSyntax');
        const ops = body.Operations;
        if (!Array.isArray(ops) || ops.length === 0) return scimError(400, 'Operations is required.', 'invalidSyntax');
        if (ops.length > BULK_MAX_OPERATIONS) return scimError(413, `At most ${BULK_MAX_OPERATIONS} operations per request.`, 'tooMany');
        const failOn = Number.isInteger(body.failOnErrors) && body.failOnErrors! > 0 ? body.failOnErrors! : Infinity;
        const root = new URL(c.request.url).pathname.replace(/\/Bulk\/?$/, '');
        const created = new Map<string, string>(); // bulkId -> location
        const bulkIds = new Set<string>();
        const results: Obj[] = [];
        let errors = 0;
        const refs = (text: string) => text.replace(/bulkId:([A-Za-z0-9_-]+)/g, (m, id: string) => created.get(id)?.split('/').pop() ?? m);
        for (const op of ops) {
          if (errors >= failOn) break;
          const method = String(op.method ?? '').toUpperCase();
          const result: Obj = { method, ...(op.bulkId ? { bulkId: op.bulkId } : {}) };
          const fail = (status: number, detail: string, scimType?: string) => {
            errors += 1;
            results.push({ ...result, status: String(status), response: { schemas: [ERR], ...(scimType ? { scimType } : {}), detail, status: String(status) } });
          };
          if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            fail(400, 'method must be POST, PUT, PATCH or DELETE.', 'invalidValue');
            continue;
          }
          if (method === 'POST') {
            if (!op.bulkId || !/^[A-Za-z0-9_-]{1,64}$/.test(op.bulkId) || bulkIds.has(op.bulkId)) {
              fail(400, 'A POST needs a unique bulkId.', 'invalidValue');
              continue;
            }
            bulkIds.add(op.bulkId);
          }
          if (typeof op.path !== 'string' || !op.path.startsWith('/') || op.path.includes('..') || /^\/(Bulk|ServiceProviderConfig|Schemas|ResourceTypes)\b/.test(op.path)) {
            fail(400, 'path must name a resource endpoint.', 'invalidPath');
            continue;
          }
          const path = refs(op.path);
          if (/bulkId:/.test(path)) {
            fail(409, 'A bulkId reference points at an operation that did not create a resource.', 'invalidValue');
            continue;
          }
          const data = op.data === undefined ? undefined : refs(JSON.stringify(op.data));
          const res = await e.handle(new Request(`${e.issuer}${root}${path}`, { method, headers: { authorization: c.request.headers.get('authorization') ?? '', 'content-type': 'application/scim+json', ...(op.version ? { 'if-match': op.version } : {}) }, ...(data !== undefined && method !== 'DELETE' ? { body: data } : {}) }));
          const text = await res.text();
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          const location = res.headers.get('location') ?? json?.meta?.location;
          if (res.status >= 400) {
            errors += 1;
            results.push({ ...result, status: String(res.status), response: json ?? {} });
            continue;
          }
          if (method === 'POST' && op.bulkId && location) created.set(op.bulkId, location);
          results.push({ ...result, ...(location ? { location } : {}), ...(res.headers.get('etag') ? { version: res.headers.get('etag') } : {}), status: String(res.status) });
        }
        return { headers: JSON_SCIM, body: { schemas: [BULK_RESPONSE], Operations: results } };
      }),
    },
    // ── discovery ──
    {
      method: 'GET',
      pattern: `${prefix}/ServiceProviderConfig`,
      public: true,
      handler: guard(false, () => ({
        headers: JSON_SCIM,
        body: {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
          patch: { supported: true },
          bulk: { supported: true, maxOperations: BULK_MAX_OPERATIONS, maxPayloadSize: BULK_MAX_PAYLOAD },
          filter: { supported: true, maxResults: 200 },
          changePassword: { supported: false },
          sort: { supported: true },
          etag: { supported: true },
          authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A SCIM token from the Backend API.' }],
        },
      })),
    },
    {
      method: 'GET',
      pattern: `${prefix}/ResourceTypes`,
      public: true,
      handler: guard(false, () => ({
        headers: JSON_SCIM,
        body: { schemas: [LIST], totalResults: 2, Resources: [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER_SCHEMA }, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP_SCHEMA }] },
      })),
    },
    {
      method: 'GET',
      pattern: `${prefix}/Schemas`,
      public: true,
      handler: guard(false, () => ({ headers: JSON_SCIM, body: { schemas: [LIST], totalResults: 2, Resources: [{ id: USER_SCHEMA, name: 'User' }, { id: GROUP_SCHEMA, name: 'Group' }] } })),
    },
  ];

  /**
   * ETag on every single-resource answer (`meta.version` and the `ETag` header), 304 for a matching `If-None-Match` on a GET, and 412
   * `invalidVers` for an `If-Match` that no longer names the resource on a PUT, PATCH or DELETE (checked before the write, `*` always passes).
   */
  const withEtag = (routes: RouteDef[]): RouteDef[] =>
    routes.map((r) => {
      if (!/\/(Users|Groups)(\/:\w+)?$/.test(r.pattern)) return r;
      const isItem = /\/:\w+$/.test(r.pattern);
      const kind = /\/Users/.test(r.pattern) ? 'User' : 'Group';
      return {
        ...r,
        handler: async (c: RouteContext): Promise<Reply> => {
          const ifMatch = c.request.headers.get('if-match');
          if (isItem && ifMatch !== null && (r.method === 'PUT' || r.method === 'PATCH' || r.method === 'DELETE')) {
            const a = authenticate(c.engine, c);
            if ('orgId' in a) {
              const id = c.params.uid ?? c.params.gid;
              const b = base(c);
              const current = kind === 'User' ? memberUsers(c.engine, a.orgId).filter((u) => u.id === id).map((u) => scimUser(c.engine, u, b))[0] : c.engine.db.scimGroups.filter((g) => g.id === id && g.organization_id === a.orgId).map((g) => scimGroup(c.engine, g, b))[0];
              if (current) {
                const tag = await etagOf(current);
                if (ifMatch.trim() !== '*' && !ifMatch.split(',').some((t) => weakEquals(t.trim(), tag))) return scimError(412, 'The resource changed since the version in If-Match.', 'invalidVers');
              }
            }
          }
          const out = await r.handler(c);
          const status = out.status ?? 200;
          const body = out.body as Obj | undefined;
          if (status < 200 || status > 201 || !body || typeof body !== 'object' || !body.meta || typeof body.id !== 'string') return out;
          const tag = await etagOf(body);
          body.meta.version = tag;
          const headers = { ...(out.headers ?? {}), etag: tag };
          const inm = c.request.headers.get('if-none-match');
          if (r.method === 'GET' && inm !== null && inm.split(',').some((t) => t.trim() === '*' || weakEquals(t.trim(), tag))) return { status: 304, headers };
          return { ...out, headers };
        },
      };
    });

  /** Record each answered request (method, path, status, why it failed, how long it took) under the token's organization; never the body. */
  const logged = (routes: RouteDef[]): RouteDef[] =>
    routes.map((r) => ({
      ...r,
      handler: async (c: RouteContext): Promise<Reply> => {
        const started = c.engine.clock.now();
        const bearer = /^Bearer\s+(.+)$/i.exec(c.request.headers.get('authorization') ?? '')?.[1];
        const token = bearer ? c.engine.db.scimTokens.find((t) => t.secret === bearer) : undefined;
        const out = await r.handler(c);
        if (token) {
          const status = out.status ?? 200;
          const errs = (out.body as Obj | undefined)?.detail;
          scimRequestLog(c.engine).insert({ organization_id: token.organization_id, token_id: token.revoked ? null : token.id, method: r.method, path: new URL(c.request.url).pathname, resource: /\/(Users|Groups|Bulk)\b/.exec(r.pattern)?.[1] ?? null, status, error_detail: status >= 400 && typeof errs === 'string' ? errs : null, ip: c.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null, user_agent: c.request.headers.get('user-agent'), duration_ms: Math.max(0, c.engine.clock.now() - started), created_at: started } as any);
        }
        return out;
      },
    }));

  return [
    // ── token management (Backend API) ──
    {
      method: 'POST',
      pattern: '/v1/scim_tokens',
      handler: (c) => {
        const e = c.engine;
        const orgId = String(need(c.body, 'organization_id'));
        if (!e.db.organizations.get(orgId)) throw new EmulatorError('NOT_FOUND', 'organization_id is not an organization.', 'organization_id');
        const secret = `scim_${randomToken(32)}`;
        const t = e.db.scimTokens.insert({ name: c.body.name ?? null, organization_id: orgId, connection_id: c.body.connection_id ?? null, scopes: c.body.scopes ?? null, role_mappings: c.body.role_mappings ?? null, secret, prefix: secret.slice(0, 10), revoked: false, created_at: e.clock.now() });
        e.webhooks.emit('scim_token.created', presentToken(t));
        return { status: 201, body: { ...presentToken(t), token: secret } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/scim_tokens',
      handler: (c) => {
        const org = c.query.get('organization_id');
        return listReply(c, c.engine.db.scimTokens.filter((t) => !org || t.organization_id === org), presentToken);
      },
    },
    {
      method: 'PATCH',
      pattern: '/v1/scim_tokens/:id',
      handler: (c) => {
        const t = c.engine.db.scimTokens.get(c.params.id);
        if (!t) throw notFound('SCIM token');
        for (const k of ['name', 'scopes', 'role_mappings']) if (k in c.body) t[k] = c.body[k];
        return { body: presentToken(t) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/scim_tokens/:id/revoke',
      handler: (c) => {
        const t = c.engine.db.scimTokens.get(c.params.id);
        if (!t) throw notFound('SCIM token');
        t.revoked = true;
        c.engine.webhooks.emit('scim_token.revoked', presentToken(t));
        return { body: { object: 'scim_token', id: t.id, revoked: true, note: 'Requests with this token now answer 401.' } };
      },
    },
    ...logged(withEtag(userRoutes('/scim/v2'))),
    ...logged(withEtag(userRoutes('/scim/v2/d/:directoryId'))),
  ];
}
