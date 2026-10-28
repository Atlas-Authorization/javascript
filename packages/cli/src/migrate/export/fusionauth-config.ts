import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, clampSessionMs, keyOf, socialKey } from './translate-kit';
import { VendorApiError, type VendorHttp } from './vendor-http';

/**
 * `atlas migrate fusionauth config` — a FusionAuth tenant's settings → Atlas
 * config: password validation rules, breach detection and password history,
 * multi-factor policy, token and session lifetimes, WebAuthn, application
 * registration and OAuth redirect URLs, application roles, and identity
 * providers (social providers become Atlas providers; SAML v2 / OpenID Connect
 * move with the data export as SSO connections). Lambdas, webhooks, themes,
 * the email server, entities and FusionAuth acting as a SAML IdP are reported
 * as manual.
 */
export interface FusionAuthConfigSnapshot {
  baseUrl?: string;
  tenants: Obj[];
  applications: Obj[];
  identityProviders: Obj[];
  lambdas: Obj[];
  webhooks: Obj[];
  themes: Obj[];
}

export async function fetchFusionAuthConfig(http: VendorHttp, baseUrl?: string, warn: (m: string) => void = () => undefined): Promise<FusionAuthConfigSnapshot> {
  const list = async (path: string, key: string, what: string): Promise<Obj[]> => {
    try {
      const { body } = await http.get<unknown>(path);
      return isObj(body) ? objs(body[key]) : [];
    } catch (err) {
      if (!(err instanceof VendorApiError) || ![401, 403, 404].includes(err.status)) throw err;
      if (err.status !== 404) warn(`${what} could not be read with this API key (${err.status}) and were skipped.`);
      return [];
    }
  };
  return {
    baseUrl,
    tenants: await list('/api/tenant', 'tenants', 'Tenants'),
    applications: await list('/api/application', 'applications', 'Applications'),
    identityProviders: await list('/api/identity-provider', 'identityProviders', 'Identity providers'),
    lambdas: await list('/api/lambda', 'lambdas', 'Lambdas'),
    webhooks: await list('/api/webhook', 'webhooks', 'Webhooks'),
    themes: await list('/api/theme', 'themes', 'Themes'),
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function translateFusionAuthConfig(snap: FusionAuthConfigSnapshot, opts: { tenantId?: string } = {}): TranslationResult {
  const b = new ConfigBuilder();
  const tenant = (opts.tenantId ? snap.tenants.find((t) => str(t.id) === opts.tenantId) : snap.tenants.find((t) => t.name === 'Default') ?? snap.tenants[0]) ?? {};
  const tName = str(tenant.name) ?? 'tenant';
  const area = `tenant ${tName}`;

  b.set('strategies.password', true);
  b.add('differs', 'authentication', 'password', 'Password sign-in. A database export carries the hashes (FusionAuth schemes verify as they are and re-hash on first sign-in); with the API alone, use the fusionauth lazy-migration preset.', 'auth_config.strategies.password');
  if (snap.tenants.length > 1) b.add('differs', 'tenants', 'tenants', `${snap.tenants.length} tenants: this report covers "${tName}". One Atlas instance per tenant, or one instance with tenants as organizations (data export tenantsAs).`, 'organizations');

  // ── password rules ──
  const rules = isObj(tenant.passwordValidationRules) ? tenant.passwordValidationRules : {};
  const min = num(rules.minLength);
  b.set('passwordPolicy.minLength', Math.max(8, min || 8));
  if (min) b.add(min < 8 ? 'differs' : 'mapped', area, 'passwordValidationRules.minLength', `${min}${min < 8 ? ' (Atlas requires at least 8; existing passwords still sign in)' : ''}.`, 'auth_config.passwordPolicy.minLength');
  if (num(rules.maxLength)) {
    b.set('passwordPolicy.maxLength', Math.min(num(rules.maxLength), 4096));
    b.add('mapped', area, 'passwordValidationRules.maxLength', `${rules.maxLength}.`, 'auth_config.passwordPolicy.maxLength');
  }
  if (rules.requireMixedCase === true) {
    b.set('passwordPolicy.requireUppercase', true);
    b.set('passwordPolicy.requireLowercase', true);
    b.add('mapped', area, 'passwordValidationRules.requireMixedCase', 'Upper and lower case required.', 'auth_config.passwordPolicy');
  }
  if (rules.requireNumber === true) {
    b.set('passwordPolicy.requireNumber', true);
    b.add('mapped', area, 'passwordValidationRules.requireNumber', 'A number required.', 'auth_config.passwordPolicy.requireNumber');
  }
  if (rules.requireNonAlpha === true) {
    b.set('passwordPolicy.requireSymbol', true);
    b.add('mapped', area, 'passwordValidationRules.requireNonAlpha', 'A non-alphanumeric character required.', 'auth_config.passwordPolicy.requireSymbol');
  }
  const history = isObj(rules.rememberPreviousPasswords) ? rules.rememberPreviousPasswords : {};
  if (history.enabled === true && num(history.count)) {
    b.set('passwordPolicy.historyCount', num(history.count));
    b.add('mapped', area, 'passwordValidationRules.rememberPreviousPasswords', `Last ${history.count} passwords. Atlas starts the history at the first password set in Atlas.`, 'auth_config.passwordPolicy.historyCount');
  }
  const breach = isObj(rules.breachDetection) ? rules.breachDetection : {};
  if (breach.enabled === true) {
    b.set('passwordPolicy.checkBreaches', true);
    b.add('mapped', area, 'passwordValidationRules.breachDetection', 'Breached passwords are refused.', 'auth_config.passwordPolicy.checkBreaches');
  }
  const pw = isObj(tenant.passwordEncryptionConfiguration) ? tenant.passwordEncryptionConfiguration : {};
  if (str(pw.encryptionScheme)) b.add('differs', area, `passwordEncryptionConfiguration ${pw.encryptionScheme}`, 'Atlas stores Argon2id; imported FusionAuth hashes verify as they are and re-hash on first sign-in.', 'auth_config.passwordPolicy');

  // ── multi-factor ──
  const mfa = isObj(tenant.multiFactorConfiguration) ? tenant.multiFactorConfiguration : {};
  const policy = str(mfa.loginPolicy);
  if (policy === 'Required') {
    b.set('mfaPolicy', 'required');
    b.add('mapped', area, 'multiFactorConfiguration.loginPolicy', 'A second factor on every sign-in.', 'auth_config.mfaPolicy');
  } else if (policy === 'Enabled') {
    b.set('mfaPolicy', 'optional');
    b.add('mapped', area, 'multiFactorConfiguration.loginPolicy', 'Second factor optional (users who enrolled are challenged).', 'auth_config.mfaPolicy');
  }
  if (isObj(mfa.authenticator) && mfa.authenticator.enabled !== false) {
    b.set('mfa.factors.totp', true);
    b.add('mapped', area, 'multiFactorConfiguration.authenticator', 'Authenticator apps. Secrets move with a database export; with the API alone users enrol again.', 'auth_config.mfa.factors.totp');
  }
  if (isObj(mfa.email) && mfa.email.enabled === true) {
    b.set('mfa.factors.emailCode', true);
    b.add('mapped', area, 'multiFactorConfiguration.email', 'Email code as a second factor.', 'auth_config.mfa.factors.emailCode');
  }
  if (isObj(mfa.sms) && mfa.sms.enabled === true) {
    b.set('mfa.factors.sms', true);
    b.add('differs', area, 'multiFactorConfiguration.sms', 'SMS second factor: the phone numbers move with the data export; Atlas sends through your own messaging provider (bring your own keys), and recommends TOTP or passkeys.', 'auth_config.mfa.factors.sms');
  }
  const webauthn = isObj(tenant.webAuthnConfiguration) ? tenant.webAuthnConfiguration : {};
  if (webauthn.enabled === true) {
    b.set('strategies.passkey', true);
    b.set('mfa.factors.passkey', true);
    b.add('differs', area, 'webAuthnConfiguration', `Passkeys. FusionAuth does not export WebAuthn credentials: users register again${str(webauthn.relyingPartyId) ? ` (relying party ${webauthn.relyingPartyId})` : ''}.`, 'auth_config.mfa.factors.passkey');
  }

  // ── tokens and sessions ──
  const jwt = isObj(tenant.jwtConfiguration) ? tenant.jwtConfiguration : {};
  if (num(jwt.timeToLiveInSeconds)) {
    b.set('session.jwtTtlSeconds', Math.min(Math.max(num(jwt.timeToLiveInSeconds), 60), 3600));
    b.add('mapped', area, 'jwtConfiguration.timeToLiveInSeconds', `${jwt.timeToLiveInSeconds} seconds (Atlas allows 60 to 3600).`, 'auth_config.session.jwtTtlSeconds');
  }
  if (num(jwt.refreshTokenTimeToLiveInMinutes)) {
    b.set('session.absoluteMs', clampSessionMs(num(jwt.refreshTokenTimeToLiveInMinutes) * 60_000));
    b.add('mapped', area, 'jwtConfiguration.refreshTokenTimeToLiveInMinutes', `${jwt.refreshTokenTimeToLiveInMinutes} minutes.`, 'auth_config.session.absoluteMs');
  }
  if (str(jwt.refreshTokenExpirationPolicy) === 'SlidingWindow' && num(jwt.refreshTokenTimeToLiveInMinutes)) {
    b.set('session.idleMs', clampSessionMs(num(jwt.refreshTokenTimeToLiveInMinutes) * 60_000));
    b.add('mapped', area, 'jwtConfiguration.refreshTokenExpirationPolicy', 'Sliding window: an idle limit of the same length.', 'auth_config.session.idleMs');
  }
  const failed = isObj(tenant.failedAuthenticationConfiguration) ? tenant.failedAuthenticationConfiguration : {};
  if (num(failed.tooManyAttempts)) b.add('mapped', area, 'failedAuthenticationConfiguration', `Lockout after ${failed.tooManyAttempts} failures: Atlas throttles failed sign-ins per account and IP (a locked user can be banned by an administrator).`, 'auth_config.rateLimit');

  // ── applications: sign-up, redirect URLs, roles ──
  const redirects = new Set<string>();
  let roleCount = 0;
  for (const app of snap.applications) {
    if (app.active === false) continue;
    const name = str(app.name) ?? str(app.id) ?? 'application';
    const reg = isObj(app.registrationConfiguration) ? app.registrationConfiguration : {};
    if (reg.enabled !== true && !b.auth.signUpMode) {
      b.set('signUpMode', 'restricted');
      b.add('mapped', `applications ${name}`, 'registrationConfiguration.enabled', 'Self-registration is off: Atlas sign-up is restricted (invitations still work).', 'auth_config.signUpMode');
    }
    if (app.verifyRegistration === true) {
      b.set('requireEmailVerification', true);
      b.add('mapped', `applications ${name}`, 'verifyRegistration', 'Email verification required.', 'auth_config.requireEmailVerification');
    }
    const oauth = isObj(app.oauthConfiguration) ? app.oauthConfiguration : {};
    for (const u of strs(oauth.authorizedRedirectURLs)) redirects.add(u);
    if (strs(oauth.enabledGrants).includes('client_credentials')) b.add('manual', `applications ${name}`, 'oauthConfiguration.enabledGrants client_credentials', 'A machine-to-machine application: create an Atlas M2M client for it.', 'oauth_clients');
    if (strs(oauth.enabledGrants).includes('password')) b.add('manual', `applications ${name}`, 'oauthConfiguration.enabledGrants password', 'Resource-owner password grant: Atlas does not offer it; move the app to the authorization-code flow with PKCE.');
    if (isObj(app.samlv2Configuration) && app.samlv2Configuration.enabled === true) b.add('manual', `applications ${name}`, 'samlv2Configuration', 'FusionAuth acting as a SAML identity provider for this application: Atlas can act as one, configure it per service provider.', 'saml_idp');
    for (const r of objs(app.roles)) {
      const rn = str(r.name);
      if (!rn) continue;
      const key = keyOf(rn);
      if (b.roles[rn]) continue;
      b.roles[rn] = key;
      roleCount++;
      b.push('roles', { key, name: rn, description: str(r.description) ?? '', permissions: [] } as Json);
    }
  }
  if (roleCount) b.add('differs', 'applications', 'roles', `${roleCount} application role(s) become Atlas app roles (roles of the same name in different applications share one key).`, 'roles');
  let exact = 0;
  for (const url of redirects) {
    if (url.includes('*') || !/^https?:\/\//.test(url)) {
      b.add('differs', 'applications', `authorizedRedirectURLs ${url}`, 'Atlas redirect URLs are exact absolute URLs (no wildcards or custom schemes).', 'redirect_urls');
      continue;
    }
    b.push('redirect_urls', { url });
    exact++;
  }
  if (exact) b.add('mapped', 'applications', 'authorizedRedirectURLs', `${exact} redirect URL(s).`, 'redirect_urls');

  // ── identity providers ──
  for (const idp of snap.identityProviders) {
    if (idp.enabled === false) continue;
    const type = str(idp.type) ?? '';
    const name = str(idp.name) ?? type;
    if (type === 'SAMLv2' || type === 'OpenIDConnect') {
      b.add('mapped', 'identity providers', `${name} (${type})`, 'Enterprise IdP: moves with the data export as an Atlas SSO connection; point it at Atlas\'s ACS URL / redirect URI at cutover.', 'sso_connections');
      continue;
    }
    if (type === 'SAMLv2IdPInitiated') {
      b.add('manual', 'identity providers', `${name} (${type})`, 'IdP-initiated SAML: Atlas SAML connections are SP-initiated.');
      continue;
    }
    if (type === 'ExternalJWT' || type === 'SonyPSN' || type === 'Nintendo' || type === 'HYPR') {
      b.add('manual', 'identity providers', `${name} (${type})`, 'No built-in Atlas provider: add it as a custom OAuth provider.', 'custom_oauth_providers');
      continue;
    }
    const key = socialKey(type);
    if (!key) {
      b.add('manual', 'identity providers', `${name} (${type})`, 'No built-in Atlas provider: add it as a custom OAuth provider.', 'custom_oauth_providers');
      continue;
    }
    const first = Object.values(isObj(idp.applicationConfiguration) ? idp.applicationConfiguration : {}).find(isObj);
    const clientId = str(idp.client_id) ?? str(first?.client_id);
    b.socialProvider({ atlasKey: key, vendorName: name, area: 'identity providers', setting: `${name} (${type})`, clientId, scopes: str(idp.scope)?.split(/[\s,]+/).filter(Boolean) });
  }

  // ── what has no counterpart ──
  const email = isObj(tenant.emailConfiguration) ? tenant.emailConfiguration : {};
  if (str(email.host)) b.add('manual', area, 'emailConfiguration', `Mail goes through your own provider in Atlas (bring your own keys): configure ${str(email.host)} or an email API in the email provider settings; the SMTP password is never returned by FusionAuth.`, 'email_provider');
  const activeLambdas = snap.lambdas.filter((l) => l.enabled !== false);
  if (activeLambdas.length) b.add('manual', 'lambdas', `${activeLambdas.length} lambda(s)`, 'JWT populate, reconcile and SAML lambdas: port the claims logic to an Atlas JWT template / action.', 'jwt_templates');
  for (const w of snap.webhooks) if (w.enabled !== false) b.add('manual', 'webhooks', str(w.url) ?? str(w.id) ?? '?', 'FusionAuth webhook: recreate it as an Atlas webhook (event names differ).', 'webhooks');
  if (snap.themes.filter((t) => str(t.name) !== 'FusionAuth Default').length) b.add('manual', 'themes', 'custom themes', 'FusionAuth (FreeMarker) themes: rebuild the look in Atlas branding or the embeddable components.', 'branding');
  if (snap.baseUrl) b.add('differs', area, 'issuer', `Tokens carry iss "${str(tenant.issuer) ?? '(tenant issuer)'}"; Atlas tokens carry your Atlas issuer. Resource servers that pin the old issuer accept both during the bridge window (legacy issuers).`, 'legacy_issuers');

  const vars: Record<string, string> = {};
  if (snap.baseUrl) vars.base_url = snap.baseUrl;
  const issuer = str(tenant.issuer);
  const urlIssuer = issuer && /^https:\/\//.test(issuer);
  const bridgeVars = { ...vars, ...(issuer && !urlIssuer ? { issuer_name: issuer } : {}) };
  return b.result(`FusionAuth ${area}`, {
    bridge: { preset: urlIssuer ? 'fusionauth_url_issuer' : 'fusionauth', vars: bridgeVars },
    lazy: { preset: 'fusionauth', config: vars },
  });
}
