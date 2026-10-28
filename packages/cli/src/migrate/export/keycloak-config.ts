import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { fetchKeycloakRealm, isBuiltInClient, isBuiltInRole } from './keycloak';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, clampSessionMs, keyOf, socialKey } from './translate-kit';
import type { VendorHttp } from './vendor-http';

/**
 * `atlas migrate keycloak config` — a realm's settings → Atlas config:
 * password policy (the `passwordPolicy` expression), brute-force detection,
 * sign-up / email verification / remember-me, SSO session lifetimes, OTP and
 * WebAuthn policy, social identity providers (SAML / OIDC brokers move with
 * the data export as SSO connections), clients' redirect URIs and realm roles.
 * Themes, authentication flows, user federation, client scopes and mappers,
 * events and the SMTP server have no 1:1 counterpart and are reported as manual.
 */

export async function fetchKeycloakConfig(http: VendorHttp, realm: string, baseUrl?: string): Promise<Obj> {
  return (await fetchKeycloakRealm(http, { realm, baseUrl, pageSize: 1 })).realm;
}

/** `length(12) and digits(1) and notUsername(undefined)` → { length: ['12'], digits: ['1'], notUsername: [] }. */
export function parsePasswordPolicy(expr: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of (expr ?? '').split(/\s+and\s+/)) {
    const m = /^\s*([A-Za-z]+)\((.*)\)\s*$/.exec(part);
    if (!m) continue;
    const arg = m[2]!.trim();
    out[m[1]!] = arg && arg !== 'undefined' ? [arg] : [];
  }
  return out;
}

const seconds = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0);

export function translateKeycloakConfig(realm: Obj, opts: { groupsAs?: 'roles' | 'organizations' | 'skip'; baseUrl?: string } = {}): TranslationResult {
  const b = new ConfigBuilder();
  const name = str(realm.realm) ?? 'realm';
  const area = `realm ${name}`;

  b.set('strategies.password', true);
  b.add('differs', 'authentication', 'password', 'Password sign-in. A realm export carries the hashes (Atlas verifies PBKDF2 and Argon2 and re-hashes on first sign-in); with the Admin API alone, use the keycloak lazy-migration preset.', 'auth_config.strategies.password');

  // ── sign-up and login ──
  if (realm.registrationAllowed !== true) {
    b.set('signUpMode', 'restricted');
    b.add('mapped', area, 'registrationAllowed', 'Self-registration is off: Atlas sign-up is restricted (invitations still work).', 'auth_config.signUpMode');
  } else b.add('mapped', area, 'registrationAllowed', 'Self-registration is on.', 'auth_config.signUpMode');
  if (realm.verifyEmail === true) {
    b.set('requireEmailVerification', true);
    b.add('mapped', area, 'verifyEmail', 'Email addresses must be verified.', 'auth_config.requireEmailVerification');
  }
  if (realm.loginWithEmailAllowed === false) b.add('differs', area, 'loginWithEmailAllowed', 'Atlas always lets a verified email sign in.', 'auth_config.strategies');
  if (realm.registrationEmailAsUsername !== true) {
    b.set('strategies.username', true);
    b.add('mapped', area, 'registrationEmailAsUsername', 'Usernames are separate from email: username sign-in is on.', 'auth_config.strategies.username');
  }
  if (realm.duplicateEmailsAllowed === true) b.add('differs', area, 'duplicateEmailsAllowed', 'Atlas keeps one account per email address; accounts sharing an address will collide at import (the report lists them).', 'users');
  if (realm.resetPasswordAllowed === false) b.add('manual', area, 'resetPasswordAllowed', 'Atlas always offers password reset by email; turn off the password strategy for a user class instead.');
  if (realm.rememberMe === true) b.add('mapped', area, 'rememberMe', 'Atlas sessions persist per the session lifetimes below.', 'auth_config.session');

  // ── password policy ──
  const policy = parsePasswordPolicy(str(realm.passwordPolicy));
  const min = Number(policy.length?.[0] ?? 0);
  b.set('passwordPolicy.minLength', Math.max(8, min || 8));
  if (min) b.add(min < 8 ? 'differs' : 'mapped', area, 'passwordPolicy length', `${min}${min < 8 ? ' (Atlas requires at least 8; existing passwords still sign in)' : ''}.`, 'auth_config.passwordPolicy.minLength');
  if (policy.maxLength?.[0]) {
    b.set('passwordPolicy.maxLength', Math.min(Number(policy.maxLength[0]), 4096));
    b.add('mapped', area, 'passwordPolicy maxLength', `${policy.maxLength[0]}.`, 'auth_config.passwordPolicy.maxLength');
  }
  const classes: Array<[string, string, string]> = [['digits', 'requireNumber', 'digits'], ['upperCase', 'requireUppercase', 'upper-case letters'], ['lowerCase', 'requireLowercase', 'lower-case letters'], ['specialChars', 'requireSymbol', 'special characters']];
  for (const [kc, atlas, label] of classes) {
    if (policy[kc]) {
      b.set(`passwordPolicy.${atlas}`, true);
      b.add('mapped', area, `passwordPolicy ${kc}`, `Requires ${label}.`, `auth_config.passwordPolicy.${atlas}`);
    }
  }
  if (policy.notUsername || policy.notEmail) {
    b.set('passwordPolicy.rejectIdentifierSubstring', true);
    b.add('mapped', area, 'passwordPolicy notUsername / notEmail', 'A password may not contain the username or email.', 'auth_config.passwordPolicy.rejectIdentifierSubstring');
  }
  if (policy.passwordHistory?.[0]) {
    b.set('passwordPolicy.historyCount', Number(policy.passwordHistory[0]));
    b.add('mapped', area, 'passwordPolicy passwordHistory', `Last ${policy.passwordHistory[0]} passwords. Atlas starts the history at the first password set in Atlas.`, 'auth_config.passwordPolicy.historyCount');
  }
  if (policy.passwordBlacklist) {
    b.set('passwordPolicy.checkBreaches', true);
    b.add('differs', area, 'passwordPolicy passwordBlacklist', 'Your blacklist file is replaced by Atlas\'s breached-password check.', 'auth_config.passwordPolicy.checkBreaches');
  }
  if (policy.forceExpiredPasswordChange) b.add('manual', area, 'passwordPolicy forceExpiredPasswordChange', 'Atlas does not expire passwords (NIST 800-63B).');
  if (policy.hashAlgorithm) b.add('differs', area, `passwordPolicy hashAlgorithm(${policy.hashAlgorithm[0]})`, 'Atlas stores Argon2id; imported Keycloak hashes verify as they are and re-hash on first sign-in.', 'auth_config.passwordPolicy');
  const known = new Set([...classes.map((c) => c[0]), 'length', 'maxLength', 'notUsername', 'notEmail', 'passwordHistory', 'passwordBlacklist', 'forceExpiredPasswordChange', 'hashAlgorithm', 'hashIterations']);
  for (const k of Object.keys(policy)) if (!known.has(k)) b.add('manual', area, `passwordPolicy ${k}`, 'No Atlas counterpart for this password policy rule.');
  if (realm.bruteForceProtected === true) {
    b.add('mapped', area, 'bruteForceProtected', `${realm.permanentLockout === true ? 'Permanent lockout' : 'Temporary lockout'} after ${realm.failureFactor ?? '?'} failures: Atlas throttles failed sign-ins per account and IP (no permanent lockout; an administrator can ban a user).`, 'auth_config.rateLimit');
  }

  // ── sessions ──
  const idle = seconds(realm.ssoSessionIdleTimeout);
  const life = seconds(realm.ssoSessionMaxLifespan);
  if (life) {
    b.set('session.absoluteMs', clampSessionMs(life * 1000));
    b.add('mapped', area, 'ssoSessionMaxLifespan', `${life} seconds.`, 'auth_config.session.absoluteMs');
  }
  if (idle) {
    b.set('session.idleMs', clampSessionMs(idle * 1000));
    b.add('mapped', area, 'ssoSessionIdleTimeout', `${idle} seconds idle.`, 'auth_config.session.idleMs');
  }
  if (seconds(realm.accessTokenLifespan)) {
    b.set('session.jwtTtlSeconds', Math.min(Math.max(Number(realm.accessTokenLifespan), 60), 3600));
    b.add('mapped', area, 'accessTokenLifespan', `${realm.accessTokenLifespan} seconds (Atlas allows 60 to 3600).`, 'auth_config.session.jwtTtlSeconds');
  }
  if (seconds(realm.offlineSessionIdleTimeout)) b.add('differs', area, 'offlineSessionIdleTimeout', 'Offline tokens: use Atlas OAuth refresh tokens with the offline_access scope.', 'oauth_clients');

  // ── second factors ──
  const required = objs(realm.requiredActions).filter((a) => a.enabled !== false);
  const totp = required.some((a) => str(a.alias) === 'CONFIGURE_TOTP') || str(realm.otpPolicyType) !== undefined;
  if (totp) {
    b.set('mfa.factors.totp', true);
    const algo = str(realm.otpPolicyAlgorithm) ?? 'HmacSHA1';
    b.add(algo === 'HmacSHA1' && Number(realm.otpPolicyDigits ?? 6) === 6 ? 'mapped' : 'differs', area, 'otpPolicy', `${str(realm.otpPolicyType) ?? 'totp'} ${algo}, ${realm.otpPolicyDigits ?? 6} digits, ${realm.otpPolicyPeriod ?? 30}s. TOTP secrets move with a realm export and keep these parameters per factor.`, 'auth_config.mfa.factors.totp');
  }
  if (str(realm.otpPolicyType) === 'hotp') b.add('differs', area, 'otpPolicy type hotp', 'Counter-based OTP factors move with their counter; new enrolments are time-based.', 'auth_config.mfa.factors.totp');
  if (required.some((a) => str(a.alias)?.startsWith('webauthn'))) {
    b.set('mfa.factors.passkey', true);
    b.set('strategies.passkey', true);
    b.add('differs', area, 'webAuthnPolicy', `Passkeys move with the data export (relying party "${str(realm.webAuthnPolicyPasswordlessRpId) || str(realm.webAuthnPolicyRpId) || 'your Keycloak host'}"); Atlas must be served from the same relying-party domain for them to keep working.`, 'auth_config.mfa.factors.passkey');
  }
  if (str(realm.browserFlow) && str(realm.browserFlow) !== 'browser') b.add('manual', 'authentication', `browserFlow ${realm.browserFlow}`, 'A customised browser flow: review its conditions (OTP rules, step-up) and recreate them with Atlas MFA policy and step-up.', 'auth_config.stepUp');

  // ── identity providers ──
  for (const idp of objs(realm.identityProviders)) {
    if (idp.enabled === false) continue;
    const alias = str(idp.alias) ?? '?';
    const type = str(idp.providerId) ?? '';
    if (type === 'saml' || type === 'oidc' || type === 'keycloak-oidc') {
      b.add('mapped', 'identity providers', `${alias} (${type})`, 'Enterprise broker: moves with the data export as an Atlas SSO connection; point the upstream IdP at Atlas\'s ACS URL / redirect URI at cutover.', 'sso_connections');
      continue;
    }
    const key = socialKey(type === 'linkedin-openid-connect' ? 'linkedin' : type);
    const config = isObj(idp.config) ? idp.config : {};
    if (!key) {
      b.add('manual', 'identity providers', `${alias} (${type})`, 'No built-in Atlas provider: add it as a custom OAuth provider.', 'custom_oauth_providers');
      continue;
    }
    b.socialProvider({ atlasKey: key, vendorName: alias, area: 'identity providers', setting: `${alias} (${type})`, clientId: str(config.clientId), scopes: str(config.defaultScope)?.split(/\s+/).filter(Boolean) });
  }

  // ── clients → redirect URLs ──
  const redirects = new Set<string>();
  for (const c of objs(realm.clients)) {
    const clientId = str(c.clientId) ?? '';
    if (!clientId || isBuiltInClient(clientId, name) || c.enabled === false) continue;
    for (const u of strs(c.redirectUris)) redirects.add(u);
    if (c.serviceAccountsEnabled === true) b.add('manual', `clients ${clientId}`, 'serviceAccountsEnabled', 'A service account: create an Atlas M2M client for it.', 'oauth_clients');
    if (c.directAccessGrantsEnabled === true && c.publicClient !== true) b.add('manual', `clients ${clientId}`, 'directAccessGrantsEnabled', 'Resource-owner password grant: Atlas does not offer it; move the app to the authorization-code flow with PKCE.');
  }
  let exact = 0;
  for (const url of redirects) {
    if (url.includes('*') || !/^https?:\/\//.test(url)) {
      b.add('differs', 'clients', `redirectUris ${url}`, 'Atlas redirect URLs are exact absolute URLs (no wildcards or relative paths).', 'redirect_urls');
      continue;
    }
    b.push('redirect_urls', { url });
    exact++;
  }
  if (exact) b.add('mapped', 'clients', 'redirectUris', `${exact} redirect URI(s).`, 'redirect_urls');

  // ── roles ──
  const groupsAs = opts.groupsAs ?? 'roles';
  const roles = isObj(realm.roles) ? realm.roles : {};
  for (const r of objs(roles.realm)) {
    const rn = str(r.name);
    if (!rn || isBuiltInRole(rn) || rn.startsWith('default-roles-')) continue;
    const key = keyOf(rn);
    b.roles[rn] = key;
    b.push('roles', { key, name: rn, description: str(r.description) ?? '', permissions: [] } as Json);
  }
  if (b.collections.roles!.length) b.add('differs', 'roles', 'realm roles', `${b.collections.roles!.length} realm role(s) become Atlas app roles (client roles are prefixed with the client id in the data export; composite roles import as plain roles).`, 'roles');
  if (objs(realm.groups).length) b.add('differs', 'groups', 'groups', groupsAs === 'organizations' ? 'Groups become organizations with the data export (--groups-as organizations).' : groupsAs === 'roles' ? 'Groups become Atlas app roles named by group path; memberships move with the data export.' : 'Groups are skipped.', groupsAs === 'organizations' ? 'organizations' : 'roles');
  if (realm.organizationsEnabled === true) b.add('mapped', area, 'organizationsEnabled', 'Keycloak organizations move as Atlas organizations with members, domains and invitations.', 'organizations');

  // ── what has no counterpart ──
  if (str(realm.loginTheme) || str(realm.emailTheme) || str(realm.accountTheme)) b.add('manual', area, 'themes', 'Keycloak (FreeMarker) themes: rebuild the look in Atlas branding or the embeddable components.', 'branding');
  if (realm.internationalizationEnabled === true) b.add('manual', area, 'internationalization', `Locales ${strs(realm.supportedLocales).join(', ') || '(none listed)'}: set the locales and message overrides in Atlas.`, 'localization');
  const smtp = isObj(realm.smtpServer) ? realm.smtpServer : {};
  if (str(smtp.host)) b.add('manual', area, 'smtpServer', `Mail goes through your own provider in Atlas (bring your own keys): configure ${str(smtp.host)} or your email API in the email provider settings; the SMTP password is never returned by Keycloak.`, 'email_provider');
  const components = isObj(realm.components) ? realm.components : {};
  if (Object.keys(components).some((k) => k.includes('UserStorageProvider'))) b.add('manual', 'user federation', 'LDAP / Kerberos / custom storage', 'Federated users have no password in Keycloak: use the keycloak lazy-migration preset so Keycloak (and the directory behind it) checks the password on first Atlas sign-in.', 'legacy_auth_connection');
  if (objs(realm.clientScopes).length || objs(realm.clients).some((c) => objs(c.protocolMappers).length)) b.add('manual', 'client scopes', 'protocol mappers', 'Custom token claims: recreate them as an Atlas JWT template / session claims.', 'jwt_templates');
  if (realm.eventsEnabled === true) b.add('manual', area, 'eventsEnabled', 'Login events: use Atlas audit logs and webhooks.', 'webhooks');
  if (realm.userManagedAccessAllowed === true || realm.authorizationSettings) b.add('manual', area, 'authorization services', 'Keycloak fine-grained authorization (resources, policies): model it with Atlas roles and permissions or OpenFGA.', 'roles');

  const baseUrl = opts.baseUrl;
  const vars: Record<string, string> = { realm: name };
  if (baseUrl) vars.base_url = baseUrl;
  return b.result(`Keycloak ${area}`, { bridge: { preset: 'keycloak', vars }, lazy: { preset: 'keycloak', config: vars } });
}
