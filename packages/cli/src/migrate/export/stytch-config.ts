import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { stytchRoleKey, type StytchProduct } from './stytch';
import { ConfigBuilder } from './translate-kit';
import { VendorApiError, type VendorHttp } from './vendor-http';

/**
 * `atlas migrate stytch config` — what Stytch's project API exposes: the RBAC
 * policy (roles, resources and their actions) and, for B2B, the organizations
 * with their SSO connections. Password strength, session duration, OAuth
 * providers, MFA and branding are dashboard-only settings: the report lists
 * each as manual, with where to find it. The bridge and lazy-migration presets
 * are carried to the next step.
 */
export interface StytchConfigSnapshot {
  projectId: string;
  product: StytchProduct;
  roles: Obj[];
  resources: Obj[];
  organizations: number;
  ssoConnections: number;
}

async function optionalGet(http: VendorHttp, path: string): Promise<Obj | null> {
  try {
    const body = (await http.get<Obj>(path)).body;
    return isObj(body) ? body : null;
  } catch (err) {
    if (err instanceof VendorApiError && [400, 403, 404].includes(err.status)) return null;
    throw err;
  }
}

export async function fetchStytchConfig(http: VendorHttp, projectId: string, product: StytchProduct): Promise<StytchConfigSnapshot> {
  // The consumer policy endpoint is UNCONFIRMED; a project without it just reports no roles.
  const res = await optionalGet(http, product === 'b2b' ? '/v1/b2b/rbac/policy' : '/v1/rbac/policy');
  const policy: Obj = res && isObj(res.policy) ? res.policy : {};
  let organizations = 0;
  let ssoConnections = 0;
  if (product === 'b2b') {
    try {
      const { body } = await http.post<Obj>('/v1/b2b/organizations/search', { limit: 1000 });
      const orgs = objs(isObj(body) ? body.organizations : undefined);
      organizations = orgs.length;
      for (const o of orgs) {
        const id = str(o.organization_id);
        const sso = id ? await optionalGet(http, `/v1/b2b/sso/${encodeURIComponent(id)}`) : null;
        if (sso) ssoConnections += objs(sso.saml_connections).length + objs(sso.oidc_connections).length;
      }
    } catch (err) {
      if (!(err instanceof VendorApiError)) throw err;
    }
  }
  return { projectId, product, roles: objs(policy.roles), resources: objs(policy.resources), organizations, ssoConnections };
}

export function translateStytchConfig(snap: StytchConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();

  const permissions = new Set<string>();
  for (const r of snap.resources) {
    const resource = str(r.resource_id);
    if (resource) for (const a of strs(r.actions)) permissions.add(`${resource}:${a}`);
  }
  let roles = 0;
  for (const r of snap.roles) {
    const id = str(r.role_id);
    if (!id) continue;
    const key = stytchRoleKey(id);
    const perms = objs(r.permissions).flatMap((p) => strs(p.actions).map((a) => `${str(p.resource_id) ?? '*'}:${a}`));
    for (const p of perms) if (!p.startsWith('*:')) permissions.add(p);
    // Built-in roles already exist in Atlas as admin and member.
    if (key !== id) continue;
    roles++;
    b.roles[id] = key;
    b.push('roles', { key, name: key, description: str(r.description) ?? '', permissions: perms } as Json);
  }
  for (const key of permissions) b.push('permissions', { key, name: key, description: '' } as Json);
  if (permissions.size) b.add('mapped', 'authorization', 'RBAC resources and actions', `${permissions.size} permission(s), keyed resource:action.`, 'permissions');
  if (roles) b.add('mapped', 'authorization', 'custom roles', `${roles} role(s); members keep the same role id as their Atlas role key. stytch_admin and stytch_member map to Atlas's admin and member.`, 'roles');
  if (snap.roles.length === 0) b.add('manual', 'authorization', 'RBAC policy', 'No RBAC policy was returned; default roles carry over as admin and member.');

  if (snap.ssoConnections) b.add('mapped', 'enterprise', `${snap.ssoConnections} SSO connection(s) in ${snap.organizations} organization(s)`, 'Move with the data export as Atlas SSO connections.', 'sso_connections');
  if (snap.product === 'b2b') b.add('manual', 'organizations', 'organization MFA policy, allowed auth methods, JIT provisioning', 'Per-organization settings are kept in the exported organization metadata; set the matching policy on each Atlas organization.');

  for (const [setting, where] of [
    ['password strength (zxcvbn / LUDS) and breach check', 'Dashboard → Authentication → Passwords; set Atlas password rules under auth_config.password'],
    ['session duration and JWT lifetime', 'Dashboard → Sessions; set the Atlas session lifetime'],
    ['OAuth providers (client ids and secrets)', 'Dashboard → OAuth; use the same OAuth apps in Atlas so imported accounts relink'],
    ['redirect URLs and authorized domains', 'Dashboard → Redirect URLs, SDK configuration'],
    ['multi-factor authentication (TOTP, SMS)', 'Dashboard → Authentication → MFA'],
    ['email templates, SMS and branding', 'Dashboard → Email templates, Branding'],
    ['custom claims and JWT templates', 'Dashboard → Sessions → JWT templates'],
    ['webhooks', 'Dashboard → Webhooks (create Atlas webhook endpoints)'],
  ] as const) {
    b.add('manual', 'settings not in the API', setting, `Stytch does not expose this through the project API; copy it from ${where}.`);
  }

  const test = snap.projectId.startsWith('project-test-');
  const vars: Record<string, string> = { project_id: snap.projectId, ...(test ? { api_host: 'test.stytch.com' } : {}), ...(snap.product === 'b2b' ? { jwks_path: 'b2b/sessions' } : {}) };
  return b.result(`Stytch project ${snap.projectId}`, {
    bridge: { preset: 'stytch', vars },
    lazy: { preset: 'stytch', config: { project_id: snap.projectId, product: snap.product } },
  });
}
