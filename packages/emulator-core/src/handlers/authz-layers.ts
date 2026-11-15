/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import type { Row } from '../store';
import { type Signals, ipFacts, readSignals, resolveSignals } from './access-signals';
import { parseIp } from './cedar-ext';
import { Resolver, compileStored, parseUser } from './fga-engine';
import { type CedarPolicy, type CedarRequest, decideCedar, linkCedarTemplate, parseCedar, parseCedarTemplate, traceCedar } from './cedar';
import { type Tuple, appRoleTable, directAppRoles, effectiveGroupKeys, effectiveGroups, genericTable, st, storeExists, storeTuples } from './authz-state';

/**
 * The seven authorization layers `POST /v1/authz/explain` asks, each evaluated from the emulator's own data:
 * organization roles and direct app roles, group-mapped app roles, resource roles, ABAC policies, access policies and FGA tuples.
 */
export const LAYERS = ['rbac', 'org_roles', 'groups', 'resource_roles', 'abac', 'access_policies', 'fga'] as const;
export type Layer = (typeof LAYERS)[number];
const CAP = 50;
const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);

export interface RoleVia {
  kind: 'org_role' | 'app_role' | 'delegated_role' | 'member_permission';
  role_key?: string;
  organization_id?: string;
}
export interface ExplainInput {
  userId: string;
  action: string;
  resource: { type?: string; id?: string; resourceId?: string; externalId?: string; organizationId?: string };
  groups?: string[];
  context?: Record<string, unknown>;
  abac?: { principalType?: string; resourceType?: string; principalAttributes?: Record<string, unknown>; resourceAttributes?: Record<string, unknown> };
  fga?: { storeId?: string; relation?: string; userType?: string };
  access?: { applicationId?: string; ip?: string; signals?: Signals };
  layers?: Layer[];
}

const skipped = (reason: string): Obj => ({ status: 'skipped', decision: 'no_match', reason, contributions: [] });
const decisionOf = (cs: Obj[]): string => {
  const hit = cs.filter((c) => c.matched);
  if (hit.some((c) => c.effect === 'deny')) return 'deny';
  if (hit.some((c) => c.effect === 'step_up')) return 'step_up';
  if (hit.some((c) => c.effect === 'allow')) return 'allow';
  return 'no_match';
};
const done = (contributions: Obj[], reason?: string): Obj => ({ status: 'evaluated', decision: decisionOf(contributions), ...(reason ? { reason } : {}), contributions });
const has = (perms: readonly string[] | null | undefined, action: string): boolean => !!perms && perms.includes(action);

// ── rbac, org roles, groups ──

export function rbacLayer(e: Engine, i: Pick<ExplainInput, 'userId' | 'action' | 'resource'>): Obj {
  const out: Obj[] = [];
  for (const m of e.db.memberships.filter((x) => x.user_id === i.userId && (!i.resource.organizationId || x.organization_id === i.resource.organizationId)).slice(0, CAP)) {
    const role = e.db.roles.find((r) => r.key === m.role);
    const hit = has(role?.permissions, i.action);
    out.push({
      layer: 'rbac',
      effect: 'allow',
      matched: hit,
      rule: { type: 'organization_role', id: role?.id ?? null, name: m.role },
      reason: hit ? `Holds role "${m.role}" in organization ${m.organization_id}, which grants ${i.action}.` : `Role "${m.role}" in organization ${m.organization_id} does not grant ${i.action}.`,
      evidence: [`organization:${m.organization_id}`],
      via: [{ kind: 'org_role', role_key: m.role, organization_id: m.organization_id }],
    });
    if (has(m.permissions, i.action)) {
      out.push({ layer: 'rbac', effect: 'allow', matched: true, rule: { type: 'member_permission', id: null, name: i.action }, reason: `Granted ${i.action} directly on the membership in organization ${m.organization_id}.`, evidence: [`organization:${m.organization_id}`], via: [{ kind: 'member_permission', organization_id: m.organization_id }] });
    }
  }
  for (const r of directAppRoles(e, i.userId).slice(0, CAP)) {
    const hit = has(r.permissions, i.action);
    out.push({ layer: 'rbac', effect: 'allow', matched: hit, rule: { type: 'app_role', id: r.id, name: r.key }, reason: hit ? `Assigned app role "${r.key}", which grants ${i.action}.` : `App role "${r.key}" does not grant ${i.action}.`, via: [{ kind: 'app_role', role_key: r.key }] });
  }
  if (!out.length) out.push({ layer: 'rbac', effect: 'allow', matched: false, rule: { type: 'none', id: null, name: null }, reason: i.resource.organizationId ? 'Not a member of that organization and holds no app role.' : 'Holds no organization role and no app role.' });
  return done(out);
}

// shortcut: the emulator has no cross-organization role delegation, so this layer always reports "no active delegations".
export const orgRolesLayer = (): Obj => ({ status: 'evaluated', decision: 'no_match', reason: 'No active role delegations.', contributions: [] });

export function groupsLayer(e: Engine, i: Pick<ExplainInput, 'userId' | 'action'>): Obj {
  const groups = effectiveGroups(e, i.userId);
  if (!groups.length) return { status: 'evaluated', decision: 'no_match', reason: 'Not in any group.', contributions: [] };
  const byKey = new Map((appRoleTable(e)?.all() ?? []).map((r) => [r.key, r.permissions as string[]]));
  const out: Obj[] = [];
  for (const g of groups.slice(0, CAP)) {
    const keys: string[] = g.app_role_keys ?? [];
    const granting = keys.filter((k) => has(byKey.get(k), i.action));
    out.push({
      layer: 'groups',
      effect: 'allow',
      matched: granting.length > 0,
      rule: { type: 'group', id: g.id, name: g.slug },
      reason: granting.length ? `Member of group "${g.slug}", which maps app role ${granting.map((k) => `"${k}"`).join(', ')} granting ${i.action}.` : keys.length ? `Member of group "${g.slug}"; none of its app roles grant ${i.action}.` : `Member of group "${g.slug}", which maps no app roles.`,
      evidence: granting.map((k) => `app_role:${k}`),
      via: keys.map((k) => ({ kind: 'app_role', role_key: k })),
    });
  }
  return done(out);
}

const dedupe = (list: RoleVia[]): RoleVia[] => {
  const seen = new Set<string>();
  return list.filter((v) => {
    const k = `${v.kind}|${v.role_key ?? ''}|${v.organization_id ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** A role-based check (organization roles, member permissions, app roles, group roles), with the roles held so a what-if can replay it. */
export function rbacCheck(e: Engine, i: { userId: string; permission: string; organizationId?: string }) {
  const base = { userId: i.userId, action: i.permission, resource: { organizationId: i.organizationId } };
  const layers = { rbac: rbacLayer(e, base), org_roles: orgRolesLayer(), groups: groupsLayer(e, base) };
  const all: Obj[] = [...layers.rbac.contributions, ...layers.org_roles.contributions, ...layers.groups.contributions];
  return {
    allowed: all.some((c) => c.matched && c.effect === 'allow'),
    layers,
    grants: dedupe(all.filter((c) => c.matched).flatMap((c) => c.via ?? [])),
    held: dedupe(all.flatMap((c) => c.via ?? []).filter((v: RoleVia) => v.kind !== 'member_permission')),
  };
}

// ── decision log ──

export function logDecision(e: Engine, d: { source: string; decision: 'allow' | 'deny'; principal: string | null; action: string | null; resource: string | null; input: Obj; result: Obj; policyVersion?: Obj }): void {
  st(e).decisions.insert({ ...d, policyVersion: d.policyVersion ?? {}, at: e.clock.now() });
}
export function recordRbacCheck(e: Engine, i: { userId: string; permission: string; organizationId?: string }, c: ReturnType<typeof rbacCheck>): void {
  logDecision(e, {
    source: 'rbac',
    decision: c.allowed ? 'allow' : 'deny',
    principal: `user:${i.userId}`,
    action: i.permission,
    resource: i.organizationId ? `organization:${i.organizationId}` : null,
    input: { user: i.userId, permission: i.permission, organization_id: i.organizationId ?? null },
    result: { kind: 'role', permission: i.permission, organization_id: i.organizationId ?? null, grants: c.grants, held: c.held },
    policyVersion: { kind: 'role' },
  });
}

/** Would a recorded role decision still be allowed after these role edits? (Same rule as the real replay.) */
export function replayRoleDecision(result: { grants?: RoleVia[]; held?: RoleVia[] }, edits: RoleEdit[], permission: string): boolean {
  const editFor = (v: RoleVia): RoleEdit | undefined => edits.find((x) => x.key === v.role_key && (v.kind === 'app_role' ? x.type === 'app_role' : x.type === 'org_role' && (!x.organizationId || x.organizationId === v.organization_id)));
  for (const g of result.grants ?? []) {
    if (g.kind === 'member_permission') return true;
    const x = editFor(g);
    if (!x || !x.removePermissions.includes(permission) || x.addPermissions.includes(permission)) return true;
  }
  for (const h of result.held ?? []) if (editFor(h)?.addPermissions.includes(permission)) return true;
  return false;
}
export interface RoleEdit {
  type: 'org_role' | 'app_role';
  key: string;
  organizationId?: string;
  addPermissions: string[];
  removePermissions: string[];
}

// ── resource roles ──

interface TypeDef {
  inherit: boolean;
  roles: Array<{ key: string; permissions: string[]; includes?: string[] }>;
}
/** The pure resolver of the real resource-role engine: roles reach permissions through `includes`; assignments flow down the parent chain unless a type or assignment stops them. */
function rolePermissions(type: TypeDef, roleKey: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(roleKey)) return out;
  seen.add(roleKey);
  const role = type.roles.find((r) => r.key === roleKey);
  if (!role) return out;
  for (const p of role.permissions) out.add(p);
  for (const inc of role.includes ?? []) for (const p of rolePermissions(type, inc, seen)) out.add(p);
  return out;
}
interface Grant {
  resourceId: string;
  role: string;
  subject: string;
  inherited: boolean;
}
const resources = (e: Engine) => genericTable(e, 'resources', 'resource');
const typeDef = (e: Engine, key: string): TypeDef => {
  const t = e.generic.get('resource_types')?.find((r) => r.key === key);
  return { inherit: t?.inherit ?? true, roles: t?.roles ?? [] };
};
export const findResourceRef = (e: Engine, ref: unknown, field: string): Row => {
  const o = (ref ?? {}) as Obj;
  const row = typeof o.id === 'string' && o.id ? resources(e).get(o.id) : typeof o.type === 'string' && typeof o.external_id === 'string' ? resources(e).find((r) => r.type === o.type && r.external_id === o.external_id) : undefined;
  if (!row) throw new EmulatorError('NOT_FOUND', `Unknown resource in ${field}.`);
  return row;
};
export const ancestorsOf = (e: Engine, startId: string | null): Row[] => {
  const out: Row[] = [];
  for (let id = startId, n = 0; id && n < 16; n++) {
    const r = resources(e).get(id);
    if (!r || out.some((x) => x.id === r.id)) break;
    out.push(r);
    id = r.parent_id;
  }
  return out;
};

export function parseSubject(raw: unknown): { type: 'user' | 'group' | 'org'; id: string } {
  const o = (raw ?? {}) as Obj;
  if (!['user', 'group', 'org'].includes(o.type)) throw bad('subject.type must be user, group or org.', 'subject');
  if (typeof o.id !== 'string' || !o.id.trim() || o.id.length > 500) throw bad('subject.id is required (at most 500 characters).', 'subject.id');
  return { type: o.type, id: o.id };
}
/** The subject itself, plus (for a user) their organizations and groups, plus any groups the caller names. */
export function expandSubjects(e: Engine, subject: { type: string; id: string }, groups: unknown): string[] {
  const out = new Set([`${subject.type}:${subject.id}`]);
  if (Array.isArray(groups)) for (const g of groups) if (typeof g === 'string') out.add(`group:${g}`);
  if (subject.type === 'user') {
    for (const m of e.db.memberships.filter((x) => x.user_id === subject.id)) out.add(`org:${m.organization_id}`);
    for (const k of effectiveGroupKeys(e, subject.id)) out.add(`group:${k}`);
  }
  return [...out];
}
function grantsOn(e: Engine, resource: Row, subjects: Iterable<string>, permission: string): Grant[] {
  const held = new Set(subjects);
  const chain = [resource, ...ancestorsOf(e, resource.parent_id)];
  const assignments = genericTable(e, 'resource_role_assignments', 'resourcerole');
  const grants: Grant[] = [];
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i]!;
    const type = typeDef(e, link.type);
    for (const a of assignments.filter((x) => x.resource_id === link.id)) {
      const subject = `${a.subject.type}:${a.subject.id}`;
      if (!held.has(subject) || (i > 0 && !a.inherit)) continue;
      const perms = rolePermissions(type, a.role);
      if (perms.has(permission) || perms.has('*')) grants.push({ resourceId: link.id, role: a.role, subject, inherited: i > 0 });
    }
    if (!type.inherit) break;
  }
  return grants;
}
const need = (v: unknown, field: string, max = 200): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${field} is required (at most ${max} characters).`, field);
  return v;
};
export function checkResource(e: Engine, body: Obj): { allowed: boolean; grants: Grant[]; resource: Row } {
  const resource = findResourceRef(e, body.resource, 'resource');
  const permission = need(body.permission, 'permission');
  const grants = grantsOn(e, resource, expandSubjects(e, parseSubject(body.subject), body.groups), permission);
  return { allowed: grants.length > 0, grants, resource };
}
export function accessibleResources(e: Engine, q: { subject: { type: string; id: string }; groups?: unknown; permission: string; type?: string }): Row[] {
  const subjects = expandSubjects(e, q.subject, q.groups);
  return resources(e).all().filter((r) => (!q.type || r.type === q.type) && grantsOn(e, r, subjects, q.permission).length > 0).reverse();
}
export const grantView = (g: Grant): Obj => ({ resource_id: g.resourceId, role: g.role, subject: g.subject, inherited: g.inherited });
export function recordResourceCheck(e: Engine, body: Obj, r: { allowed: boolean; grants: Grant[]; resource: Row }): void {
  const s = (body.subject ?? {}) as Obj;
  const principal = typeof s.type === 'string' && typeof s.id === 'string' ? `${s.type}:${s.id}` : null;
  logDecision(e, {
    source: 'rbac',
    decision: r.allowed ? 'allow' : 'deny',
    principal,
    action: typeof body.permission === 'string' ? body.permission : null,
    resource: `${r.resource.type ?? 'resource'}:${r.resource.id}`,
    input: { subject: body.subject, permission: body.permission, resource_id: r.resource.id },
    result: { kind: 'resource_role', grants: r.grants.map(grantView) },
    policyVersion: { kind: 'resource_role' },
  });
}

function resourceRolesLayer(e: Engine, i: ExplainInput): Obj {
  const rs = i.resource;
  const ref = rs.resourceId ? { id: rs.resourceId } : rs.type && rs.externalId ? { type: rs.type, external_id: rs.externalId } : null;
  if (!ref) return skipped('Name the resource by resource_id, or by type and external_id.');
  let r;
  try {
    r = checkResource(e, { resource: ref, permission: i.action, subject: { type: 'user', id: i.userId }, groups: i.groups });
  } catch (err) {
    if (err instanceof EmulatorError && err.code === 'NOT_FOUND') return skipped('Unknown resource.');
    throw err;
  }
  const out: Obj[] = r.grants.map((g) => ({ layer: 'resource_roles', effect: 'allow', matched: true, rule: { type: 'resource_role', id: g.resourceId, name: g.role }, reason: `Role "${g.role}" on ${g.inherited ? 'ancestor ' : ''}resource ${g.resourceId} is held through ${g.subject}.`, evidence: [g.subject] }));
  if (!out.length) out.push({ layer: 'resource_roles', effect: 'allow', matched: false, rule: { type: 'resource', id: r.resource.id, name: r.resource.name ?? null }, reason: `No role assigned to the user, their groups or organizations on this resource (or its ancestors) grants ${i.action}.` });
  return done(out);
}

// ── ABAC ──

export interface Pdp {
  policies: CedarPolicy[];
  owners: string[];
}
/** The enabled stored policies, parsed. A policy whose source does not parse is skipped, never fail-open or fail-closed. */
export function loadPdp(e: Engine, policyIds?: string[]): Pdp {
  const out: Pdp = { policies: [], owners: [] };
  for (const row of [...(e.generic.get('abac_policies')?.all() ?? [])].reverse()) {
    if (row.enabled === false || typeof row.source !== 'string' || (policyIds && !policyIds.includes(row.id))) continue;
    try {
      for (const p of parseCedar(row.source)) (out.policies.push(p), out.owners.push(row.name));
    } catch {
      /* skipped like the real loader */
    }
  }
  // Enabled template links, filled in; a link whose template is gone or no longer fits is skipped, never evaluated half-filled.
  if (!policyIds) {
    for (const l of linkedPolicies(e)) (out.policies.push(...l.policies), out.owners.push(...l.policies.map(() => `link ${l.name}`)));
  } else {
    for (const l of linkedPolicies(e).filter((x) => policyIds.includes(x.id))) (out.policies.push(...l.policies), out.owners.push(...l.policies.map(() => `link ${l.name}`)));
  }
  return out;
}
/** The enabled `abac_policy_links`, instantiated from their templates. */
export function linkedPolicies(e: Engine): Array<{ id: string; name: string; policies: CedarPolicy[] }> {
  const out: Array<{ id: string; name: string; policies: CedarPolicy[] }> = [];
  for (const link of [...(e.generic.get('abac_policy_links')?.all() ?? [])].reverse()) {
    const t = e.generic.get('abac_templates')?.get(link.template_id);
    if (link.enabled === false || !t || typeof t.source !== 'string') continue;
    try {
      out.push({ id: link.id, name: link.name, policies: linkCedarTemplate(parseCedarTemplate(t.source), { principal: link.principal ?? undefined, resource: link.resource ?? undefined }) });
    } catch {
      /* skipped */
    }
  }
  return out;
}
/** The stored pdp with candidate edits applied: removed and replaced names dropped, added and replacement sources appended. */
export function candidatePdp(cur: Pdp, c: { add: Array<{ name: string; source: string }>; replace: Array<{ name: string; source: string }>; remove: string[] }): Pdp {
  const drop = new Set([...c.remove, ...c.replace.map((r) => r.name)]);
  const out: Pdp = { policies: [], owners: [] };
  cur.policies.forEach((p, i) => {
    if (!drop.has(cur.owners[i]!)) (out.policies.push(p), out.owners.push(cur.owners[i]!));
  });
  for (const n of [...c.add, ...c.replace]) for (const p of parseCedar(n.source)) (out.policies.push(p), out.owners.push(n.name));
  return out;
}
export const abacDecide = (pdp: Pdp, req: CedarRequest) => decideCedar(traceCedar(pdp.policies, req));

function abacLayer(e: Engine, i: ExplainInput): Obj {
  const rType = i.abac?.resourceType ?? i.resource.type;
  const rId = i.resource.id ?? i.resource.externalId;
  if (!rType || !rId) return skipped('ABAC needs resource.type and resource.id.');
  const req: CedarRequest = {
    principal: { type: i.abac?.principalType ?? 'User', id: i.userId, ...(i.abac?.principalAttributes ? { attributes: i.abac.principalAttributes } : {}) },
    action: { id: i.action },
    resource: { type: rType, id: rId, ...(i.abac?.resourceAttributes ? { attributes: i.abac.resourceAttributes } : {}) },
    ...(i.context ? { context: i.context } : {}),
  };
  const pdp = loadPdp(e);
  if (!pdp.policies.length) return { status: 'evaluated', decision: 'no_match', reason: 'The instance has no ABAC policies.', contributions: [] };
  const out: Obj[] = traceCedar(pdp.policies, req).slice(0, 200).map((o) => ({
    layer: 'abac',
    effect: o.effect === 'permit' ? 'allow' : 'deny',
    matched: o.matched,
    rule: { type: `abac_${o.effect}`, id: String(o.index), name: pdp.owners[o.index] ?? null },
    reason: o.error ? `Policy "${pdp.owners[o.index]}" errored: ${o.error}` : o.matched ? `${o.effect === 'permit' ? 'Permit' : 'Forbid'} policy "${pdp.owners[o.index]}" matched.` : o.scoped === false ? `Policy "${pdp.owners[o.index]}" does not apply to this principal, action and resource.` : `Policy "${pdp.owners[o.index]}" applies but its conditions were not met.`,
  }));
  const errored = (c: Obj) => c.reason.includes('errored');
  const kept = [...out.filter((c) => c.matched || errored(c)), ...out.filter((c) => !c.matched && !errored(c)).slice(0, 10)];
  return { status: 'evaluated', decision: decisionOf(kept), contributions: kept };
}

// ── access policies ──

/** Whether an address (IPv4 or IPv6) is inside a CIDR range, or equals a bare address. */
export function ipInCidr(ip: string | undefined, cidr: string): boolean {
  if (!ip) return false;
  try {
    const a = parseIp(ip);
    const n = parseIp(cidr);
    if (a.v6 !== n.v6) return false;
    const host = BigInt(n.bits - n.prefix);
    return a.addr >> host === n.addr >> host;
  } catch {
    return false;
  }
}

export type AccessCtx = {
  stage: string;
  applicationId: string | null;
  userId: string | null;
  groupIds: string[];
  orgIds: string[];
  roles: string[];
  zoneIds: string[];
  hasIp: boolean;
  country: string | null;
  riskLevel: string | null;
  deviceTrust: string | null;
  authMethods: string[];
  devicePlatform?: string | null;
  osVersion?: string | null;
  clientType?: string | null;
  userRiskLevel?: string | null;
  principalId?: string | null;
  userAttributes: Obj;
  now: Date;
};
const pathGet = (o: Obj | undefined, key: string): unknown => key.split('.').reduce<any>((c, p) => (c && typeof c === 'object' ? c[p] : undefined), o);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function attrMatches(a: Obj, attrs: Obj): boolean {
  const v = pathGet(attrs, a.key);
  switch (a.op) {
    case 'exists':
      return v !== undefined && v !== null;
    case 'eq':
      return v !== undefined && same(v, a.value);
    case 'neq':
      return v !== undefined && !same(v, a.value);
    case 'in':
      return Array.isArray(a.value) && v !== undefined && a.value.some((x: unknown) => same(x, v));
    case 'not_in':
      return Array.isArray(a.value) && v !== undefined && !a.value.some((x: unknown) => same(x, v));
    case 'contains':
      return Array.isArray(v) ? v.some((x) => same(x, a.value)) : typeof v === 'string' && typeof a.value === 'string' && v.includes(a.value);
    default:
      return false;
  }
}
/** Compare dotted versions numerically ("14.2.1" vs "14.10"); null when either is not dotted digits. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v.trim()) ? v.trim().split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
const overlaps = (want: unknown, have: string[]) => !Array.isArray(want) || !want.length || have.some((h) => want.includes(h));
/** The first condition of a policy that does not hold (with the fact it needs when the emulator lacks it), or null when every condition holds. */
export function failing(c: Obj, ctx: AccessCtx): { key: string; unknown: boolean } | null {
  const no = (key: string, unknown = false) => ({ key, unknown });
  if (c.applications?.length && !(ctx.applicationId && c.applications.includes(ctx.applicationId))) return no('applications', !ctx.applicationId);
  if (c.userIds?.length && !(ctx.userId && c.userIds.includes(ctx.userId))) return no('userIds');
  if (!overlaps(c.groups, ctx.groupIds)) return no('groups');
  if (!overlaps(c.orgs, ctx.orgIds)) return no('orgs');
  if (!overlaps(c.roles, ctx.roles)) return no('roles');
  if (c.networkZones?.include?.length && !overlaps(c.networkZones.include, ctx.zoneIds)) return no('networkZones', !ctx.hasIp);
  if (c.networkZones?.exclude?.length && overlaps(c.networkZones.exclude, ctx.zoneIds)) return no('networkZones');
  // A signal the request, the address and the emulator settings all lack is "unknown": the policy is listed as not matched, never as a block.
  if (c.countries?.length && !(ctx.country && c.countries.map((x: string) => x.toUpperCase()).includes(ctx.country.toUpperCase()))) return no('countries', !ctx.country);
  if (c.riskLevels?.length && !(ctx.riskLevel && c.riskLevels.includes(ctx.riskLevel))) return no('riskLevels', !ctx.riskLevel);
  if (c.signInRiskLevels?.length && !(ctx.riskLevel && c.signInRiskLevels.includes(ctx.riskLevel))) return no('signInRiskLevels', !ctx.riskLevel);
  if (c.userRiskLevels?.length && !(ctx.userRiskLevel && c.userRiskLevels.includes(ctx.userRiskLevel))) return no('userRiskLevels', !ctx.userRiskLevel);
  if (c.deviceTrust?.length && !(ctx.deviceTrust && c.deviceTrust.includes(ctx.deviceTrust))) return no('deviceTrust', !ctx.deviceTrust);
  if (c.authMethods?.length && !overlaps(c.authMethods, ctx.authMethods)) return no('authMethods', !ctx.authMethods.length);
  if (c.devicePlatforms?.length && !(ctx.devicePlatform && c.devicePlatforms.map((x: string) => x.toLowerCase()).includes(ctx.devicePlatform.toLowerCase()))) return no('devicePlatforms', !ctx.devicePlatform);
  if (c.osVersion && (c.osVersion.min || c.osVersion.max)) {
    const lo = c.osVersion.min && ctx.osVersion ? compareVersions(ctx.osVersion, c.osVersion.min) : null;
    const hi = c.osVersion.max && ctx.osVersion ? compareVersions(ctx.osVersion, c.osVersion.max) : null;
    if (!ctx.osVersion || (c.osVersion.min && !((lo ?? -1) >= 0)) || (c.osVersion.max && !((hi ?? 1) <= 0))) return no('osVersion', !ctx.osVersion);
  }
  if (c.clientTypes?.length && !(ctx.clientType && c.clientTypes.includes(ctx.clientType))) return no('clientTypes', !ctx.clientType);
  if (c.principalIds?.length && !(ctx.principalId && c.principalIds.includes(ctx.principalId))) return no('principalIds', !ctx.principalId);
  if (c.timeWindow && !inWindow(c.timeWindow, ctx.now)) return no('timeWindow');
  if (c.userAttributes?.length && !c.userAttributes.every((a: Obj) => attrMatches(a, ctx.userAttributes))) return no('userAttributes');
  return null;
}
function inWindow(w: Obj, now: Date): boolean {
  const mins = (s: string) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s ?? '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = mins(w.start);
  const end = mins(w.end);
  if (start === null || end === null) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: w.timezone ?? 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    return false;
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const at = Number(get('hour')) * 60 + Number(get('minute'));
  const dayOk = (d: number) => !w.days?.length || w.days.includes(d);
  if (start <= end) return dayOk(day) && at >= start && at < end;
  return at >= start ? dayOk(day) : dayOk((day + 6) % 7);
}

/** Does an address fall in a network zone: a listed range, a country or ASN the emulator knows for it, or an anonymizer flag. */
export function zoneMatches(e: Engine, z: Obj, ip: string | undefined): boolean {
  if (!ip) return false;
  if ((z.cidrs ?? []).some((c: string) => ipInCidr(ip, c))) return true;
  const f = ipFacts(e, ip);
  if (f.country && (z.countries ?? []).map((c: string) => String(c).toUpperCase()).includes(f.country.toUpperCase())) return true;
  if (f.asn !== null && (z.asns ?? []).includes(f.asn)) return true;
  return (z.anonymizers ?? []).some((k: string) => (k === 'tor' && f.tor) || (k === 'datacenter' && f.datacenter));
}

export interface Decision {
  decision: 'allow' | 'block' | 'step_up';
  matched: string[];
  blockedBy?: string;
  steps: string[];
}
/** Evaluate access policies like the real evaluator: any matching block wins, step-up requirements are unioned; report-only never enforces. */
export function evalSet(sorted: Obj[], ctx: AccessCtx): Decision {
  const out: Decision = { decision: 'allow', matched: [], steps: [] };
  const add = (s: string) => out.steps.includes(s) || out.steps.push(s);
  for (const p of sorted) {
    if (failing(p.conditions ?? {}, ctx)) continue;
    out.matched.push(p.id);
    for (const g of p.grants ?? []) {
      if (g.type === 'block') out.blockedBy ??= p.id;
      else if (g.type === 'require_mfa') add('mfa');
      else if (g.type === 'require_acr') add(`acr:${g.value}`);
      else if (g.type === 'require_policy_acceptance') add(`policy_acceptance:${g.value}`);
      else if (g.type === 'require_action') add(`action:${g.value}`);
      else if (g.type === 'require_password_change') add('action:password_change');
      else if (g.type === 'require_auth_strength') add(`auth_strength:${g.value}`);
      else if (g.type === 'sign_in_frequency') add('sign_in_frequency');
      else if (g.type === 'max_session_age') add('max_session_age');
      else if (g.type === 'require_device_bound_session') add('device_bound_session');
    }
  }
  out.decision = out.blockedBy ? 'block' : out.steps.length ? 'step_up' : 'allow';
  return out;
}

function accessPoliciesLayer(e: Engine, i: ExplainInput): Obj {
  const rows = [...(e.generic.get('access_policies')?.all() ?? [])].reverse().filter((r) => r.enabled !== false);
  if (!rows.length) return { status: 'evaluated', decision: 'no_match', reason: 'The instance has no access policies.', contributions: [] };
  const user = e.db.users.get(i.userId);
  const mems = e.db.memberships.filter((m) => m.user_id === i.userId);
  const zones = (e.generic.get('network_zones')?.all() ?? []).filter((z) => zoneMatches(e, z, i.access?.ip));
  const sig = resolveSignals(e, { userId: i.userId, ip: i.access?.ip, explicit: i.access?.signals });
  const ctx: AccessCtx = {
    stage: 'authorize',
    applicationId: i.access?.applicationId ?? null,
    userId: i.userId,
    groupIds: effectiveGroupKeys(e, i.userId),
    orgIds: [...new Set(mems.map((m) => m.organization_id))],
    roles: [...new Set(mems.map((m) => m.role))],
    zoneIds: zones.map((z) => z.id),
    hasIp: !!i.access?.ip,
    country: sig.country ?? null,
    riskLevel: sig.riskLevel ?? null,
    deviceTrust: sig.deviceTrust ?? null,
    authMethods: sig.authMethods ?? [],
    devicePlatform: sig.devicePlatform ?? null,
    osVersion: sig.osVersion ?? null,
    clientType: sig.clientType ?? null,
    userRiskLevel: sig.userRiskLevel ?? null,
    userAttributes: user?.public_metadata ?? {},
    now: new Date(e.clock.now()),
  };
  // Enabled policies for this stage and target; lower priority number first.
  const live = rows
    .filter((p) => (!p.stages?.length || p.stages.includes('authorize')) && (p.targets?.length ? p.targets : ['user']).includes('user'))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  const enforced = live.filter((p) => p.mode !== 'report_only');
  const report = live.filter((p) => p.mode === 'report_only');
  const dec = evalSet(enforced, ctx);
  const would = report.length ? evalSet(live, ctx) : null;
  const names = new Map(rows.map((r) => [r.id, r.name]));
  // The emulator never has a second factor or auth method for an explain request, so every step-up requirement is unmet.
  const unmet = dec.decision === 'step_up' ? dec.steps : [];
  const out: Obj[] = dec.matched.map((id) => {
    const blocks = dec.decision === 'block' && dec.blockedBy === id;
    const steps = dec.decision === 'step_up' && unmet.length > 0;
    return {
      layer: 'access_policies',
      effect: blocks ? 'deny' : steps ? 'step_up' : 'none',
      matched: true,
      rule: { type: 'access_policy', id, name: names.get(id) ?? null },
      reason: blocks ? `Access policy "${names.get(id)}" blocks this request.` : steps ? `Access policy "${names.get(id)}" applies; the request has not yet met: ${unmet.join(', ')}.` : `Access policy "${names.get(id)}" applies and imposes nothing more.`,
      evidence: steps ? unmet : undefined,
    };
  });
  if (would && would.decision !== 'allow' && would.matched.some((id) => report.some((r) => r.id === id))) {
    for (const id of would.matched.filter((m) => report.some((r) => r.id === m))) {
      out.push({ layer: 'access_policies', effect: 'none', matched: false, rule: { type: 'access_policy_report_only', id, name: names.get(id) ?? null }, reason: `Report-only policy "${names.get(id)}" would ${would.decision === 'block' ? 'block' : 'require a step up for'} this request, but is not enforced.` });
    }
  }
  // Policies that could not match because the emulator lacks the fact (country, risk, device, network data): listed as not matched, never a block.
  for (const p of live) {
    const f = failing(p.conditions ?? {}, ctx);
    if (f?.unknown) out.push({ layer: 'access_policies', effect: 'none', matched: false, rule: { type: 'access_policy', id: p.id, name: p.name }, reason: `Access policy "${p.name}" needs a ${f.key} signal the emulator does not have, so it is reported as not matched.` });
  }
  return { status: 'evaluated', decision: decisionOf(out), ...(out.length ? {} : { reason: 'No access policy applies to this request.' }), contributions: out };
}

// ── FGA ──

/** Best-effort model lookup: does the store's latest model declare this relation on this type? Unknown formats are given the benefit of the doubt. */
function modelHasRelation(model: unknown, type: string, relation: string): boolean {
  if (typeof model === 'string') {
    const t = new RegExp(`(^|\\n)\\s*type\\s+${type}\\b([\\s\\S]*?)(?=\\n\\s*type\\s|$)`).exec(model);
    if (!t) return !/(^|\n)\s*type\s/.test(model);
    return new RegExp(`define\\s+${relation}\\s*:`).test(t[2] ?? '');
  }
  const defs = (model as Obj | null)?.type_definitions;
  if (!Array.isArray(defs)) return true;
  const d = defs.find((x: Obj) => x.type === type);
  return !!d && !!(d.relations && relation in d.relations);
}
/** The newest model of a store (tables list newest first). */
export const latestModel = (e: Engine, storeId: string): Row | undefined => e.generic.get('fga/stores/authorization-models')?.filter((m) => m._parent === storeId)[0];

/**
 * Relationship check over the tuples the emulator holds: a direct tuple, a type wildcard (`user:*`), or membership in a
 * userset (`group:eng#member`) through stored tuples, nested up to eight levels. Contextual tuples are honoured.
 * shortcut: no model rewrites (computed or inherited relations such as `viewer from parent`) and conditional tuples never match;
 * upgrade by running the real engine if your model depends on them.
 */
export function fgaCheck(e: Engine, storeId: string, req: { user: string; relation: string; object: string; contextual?: Tuple[]; context?: Obj; model?: Row }, overlay?: { writes: Tuple[]; deletes: Tuple[] }): boolean {
  const del = new Set((overlay?.deletes ?? []).map((t) => `${t.user}|${t.relation}|${t.object}`));
  const tuples: Tuple[] = [...storeTuples(e, storeId).filter((t) => !del.has(`${t.user}|${t.relation}|${t.object}`)), ...(overlay?.writes ?? []), ...(req.contextual ?? [])];
  // A model written through the authorization-models route is enforced with its rewrites and conditions; a model seeded as plain text keeps the direct, wildcard and userset matching below.
  const compiled = compileStored((req.model ?? latestModel(e, storeId))?.model);
  if (compiled) {
    try {
      return new Resolver(compiled, tuples, req.context).check(parseUser(req.user), req.object, req.relation);
    } catch {
      return false;
    }
  }
  const userType = req.user.split(':')[0];
  const seen = new Set<string>();
  const holds = (user: string, relation: string, object: string, depth: number): boolean => {
    const key = `${relation}|${object}`;
    if (depth > 8 || seen.has(key + user)) return false;
    seen.add(key + user);
    for (const t of tuples) {
      if (t.relation !== relation || t.object !== object || t.condition) continue;
      if (t.user === user || t.user === `${userType}:*`) return true;
      const hash = t.user.indexOf('#');
      if (hash > 0 && holds(user, t.user.slice(hash + 1), t.user.slice(0, hash), depth + 1)) return true;
    }
    return false;
  };
  return holds(req.user, req.relation, req.object, 0);
}

function fgaLayer(e: Engine, i: ExplainInput): Obj {
  const type = i.resource.type;
  const id = i.resource.id ?? i.resource.externalId;
  if (!type || !id) return skipped('FGA needs resource.type and resource.id.');
  const storeId = i.fga?.storeId ?? st(e).config.store_id;
  if (!storeId) return skipped('No FGA store: pass fga.store_id or configure managed sync.');
  if (!storeExists(e, storeId)) return skipped('Unknown FGA store.');
  const model = latestModel(e, storeId);
  if (!model) return skipped('The FGA store has no authorization model.');
  const relation = i.fga?.relation ?? i.action;
  const userType = i.fga?.userType ?? 'user';
  const user = `${userType}:${i.userId}`;
  const object = `${type}:${id}`;
  if (!modelHasRelation(model.model, type, relation)) return skipped(`The model has no relation ${type}#${relation}.`);
  const allowed = fgaCheck(e, storeId, { user, relation, object });
  const evidence = storeTuples(e, storeId)
    .filter((t) => t.object === object && t.relation === relation && (t.user === user || t.user === `${userType}:*` || t.user.includes('#')))
    .slice(0, 25)
    .map((t) => `${t.user}|${t.relation}|${t.object}`);
  return done([{ layer: 'fga', effect: 'allow', matched: allowed, rule: { type: 'fga_check', id: `${object}#${relation}`, name: storeId }, reason: allowed ? `${user} has ${relation} on ${object} (model ${model.id}).` : `${user} has no ${relation} on ${object} in model ${model.id}.`, evidence }]);
}

// ── the answer ──

export function combine(layers: Obj): { decision: string; deciding: Obj[]; summary: string } {
  const all: Obj[] = Object.values(layers).flatMap((l: any) => l?.contributions ?? []).filter((c: Obj) => c.matched);
  const denies = all.filter((c) => c.effect === 'deny');
  if (denies.length) return { decision: 'deny', deciding: denies, summary: `Denied: ${denies.map((d) => `${d.rule.type} "${d.rule.name ?? d.rule.id}"`).join(', ')} denies it.` };
  const allows = all.filter((c) => c.effect === 'allow');
  if (!allows.length) return { decision: 'deny', deciding: [], summary: 'Denied by default: no rule in any layer grants it.' };
  const steps = all.filter((c) => c.effect === 'step_up');
  if (steps.length) return { decision: 'step_up', deciding: [...allows, ...steps], summary: `Allowed once the request satisfies: ${[...new Set(steps.flatMap((s) => s.evidence ?? []))].join(', ') || 'a step up'}.` };
  return { decision: 'allow', deciding: allows, summary: `Allowed: ${allows.length} rule${allows.length === 1 ? '' : 's'} grant it.` };
}

export function explainAccess(e: Engine, i: ExplainInput): Obj {
  const want = new Set<Layer>(i.layers?.length ? i.layers : LAYERS);
  const layers: Obj = {};
  const run: Record<Layer, () => Obj> = {
    rbac: () => rbacLayer(e, i),
    org_roles: orgRolesLayer,
    groups: () => groupsLayer(e, i),
    resource_roles: () => resourceRolesLayer(e, i),
    abac: () => abacLayer(e, i),
    access_policies: () => accessPoliciesLayer(e, i),
    fga: () => fgaLayer(e, i),
  };
  for (const layer of LAYERS) {
    if (!want.has(layer)) continue;
    try {
      layers[layer] = run[layer]();
    } catch (err) {
      layers[layer] = { status: 'error', decision: 'no_match', reason: err instanceof Error ? err.message.slice(0, 200) : 'The layer failed.', contributions: [] };
    }
  }
  const { decision, deciding, summary } = combine(layers);
  return { object: 'authz_explanation', decision, combination: 'deny_overrides', summary, subject: { type: 'user', id: i.userId }, action: i.action, resource: { ...i.resource }, layers, deciding, contributions: Object.values(layers).flatMap((l: any) => l.contributions ?? []) };
}

/** Parse and validate an explain body (snake_case on the wire). `permission` is accepted as an alias of `action`. */
export function parseExplainBody(body: Obj): ExplainInput {
  const obj = (v: unknown, field: string): Obj => {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw bad(`${field} must be an object.`, field);
    return v as Obj;
  };
  const str = (v: unknown, field: string, max = 500): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v.length === 0 || v.length > max) throw bad(`${field} must be a non-empty string.`, field);
    return v;
  };
  const subject = obj(body.subject, 'subject');
  if (subject.type !== undefined && subject.type !== 'user') throw bad('subject.type must be user.', 'subject.type');
  const userId = str(subject.id, 'subject.id');
  if (!userId) throw bad('subject.id is required.', 'subject.id');
  const action = str(body.action ?? body.permission, 'action');
  if (!action) throw bad('action is required.', 'action');
  const r = obj(body.resource, 'resource');
  const abac = obj(body.abac, 'abac');
  const fga = obj(body.fga, 'fga');
  const access = obj(body.access, 'access');
  let layers: Layer[] | undefined;
  if (body.layers !== undefined) {
    if (!Array.isArray(body.layers) || body.layers.some((l) => !(LAYERS as readonly string[]).includes(l))) throw bad(`layers must be a list of: ${LAYERS.join(', ')}.`, 'layers');
    layers = body.layers as Layer[];
  }
  let groups: string[] | undefined;
  if (body.groups !== undefined) {
    if (!Array.isArray(body.groups) || body.groups.some((g) => typeof g !== 'string')) throw bad('groups must be a list of strings.', 'groups');
    groups = body.groups;
  }
  const attrs = (v: unknown, field: string) => (v === undefined ? undefined : obj(v, field));
  return {
    userId,
    action,
    // The organization may ride on resource.organization_id or, as before, on a top-level organization_id.
    resource: { type: str(r.type, 'resource.type'), id: str(r.id, 'resource.id'), resourceId: str(r.resource_id, 'resource.resource_id'), externalId: str(r.external_id, 'resource.external_id'), organizationId: str(r.organization_id ?? body.organization_id, 'resource.organization_id') },
    groups,
    context: body.context === undefined ? undefined : obj(body.context, 'context'),
    abac: { principalType: str(abac.principal_type, 'abac.principal_type', 100), resourceType: str(abac.resource_type, 'abac.resource_type', 100), principalAttributes: attrs(abac.principal_attributes, 'abac.principal_attributes'), resourceAttributes: attrs(abac.resource_attributes, 'abac.resource_attributes') },
    fga: { storeId: str(fga.store_id, 'fga.store_id'), relation: str(fga.relation, 'fga.relation', 100), userType: str(fga.user_type, 'fga.user_type', 100) },
    access: { applicationId: str(access.application_id, 'access.application_id'), ip: str(access.ip, 'access.ip', 100), signals: readSignals(access, (m, p) => { throw bad(m, p); }, 'access.') },
    layers,
  };
}

