import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { collectIdps, fetchIdpTemplates, g, readZitadelExport, zitadelBase, zitadelHttp, type ZitadelApiOptions } from './zitadel';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, keyOf, socialKey } from './translate-kit';
import { VendorApiError, VendorHttp } from './vendor-http';

/**
 * `atlas migrate zitadel config` — ZITADEL settings → Atlas config.
 *
 * One reader, two sources: ZITADEL's own export document (`zitadel export`, or
 * `POST /admin/v1/export` with passwords and secrets OFF), which carries each
 * organization's policies, projects with their roles, OIDC / API applications,
 * identity providers and actions; plus, through the API, the INSTANCE default
 * policies (login, password complexity, lockout, second factors), which an
 * organization without an override inherits.
 */

export interface ZitadelPolicies {
  login?: Obj;
  passwordComplexity?: Obj;
  lockout?: Obj;
  secondFactors?: string[];
  multiFactors?: string[];
}

export interface ZitadelConfigSnapshot {
  origin: string;
  orgs: Obj[];
  idpTemplates: Obj[];
  /** Instance default policies (live API read only). */
  defaults: ZitadelPolicies;
  /** The instance URL: the bridge issuer and the lazy-migration base URL. */
  instance?: string;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const sub = (o: Obj | undefined, camel: string): Obj | undefined => {
  const v = g(o, camel);
  return isObj(v) ? v : undefined;
};
const flag = (o: Obj | undefined, camel: string): boolean | undefined => {
  const v = g(o, camel);
  return typeof v === 'boolean' ? v : undefined;
};

// ── reading ─────────────────────────────────────────────────────────────────

/** An export document (`{ orgs }`) as a config snapshot; no instance defaults. */
export function configSnapshotFromExport(doc: unknown, origin: string, instance?: string): ZitadelConfigSnapshot {
  const snap = readZitadelExport(doc);
  return { origin, orgs: snap.orgs, idpTemplates: [], defaults: {}, instance };
}

/** The instance's default policies, best effort (a narrow role or an old version answers 4xx for some). */
export async function fetchZitadelPolicies(http: VendorHttp): Promise<ZitadelPolicies> {
  const policy = async (path: string): Promise<Obj | undefined> => {
    try {
      const { body } = await http.get<unknown>(path);
      return isObj(body) && isObj(body.policy) ? body.policy : undefined;
    } catch (err) {
      if (err instanceof VendorApiError && err.status > 0 && err.status < 500) return undefined;
      throw err;
    }
  };
  const factors = async (path: string): Promise<string[] | undefined> => {
    try {
      const { body } = await http.get<unknown>(path);
      return isObj(body) ? strs(body.result) : undefined;
    } catch (err) {
      if (err instanceof VendorApiError && err.status > 0 && err.status < 500) return undefined;
      throw err;
    }
  };
  return {
    login: await policy('/admin/v1/policies/login'),
    passwordComplexity: await policy('/admin/v1/policies/password/complexity'),
    lockout: await policy('/admin/v1/policies/lockout'),
    secondFactors: await factors('/admin/v1/policies/login/second_factors'),
    multiFactors: await factors('/admin/v1/policies/login/multi_factors'),
  };
}

/** Read the instance through the Admin API (an IAM_OWNER token): the export WITHOUT secrets, plus the default policies. */
export async function fetchZitadelConfig(o: Pick<ZitadelApiOptions, 'instance' | 'token' | 'fetchImpl' | 'sleep'>): Promise<ZitadelConfigSnapshot> {
  const http = zitadelHttp(o);
  const instance = zitadelBase(o.instance);
  const { body } = await http.post<unknown>('/admin/v1/export', { withPasswords: false, withOtp: false, responseOutput: true });
  const snap = readZitadelExport(body);
  return { origin: `ZITADEL ${instance.replace(/^https?:\/\//, '')}`, orgs: snap.orgs, idpTemplates: await fetchIdpTemplates(http), defaults: await fetchZitadelPolicies(http), instance };
}

// ── translation ─────────────────────────────────────────────────────────────

/** The first organization that overrides a policy, or the instance default; notes when organizations disagree. */
function pick(snap: ZitadelConfigSnapshot, camel: string, fallback: Obj | undefined): { value: Obj | undefined; overridden: number } {
  const found = snap.orgs.map((o) => sub(o, camel)).filter((p): p is Obj => p !== undefined);
  const distinct = new Set(found.map((p) => JSON.stringify(p)));
  return { value: fallback ?? found[0], overridden: fallback ? found.length : distinct.size > 1 ? distinct.size : 0 };
}

const SECOND_FACTORS: Record<string, { atlas: string; label: string }> = {
  SECOND_FACTOR_TYPE_OTP: { atlas: 'totp', label: 'Authenticator apps' },
  SECOND_FACTOR_TYPE_U2F: { atlas: 'passkey', label: 'Security keys' },
  SECOND_FACTOR_TYPE_OTP_EMAIL: { atlas: 'emailCode', label: 'Email code' },
  SECOND_FACTOR_TYPE_OTP_SMS: { atlas: 'sms', label: 'SMS code' },
};

export function translateZitadelConfig(snap: ZitadelConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const add = (status: 'mapped' | 'differs' | 'manual', area: string, setting: string, note: string, atlas?: string) => b.add(status, area, setting, note, atlas);

  // ── login policy ──
  const login = pick(snap, 'loginPolicy', snap.defaults.login);
  const lp = login.value;
  if (login.overridden) add('differs', 'login policy', 'loginPolicy', `${login.overridden} organization(s) override the instance login policy; Atlas settings are instance-wide, so the ${snap.defaults.login ? 'instance default' : 'first organization\'s policy'} is used. Check the others by hand.`);
  if (lp) {
    if (flag(lp, 'allowRegister') !== undefined) {
      const open = flag(lp, 'allowRegister') === true;
      b.set('signUpMode', open ? 'public' : 'restricted');
      add('mapped', 'login policy', 'loginPolicy.allowRegister', open ? 'Public sign-up.' : 'Sign-up closed (invitations and the allowlist still work).', 'auth_config.signUpMode');
    }
    if (flag(lp, 'allowUsernamePassword') !== undefined) {
      const on = flag(lp, 'allowUsernamePassword') === true;
      b.set('strategies.password', on);
      add('mapped', 'login policy', 'loginPolicy.allowUsernamePassword', on ? 'Password sign-in on.' : 'Password sign-in off.', 'auth_config.strategies.password');
    }
    if (flag(lp, 'allowExternalIdp') === false) add('differs', 'login policy', 'loginPolicy.allowExternalIdp', 'External sign-in is off in ZITADEL: leave the social providers below disabled in Atlas.');
    if (str(g(lp, 'passwordlessType')) === 'PASSWORDLESS_TYPE_ALLOWED') {
      b.set('strategies.passkey', true);
      add('mapped', 'login policy', 'loginPolicy.passwordlessType', 'Passwordless (passkey) sign-in on.', 'auth_config.strategies.passkey');
    }
    if (flag(lp, 'forceMfa') === true) {
      b.set('mfaPolicy', 'required');
      add(flag(lp, 'forceMfaLocalOnly') === true ? 'differs' : 'mapped', 'login policy', 'loginPolicy.forceMfa', flag(lp, 'forceMfaLocalOnly') === true ? 'MFA is required for every user in Atlas; ZITADEL required it only for password sign-ins (forceMfaLocalOnly).' : 'MFA always required.', 'auth_config.mfaPolicy');
    }
    if (flag(lp, 'hidePasswordReset') === true) add('differs', 'login policy', 'loginPolicy.hidePasswordReset', 'Atlas shows "Forgot password?" whenever password sign-in is on.');
    if (flag(lp, 'ignoreUnknownUsernames') === true) add('mapped', 'login policy', 'loginPolicy.ignoreUnknownUsernames', 'Atlas answers uniformly for unknown users.');
    const redirect = str(g(lp, 'defaultRedirectUri'));
    if (redirect) {
      b.push('redirect_urls', { url: redirect });
      add('mapped', 'login policy', 'loginPolicy.defaultRedirectUri', 'Becomes a redirect URL.', 'redirect_urls');
    }
    for (const field of ['passwordCheckLifetime', 'externalLoginCheckLifetime', 'secondFactorCheckLifetime', 'multiFactorCheckLifetime', 'mfaInitSkipLifetime']) {
      if (g(lp, field) !== undefined) add('differs', 'login policy', `loginPolicy.${field}`, `ZITADEL re-checks this factor after ${String(g(lp, field))}; Atlas sessions have one lifetime (auth_config.session) and sensitive actions use step-up (auth_config.stepUp).`, 'auth_config.stepUp');
    }
  }
  const second = snap.defaults.secondFactors ?? [...new Set(snap.orgs.flatMap((o) => strs(g(o, 'secondFactors'))))];
  const multi = snap.defaults.multiFactors ?? [...new Set(snap.orgs.flatMap((o) => strs(g(o, 'multiFactors'))))];
  for (const f of second) {
    const known = SECOND_FACTORS[f];
    if (!known) {
      add('manual', 'login policy', `secondFactors ${f}`, 'No Atlas counterpart.');
      continue;
    }
    b.set(`mfa.factors.${known.atlas}`, true);
    add('mapped', 'login policy', `secondFactors ${f}`, `${known.label} second factor.${known.atlas === 'totp' ? ' Seeds move with the export (`withOtp`).' : known.atlas === 'passkey' ? ' ZITADEL does not export security keys: users register again.' : ''}`, `auth_config.mfa.factors.${known.atlas}`);
  }
  if (multi.includes('MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION')) {
    b.set('mfa.factors.passkey', true);
    add('mapped', 'login policy', 'multiFactors MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION', 'Passkeys with user verification.', 'auth_config.mfa.factors.passkey');
  }

  // ── password complexity, lockout ──
  const complexity = pick(snap, 'passwordComplexityPolicy', snap.defaults.passwordComplexity);
  const pc = complexity.value;
  if (complexity.overridden) add('differs', 'password policy', 'passwordComplexityPolicy', `${complexity.overridden} organization(s) override the password policy; Atlas has one instance-wide policy.`);
  if (pc) {
    const min = num(g(pc, 'minLength'));
    if (min !== undefined) {
      b.set('passwordPolicy.minLength', Math.max(min, 6));
      add('mapped', 'password policy', 'passwordComplexityPolicy.minLength', `Minimum ${min} characters.`, 'auth_config.passwordPolicy.minLength');
    }
    for (const [field, key, label] of [['hasUppercase', 'requireUppercase', 'an uppercase letter'], ['hasLowercase', 'requireLowercase', 'a lowercase letter'], ['hasNumber', 'requireNumber', 'a digit'], ['hasSymbol', 'requireSymbol', 'a symbol']] as const) {
      if (flag(pc, field) === true) {
        b.set(`passwordPolicy.${key}`, true);
        add('mapped', 'password policy', `passwordComplexityPolicy.${field}`, `Requires ${label}.`, `auth_config.passwordPolicy.${key}`);
      }
    }
  }
  const lock = pick(snap, 'lockoutPolicy', snap.defaults.lockout).value;
  if (lock) {
    if (num(g(lock, 'maxPasswordAttempts'))) add('differs', 'lockout', 'lockoutPolicy.maxPasswordAttempts', `ZITADEL locks an account after ${String(g(lock, 'maxPasswordAttempts'))} failed passwords; Atlas throttles failed sign-ins per account and per IP with its own thresholds.`);
    if (num(g(lock, 'maxOtpAttempts'))) add('differs', 'lockout', 'lockoutPolicy.maxOtpAttempts', 'Atlas limits second-factor attempts with its own thresholds.');
  }
  const domain = pick(snap, 'domainPolicy', undefined).value;
  if (flag(domain, 'userLoginMustBeDomain') === true) add('differs', 'login policy', 'domainPolicy.userLoginMustBeDomain', 'ZITADEL login names carried the organization domain (user@org.domain); Atlas users sign in with their email address or username (kept from the export).');
  const privacy = pick(snap, 'privacyPolicy', undefined).value;
  if (privacy) add('manual', 'privacy policy', 'privacyPolicy', `Terms of service, privacy and help links (${[str(g(privacy, 'tosLink')), str(g(privacy, 'privacyLink')), str(g(privacy, 'helpLink'))].filter(Boolean).join(', ') || 'none set'}): publish them as Atlas policies and turn on policy acceptance.`);
  if (pick(snap, 'labelPolicy', undefined).value) add('manual', 'branding', 'labelPolicy', 'Colors, logo, icon and font: recreate them in the Atlas branding designer (per organization when needed). Custom login texts are rewritten in Atlas\'s localization.');

  // ── projects, roles, applications ──
  const roles = new Map<string, Obj>();
  let roleAssertions = 0;
  const redirects = new Set<string>();
  const origins = new Set<string>();
  for (const org of snap.orgs) {
    for (const r of objs(g(org, 'projectRoles'))) {
      const key = str(g(r, 'roleKey'));
      if (key && !roles.has(key)) roles.set(key, r);
    }
    for (const p of objs(g(org, 'projects'))) {
      if (flag(sub(p, 'project'), 'projectRoleAssertion') === true) roleAssertions++;
    }
    for (const a of objs(g(org, 'oidcApps'))) {
      const app = sub(a, 'app') ?? a;
      const name = str(g(app, 'name')) ?? str(g(a, 'appId')) ?? 'application';
      for (const u of [...strs(g(app, 'redirectUris')), ...strs(g(app, 'postLogoutRedirectUris'))]) redirects.add(u);
      for (const o of strs(g(app, 'additionalOrigins'))) origins.add(o);
      const type = str(g(app, 'appType'));
      if (type === 'OIDC_APP_TYPE_NATIVE') add('manual', `applications ${name}`, 'appType NATIVE', 'A native app: register its bundle id / package name under auth_config.nativeApps and use the Atlas native SDK.', 'auth_config.nativeApps');
      if (strs(g(app, 'grantTypes')).includes('OIDC_GRANT_TYPE_CLIENT_CREDENTIALS')) add('manual', `applications ${name}`, 'grantTypes client_credentials', 'A service application: create an Atlas M2M client for it.', 'oauth_clients');
      if (str(g(app, 'authMethodType')) === 'OIDC_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT') add('manual', `applications ${name}`, 'authMethodType private_key_jwt', 'Client authentication with a signed JWT: register the application\'s public key in Atlas.');
    }
    for (const a of objs(g(org, 'apiApps'))) add('manual', `applications ${str(g(sub(a, 'app') ?? a, 'name')) ?? 'api'}`, 'API application', 'A ZITADEL API application (token introspection / JWT profile): register the API as a resource server in Atlas and verify Atlas tokens with the instance JWKS.', 'resource_servers');
    for (const action of objs(g(org, 'actions'))) {
      const name = str(g(sub(action, 'action') ?? action, 'name')) ?? str(g(action, 'actionId')) ?? 'action';
      add('manual', 'actions', `action ${name}`, 'A ZITADEL Action (script on a flow trigger): rebuild it as an Atlas Action or webhook.');
    }
  }
  let exact = 0;
  for (const url of redirects) {
    if (url.includes('*')) {
      add('differs', 'applications', `redirectUris ${url}`, 'Atlas redirect URLs are exact (no wildcards); list each URL.', 'redirect_urls');
      continue;
    }
    b.push('redirect_urls', { url });
    exact++;
  }
  if (exact) add('mapped', 'applications', 'oidcApps redirectUris', `${exact} redirect / post-logout URL(s) become redirect URLs.`, 'redirect_urls');
  if (origins.size) {
    b.instance.allowed_origins = [...origins].filter((o) => !o.includes('*'));
    add('mapped', 'applications', 'additionalOrigins', 'Allowed origins for the browser SDK.', 'instance.allowed_origins');
  }
  for (const [key, r] of roles) {
    b.push('roles', { key: keyOf(key), name: str(g(r, 'displayName')) ?? key, description: str(g(r, 'group')) ?? '', permissions: [] } as Json);
    if (keyOf(key) !== key) b.roles[key] = keyOf(key);
  }
  if (roles.size) add('mapped', 'projects', 'projectRoles', `${roles.size} project role(s) become app roles; user grants move with the data export. Roles of different projects share one namespace in Atlas.`, 'roles');
  if (roleAssertions) add('manual', 'projects', 'projectRoleAssertion', 'ZITADEL put roles in the urn:zitadel:iam:org:project:roles claim: add the roles claim your apps read as an Atlas JWT template / session claim.', 'jwt_templates');

  // ── identity providers ──
  for (const idp of collectIdps({ orgs: snap.orgs, idpTemplates: snap.idpTemplates, source: 'api' }).values()) {
    const where = `identity provider ${idp.name}`;
    const social = socialKey(idp.kind);
    const clientId = str(g(idp.config, 'clientId'));
    if (social) {
      b.socialProvider({ atlasKey: social, vendorName: social, area: 'identity providers', setting: where, clientId, scopes: strs(g(idp.config, 'scopes')).length ? strs(g(idp.config, 'scopes')) : undefined });
    } else if (idp.kind === 'oidc') {
      const providerKey = keyOf(idp.name).replace(/:/g, '_').slice(0, 48) || 'oidc';
      const upper = providerKey.toUpperCase();
      const issuer = str(g(idp.config, 'issuer'));
      const doc: Record<string, Json> = {
        provider_key: providerKey,
        display_name: idp.name,
        protocol: 'oidc',
        client_id: clientId ?? b.placeholder(`${upper}_CLIENT_ID`, `${idp.name} client id`),
        client_secret: b.placeholder(`${upper}_CLIENT_SECRET`, `${idp.name} client secret`),
        enabled: true,
        allow_sign_in: true,
        allow_sign_up: true,
      };
      if (issuer) {
        doc.issuer = issuer;
        doc.discovery_url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
      }
      if (strs(g(idp.config, 'scopes')).length) doc.scopes = strs(g(idp.config, 'scopes'));
      b.push('custom_oauth_providers', doc);
      b.providers[idp.name] = providerKey;
      add('differs', 'identity providers', where, `Generic OIDC provider "${idp.name}"${issuer ? ` (issuer ${issuer})` : ''} moves with the data export as an SSO connection when it serves an organization, and as the custom OIDC provider "${providerKey}" for sign-in. Add Atlas's redirect URI at the provider and set ${upper}_CLIENT_SECRET.`, `custom_oauth_providers ${providerKey}`);
    } else if (idp.kind === 'saml') {
      add('mapped', 'identity providers', where, 'SAML provider: moves with the data export as an SSO connection. Give the IdP Atlas\'s ACS URL and entity id before turning it on.', 'sso_connections');
    } else {
      add('manual', 'identity providers', where, `A ${idp.kind} identity provider has no built-in Atlas provider: add it as a custom OAuth provider, or let those users sign in with email.`, 'custom_oauth_providers');
    }
  }

  const vars: Record<string, string> = snap.instance ? { issuer: snap.instance } : {};
  return b.result(snap.origin, {
    bridge: { preset: 'zitadel', vars },
    ...(snap.instance ? { lazy: { preset: 'zitadel', config: { base_url: snap.instance } } } : {}),
  });
}
