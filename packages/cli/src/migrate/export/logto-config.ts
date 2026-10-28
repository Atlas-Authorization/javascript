import type { Json } from '../../serialize';
import type { TranslationResult } from '../framework/plugin';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, keyOf, socialKey } from './translate-kit';
import { VendorApiError, type VendorHttp } from './vendor-http';

/**
 * `atlas migrate logto config` — a Logto tenant's sign-in experience, social
 * and email / SMS connectors, applications, API resources, roles and webhooks →
 * Atlas config, read with a machine-to-machine app on this machine (the same
 * one the data export uses). Custom JWT claims, webhooks and the hosted sign-in
 * page's CSS are reported as manual.
 */
export interface LogtoConfigSnapshot {
  endpoint: string;
  tenantId: string;
  signInExp: Obj;
  connectors: Obj[];
  applications: Obj[];
  /** API resources with their `scopes` filled in. */
  resources: Array<Obj & { scopes?: Obj[] }>;
  roles: Obj[];
  hooks: Obj[];
  /** The custom token claim scripts (`/api/configs/jwt-customizer`). */
  jwtCustomizers: Obj[];
}

const PAGE = 100;

export async function fetchLogtoConfig(http: VendorHttp, endpoint: string, tenantId: string): Promise<LogtoConfigSnapshot> {
  const optional = async <T>(fn: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VendorApiError && [401, 403, 404, 501].includes(err.status)) return empty;
      throw err;
    }
  };
  const list = (path: string) =>
    optional(async () => {
      const out: Obj[] = [];
      const sep = path.includes('?') ? '&' : '?';
      for (let page = 1; page <= 10_000; page++) {
        const rows = objs((await http.get<unknown>(`${path}${sep}page=${page}&page_size=${PAGE}`)).body);
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return out;
    }, [] as Obj[]);
  const resources = (await list('/api/resources')) as LogtoConfigSnapshot['resources'];
  for (const r of resources) {
    const id = str(r.id);
    if (id) r.scopes = await optional(async () => objs((await http.get<unknown>(`/api/resources/${encodeURIComponent(id)}/scopes?page=1&page_size=${PAGE}`)).body), [] as Obj[]);
  }
  return {
    endpoint,
    tenantId,
    signInExp: await optional(async () => {
      const { body } = await http.get<unknown>('/api/sign-in-exp');
      return isObj(body) ? body : {};
    }, {} as Obj),
    connectors: await optional(async () => objs((await http.get<unknown>('/api/connectors')).body), [] as Obj[]),
    applications: await list('/api/applications'),
    resources,
    roles: (await list('/api/roles')).filter((r) => str(r.type) !== 'MachineToMachine'),
    hooks: await optional(async () => objs((await http.get<unknown>('/api/hooks')).body), [] as Obj[]),
    jwtCustomizers: await optional(async () => objs((await http.get<unknown>('/api/configs/jwt-customizer')).body), [] as Obj[]),
  };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function translateLogtoConfig(snap: LogtoConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const exp = snap.signInExp;
  const area = 'sign-in experience';

  // ── identifiers and sign-in methods ──
  const methods = objs(isObj(exp.signIn) ? exp.signIn.methods : undefined);
  const signUp = isObj(exp.signUp) ? exp.signUp : {};
  const identifiers = new Set([...methods.map((m) => str(m.identifier)), ...strs(signUp.identifiers)].filter((x): x is string => !!x));
  const anyPassword = methods.some((m) => m.password === true) || signUp.password === true;
  if (anyPassword) {
    b.set('strategies.password', true);
    b.add('differs', area, 'signIn.methods[].password', 'Password sign-in. Logto password hashes move with a database export (Argon2, bcrypt, SHA-family); a Management API export carries them from Logto 2026.3, and lazy migration (logto preset) covers the rest.', 'auth_config.strategies.password');
  }
  if (identifiers.has('username')) {
    b.set('strategies.username', true);
    b.add('mapped', area, 'signIn.methods[identifier=username]', 'Sign in with a username.', 'auth_config.strategies.username');
  }
  if (methods.some((m) => str(m.identifier) === 'email' && m.verificationCode === true)) {
    b.set('strategies.emailCode', true);
    b.add('mapped', area, 'signIn.methods[identifier=email].verificationCode', 'Email verification code sign-in.', 'auth_config.strategies.emailCode');
  }
  if (methods.some((m) => str(m.identifier) === 'phone' && m.verificationCode === true)) {
    b.set('strategies.phoneCode', true);
    b.add('mapped', area, 'signIn.methods[identifier=phone].verificationCode', 'SMS code sign-in (bring your own SMS provider).', 'auth_config.strategies.phoneCode');
  }
  const passkey = isObj(exp.passkeySignIn) ? exp.passkeySignIn : {};
  if (passkey.enabled === true) {
    b.set('strategies.passkey', true);
    b.add('differs', area, 'passkeySignIn', 'Passkey sign-in. Passkeys move with a database export (public credentials); users keep them when your Atlas domain matches the relying-party id.', 'auth_config.strategies.passkey');
  }
  if (signUp.verify === true && identifiers.has('email')) {
    b.set('requireEmailVerification', true);
    b.add('mapped', area, 'signUp.verify', 'Emails are verified at sign-up.', 'auth_config.requireEmailVerification');
  }
  const mode = str(exp.signInMode);
  if (mode === 'SignIn') {
    b.set('signUpMode', 'restricted');
    b.add('mapped', area, 'signInMode', 'Self sign-up is closed (invitations and the allowlist still work).', 'auth_config.signUpMode');
  } else if (mode === 'Register') {
    b.add('differs', area, 'signInMode', 'Register-only mode has no Atlas counterpart; the sign-in page also signs existing users in.');
  }
  if (isObj(exp.forgotPasswordMethods) || Array.isArray(exp.forgotPasswordMethods)) {
    b.add('mapped', area, 'forgotPasswordMethods', 'Password reset by email or SMS code follows the enabled strategies.', 'auth_config.accountUx.passwordReset');
  }
  if (str(exp.agreeToTermsPolicy) && str(exp.agreeToTermsPolicy) !== 'Automatic') {
    b.add('manual', area, 'agreeToTermsPolicy', 'Terms acceptance at sign-up: configure a policy acceptance requirement in Atlas.', 'policy_acceptance');
  }

  // ── password policy ──
  const pw = isObj(exp.passwordPolicy) ? exp.passwordPolicy : {};
  const length = isObj(pw.length) ? pw.length : {};
  const min = num(length.min);
  if (min !== undefined) {
    b.set('passwordPolicy.minLength', Math.max(8, min));
    b.add(min < 8 ? 'differs' : 'mapped', `${area} passwordPolicy`, 'length.min', `${min}${min < 8 ? ' (Atlas requires at least 8; existing passwords still sign in)' : ''}.`, 'auth_config.passwordPolicy.minLength');
  }
  const max = num(length.max);
  if (max !== undefined && max >= 8) {
    b.set('passwordPolicy.maxLength', Math.min(max, 4096));
    b.add('mapped', `${area} passwordPolicy`, 'length.max', `${max}.`, 'auth_config.passwordPolicy.maxLength');
  }
  const rejects = isObj(pw.rejects) ? pw.rejects : {};
  if (rejects.pwned === true) {
    b.set('passwordPolicy.checkBreaches', true);
    b.add('mapped', `${area} passwordPolicy`, 'rejects.pwned', 'Breached passwords are refused.', 'auth_config.passwordPolicy.checkBreaches');
  }
  if (rejects.userInfo === true) {
    b.set('passwordPolicy.rejectIdentifierSubstring', true);
    b.add('mapped', `${area} passwordPolicy`, 'rejects.userInfo', 'Passwords containing the user\'s own identifiers are refused.', 'auth_config.passwordPolicy.rejectIdentifierSubstring');
  }
  if (rejects.repeatedIdentical === true || rejects.sequential === true || strs(rejects.words).length) {
    b.add('differs', `${area} passwordPolicy`, 'rejects.repeatedIdentical / sequential / words', 'Atlas follows NIST 800-63B: length and breached-password checks, no pattern or custom-word rules.', 'auth_config.passwordPolicy');
  }
  const types = isObj(pw.characterTypes) ? num(pw.characterTypes.min) : undefined;
  if (types && types > 1) {
    b.add('differs', `${area} passwordPolicy`, 'characterTypes.min', 'Atlas has no character-class rules (NIST 800-63B); length and the breach check apply.', 'auth_config.passwordPolicy');
  }

  // ── multi-factor ──
  const mfa = isObj(exp.mfa) ? exp.mfa : {};
  const factors = strs(mfa.factors);
  if (factors.includes('Totp')) {
    b.set('mfa.factors.totp', true);
    b.add('mapped', `${area} mfa`, 'factors Totp', 'Authenticator apps; TOTP secrets move with a database export.', 'auth_config.mfa.factors.totp');
  }
  if (factors.includes('WebAuthn')) {
    b.set('mfa.factors.passkey', true);
    b.add('differs', `${area} mfa`, 'factors WebAuthn', 'Security keys and passkeys as a second factor; credentials move with a database export.', 'auth_config.mfa.factors.passkey');
  }
  if (factors.includes('BackupCode')) b.add('mapped', `${area} mfa`, 'factors BackupCode', 'Backup codes (unused ones move with a database export).', 'auth_config.mfa');
  const policy = str(mfa.policy);
  if (policy === 'Mandatory') {
    b.set('mfaPolicy', 'required');
    b.add('mapped', `${area} mfa`, 'policy Mandatory', 'A second factor on every sign-in.', 'auth_config.mfaPolicy');
  } else if (factors.length) {
    b.set('mfaPolicy', 'optional');
    b.add('differs', `${area} mfa`, `policy ${policy ?? 'UserControlled'}`, 'Users may enrol a second factor; Atlas does not prompt for enrolment at sign-in (use a step-up rule or require MFA).', 'auth_config.mfaPolicy');
  }
  if (isObj(exp.adaptiveMfa) && exp.adaptiveMfa.enabled === true) b.add('differs', `${area} mfa`, 'adaptiveMfa', 'Adaptive MFA: Atlas uses step-up and risk policies instead; review auth_config.stepUp.', 'auth_config.stepUp');

  // ── social and message connectors ──
  for (const c of snap.connectors) {
    const target = str(c.target) ?? str(c.connectorId) ?? '';
    const type = str(c.type);
    const name = str(isObj(c.metadata) && isObj(c.metadata.name) ? c.metadata.name.en : undefined) ?? str(c.connectorId) ?? target;
    if (type === 'Email' || type === 'Sms' || /-(mail|sms)$/.test(target)) {
      b.add('manual', 'connectors', `${name} (${type ?? target})`, 'Message delivery: Atlas sends through your own email / SMS provider (bring-your-own keys): configure it in the dashboard.', 'email_provider');
      continue;
    }
    const key = socialKey(target);
    if (!key) {
      b.add('manual', 'connectors', `${name} (${target})`, 'No built-in Atlas provider: add it as a custom OAuth provider.', 'custom_oauth_providers');
      continue;
    }
    const config = isObj(c.config) ? c.config : {};
    b.socialProvider({ atlasKey: key, vendorName: name, area: 'connectors', setting: `${name} (${target})`, clientId: str(config.clientId), scopes: str(config.scope)?.split(/[ ,]+/).filter(Boolean) });
  }
  const targets = strs(exp.socialSignInConnectorTargets);
  if (targets.length) b.add('mapped', area, 'socialSignInConnectorTargets', `${targets.join(', ')} shown on the sign-in page: each enabled provider appears on Atlas's.`, 'oauth_providers');
  if (exp.singleSignOnEnabled === true) b.add('mapped', area, 'singleSignOnEnabled', 'Enterprise SSO connectors move with the data export as Atlas SSO connections (update each IdP with Atlas\'s ACS URL / redirect URI).', 'sso_connections');

  // ── applications → redirect URLs and origins ──
  const origins = new Set<string>();
  const redirects = new Set<string>();
  for (const app of snap.applications) {
    const type = str(app.type);
    const appName = str(app.name) ?? str(app.id) ?? '?';
    if (type === 'MachineToMachine') {
      b.add('manual', `applications ${appName}`, 'type MachineToMachine', 'A service app: create an Atlas M2M client for it.', 'oauth_clients');
      continue;
    }
    if (type === 'SAML') {
      b.add('manual', `applications ${appName}`, 'type SAML', 'Logto acting as a SAML identity provider for this app: register it as an Atlas SAML application.', 'oauth_clients');
      continue;
    }
    if (type === 'Protected') {
      b.add('manual', `applications ${appName}`, 'type Protected', 'A Logto protected app (the hosted reverse proxy) has no Atlas counterpart: protect the origin with the Atlas middleware.');
      continue;
    }
    const oidc = isObj(app.oidcClientMetadata) ? app.oidcClientMetadata : {};
    for (const u of [...strs(oidc.redirectUris), ...strs(oidc.postLogoutRedirectUris)]) redirects.add(u);
    const custom = isObj(app.customClientMetadata) ? app.customClientMetadata : {};
    for (const o of strs(custom.corsAllowedOrigins)) origins.add(o);
    if (num(custom.idTokenTtl) || num(custom.refreshTokenTtl)) {
      b.add('differs', `applications ${appName}`, 'customClientMetadata idTokenTtl / refreshTokenTtl', 'Atlas sets token lifetimes per instance (auth_config.session), not per application.', 'auth_config.session');
    }
  }
  let exact = 0;
  for (const url of redirects) {
    if (url.includes('*')) {
      b.add('differs', 'applications', `redirectUris ${url}`, 'Atlas redirect URLs are exact (no wildcards).', 'redirect_urls');
      continue;
    }
    if (!/^https?:\/\//.test(url)) {
      b.add('differs', 'applications', `redirectUris ${url}`, 'A native-app scheme: register it with the Atlas native app, not as a web redirect URL.', 'native_apps');
      continue;
    }
    b.push('redirect_urls', { url });
    exact++;
  }
  if (exact) b.add('mapped', 'applications', 'oidcClientMetadata.redirectUris / postLogoutRedirectUris', `${exact} redirect URL(s).`, 'redirect_urls');
  if (origins.size) {
    b.instance.allowed_origins = [...origins].filter((o) => !o.includes('*'));
    b.add('mapped', 'applications', 'customClientMetadata.corsAllowedOrigins', 'Allowed origins for the browser SDK.', 'instance.allowed_origins');
  }

  // ── API resources ──
  for (const r of snap.resources) {
    const indicator = str(r.indicator);
    if (!indicator) continue;
    const scopes = (r.scopes ?? []).map((s) => str(s.name)).filter((s): s is string => !!s);
    b.push('resource_servers', { identifier: indicator, name: str(r.name) ?? indicator, scopes } as Json);
    b.add('mapped', `api resources ${str(r.name) ?? indicator}`, `indicator ${indicator}`, `An API with ${scopes.length} scope(s); Atlas access tokens for it keep "aud": "${indicator}".`, `resource_servers ${indicator}`);
    if (num(r.accessTokenTtl) && num(r.accessTokenTtl) !== 3600) b.add('differs', `api resources ${str(r.name) ?? indicator}`, 'accessTokenTtl', 'Atlas access-token lifetime is an instance setting (auth_config.session.jwtTtlSeconds).', 'auth_config.session.jwtTtlSeconds');
  }

  // ── roles ──
  for (const r of snap.roles) {
    const name = str(r.name);
    if (!name) continue;
    const key = keyOf(name);
    b.roles[name] = key;
    b.push('roles', { key, name, description: str(r.description) ?? '', permissions: [] } as Json);
  }
  if (snap.roles.length) b.add('differs', 'roles', 'roles', `${snap.roles.length} role(s) become Atlas app roles; their API permissions and the user assignments move with the data export.`, 'roles');

  // ── things with no 1:1 ──
  for (const h of snap.hooks) {
    if (h.enabled === false) continue;
    const events = [...strs(h.events), ...(str(h.event) ? [str(h.event)!] : [])];
    b.add('manual', 'webhooks', `${str(h.name) ?? str(h.id) ?? '?'} (${events.join(', ') || 'events unknown'})`, 'A Logto webhook: create an Atlas webhook endpoint for the matching events and re-verify the signature in your receiver.', 'webhooks');
  }
  for (const j of snap.jwtCustomizers) {
    const kind = str(j.key) ?? 'custom JWT';
    b.add('manual', 'custom token claims', kind, 'A custom claims script: recreate its claims as an Atlas JWT template / session claims.', 'jwt_templates');
  }
  if (str(exp.customCss) || str(exp.customContent)) b.add('manual', area, 'customCss / customContent', 'Custom CSS and page content: restyle the Atlas components with the appearance settings.', 'branding');
  b.add('differs', 'sessions', 'session lifetime', 'Logto sessions are not configurable per tenant; set the idle and absolute session windows you want in Atlas (auth_config.session).', 'auth_config.session');

  return b.result(`Logto tenant ${snap.tenantId} (${snap.endpoint})`, {
    bridge: { preset: 'logto', vars: { base_url: snap.endpoint } },
    lazy: { preset: 'logto', config: { base_url: snap.endpoint } },
  });
}
