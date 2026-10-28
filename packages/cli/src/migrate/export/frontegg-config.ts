import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { fronteggApi, listOf, optional, type FronteggConnection } from './frontegg';
import { isObj, str, strs, type Obj } from './record-set';
import { ConfigBuilder, clampSessionMs, keyOf } from './translate-kit';

/**
 * `atlas migrate frontegg config` — what the Frontegg management API exposes of
 * an environment: identity configuration (sign-in method, JWT contents), the
 * password, MFA, lockout and session policies, roles and permissions, custom
 * social providers, applications (login and app URLs), JWT templates and email
 * domain restrictions. Social providers set in the portal, hosted-login
 * branding, flows and webhooks are not in the public API: the report lists them
 * as manual. SSO configurations and users move with the data export.
 */
export interface FronteggConfigSnapshot {
  clientId: string;
  region: string;
  configuration: Obj | null;
  password: Obj | null;
  mfaPolicy: Obj | null;
  lockout: Obj | null;
  sessions: Obj | null;
  roles: Obj[];
  permissions: Obj[];
  customProviders: Obj[];
  applications: Obj[];
  jwtTemplates: Obj[];
  domainRestrictions: Obj | null;
}

export async function fetchFronteggConfig(c: FronteggConnection): Promise<FronteggConfigSnapshot> {
  const { http } = fronteggApi(c);
  const get = (path: string) => optional<unknown>(http, path);
  const obj = async (path: string) => {
    const b = await get(path);
    return isObj(b) ? b : null;
  };
  const roles: Obj[] = [];
  for (let page = 0; page < 50; page++) {
    const b = await get(`/identity/resources/roles/v2?_limit=200&_offset=${page}`);
    const items = listOf(b, 'roles');
    roles.push(...items);
    if (items.length < 200) break;
  }
  return {
    clientId: c.clientId,
    region: (c.region ?? 'eu').toLowerCase(),
    configuration: await obj('/identity/resources/configurations/v1'),
    password: await obj('/identity/resources/configurations/v1/password'),
    mfaPolicy: await obj('/identity/resources/configurations/v1/mfa-policy'),
    lockout: await obj('/identity/resources/configurations/v1/lockout-policy'),
    sessions: await obj('/identity/resources/configurations/sessions/v1/vendor'),
    roles,
    permissions: listOf(await get('/identity/resources/permissions/v1')),
    customProviders: listOf(await get('/identity/resources/sso/custom/v1')),
    applications: listOf(await get('/applications/resources/applications/v1'), 'applications'),
    jwtTemplates: listOf(await get('/identity/resources/jwt-templates/v1')),
    domainRestrictions: await obj('/identity/resources/configurations/restrictions/v1/email-domain/config'),
  };
}

export function translateFronteggConfig(snap: FronteggConfigSnapshot, domain?: string): TranslationResult {
  const b = new ConfigBuilder();

  const cfg = snap.configuration;
  if (cfg) {
    const strategy = str(cfg.authStrategy) ?? '';
    const name = 'authStrategy';
    const username = strategy.startsWith('Username');
    if (username) {
      b.set('strategies.username', true);
      b.add('mapped', 'authentication', name, `${strategy}: usernames are imported as Atlas usernames.`, 'auth_config.strategies.username');
    }
    if (/Password$/.test(strategy)) {
      b.set('strategies.password', true);
      b.add('differs', 'authentication', name, `${strategy}: password sign-in. Frontegg never returns password hashes: the frontegg lazy-migration preset checks each password against Frontegg on first sign-in.`, 'auth_config.strategies.password');
    } else if (/MagicLink$/.test(strategy)) {
      b.set('strategies.emailLink', true);
      b.add('mapped', 'authentication', name, `${strategy}: passwordless email link.`, 'auth_config.strategies.emailLink');
    } else if (/Code$/.test(strategy)) {
      b.set('strategies.emailCode', true);
      b.add('mapped', 'authentication', name, `${strategy}: passwordless email code.`, 'auth_config.strategies.emailCode');
    } else if (/Sms(Code)?$/.test(strategy)) {
      b.set('strategies.phoneCode', true);
      b.add('differs', 'authentication', name, `${strategy}: SMS codes. Atlas keeps SMS sign-in off until you turn it on (every message costs money).`, 'auth_config.strategies.phoneCode');
    } else if (strategy === 'NoLocalAuthentication') {
      b.add('manual', 'authentication', name, 'NoLocalAuthentication: Frontegg only federates sign-in (SSO / social). Enable the matching connections in Atlas; no local strategy is turned on.', 'auth_config.strategies');
    } else if (strategy) {
      b.add('manual', 'authentication', name, `${strategy}: review the sign-in methods by hand.`, 'auth_config.strategies');
    }
    if (cfg.allowSignups === false) b.add('manual', 'authentication', 'allowSignups', 'Self sign-up is off in Frontegg: close public sign-up in Atlas (invitations or waitlist).', 'auth_config.signUpMode');
    if (cfg.allowNotVerifiedUsersLogin === true) b.add('manual', 'authentication', 'allowNotVerifiedUsersLogin', 'Frontegg lets unverified users sign in; Atlas verifies an email before it counts as a login identifier.');
    const tokenSecs = Number(cfg.defaultTokenExpiration ?? 0);
    if (tokenSecs > 0) b.add('differs', 'tokens', 'defaultTokenExpiration', `${tokenSecs}s access token. Atlas session tokens are short-lived and refreshed by the SDK; the session length below sets how long a user stays signed in.`, 'auth_config.session');
    const refreshSecs = Number(cfg.defaultRefreshTokenExpiration ?? 0);
    if (refreshSecs > 0) {
      b.set('session.absoluteMs', clampSessionMs(refreshSecs * 1000));
      b.add('mapped', 'tokens', 'defaultRefreshTokenExpiration', `${refreshSecs}s refresh token lifetime.`, 'auth_config.session.absoluteMs');
    }
    if (cfg.jwtAlgorithm === 'HS256') b.add('manual', 'tokens', 'jwtAlgorithm', 'Frontegg signs this environment with HS256 (a shared secret). Atlas signs with asymmetric keys: verify Atlas tokens against its JWKS instead of the secret.');
    if (cfg.addRolesToJwt === false || cfg.addPermissionsToJwt === false) b.add('manual', 'tokens', 'addRolesToJwt / addPermissionsToJwt', 'Roles and permissions were not in the Frontegg JWT; Atlas puts organization roles and permissions in its session claims when the session has an active organization.');
    if (cfg.rotateRefreshTokens === true) b.add('mapped', 'tokens', 'rotateRefreshTokens', 'Atlas rotates refresh tokens on every use.');
    if (cfg.apiTokensEnabled === true) b.add('manual', 'api tokens', 'apiTokensEnabled', 'Frontegg API tokens (client id + secret) cannot be exported: reissue them as Atlas API keys or M2M clients.', 'oauth_clients');
    if (cfg.forceSameDeviceOnAuth === true) b.add('manual', 'authentication', 'forceSameDeviceOnAuth', 'Atlas email links work from any device; there is no same-device switch.');
  } else {
    b.add('manual', 'authentication', 'configurations/v1', 'The identity configuration could not be read (permission or plan): turn on the same sign-in methods in Atlas by hand.', 'auth_config.strategies');
  }

  const pw = snap.password;
  if (pw) {
    const min = Number(pw.minLength ?? 0);
    if (min > 0) {
      b.set('passwordPolicy.minLength', Math.max(8, min));
      b.add(min < 8 ? 'differs' : 'mapped', 'password', 'minLength', `${min}${min < 8 ? ' (Atlas requires at least 8; existing passwords still sign in)' : ''}.`, 'auth_config.passwordPolicy.minLength');
    }
    if (pw.blockPwnedPasswords === true) {
      b.set('passwordPolicy.checkBreaches', true);
      b.add('mapped', 'password', 'blockPwnedPasswords', 'Breached passwords are refused.', 'auth_config.passwordPolicy.checkBreaches');
    }
    if (isObj(pw.requiredTests) && Object.values(pw.requiredTests).some(Boolean)) {
      b.add('differs', 'password', 'requiredTests / optionalTests', 'Atlas follows NIST 800-63B: length and breached-password checks, no character-class rules.', 'auth_config.passwordPolicy');
    }
    if (pw.allowPassphrases === true) b.add('mapped', 'password', 'allowPassphrases', 'Atlas accepts any password that meets the length rule, passphrases included.');
  }

  const lock = snap.lockout;
  if (lock && lock.enabled === true) {
    b.add('mapped', 'security', 'lockout-policy', `Frontegg locks after ${lock.maxAttempts ?? '?'} failed attempts; Atlas throttles failed sign-ins per account and IP.`, 'auth_config.rateLimit');
  }

  const mfa = snap.mfaPolicy;
  if (mfa) {
    const enforce = str(mfa.enforceMFAType) ?? '';
    if (/force/i.test(enforce)) {
      b.set('mfaPolicy', 'required');
      b.add('mapped', 'mfa', 'enforceMFAType', `${enforce}: a second factor for everyone (users enrol again: Frontegg does not export authenticator seeds).`, 'auth_config.mfaPolicy');
    } else if (enforce) {
      b.add('differs', 'mfa', 'enforceMFAType', `${enforce}: MFA is optional for users; turn on the factors (authenticator app, passkeys) in Atlas.`, 'auth_config.mfa');
    }
    if (mfa.allowRememberMyDevice === true) b.add('manual', 'mfa', 'allowRememberMyDevice', 'Remembered devices: set the equivalent trusted-device window in Atlas MFA settings.', 'auth_config.mfa');
  }

  const sess = snap.sessions;
  if (sess) {
    const idle = isObj(sess.sessionIdleTimeoutConfiguration) ? sess.sessionIdleTimeoutConfiguration : undefined;
    if (idle && idle.isActive === true && Number(idle.timeout) > 0) {
      b.set('session.idleMs', clampSessionMs(Number(idle.timeout) * 1000));
      b.add('mapped', 'sessions', 'sessionIdleTimeoutConfiguration', `${idle.timeout}s idle timeout.`, 'auth_config.session.idleMs');
    }
    const abs = isObj(sess.sessionTimeoutConfiguration) ? sess.sessionTimeoutConfiguration : undefined;
    if (abs && abs.isActive === true && Number(abs.timeout) > 0) {
      b.set('session.absoluteMs', clampSessionMs(Number(abs.timeout) * 1000));
      b.add('mapped', 'sessions', 'sessionTimeoutConfiguration', `${abs.timeout}s absolute session lifetime.`, 'auth_config.session.absoluteMs');
    }
    const conc = isObj(sess.sessionConcurrentConfiguration) ? sess.sessionConcurrentConfiguration : undefined;
    if (conc && conc.isActive === true) b.add('manual', 'sessions', 'sessionConcurrentConfiguration', `Frontegg caps concurrent sessions at ${conc.maxSessions ?? '?'}; Atlas has no per-user session cap (users revoke devices from their profile).`);
  }

  // Permissions and roles (permission ids in a role's list resolve through the permission list).
  const permissionKeys = new Map<string, string>();
  for (const p of snap.permissions) {
    const key = str(p.key);
    if (!key) continue;
    const id = str(p.id);
    if (id) permissionKeys.set(id, key);
    b.push('permissions', { key, name: str(p.name) ?? key, description: str(p.description) ?? '' } as Json);
  }
  if (snap.permissions.length) b.add('mapped', 'authorization', 'permissions', `${snap.permissions.length} permission(s).`, 'permissions');
  const seen = new Set<string>();
  let tenantRoles = 0;
  for (const r of snap.roles) {
    const raw = str(r.key) ?? str(r.name);
    if (!raw) continue;
    if (str(r.tenantId)) {
      tenantRoles++;
      continue;
    }
    const key = keyOf(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    b.roles[raw] = key;
    const perms = (Array.isArray(r.permissions) ? r.permissions : [])
      .map((p) => (isObj(p) ? (str(p.key) ?? permissionKeys.get(str(p.id) ?? '')) : permissionKeys.get(String(p))))
      .filter((p): p is string => !!p);
    b.push('roles', { key, name: str(r.name) ?? raw, description: str(r.description) ?? '', permissions: perms } as Json);
  }
  if (seen.size) b.add('mapped', 'authorization', 'roles', `${seen.size} environment role(s) become organization roles with their permissions.`, 'roles');
  if (tenantRoles) b.add('differs', 'authorization', 'account-specific roles', `${tenantRoles} role(s) defined inside one account: they move with the data export as that organization's custom roles.`, 'roles');

  // Custom social providers.
  for (const p of snap.customProviders) {
    const name = str(p.displayName) ?? str(p.name) ?? str(p.id) ?? 'custom';
    const clientId = str(p.clientId);
    const authUrl = str(p.authorizationUrl);
    const tokenUrl = str(p.tokenUrl);
    const userInfo = str(p.userInfoUrl);
    const key = keyOf(name);
    b.push('custom_oauth_providers', {
      key,
      name,
      enabled: p.active !== false,
      client_id: clientId ?? b.placeholder(`${key.toUpperCase()}_CLIENT_ID`, `${name} client id`),
      client_secret: b.placeholder(`${key.toUpperCase()}_CLIENT_SECRET`, `${name} client secret`),
      ...(authUrl ? { authorization_url: authUrl } : {}),
      ...(tokenUrl ? { token_url: tokenUrl } : {}),
      ...(userInfo ? { userinfo_url: userInfo } : {}),
      ...(strs(p.scopes).length ? { scopes: strs(p.scopes) } : {}),
    } as Json);
    b.add('differs', 'custom social login', name, 'Becomes an Atlas custom OAuth provider. Keep the same OAuth app and add Atlas\'s callback URL; set the client secret (secrets are never copied).', 'custom_oauth_providers');
  }
  b.add('manual', 'social login', 'built-in providers (Google, GitHub, Microsoft, …)', 'Frontegg does not list the social providers you enabled in its public API: turn the same providers on in Atlas (oauth_providers) and keep the same OAuth apps so accounts relink.', 'oauth_providers');

  // Applications: login and app URLs.
  const urls = new Set<string>();
  for (const a of snap.applications) {
    for (const u of [str(a.appURL), str(a.loginURL)]) if (u && /^https?:\/\//.test(u)) urls.add(u);
  }
  for (const url of urls) b.push('redirect_urls', { url });
  if (urls.size) b.add('mapped', 'applications', 'appURL / loginURL', `${urls.size} application URL(s) as allowed redirect URLs (add any other post-login URL yourself).`, 'redirect_urls');
  if (snap.applications.length > 1) b.add('manual', 'applications', 'multiple applications', `${snap.applications.length} Frontegg applications share one user pool; Atlas has one instance per app: create one Atlas instance (or use organizations) per product.`);

  if (snap.jwtTemplates.length) b.add('manual', 'tokens', 'JWT templates', `${snap.jwtTemplates.length} custom JWT template(s): recreate their claims as an Atlas JWT template.`, 'jwt_templates');
  const dr = snap.domainRestrictions;
  if (dr && (dr.active === true || dr.enabled === true)) b.add('manual', 'security', 'email domain restrictions', 'Frontegg allow / block list for sign-up domains: set the equivalent sign-up restrictions in Atlas.', 'auth_config.signUpMode');

  for (const [setting, where] of [
    ['hosted login branding, localisation and flows', 'Frontegg portal → Builder / Login Box'],
    ['email and SMS templates and providers', 'Frontegg portal → Notifications (Atlas sends with your own provider keys)'],
    ['webhooks and audit streams', 'Frontegg portal → Webhooks'],
    ['entitlements (plans, features)', 'Frontegg portal → Entitlements (use Atlas organization roles and permissions, or your billing system)'],
  ] as const) {
    b.add('manual', 'settings not in the API', setting, `Not exposed for export; recreate it in Atlas (see ${where}).`);
  }

  return b.result(`Frontegg environment (${snap.region})`, {
    ...(domain ? { bridge: { preset: 'frontegg', vars: { base_url: domain } } } : {}),
    lazy: { preset: 'frontegg', config: { client_id: snap.clientId, region: snap.region } },
  });
}
