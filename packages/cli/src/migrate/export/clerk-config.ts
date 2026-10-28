import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { clerkFrontendApiFromPublishableKey } from '@atlasauth/backend';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, keyOf, socialKey } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate clerk config` — a Clerk instance's settings → Atlas config.
 *
 * Read from Clerk's PUBLIC environment document (`GET https://<frontend
 * api>/v1/environment`, what clerk-js loads with the publishable key) and,
 * with the secret key, the Backend API's JWT templates, redirect URLs,
 * organization roles and permissions. Atlas mirrors Clerk's model, so most
 * settings map 1:1.
 */
export interface ClerkConfigSnapshot {
  frontendApi: string;
  environment: Obj;
  jwtTemplates?: Obj[];
  redirectUrls?: Obj[];
  roles?: Obj[];
  permissions?: Obj[];
}

export async function fetchClerkConfig(opts: { publishableKey: string; secretKey?: string; fetchImpl?: typeof fetch; apiUrl?: string }): Promise<ClerkConfigSnapshot> {
  const frontendApi = clerkFrontendApiFromPublishableKey(opts.publishableKey);
  if (!frontendApi) throw new Error('That is not a Clerk publishable key (pk_test_… / pk_live_…).');
  const fapi = new VendorHttp({ vendor: 'Clerk', baseUrl: `https://${frontendApi}`, fetchImpl: opts.fetchImpl });
  const { body: environment } = await fapi.get<Obj>('/v1/environment');
  const snap: ClerkConfigSnapshot = { frontendApi, environment: isObj(environment) ? environment : {} };
  if (opts.secretKey) {
    const bapi = new VendorHttp({ vendor: 'Clerk', baseUrl: opts.apiUrl ?? 'https://api.clerk.com', headers: { authorization: `Bearer ${opts.secretKey}` }, fetchImpl: opts.fetchImpl });
    const list = async (path: string): Promise<Obj[]> => {
      try {
        const { body } = await bapi.get<unknown>(path);
        return Array.isArray(body) ? objs(body) : isObj(body) ? objs(body.data) : [];
      } catch (err) {
        if (err instanceof VendorApiError && [403, 404, 422].includes(err.status)) return [];
        throw err;
      }
    };
    snap.jwtTemplates = await list('/v1/jwt_templates');
    snap.redirectUrls = await list('/v1/redirect_urls');
    snap.roles = await list('/v1/organization_roles?limit=500');
    snap.permissions = await list('/v1/organization_permissions?limit=500');
  }
  return snap;
}

const AREA_ATTR = 'user & authentication';

export function translateClerkConfig(snap: ClerkConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const env = snap.environment;
  const us = isObj(env.user_settings) ? env.user_settings : {};
  const attrs = isObj(us.attributes) ? us.attributes : {};
  const attr = (name: string): Obj => (isObj(attrs[name]) ? (attrs[name] as Obj) : {});
  const on = (name: string) => attr(name).enabled === true;

  // ── identifiers and first factors ──
  const email = attr('email_address');
  if (on('email_address')) {
    const first = strs(email.first_factors);
    b.set('strategies.emailCode', first.includes('email_code'));
    b.set('strategies.emailLink', first.includes('email_link'));
    b.add('mapped', AREA_ATTR, 'attributes.email_address.first_factors', `Email sign-in: ${first.join(', ') || 'identifier only'}.`, 'auth_config.strategies.emailCode / emailLink');
    const verifyAtSignUp = email.verify_at_sign_up === true || strs(email.verifications).length > 0;
    b.set('requireEmailVerification', verifyAtSignUp);
    b.add('mapped', AREA_ATTR, 'attributes.email_address.verify_at_sign_up', verifyAtSignUp ? 'Email addresses are verified at sign-up.' : 'Email addresses are not verified at sign-up.', 'auth_config.requireEmailVerification');
  }
  if (on('phone_number')) {
    b.set('strategies.phoneCode', strs(attr('phone_number').first_factors).includes('phone_code'));
    b.add('mapped', AREA_ATTR, 'attributes.phone_number', 'SMS code sign-in.', 'auth_config.strategies.phoneCode');
  }
  if (on('username')) {
    b.set('strategies.username', true);
    const u = isObj(us.username_settings) ? us.username_settings : {};
    if (typeof u.min_length === 'number') b.set('accountUx.username.minLength', u.min_length);
    if (typeof u.max_length === 'number') b.set('accountUx.username.maxLength', u.max_length);
    b.add('mapped', AREA_ATTR, 'attributes.username', 'Usernames, with the same length limits.', 'auth_config.strategies.username');
  }
  const password = on('password');
  b.set('strategies.password', password);
  if (password) b.add('mapped', AREA_ATTR, 'attributes.password', 'Password sign-in. Imported Clerk users keep their bcrypt digest and are re-hashed to Argon2id on first sign-in.', 'auth_config.strategies.password');
  if (on('passkey')) {
    b.set('strategies.passkey', true);
    b.add('differs', AREA_ATTR, 'attributes.passkey', 'Passkey sign-in is on, but Clerk does not export passkeys: users register a new one in Atlas.', 'auth_config.strategies.passkey');
  }
  if (on('web3_wallet')) b.add('differs', AREA_ATTR, 'attributes.web3_wallet', 'Atlas signs wallets in with Sign-In with Ethereum (strategies.siwe); wallet-only Clerk users are not exported (no email to carry).', 'auth_config.strategies.siwe');
  for (const name of ['first_name', 'last_name']) {
    if (attr(name).required === true) b.add('manual', AREA_ATTR, `attributes.${name}.required`, 'Make the name a required identity trait in Atlas (identityTraits) if sign-up must collect it.', 'auth_config.identityTraits');
  }

  // ── second factors ──
  const totp = on('authenticator_app');
  const sms2fa = attr('phone_number').used_for_second_factor === true;
  const backup = on('backup_code');
  b.set('mfa.factors.totp', totp);
  if (totp) b.add('mapped', 'multi-factor', 'attributes.authenticator_app', 'Authenticator apps. TOTP secrets move only from the dashboard CSV export.', 'auth_config.mfa.factors.totp');
  if (sms2fa) b.add('differs', 'multi-factor', 'attributes.phone_number.used_for_second_factor', 'SMS second factor: Atlas offers SMS as a first factor and recommends TOTP or passkeys for the second.', 'auth_config.mfa');
  if (backup) b.add('mapped', 'multi-factor', 'attributes.backup_code', 'Backup codes. Clerk does not export them: users generate new ones.', 'auth_config.mfa.backupCodes');
  const signIn = isObj(us.sign_in) ? us.sign_in : {};
  if (isObj(signIn.second_factor) && signIn.second_factor.required === true) {
    b.set('mfaPolicy', 'required');
    b.add('mapped', 'multi-factor', 'sign_in.second_factor.required', 'Every user must use a second factor.', 'auth_config.mfaPolicy');
  }

  // ── sign-up mode ──
  const signUp = isObj(us.sign_up) ? us.sign_up : {};
  const mode = str(signUp.mode) ?? 'public';
  if (mode === 'restricted' || mode === 'waitlist') {
    b.set('signUpMode', 'restricted');
    b.add(mode === 'waitlist' ? 'differs' : 'mapped', 'restrictions', 'sign_up.mode', mode === 'waitlist' ? 'Clerk waitlist: Atlas restricts sign-up to invitations and the allowlist; collect waitlist sign-ups yourself.' : 'Sign-up by invitation / allowlist only.', 'auth_config.signUpMode');
  } else {
    b.set('signUpMode', 'public');
    b.add('mapped', 'restrictions', 'sign_up.mode', 'Public sign-up.', 'auth_config.signUpMode');
  }

  // ── password policy ──
  const pw = isObj(us.password_settings) ? us.password_settings : {};
  if (typeof pw.min_length === 'number') {
    b.set('passwordPolicy.minLength', Math.max(8, pw.min_length));
    b.add(pw.min_length < 8 ? 'differs' : 'mapped', 'password', 'password_settings.min_length', pw.min_length < 8 ? `Clerk allows ${pw.min_length}; Atlas requires at least 8 (existing passwords still sign in).` : `${pw.min_length}.`, 'auth_config.passwordPolicy.minLength');
  }
  if (typeof pw.max_length === 'number' && pw.max_length > 0) {
    b.set('passwordPolicy.maxLength', Math.min(256, pw.max_length));
    b.add('mapped', 'password', 'password_settings.max_length', `${Math.min(256, pw.max_length)}.`, 'auth_config.passwordPolicy.maxLength');
  }
  if (pw.disable_hibp !== undefined) {
    b.set('passwordPolicy.checkBreaches', pw.disable_hibp !== true);
    b.add('mapped', 'password', 'password_settings.disable_hibp', pw.disable_hibp === true ? 'Breached-password check off.' : 'Breached passwords are refused.', 'auth_config.passwordPolicy.checkBreaches');
  }
  for (const k of ['require_special_char', 'require_numbers', 'require_uppercase', 'require_lowercase']) {
    if (pw[k] === true) b.add('differs', 'password', `password_settings.${k}`, 'Atlas follows NIST 800-63B (length and breach checks, no composition rules); this rule is dropped.', 'auth_config.passwordPolicy');
  }

  // ── social providers ──
  const social = isObj(us.social) ? us.social : {};
  for (const [strategy, cfg] of Object.entries(social)) {
    if (!isObj(cfg) || cfg.enabled !== true) continue;
    const key = socialKey(strategy);
    if (key) {
      b.socialProvider({ atlasKey: key, vendorName: strategy, area: 'SSO connections', setting: `social.${strategy}`, allowSignUp: cfg.authenticatable !== false });
      if (cfg.authenticatable === false) b.add('differs', 'SSO connections', `social.${strategy}.authenticatable`, 'Connect-only in Clerk; in Atlas it can sign in too (turn allow_sign_in off to match).', `oauth_providers ${key}`);
    } else if (strategy.startsWith('oauth_custom_')) {
      b.add('manual', 'SSO connections', `social.${strategy}`, `Custom OAuth provider "${str(cfg.name) ?? strategy}": recreate it in Atlas as a custom OAuth/OIDC provider with its endpoints.`, 'custom_oauth_providers');
    } else {
      b.add('manual', 'SSO connections', `social.${strategy}`, `"${str(cfg.name) ?? strategy}" is not a built-in Atlas provider; add it as a custom OAuth provider.`, 'custom_oauth_providers');
    }
  }
  if (isObj(us.enterprise_sso) && us.enterprise_sso.enabled === true) {
    b.add('mapped', 'SSO connections', 'enterprise_sso', 'Enterprise connections (SAML / OIDC) move with the data export as Atlas SSO connections. Give each IdP Atlas\'s new ACS URL and entity id.', 'sso_connections');
  }

  // ── sessions ──
  const authConfig = isObj(env.auth_config) ? env.auth_config : {};
  if (authConfig.single_session_mode !== undefined) {
    b.set('session.multiSession', authConfig.single_session_mode !== true);
    b.add('mapped', 'sessions', 'auth_config.single_session_mode', authConfig.single_session_mode === true ? 'One signed-in account per browser.' : 'Multi-session (account switching).', 'auth_config.session.multiSession');
  }
  b.add('manual', 'sessions', 'session lifetime / inactivity timeout', "Clerk's session lifetime is not in its public settings: copy it from Clerk's dashboard (Sessions) into auth_config.session.absoluteMs / idleMs.", 'auth_config.session');

  // ── organizations ──
  const orgs = isObj(env.organization_settings) ? env.organization_settings : {};
  if (orgs.enabled === true) {
    if (typeof orgs.max_allowed_memberships === 'number' && orgs.max_allowed_memberships > 0) {
      b.set('organizations.defaultMaxAllowedMemberships', orgs.max_allowed_memberships);
      b.add('mapped', 'organizations', 'organization_settings.max_allowed_memberships', `${orgs.max_allowed_memberships} members per organization.`, 'auth_config.organizations.defaultMaxAllowedMemberships');
    }
    const actions = isObj(orgs.actions) ? orgs.actions : {};
    if (actions.admin_delete !== undefined) {
      b.set('organizations.allowDeletionFromApp', actions.admin_delete === true);
      b.add('mapped', 'organizations', 'organization_settings.actions.admin_delete', actions.admin_delete === true ? 'Admins can delete their organization.' : 'Admins cannot delete organizations.', 'auth_config.organizations.allowDeletionFromApp');
    }
    const domains = isObj(orgs.domains) ? orgs.domains : {};
    if (domains.enabled === true) b.add('mapped', 'organizations', 'organization_settings.domains', `Verified domains (${strs(domains.enrollment_modes).join(', ') || 'manual'}) move with each organization.`, 'organizations.domains');
    const creator = str(isObj(orgs.creator_role) ? orgs.creator_role.key : orgs.creator_role);
    if (creator) {
      b.set('organizations.creatorRole', creator.startsWith('org:') ? creator : `org:${creator}`);
      b.add('mapped', 'organizations', 'organization_settings.creator_role', `Creators are seated as ${creator}.`, 'auth_config.organizations.creatorRole');
    }
  }

  // ── roles, permissions, JWT templates, redirect URLs (Backend API) ──
  for (const p of snap.permissions ?? []) {
    const key = str(p.key);
    if (!key || /^org:sys_/.test(key)) continue;
    b.push('permissions', { key: key.replace(/^org:/, ''), name: str(p.name) ?? key, description: str(p.description) ?? '' } as Json);
  }
  if (snap.permissions?.length) b.add('mapped', 'organizations', 'organization_permissions', `${b.collections.permissions!.length} custom permission(s); Clerk's system permissions are built into Atlas.`, 'permissions');
  for (const r of snap.roles ?? []) {
    const key = str(r.key);
    if (!key) continue;
    const atlasKey = key.startsWith('org:') ? key : `org:${keyOf(key)}`;
    b.roles[key] = atlasKey;
    b.push('roles', {
      key: atlasKey,
      name: str(r.name) ?? key,
      description: str(r.description) ?? '',
      permissions: objs(r.permissions).map((p) => str(p.key)).filter((p): p is string => !!p).map((p) => p.replace(/^org:/, '')),
    } as Json);
  }
  if (snap.roles?.length) b.add('mapped', 'organizations', 'organization_roles', `${snap.roles.length} role(s), same keys.`, 'roles');
  for (const t of snap.jwtTemplates ?? []) {
    const name = str(t.name);
    if (!name) continue;
    b.push('jwt_templates', { name, claims: (isObj(t.claims) ? t.claims : {}) as Json, lifetime: typeof t.lifetime === 'number' ? t.lifetime : 60, ...(typeof t.allowed_clock_skew === 'number' ? { allowed_clock_skew: t.allowed_clock_skew } : {}) } as Json);
    b.add(t.custom_signing_key === true ? 'differs' : 'mapped', 'JWT templates', `jwt_templates.${name}`, t.custom_signing_key === true ? 'Template kept; Atlas signs it with the instance key (the custom signing key is not copied).' : 'Same shortcodes ({{user.id}}, {{org.role}} …).', `jwt_templates ${name}`);
  }
  for (const r of snap.redirectUrls ?? []) {
    const url = str(r.url);
    if (url) b.push('redirect_urls', { url });
  }
  if (snap.redirectUrls?.length) b.add('mapped', 'paths', 'redirect_urls', 'Native / OAuth redirect URLs.', 'redirect_urls');
  const display = isObj(env.display_config) ? env.display_config : {};
  for (const [setting, atlas] of [
    ['sign_in_url', 'NEXT_PUBLIC_ATLAS_SIGN_IN_URL'],
    ['sign_up_url', 'NEXT_PUBLIC_ATLAS_SIGN_UP_URL'],
  ] as const) {
    const v = str(display[setting]);
    if (v) b.add('differs', 'paths', `display_config.${setting}`, `Clerk hosts ${v}; Atlas uses its own hosted pages or your routes (set ${atlas}).`, atlas);
  }

  return b.result(`Clerk instance ${snap.frontendApi}`, {
    bridge: { preset: 'clerk', vars: { frontend_api: snap.frontendApi } },
  });
}
