import type { TranslationResult } from '../framework/plugin';
import { objs, str, type Obj } from './record-set';
import { ConfigBuilder } from './translate-kit';
import { normalizeAuthUrl } from './propelauth';
import { VendorApiError, type VendorHttp } from './vendor-http';

/**
 * `atlas migrate propelauth config` — what PropelAuth's backend API exposes
 * about a project's configuration: the custom role mappings, and which
 * organizations have SAML set up. Login methods, password and MFA rules,
 * session lifetimes, branding and the hosted-page settings live only in the
 * PropelAuth dashboard: the report lists each as manual with where to find it.
 */
export interface PropelauthConfigSnapshot {
  authUrl: string;
  /** Names of the custom role mappings (shape UNCONFIRMED: tolerated as objects or bare names). */
  roleMappings: string[];
  orgs: number;
  samlOrgs: number;
}

async function optional<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VendorApiError && [400, 403, 404, 405].includes(err.status)) return fallback;
    throw err;
  }
}

export async function fetchPropelauthConfig(http: VendorHttp, authUrl: string): Promise<PropelauthConfigSnapshot> {
  const mappings = await optional(async () => (await http.get<unknown>('/api/backend/v1/custom_role_mappings')).body, null as unknown);
  const list: unknown[] = Array.isArray(mappings) ? mappings : Array.isArray((mappings as Obj | null)?.custom_role_mappings) ? ((mappings as Obj).custom_role_mappings as unknown[]) : [];
  const roleMappings = list.map((m) => (typeof m === 'string' ? m : str((m as Obj | null)?.custom_role_mapping_name) ?? str((m as Obj | null)?.name))).filter((n): n is string => !!n);
  let orgs = 0;
  let samlOrgs = 0;
  for (let page = 0; page < 1000; page++) {
    const body = await optional(async () => (await http.get<Obj>(`/api/backend/v1/org/query?page_size=100&page_number=${page}`)).body, null as Obj | null);
    const rows = objs(body?.orgs);
    orgs += rows.length;
    samlOrgs += rows.filter((o) => o.is_saml_configured === true).length;
    if (body?.has_more_results !== true || rows.length === 0) break;
  }
  return { authUrl: normalizeAuthUrl(authUrl), roleMappings, orgs, samlOrgs };
}

export function translatePropelauthConfig(snap: PropelauthConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  b.add('mapped', 'organizations', 'organizations and members', `${snap.orgs} organization(s) with their members, roles, permissions and pending invitations move with the data export.`, 'organizations');
  for (const name of snap.roleMappings) {
    b.add('manual', 'roles', `custom role mapping ${name}`, 'PropelAuth role mappings choose which role set an organization uses; Atlas roles are instance-wide, so recreate the set once and assign it in Atlas.', 'roles');
  }
  if (snap.samlOrgs > 0) {
    b.add('manual', 'enterprise', `SAML (${snap.samlOrgs} organization(s))`, 'PropelAuth never returns a connection\'s IdP settings: create each SAML connection again in Atlas with the IdP\'s metadata.', 'sso_connections');
  }
  for (const [setting, where] of [
    ['login methods (password, passwordless, social)', 'Dashboard → Login Methods'],
    ['password and MFA requirements', 'Dashboard → Login Methods / Security'],
    ['session and token lifetimes', 'Dashboard → Settings → Sessions'],
    ['social provider credentials', 'Dashboard → Login Methods → Social (re-enter each client id and secret as an Atlas oauth provider)'],
    ['allowed redirect URLs and domains', 'Dashboard → Frontend Integration'],
    ['branding, hosted pages and emails', 'Dashboard → Branding / Emails (use the Atlas theme and email templates)'],
    ['user properties and metadata schema', 'Dashboard → User Properties (carried as user metadata in the export)'],
  ] as const) {
    b.add('manual', 'settings not in the API', setting, `PropelAuth does not expose this by API; copy it from the dashboard (${where}).`);
  }
  b.add('differs', 'sessions', 'access tokens', 'PropelAuth signs RS256 tokens verified with a project verifier key (there is no JWKS). The propelauth bridge preset needs that key to keep sessions through the switch; new sign-ins use Atlas tokens.', 'migration bridge');
  return b.result(`PropelAuth project ${snap.authUrl}`, { bridge: { preset: 'propelauth', vars: { auth_url: snap.authUrl } } });
}
