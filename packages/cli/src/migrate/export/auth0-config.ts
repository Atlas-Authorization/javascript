import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, clampSessionMs, keyOf, socialKey } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate auth0 config` — an Auth0 tenant's settings → Atlas config,
 * read with the Management API on this machine: tenant settings (session
 * lifetimes), database connections (password policy, username, sign-up,
 * passkeys), passwordless and social connections, MFA factors and policy,
 * breached-password detection, applications (callback URLs, web origins),
 * APIs, roles and permissions. Actions, Rules, Hooks and branding are code
 * or design: reported as manual.
 */
export interface Auth0ConfigSnapshot {
  domain: string;
  tenant: Obj;
  connections: Obj[];
  guardianFactors: Obj[];
  guardianPolicies: string[];
  breachedPassword: Obj | null;
  clients: Obj[];
  resourceServers: Obj[];
  roles: Array<Obj & { permissions?: Obj[] }>;
  actions: Obj[];
  rules: Obj[];
}

export async function fetchAuth0Config(http: VendorHttp, domain: string): Promise<Auth0ConfigSnapshot> {
  const get = async <T>(path: string, fallback: T): Promise<T> => {
    try {
      return (await http.get<T>(path)).body ?? fallback;
    } catch (err) {
      if (err instanceof VendorApiError && [403, 404].includes(err.status)) return fallback;
      throw err;
    }
  };
  const list = async (path: string, key: string): Promise<Obj[]> => {
    const body = await get<unknown>(path, []);
    return Array.isArray(body) ? objs(body) : isObj(body) ? objs(body[key]) : [];
  };
  const roles = (await list('/roles?per_page=100', 'roles')) as Auth0ConfigSnapshot['roles'];
  for (const r of roles) r.permissions = await list(`/roles/${str(r.id)}/permissions?per_page=100`, 'permissions');
  return {
    domain,
    tenant: await get<Obj>('/tenants/settings', {}),
    connections: await list('/connections?per_page=100', 'connections'),
    guardianFactors: await list('/guardian/factors', 'factors'),
    guardianPolicies: strs(await get<unknown>('/guardian/policies', [])),
    breachedPassword: await get<Obj | null>('/attack-protection/breached-password-detection', null),
    clients: await list('/clients?per_page=100&is_global=false', 'clients'),
    resourceServers: await list('/resource-servers?per_page=100', 'resource_servers'),
    roles,
    actions: await list('/actions/actions?per_page=100', 'actions'),
    rules: await list('/rules?per_page=100', 'rules'),
  };
}

const HOUR = 3600_000;

export function translateAuth0Config(snap: Auth0ConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();

  // ── sessions ──
  const t = snap.tenant;
  if (typeof t.session_lifetime === 'number') {
    const ms = clampSessionMs(t.session_lifetime * HOUR);
    b.set('session.absoluteMs', ms);
    b.add(ms === t.session_lifetime * HOUR ? 'mapped' : 'differs', 'tenant settings', 'session_lifetime', `${t.session_lifetime} hour(s)${ms !== t.session_lifetime * HOUR ? ' (clamped to Atlas\'s 90-day maximum)' : ''}.`, 'auth_config.session.absoluteMs');
  }
  if (typeof t.idle_session_lifetime === 'number') {
    const ms = clampSessionMs(t.idle_session_lifetime * HOUR);
    b.set('session.idleMs', ms);
    b.add('mapped', 'tenant settings', 'idle_session_lifetime', `${t.idle_session_lifetime} hour(s) of inactivity.`, 'auth_config.session.idleMs');
  }

  // ── database connections ──
  const dbs = snap.connections.filter((c) => str(c.strategy) === 'auth0');
  if (dbs.length > 1) b.add('differs', 'connections', 'database connections', `${dbs.length} database connections: Atlas has one user store per instance; their users are imported together (an email in two connections becomes one user).`, 'users');
  const db = dbs.find((c) => str(c.name) === 'Username-Password-Authentication') ?? dbs[0];
  b.set('strategies.password', Boolean(db));
  if (db) {
    const o = isObj(db.options) ? db.options : {};
    const name = str(db.name)!;
    const area = `connections ${name}`;
    b.add('mapped', area, 'strategy auth0', 'Email + password sign-in. Imported password hashes (support export) verify as-is; lazy migration covers the rest.', 'auth_config.strategies.password');
    const complexity = isObj(o.password_complexity_options) ? o.password_complexity_options : {};
    const policyMin: Record<string, number> = { none: 1, low: 6, fair: 8, good: 8, excellent: 10 };
    const policy = str(o.passwordPolicy) ?? 'good';
    const min = typeof complexity.min_length === 'number' ? complexity.min_length : policyMin[policy] ?? 8;
    b.set('passwordPolicy.minLength', Math.max(8, min));
    b.add(min < 8 ? 'differs' : 'mapped', area, 'options.password_complexity_options.min_length', min < 8 ? `Auth0 allows ${min}; Atlas requires at least 8 (existing passwords still sign in).` : `${min}.`, 'auth_config.passwordPolicy.minLength');
    if (policy === 'fair' || policy === 'good' || policy === 'excellent') b.add('differs', area, `options.passwordPolicy "${policy}"`, 'Atlas follows NIST 800-63B (length and breached-password checks, no character-class rules).', 'auth_config.passwordPolicy');
    if (o.password_history && isObj(o.password_history) && o.password_history.enable === true) b.add('manual', area, 'options.password_history', 'Atlas does not keep a password history.');
    if (o.password_dictionary && isObj(o.password_dictionary) && o.password_dictionary.enable === true) b.add('differs', area, 'options.password_dictionary', 'Atlas checks breached-password corpora instead of a custom dictionary.', 'auth_config.passwordPolicy.checkBreaches');
    if (o.requires_username === true) {
      b.set('strategies.username', true);
      const v = isObj(o.validation) && isObj(o.validation.username) ? o.validation.username : {};
      if (typeof v.min === 'number') b.set('accountUx.username.minLength', v.min);
      if (typeof v.max === 'number') b.set('accountUx.username.maxLength', v.max);
      b.add('mapped', area, 'options.requires_username', 'Usernames (with the same length limits).', 'auth_config.strategies.username');
    }
    if (o.disable_signup === true) {
      b.set('signUpMode', 'restricted');
      b.add('mapped', area, 'options.disable_signup', 'Self sign-up is closed (invitations and the allowlist still work).', 'auth_config.signUpMode');
    }
    if (o.brute_force_protection !== false) b.add('mapped', area, 'options.brute_force_protection', 'Atlas locks out repeated failed sign-ins per account and IP.', 'auth_config.rateLimit');
    const methods = isObj(o.authentication_methods) ? o.authentication_methods : {};
    if (isObj(methods.passkey) && methods.passkey.enabled === true) {
      b.set('strategies.passkey', true);
      b.add('mapped', area, 'options.authentication_methods.passkey', 'Passkeys. Existing Auth0 passkeys move with --authentication-methods when the RP id stays the same.', 'auth_config.strategies.passkey');
    }
    if (o.customScripts && isObj(o.customScripts) && o.enabledDatabaseCustomization === true) {
      b.add('manual', area, 'options.customScripts', 'A custom database (Login / Get User scripts): point an Atlas legacy-auth connection at your user store instead (lazy migration webhook).', 'legacy_auth_connection');
    }
  }

  // ── passwordless ──
  for (const c of snap.connections) {
    const strategy = str(c.strategy);
    const o = isObj(c.options) ? c.options : {};
    if (strategy === 'email') {
      const link = str(o.authParams && isObj(o.authParams) ? o.authParams.response_type : undefined) === 'code' ? false : str(o.email && isObj(o.email) ? o.email.body : undefined)?.includes('@@link@@');
      b.set(link ? 'strategies.emailLink' : 'strategies.emailCode', true);
      b.add('mapped', 'connections email', 'strategy email', link ? 'Passwordless magic link.' : 'Passwordless email code.', link ? 'auth_config.strategies.emailLink' : 'auth_config.strategies.emailCode');
      if (typeof o.totp === 'object' && isObj(o.totp) && typeof o.totp.time_step === 'number') b.add('differs', 'connections email', 'options.totp.time_step', `Auth0 codes live ${o.totp.time_step}s; set Atlas's verification.emailCode.ttlMinutes.`, 'auth_config.verification.emailCode.ttlMinutes');
    } else if (strategy === 'sms') {
      b.set('strategies.phoneCode', true);
      b.add('mapped', 'connections sms', 'strategy sms', 'Passwordless SMS code (Atlas sends through its own SMS provider settings).', 'auth_config.strategies.phoneCode');
    }
  }

  // ── social connections ──
  const ENTERPRISE = new Set(['samlp', 'oidc', 'waad', 'adfs', 'okta', 'pingfederate', 'google-apps', 'ad', 'auth0-adldap', 'office365']);
  for (const c of snap.connections) {
    const strategy = str(c.strategy);
    const name = str(c.name) ?? strategy ?? '';
    if (!strategy || strategy === 'auth0' || strategy === 'email' || strategy === 'sms') continue;
    const o = isObj(c.options) ? c.options : {};
    if (ENTERPRISE.has(strategy)) {
      b.add(strategy === 'ad' || strategy === 'auth0-adldap' ? 'manual' : 'mapped', `connections ${name}`, `strategy ${strategy}`, strategy === 'ad' || strategy === 'auth0-adldap' ? 'AD/LDAP connector: no Atlas counterpart; use a lazy-migration webhook against your directory, or an enterprise IdP in front of it.' : 'Enterprise connection: moves with the data export as an Atlas SSO connection. Update the IdP with Atlas\'s ACS URL / redirect URI.', 'sso_connections');
      continue;
    }
    if (strategy === 'oauth2') {
      b.add('manual', `connections ${name}`, 'strategy oauth2', `Custom social connection "${name}": recreate it as an Atlas custom OAuth provider (authorization ${str(o.authorizationURL) ?? '?'}, token ${str(o.tokenURL) ?? '?'}); its fetchUserProfile script becomes a claim mapping.`, 'custom_oauth_providers');
      continue;
    }
    const key = socialKey(strategy);
    if (!key) {
      b.add('manual', `connections ${name}`, `strategy ${strategy}`, `"${strategy}" is not a built-in Atlas provider; add it as a custom OAuth provider.`, 'custom_oauth_providers');
      continue;
    }
    // Auth0's developer keys (no client_id) never work outside Auth0.
    const clientId = str(o.client_id);
    b.socialProvider({ atlasKey: key, vendorName: strategy, area: `connections ${name}`, setting: `strategy ${strategy}`, clientId, scopes: strs(o.scope ?? o.scopes) });
    if (!clientId) b.add('manual', `connections ${name}`, 'options.client_id', 'This connection uses Auth0\'s shared developer keys, which only work inside Auth0: create your own OAuth app (provider user ids change, so these users relink by email).', `oauth_providers ${key}`);
  }

  // ── MFA ──
  const factors = new Map(snap.guardianFactors.map((f) => [str(f.name) ?? '', f.enabled === true]));
  if (factors.get('otp')) {
    b.set('mfa.factors.totp', true);
    b.add('mapped', 'multi-factor', 'guardian factor otp', 'Authenticator apps. TOTP secrets move only with Auth0 support\'s secrets export.', 'auth_config.mfa.factors.totp');
  }
  if (factors.get('webauthn-roaming') || factors.get('webauthn-platform')) {
    b.set('mfa.factors.passkey', true);
    b.add('mapped', 'multi-factor', 'guardian factor webauthn', 'Security keys / device biometrics as a second factor.', 'auth_config.mfa.factors.passkey');
  }
  if (factors.get('email')) {
    b.set('mfa.factors.emailCode', true);
    b.add('mapped', 'multi-factor', 'guardian factor email', 'Email code second factor.', 'auth_config.mfa.factors.emailCode');
  }
  if (factors.get('sms') || factors.get('phone-message')) b.add('differs', 'multi-factor', 'guardian factor sms', 'SMS second factor: phone factors move with --authentication-methods; Atlas recommends TOTP or passkeys.', 'auth_config.mfa');
  if (factors.get('push-notification')) b.add('manual', 'multi-factor', 'guardian factor push-notification', 'Auth0 Guardian push has no Atlas counterpart: those users enrol TOTP or a passkey.');
  if (factors.get('recovery-code')) b.add('mapped', 'multi-factor', 'guardian factor recovery-code', 'Backup codes (new ones are generated in Atlas).', 'auth_config.mfa.backupCodes');
  if (snap.guardianPolicies.includes('all-applications')) {
    b.set('mfaPolicy', 'required');
    b.add('mapped', 'multi-factor', 'guardian policies all-applications', 'MFA always required.', 'auth_config.mfaPolicy');
  } else if (snap.guardianPolicies.includes('confidence-score')) {
    b.add('differs', 'multi-factor', 'guardian policies confidence-score', 'Adaptive MFA: Atlas uses step-up and risk policies instead; review auth_config.stepUp.', 'auth_config.stepUp');
  }
  if (snap.breachedPassword) {
    const on = snap.breachedPassword.enabled === true;
    b.set('passwordPolicy.checkBreaches', on);
    b.add('mapped', 'attack protection', 'breached-password-detection.enabled', on ? 'Breached passwords are refused.' : 'Breached-password check off.', 'auth_config.passwordPolicy.checkBreaches');
  }

  // ── applications ──
  const origins = new Set<string>();
  const redirects = new Set<string>();
  for (const c of snap.clients) {
    const app = str(c.name) ?? str(c.client_id) ?? 'application';
    const type = str(c.app_type);
    if (type === 'non_interactive') {
      b.add('manual', `applications ${app}`, 'app_type non_interactive', 'A machine-to-machine application: create an Atlas M2M client (client credentials) for it.', 'oauth_clients');
      continue;
    }
    for (const u of strs(c.callbacks)) redirects.add(u);
    for (const u of [...strs(c.web_origins), ...strs(c.allowed_origins)]) origins.add(u);
    if (c.is_first_party === false) b.add('manual', `applications ${app}`, 'is_first_party false', 'A third-party application: register it as an Atlas OAuth client.', 'oauth_clients');
  }
  let exact = 0;
  for (const url of redirects) {
    if (url.includes('*')) {
      b.add('differs', 'applications', `callbacks ${url}`, 'Atlas redirect URLs are exact (no wildcards); list each URL.', 'redirect_urls');
      continue;
    }
    b.push('redirect_urls', { url });
    exact++;
  }
  if (exact) b.add('mapped', 'applications', 'callbacks', `${exact} callback URL(s) become redirect URLs.`, 'redirect_urls');
  if (origins.size) {
    b.instance.allowed_origins = [...origins].filter((o) => !o.includes('*'));
    b.add('mapped', 'applications', 'web_origins / allowed_origins', 'Allowed origins for the browser SDK.', 'instance.allowed_origins');
  }

  // ── APIs, roles, permissions ──
  for (const rs of snap.resourceServers) {
    const identifier = str(rs.identifier);
    if (!identifier || rs.is_system === true) continue;
    b.push('resource_servers', { identifier, name: str(rs.name) ?? identifier, scopes: objs(rs.scopes).map((s) => str(s.value)).filter((s): s is string => !!s) } as Json);
    b.add('mapped', 'APIs', `resource-servers ${identifier}`, `API with ${objs(rs.scopes).length} scope(s); access tokens for it keep "aud": "${identifier}".`, `resource_servers ${identifier}`);
  }
  const perms = new Map<string, string>();
  for (const r of snap.roles) {
    const name = str(r.name);
    if (!name) continue;
    const key = keyOf(name);
    b.roles[name] = key;
    const rp = (r.permissions ?? []).map((p) => str(p.permission_name)).filter((p): p is string => !!p);
    for (const p of r.permissions ?? []) {
      const n = str(p.permission_name);
      if (n) perms.set(n, str(p.description) ?? '');
    }
    b.push('roles', { key, name, description: str(r.description) ?? '', permissions: rp } as Json);
  }
  for (const [key, description] of [...perms.entries()].sort()) b.push('permissions', { key, name: key, description } as Json);
  if (snap.roles.length) b.add('mapped', 'roles', 'roles', `${snap.roles.length} role(s) with their permissions; assignments move with the data export.`, 'roles');

  // ── code ──
  for (const a of snap.actions) {
    const triggers = objs(a.supported_triggers).map((tr) => str(tr.id)).filter(Boolean).join(', ');
    b.add('manual', 'actions', `actions ${str(a.name) ?? '?'}`, `Auth0 Action (${triggers || 'trigger unknown'}): port it to an Atlas action or webhook; token claims it adds become a JWT template or session claims.`, 'actions');
  }
  for (const r of snap.rules) if (r.enabled !== false) b.add('manual', 'rules', `rules ${str(r.name) ?? '?'}`, 'Auth0 Rule: port it to an Atlas action.', 'actions');

  return b.result(`Auth0 tenant ${snap.domain}`, {
    bridge: { preset: 'auth0', vars: { domain: snap.domain } },
    lazy: db ? { preset: 'auth0', config: { domain: snap.domain, connection: str(db.name) ?? 'Username-Password-Authentication' } } : undefined,
  });
}
