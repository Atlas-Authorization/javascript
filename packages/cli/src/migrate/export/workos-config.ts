import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder } from './translate-kit';
import { VendorApiError, type VendorHttp } from './vendor-http';

/**
 * `atlas migrate workos config` — what WorkOS's API exposes of an environment:
 * roles and permissions (RBAC), the redirect URIs and CORS origins registered
 * for AuthKit, and the SSO connections / Directory Sync directories (which
 * move with the data export). Authentication methods, MFA policy, session and
 * token lifetimes, branding, email templates, JWT templates and signup rules
 * live only in the WorkOS dashboard: the report lists each as manual, with
 * where to find it.
 */
export interface WorkosConfigSnapshot {
  clientId?: string;
  roles: Obj[];
  permissions: Obj[];
  redirectUris: Obj[];
  corsOrigins: Obj[];
  connections: Obj[];
  directories: number;
}

async function listOf(http: VendorHttp, path: string): Promise<Obj[]> {
  const out: Obj[] = [];
  let after: string | undefined;
  try {
    for (;;) {
      const q = new URLSearchParams({ limit: '100', order: 'asc' });
      if (after) q.set('after', after);
      const body = (await http.get<Obj>(`${path}?${q.toString()}`)).body;
      out.push(...objs(isObj(body) ? body.data : undefined));
      const next = isObj(body) && isObj(body.list_metadata) ? str(body.list_metadata.after) : undefined;
      if (!next || next === after) break;
      after = next;
    }
  } catch (err) {
    // Absent on this environment (RBAC off, endpoint not offered, no permission).
    if (err instanceof VendorApiError && [400, 403, 404, 405].includes(err.status)) return out;
    throw err;
  }
  return out;
}

async function plainList(http: VendorHttp, path: string): Promise<Obj[]> {
  try {
    const body = (await http.get<Obj>(path)).body;
    return objs(isObj(body) ? body.data : undefined);
  } catch (err) {
    if (err instanceof VendorApiError && [400, 403, 404, 405].includes(err.status)) return [];
    throw err;
  }
}

export async function fetchWorkosConfig(http: VendorHttp, clientId?: string): Promise<WorkosConfigSnapshot> {
  return {
    ...(clientId ? { clientId } : {}),
    // The roles listing is not paginated.
    roles: await plainList(http, '/authorization/roles'),
    permissions: await listOf(http, '/authorization/permissions'),
    redirectUris: await listOf(http, '/user_management/redirect_uris'),
    corsOrigins: await listOf(http, '/user_management/cors_origins'),
    connections: await listOf(http, '/connections'),
    directories: (await listOf(http, '/directories')).length,
  };
}

export function translateWorkosConfig(snap: WorkosConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();

  for (const p of snap.permissions) {
    const key = str(p.slug);
    if (key) b.push('permissions', { key, name: str(p.name) ?? key, description: str(p.description) ?? '' } as Json);
  }
  if (snap.permissions.length) b.add('mapped', 'authorization', 'permissions', `${snap.permissions.length} permission(s).`, 'permissions');

  let roles = 0;
  for (const r of snap.roles) {
    const slug = str(r.slug);
    // Organization-specific roles are exported per organization with the data.
    if (!slug || str(r.type) === 'OrganizationRole') continue;
    roles++;
    b.roles[slug] = slug;
    b.push('roles', { key: slug, name: str(r.name) ?? slug, description: str(r.description) ?? '', permissions: strs(r.permissions) } as Json);
  }
  if (roles) b.add('mapped', 'authorization', 'environment roles', `${roles} role(s); members keep the same role slug as their Atlas role key.`, 'roles');
  if (snap.roles.length === 0) b.add('manual', 'authorization', 'roles', 'No roles were returned (RBAC may be off for this environment); the default "admin" and "member" roles carry over as Atlas organization roles.');

  const redirects = new Set<string>();
  for (const u of snap.redirectUris) {
    const uri = str(u.uri);
    if (uri) redirects.add(uri);
  }
  for (const url of redirects) {
    if (url.includes('*')) b.add('differs', 'redirect URIs', url, 'Atlas redirect URLs are exact (no wildcards).', 'redirect_urls');
    else b.push('redirect_urls', { url });
  }
  const exact = [...redirects].filter((u) => !u.includes('*')).length;
  if (exact) b.add('mapped', 'redirect URIs', 'redirect_uris', `${exact} redirect URI(s).`, 'redirect_urls');
  if (redirects.size === 0) b.add('manual', 'redirect URIs', 'redirect_uris', 'WorkOS did not list its redirect URIs by API: add your app\'s post-sign-in URLs to Atlas (redirect_urls).', 'redirect_urls');

  for (const o of snap.corsOrigins) {
    const origin = str(o.origin);
    if (origin) b.add('manual', 'CORS origins', origin, 'Add this origin to the allowed origins of your Atlas instance (Atlas dashboard → Settings → Allowed origins).');
  }

  const sso = snap.connections.length;
  if (sso) b.add('mapped', 'enterprise', `${sso} SSO connection(s)`, 'Move with the data export as Atlas SSO connections. WorkOS does not return the identity provider details: each customer\'s IdP is set up again against the new Atlas service-provider settings.', 'sso_connections');
  if (snap.directories) b.add('manual', 'enterprise', `${snap.directories} Directory Sync directory(ies)`, 'Reconnect through Atlas SCIM provisioning; the identity provider re-provisions users and groups.');

  for (const [setting, where] of [
    ['authentication methods (password, Magic Auth, social, passkeys)', 'Authentication → Methods'],
    ['social connections (client ids and secrets)', 'Authentication → Social login (use the same OAuth apps in Atlas so imported accounts relink)'],
    ['multi-factor authentication policy', 'Authentication → Multi-Factor Auth'],
    ['session lifetime and access token lifetime', 'Authentication → Sessions'],
    ['sign-up rules, email verification and domain restrictions', 'Authentication → Sign-up'],
    ['branding, hosted-page text and email templates', 'Branding and Email'],
    ['JWT templates and custom claims', 'Authentication → Sessions → JWT template'],
    ['custom authentication domain', 'Domains'],
    ['Radar (bot and fraud rules)', 'Radar'],
    ['webhooks and events', 'Webhooks (create Atlas webhook endpoints)'],
  ] as const) {
    b.add('manual', 'settings not in the API', setting, `WorkOS does not expose this by API; copy it from the WorkOS dashboard (${where}).`);
  }

  return b.result(`WorkOS environment${snap.clientId ? ` ${snap.clientId}` : ''}`, {
    ...(snap.clientId
      ? { bridge: { preset: 'workos', vars: { client_id: snap.clientId } }, lazy: { preset: 'workos', config: { client_id: snap.clientId } } }
      : {}),
  });
}
