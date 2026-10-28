import type { Json } from '../../serialize';
import type { TranslationResult } from '../framework/plugin';
import { objs, str, type Obj } from './record-set';
import { ConfigBuilder, keyOf } from './translate-kit';
import { checkTenantId } from './userfront';
import { VendorApiError, type VendorHttp } from './vendor-http';

/**
 * `atlas migrate userfront config` — what Userfront's admin API exposes about
 * a tenant's configuration: its roles. Sign-in methods, forms, password and
 * MFA rules, session lifetimes, domains and branding live only in the
 * Userfront dashboard: the report lists each as manual with where to look.
 * Passwords move by the `userfront` lazy-migration preset.
 */
export interface UserfrontConfigSnapshot {
  tenantId: string;
  roles: string[];
}

export async function fetchUserfrontConfig(http: VendorHttp, tenantId: string): Promise<UserfrontConfigSnapshot> {
  const tid = checkTenantId(tenantId);
  let body: Obj | null = null;
  try {
    body = (await http.get<Obj>(`/tenants/${tid}/roles`)).body;
  } catch (err) {
    if (!(err instanceof VendorApiError) || ![400, 403, 404].includes(err.status)) throw err;
  }
  return { tenantId: tid, roles: objs(body?.roles).map((r) => str(r.name)).filter((n): n is string => !!n) };
}

export function translateUserfrontConfig(snap: UserfrontConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const seen = new Set<string>();
  for (const name of snap.roles) {
    const key = keyOf(name);
    if (seen.has(key)) continue;
    seen.add(key);
    b.roles[name] = key;
    b.push('roles', { key, name, description: '', permissions: [] } as Json);
  }
  if (seen.size) b.add('mapped', 'authorization', 'roles', `${seen.size} role(s) (tenant roles become app roles; members keep theirs with the data export).`, 'roles');
  b.add('mapped', 'authentication', 'password sign-in', 'Userfront never returns password hashes: the userfront lazy-migration preset checks each password against Userfront on the first Atlas sign-in.', 'auth_config.strategies.password');
  for (const [setting, where] of [
    ['sign-in methods (password, email link, code, social, SSO)', 'Dashboard → Authentication'],
    ['multi-factor authentication', 'Dashboard → Authentication → Multi-factor'],
    ['session and token lifetimes', 'Dashboard → Settings → Sessions'],
    ['social provider credentials', 'Dashboard → Authentication → Social (re-enter each client id and secret as an Atlas oauth provider)'],
    ['domains and redirect URLs', 'Dashboard → Settings → Domains'],
    ['forms and branding', 'Dashboard → Toolkit / Branding (use the Atlas components and theme)'],
    ['custom emails', 'Dashboard → Emails (use the Atlas email templates)'],
  ] as const) {
    b.add('manual', 'settings not in the API', setting, `Userfront does not expose this by API; copy it from the dashboard (${where}).`);
  }
  b.add('differs', 'sessions', 'access and ID tokens', 'Userfront tokens carry no issuer claim, so the zero-logout bridge cannot verify them: users sign in once more after the switch.', 'migration bridge');
  return b.result(`Userfront tenant ${snap.tenantId}`, { lazy: { preset: 'userfront', config: { tenant_id: snap.tenantId } } });
}
