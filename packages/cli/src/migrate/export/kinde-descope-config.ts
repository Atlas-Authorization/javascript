import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, keyOf, socialKey } from './translate-kit';
import { VendorApiError, type VendorHttp } from './vendor-http';

async function optional<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VendorApiError && [400, 403, 404].includes(err.status)) return fallback;
    throw err;
  }
}

// ── Kinde ───────────────────────────────────────────────────────────────────

/**
 * `atlas migrate kinde config` — what Kinde's Management API exposes:
 * applications (callback and logout URLs), connections (social and
 * enterprise), roles and permissions, and registered APIs. Kinde does not
 * expose its authentication settings (password, MFA, session lifetimes) by
 * API: the report lists them as manual, with where to find them.
 */
export interface KindeConfigSnapshot {
  domain: string;
  applications: Array<Obj & { redirects?: string[] }>;
  connections: Obj[];
  roles: Array<Obj & { permissions?: Obj[] }>;
  permissions: Obj[];
  apis: Obj[];
}

export async function fetchKindeConfig(http: VendorHttp, domain: string): Promise<KindeConfigSnapshot> {
  const list = (path: string, key: string) => optional(async () => objs((await http.get<Obj>(path)).body?.[key]), [] as Obj[]);
  const applications = (await list('/applications?page_size=500', 'applications')) as KindeConfigSnapshot['applications'];
  for (const a of applications) {
    const raw = await optional(async () => (await http.get<Obj>(`/applications/${str(a.id)}/auth_redirect_urls`)).body?.redirect_urls, undefined as unknown);
    const urls: unknown[] = Array.isArray(raw) ? raw : [];
    a.redirects = urls.map((u) => (typeof u === 'string' ? u : isObj(u) ? (str(u.redirect_url) ?? str(u.url)) : undefined)).filter((u): u is string => !!u);
  }
  const roles = (await list('/roles?page_size=500', 'roles')) as KindeConfigSnapshot['roles'];
  for (const r of roles) r.permissions = await list(`/roles/${str(r.id)}/permissions?page_size=500`, 'permissions');
  return {
    domain,
    applications,
    connections: await list('/connections?page_size=500', 'connections'),
    roles,
    permissions: await list('/permissions?page_size=500', 'permissions'),
    apis: await list('/apis', 'apis'),
  };
}

export function translateKindeConfig(snap: KindeConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  for (const c of snap.connections) {
    const strategy = str(c.strategy) ?? '';
    const name = str(c.display_name) ?? str(c.name) ?? strategy;
    if (strategy === 'email:password' || strategy === 'username:password') {
      b.set('strategies.password', true);
      if (strategy === 'username:password') b.set('strategies.username', true);
      b.add('mapped', 'authentication', `connection ${name}`, 'Password sign-in; hashes move with Kinde\'s "All data" export.', 'auth_config.strategies.password');
    } else if (strategy === 'email:otp' || strategy === 'username:otp') {
      b.set('strategies.emailCode', true);
      b.add('mapped', 'authentication', `connection ${name}`, 'Passwordless email code.', 'auth_config.strategies.emailCode');
    } else if (strategy === 'phone:otp') {
      b.set('strategies.phoneCode', true);
      b.add('mapped', 'authentication', `connection ${name}`, 'SMS code.', 'auth_config.strategies.phoneCode');
    } else if (/^(saml|wsfed|oauth2:(azure_ad|microsoft_entra))/.test(strategy)) {
      b.add('mapped', 'enterprise', `connection ${name} (${strategy})`, 'Moves with the data export as an Atlas SSO connection (add the client secret / confirm the certificate after the import).', 'sso_connections');
    } else if (strategy.startsWith('oauth2:')) {
      const key = socialKey(strategy);
      if (key) b.socialProvider({ atlasKey: key, vendorName: name, area: 'authentication', setting: `connection ${name} (${strategy})` });
      else b.add('manual', 'authentication', `connection ${name} (${strategy})`, 'No built-in Atlas provider: add it as a custom OAuth provider.', 'custom_oauth_providers');
    } else if (strategy) {
      b.add('manual', 'authentication', `connection ${name} (${strategy})`, 'Review this connection by hand.');
    }
  }
  const redirects = new Set<string>();
  for (const a of snap.applications) for (const u of a.redirects ?? []) redirects.add(u);
  for (const url of redirects) b.push('redirect_urls', { url });
  if (redirects.size) b.add('mapped', 'applications', 'allowed callback URLs', `${redirects.size} callback URL(s).`, 'redirect_urls');
  for (const a of snap.applications) if (str(a.type) === 'm2m') b.add('manual', `applications ${str(a.name) ?? str(a.id)}`, 'type m2m', 'Machine-to-machine application: create an Atlas M2M client.', 'oauth_clients');
  for (const p of snap.permissions) {
    const key = str(p.key);
    if (key) b.push('permissions', { key, name: str(p.name) ?? key, description: str(p.description) ?? '' } as Json);
  }
  for (const r of snap.roles) {
    const key = str(r.key);
    if (!key) continue;
    const atlasKey = `org:${keyOf(key.replace(/^org:/, ''))}`;
    b.roles[key] = atlasKey;
    b.push('roles', { key: atlasKey, name: str(r.name) ?? key, description: str(r.description) ?? '', permissions: (r.permissions ?? []).map((p) => str(p.key)).filter((p): p is string => !!p) } as Json);
  }
  if (snap.roles.length) b.add('mapped', 'roles', 'roles', `${snap.roles.length} organization role(s) with permissions (Kinde roles apply inside organizations).`, 'roles');
  for (const api of snap.apis) {
    const audience = str(api.audience);
    if (audience && !audience.endsWith('/api')) {
      b.push('resource_servers', { identifier: audience, name: str(api.name) ?? audience, scopes: [] } as Json);
      b.add('mapped', 'APIs', `apis ${str(api.name) ?? audience}`, `Access tokens keep "aud": "${audience}".`, `resource_servers ${audience}`);
    }
  }
  for (const [setting, where] of [
    ['multi-factor authentication', 'Settings → Environment → Multi-factor auth'],
    ['password rules and breached-password checks', 'Settings → Environment → Authentication'],
    ['session and token lifetimes', 'Applications → <app> → Tokens'],
    ['feature flags', 'Feature flags (no Atlas counterpart: keep them in your own flag service)'],
  ] as const) {
    b.add('manual', 'settings not in the API', setting, `Kinde does not expose this by API; copy it from Kinde (${where}).`);
  }
  return b.result(`Kinde business ${snap.domain}`, { bridge: { preset: 'kinde', vars: { domain: snap.domain } } });
}

// ── Descope ─────────────────────────────────────────────────────────────────

/**
 * `atlas migrate descope config` — a Descope project's password settings,
 * roles and permissions (management key, on this machine). Flows, connectors
 * and styles are Descope-specific: reported as manual. Tenant SSO moves with
 * the data export.
 */
export interface DescopeConfigSnapshot {
  projectId: string;
  passwordSettings: Obj | null;
  roles: Obj[];
  permissions: Obj[];
}

export async function fetchDescopeConfig(http: VendorHttp, projectId: string): Promise<DescopeConfigSnapshot> {
  return {
    projectId,
    passwordSettings: await optional(async () => (await http.get<Obj>('/v1/mgmt/password/settings')).body ?? null, null as Obj | null),
    roles: await optional(async () => objs((await http.get<Obj>('/v1/mgmt/role/all')).body?.roles), [] as Obj[]),
    permissions: await optional(async () => objs((await http.get<Obj>('/v1/mgmt/permission/all')).body?.permissions), [] as Obj[]),
  };
}

export function translateDescopeConfig(snap: DescopeConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const pw = snap.passwordSettings;
  if (pw && isObj(pw)) {
    b.set('strategies.password', pw.enabled !== false);
    b.add('mapped', 'password', 'enabled', pw.enabled === false ? 'Password sign-in off.' : 'Password sign-in. Descope keeps hashes (Argon2id) unless its support exports them: the descope lazy-migration preset moves each password on first sign-in.', 'auth_config.strategies.password');
    if (typeof pw.minLength === 'number') {
      b.set('passwordPolicy.minLength', Math.max(8, pw.minLength));
      b.add(pw.minLength < 8 ? 'differs' : 'mapped', 'password', 'minLength', `${pw.minLength}${pw.minLength < 8 ? ' (Atlas requires at least 8)' : ''}.`, 'auth_config.passwordPolicy.minLength');
    }
    if (['lowercase', 'uppercase', 'number', 'nonAlphanumeric'].some((k) => pw[k] === true)) b.add('differs', 'password', 'character classes', 'Atlas follows NIST 800-63B (length and breached-password checks, no character-class rules).', 'auth_config.passwordPolicy');
    if (pw.expiration === true) b.add('manual', 'password', 'expiration', 'Atlas does not expire passwords.');
    if (pw.reuse === true) b.add('manual', 'password', 'reuse', 'Atlas does not keep a password history.');
    if (pw.lock === true) b.add('mapped', 'password', 'lock', `Descope locks after ${pw.lockAttempts ?? '?'} attempts; Atlas throttles failed sign-ins per account and IP.`, 'auth_config.rateLimit');
  }
  for (const p of snap.permissions) {
    const name = str(p.name);
    if (name) b.push('permissions', { key: keyOf(name), name, description: str(p.description) ?? '' } as Json);
  }
  const seen = new Set<string>();
  for (const r of snap.roles) {
    const name = str(r.name);
    if (!name || str(r.tenantId)) continue;
    const key = keyOf(name);
    if (seen.has(key)) continue;
    seen.add(key);
    b.roles[name] = key;
    b.push('roles', { key, name, description: str(r.description) ?? '', permissions: strs(r.permissionNames).map(keyOf) } as Json);
  }
  if (seen.size) b.add('mapped', 'authorization', 'roles', `${seen.size} role(s) (project roles become app roles; the same keys seat tenant members).`, 'roles');
  const tenantRoles = snap.roles.filter((r) => str(r.tenantId)).length;
  if (tenantRoles) b.add('differs', 'authorization', 'tenant-scoped roles', `${tenantRoles} role(s) defined inside one tenant: they move with the data export as that organization's custom roles.`, 'roles');
  b.add('manual', 'flows', 'flows and screens', 'Descope flows (sign-up-or-in, step-up, MFA screens) are replaced by Atlas\'s hosted pages and components; recreate custom steps (forms, connectors) as Atlas actions.', 'actions');
  b.add('manual', 'authentication methods', 'magic link / OTP / social / passkeys', 'Descope does not expose its enabled authentication methods by API: turn the same ones on in Atlas (strategies, oauth_providers).', 'auth_config.strategies');
  return b.result(`Descope project ${snap.projectId}`, {
    bridge: { preset: 'descope', vars: { project_id: snap.projectId } },
    lazy: { preset: 'descope', config: { project_id: snap.projectId } },
  });
}
