import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder } from './translate-kit';
import { VendorApiError, type VendorHttp } from './vendor-http';

/**
 * `atlas migrate firebase config` — a Firebase / Identity Platform project's
 * auth settings → Atlas config.
 *
 * Read with the same credentials as the export from the Identity Toolkit
 * admin v2 API: the project `config` (sign-in methods, MFA, password policy,
 * authorized domains, blocking functions …), the built-in social providers
 * (`defaultSupportedIdpConfigs`), OIDC providers (`oauthIdpConfigs`), SAML
 * providers (`inboundSamlConfigs`) and, on Identity Platform, the tenants.
 * Every report line names the setting path in that API.
 */
export interface FirebaseConfigSnapshot {
  projectId: string;
  config: Obj;
  defaultIdps: Obj[];
  oidcIdps: Obj[];
  samlIdps: Obj[];
  tenants: Obj[];
}

export async function fetchFirebaseConfig(http: VendorHttp, projectId: string): Promise<FirebaseConfigSnapshot> {
  const base = `/v2/projects/${encodeURIComponent(projectId)}`;
  const { body: config } = await http.get<Obj>(`${base}/config`);
  const list = async (kind: string): Promise<Obj[]> => {
    try {
      const out: Obj[] = [];
      let token: string | undefined;
      do {
        const { body } = await http.get<Obj>(`${base}/${kind}?pageSize=100${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`);
        out.push(...objs(body?.[kind]));
        token = str(body?.nextPageToken);
      } while (token);
      return out;
    } catch (err) {
      // Tenants and some provider lists exist only on Identity Platform.
      if (err instanceof VendorApiError && [400, 403, 404].includes(err.status)) return [];
      throw err;
    }
  };
  return {
    projectId,
    config: isObj(config) ? config : {},
    defaultIdps: await list('defaultSupportedIdpConfigs'),
    oidcIdps: await list('oauthIdpConfigs'),
    samlIdps: await list('inboundSamlConfigs'),
    tenants: await list('tenants'),
  };
}

/** Firebase's built-in providers → Atlas built-in provider keys. */
const SOCIAL: Record<string, string> = {
  'google.com': 'google',
  'facebook.com': 'facebook',
  'twitter.com': 'x',
  'github.com': 'github',
  'apple.com': 'apple',
  'microsoft.com': 'microsoft',
  'linkedin.com': 'linkedin',
  'yahoo.com': 'yahoo',
};

const node = (o: Obj, ...path: string[]): Obj => {
  let cur: unknown = o;
  for (const k of path) cur = isObj(cur) ? cur[k] : undefined;
  return isObj(cur) ? cur : {};
};
const lastName = (name: unknown) => str(name)?.split('/').pop();

export function translateFirebaseConfig(snap: FirebaseConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const c = snap.config;
  const signIn = node(c, 'signIn');

  // ── sign-in methods ──
  const email = node(signIn, 'email');
  const emailOn = email.enabled === true;
  const passwordRequired = email.passwordRequired !== false;
  b.set('strategies.password', emailOn && passwordRequired);
  b.add('mapped', 'sign-in method', 'signIn.email.enabled', emailOn ? 'Email / password sign-in on.' : 'Email / password sign-in off.', 'auth_config.strategies.password');
  if (emailOn) {
    // passwordRequired=false is "Email link (passwordless sign-in)".
    b.set('strategies.emailLink', !passwordRequired);
    b.add('mapped', 'sign-in method', 'signIn.email.passwordRequired', passwordRequired ? 'Passwords are required (no email-link sign-in).' : 'Email-link (passwordless) sign-in on.', 'auth_config.strategies.emailLink');
  }
  const phone = node(signIn, 'phoneNumber');
  b.set('strategies.phoneCode', phone.enabled === true);
  b.add('mapped', 'sign-in method', 'signIn.phoneNumber.enabled', phone.enabled === true ? 'SMS code sign-in on. Configure your SMS provider in Atlas.' : 'Phone sign-in off.', 'auth_config.strategies.phoneCode');
  const testNumbers = Object.keys(node(phone, 'testPhoneNumbers'));
  if (testNumbers.length) b.add('manual', 'sign-in method', 'signIn.phoneNumber.testPhoneNumbers', `${testNumbers.length} fictional test number(s): use Atlas development instances' test numbers instead (codes are not copied).`);
  const anon = node(signIn, 'anonymous').enabled === true;
  b.set('strategies.anonymous', anon);
  b.add('mapped', 'sign-in method', 'signIn.anonymous.enabled', anon ? 'Guest (anonymous) sign-in on.' : 'Anonymous sign-in off.', 'auth_config.strategies.anonymous');
  if (signIn.allowDuplicateEmails === true) {
    b.add('differs', 'user account linking', 'signIn.allowDuplicateEmails', 'Firebase allowed one account per provider for the same email; Atlas keeps one user per email and links providers to it. Duplicate accounts are reported as conflicts at import.', 'auth_config');
  }
  if (isObj(signIn.hashConfig)) {
    b.add('mapped', 'password hash parameters', 'signIn.hashConfig', 'The export carries these parameters with every password hash; Atlas verifies Firebase scrypt hashes and re-hashes each password on its first sign-in.');
  }

  // ── social, OIDC and SAML providers ──
  for (const idp of snap.defaultIdps) {
    const id = lastName(idp.name);
    if (!id) continue;
    const key = SOCIAL[id];
    if (!key) {
      b.add('manual', 'sign-in method', `defaultSupportedIdpConfigs/${id}`, `"${id}" has no Atlas built-in provider: add it as a custom OAuth provider, or let those users sign in with email.`, 'custom_oauth_providers');
      continue;
    }
    b.socialProvider({ atlasKey: key, vendorName: id, area: 'sign-in method', setting: `defaultSupportedIdpConfigs/${id}`, clientId: str(idp.clientId), enabled: idp.enabled === true });
    if (id === 'apple.com' && isObj(idp.appleSignInConfig)) {
      b.add('manual', 'sign-in method', `defaultSupportedIdpConfigs/apple.com.appleSignInConfig`, 'Sign in with Apple: add your Services ID, team id, key id and private key on the Atlas apple provider (and native bundle ids under auth_config.nativeApps).', 'oauth_providers apple');
    }
  }
  for (const idp of snap.oidcIdps) {
    const id = lastName(idp.name);
    if (!id) continue;
    const providerKey = id.replace(/^oidc\./, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'oidc';
    const upper = providerKey.toUpperCase();
    const issuer = str(idp.issuer);
    const doc: Record<string, Json> = {
      provider_key: providerKey,
      display_name: str(idp.displayName) ?? id,
      protocol: 'oidc',
      client_id: str(idp.clientId) ?? b.placeholder(`${upper}_CLIENT_ID`, `${id} client id`),
      client_secret: b.placeholder(`${upper}_CLIENT_SECRET`, `${id} client secret`),
      enabled: idp.enabled === true,
      allow_sign_in: true,
      allow_sign_up: true,
    };
    if (issuer) {
      doc.issuer = issuer;
      doc.discovery_url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    }
    const rt = node(idp, 'responseType');
    if (rt.code === true) doc.token_endpoint_auth_method = 'client_secret_post';
    b.push('custom_oauth_providers', doc);
    b.providers[id] = providerKey;
    b.add(
      rt.idToken === true && rt.code !== true ? 'differs' : 'mapped',
      'sign-in method',
      `oauthIdpConfigs/${id}`,
      `OIDC provider "${id}" becomes the custom OIDC provider "${providerKey}"${rt.idToken === true && rt.code !== true ? ' (Firebase used the implicit id_token flow; Atlas uses the code flow, so the client needs a secret)' : ''}. Add Atlas's redirect URI to the IdP and set ${upper}_CLIENT_SECRET. Imported identities keep provider "${id}"; map it with provider_map ${id}=${providerKey}.`,
      `custom_oauth_providers ${providerKey}`,
    );
  }
  for (const idp of snap.samlIdps) {
    const id = lastName(idp.name);
    if (!id) continue;
    b.add('mapped', 'sign-in method', `inboundSamlConfigs/${id}`, `SAML provider "${str(idp.displayName) ?? id}" moves with the data export as an SSO connection. Give the IdP Atlas's ACS URL and entity id before turning it on.`, 'sso_connections');
  }

  // ── MFA ──
  const mfa = node(c, 'mfa');
  const state = str(mfa.state);
  if (state === 'ENABLED' || state === 'MANDATORY') {
    b.set('mfaPolicy', state === 'MANDATORY' ? 'required' : 'optional');
    b.add('mapped', 'multi-factor', 'mfa.state', state === 'MANDATORY' ? 'MFA required.' : 'MFA optional.', 'auth_config.mfaPolicy');
    const sms = strs(mfa.enabledProviders).includes('PHONE_SMS');
    b.set('mfa.factors.sms', sms);
    b.add('mapped', 'multi-factor', 'mfa.enabledProviders', sms ? 'SMS second factor on; enrolled phone numbers are imported.' : 'No SMS second factor.', 'auth_config.mfa.factors.sms');
    const totp = objs(mfa.providerConfigs).find((p) => isObj(p.totpProviderConfig));
    if (totp) {
      b.set('mfa.factors.totp', str(totp.state) === 'ENABLED');
      b.add('differs', 'multi-factor', 'mfa.providerConfigs.totpProviderConfig', 'Authenticator-app second factor on. Firebase never exports TOTP secrets: enrolled users enrol again in Atlas.', 'auth_config.mfa.factors.totp');
      const adjacent = node(totp, 'totpProviderConfig').adjacentIntervals;
      if (typeof adjacent === 'number') b.add('differs', 'multi-factor', 'mfa.providerConfigs.totpProviderConfig.adjacentIntervals', `Firebase accepted ±${adjacent} adjacent interval(s); Atlas accepts ±1.`);
    }
  } else {
    b.add('mapped', 'multi-factor', 'mfa.state', 'MFA off.', 'auth_config.mfaPolicy');
  }

  // ── password policy ──
  const pp = node(c, 'passwordPolicyConfig');
  const enforce = str(pp.passwordPolicyEnforcementState);
  const version = objs(pp.passwordPolicyVersions)[0];
  const strength = version ? node(version, 'customStrengthOptions') : {};
  if (enforce === 'ENFORCE' || enforce === 'NOT_ENFORCE') {
    if (typeof strength.minPasswordLength === 'number') b.set('passwordPolicy.minLength', Math.max(strength.minPasswordLength, 6));
    if (typeof strength.maxPasswordLength === 'number') b.set('passwordPolicy.maxLength', Math.min(strength.maxPasswordLength, 4096));
    for (const [fb, atlas] of [
      ['containsUppercaseCharacter', 'requireUppercase'],
      ['containsLowercaseCharacter', 'requireLowercase'],
      ['containsNumericCharacter', 'requireNumber'],
      ['containsNonAlphanumericCharacter', 'requireSymbol'],
    ] as const) {
      if (typeof strength[fb] === 'boolean') b.set(`passwordPolicy.${atlas}`, strength[fb] as boolean);
    }
    b.add(enforce === 'ENFORCE' ? 'mapped' : 'differs', 'password policy', 'passwordPolicyConfig', enforce === 'ENFORCE' ? 'Password requirements enforced at sign-up and password change.' : 'Firebase only reported (NOT_ENFORCE) violations; Atlas enforces its policy.', 'auth_config.passwordPolicy');
    if (pp.forceUpgradeOnSignin === true) b.add('differs', 'password policy', 'passwordPolicyConfig.forceUpgradeOnSignin', 'Atlas does not force a password change at sign-in for an old password that misses the policy; it applies on the next change.');
  } else {
    b.add('differs', 'password policy', 'passwordPolicyConfig', 'No Firebase policy (6 characters minimum). Atlas defaults to 8 and checks breached passwords; imported passwords keep working.', 'auth_config.passwordPolicy');
  }

  // ── domains, blocking functions and the rest ──
  const domains = strs(c.authorizedDomains);
  const origins = domains.filter((d) => !/\.(firebaseapp\.com|web\.app)$/.test(d)).map((d) => (d === 'localhost' || d.startsWith('127.') ? `http://${d}` : `https://${d}`));
  if (origins.length) {
    b.instance.allowed_origins = origins;
    b.add('differs', 'authorized domains', 'authorizedDomains', `Firebase authorized domains become allowed origins (${origins.length}); the *.firebaseapp.com / *.web.app hosting domains are dropped — add them if you keep hosting there.`, 'instance.allowed_origins');
  }
  const triggers = Object.keys(node(c, 'blockingFunctions', 'triggers'));
  for (const t of triggers) {
    const what = t === 'beforeCreate' ? 'a before-sign-up action (or a user.created webhook)' : t === 'beforeSignIn' ? 'a before-sign-in action (custom claims become a JWT template)' : 'Atlas email / SMS templates and your own delivery provider';
    b.add('manual', 'blocking functions', `blockingFunctions.triggers.${t}`, `Move this Cloud Function to ${what}.`);
  }
  if (node(c, 'emailPrivacyConfig').enableImprovedEmailPrivacy === true) b.add('mapped', 'user actions', 'emailPrivacyConfig.enableImprovedEmailPrivacy', 'Atlas never reveals whether an email has an account.');
  if (isObj(c.autodeleteAnonymousUsers) || c.autodeleteAnonymousUsers === true) b.add('manual', 'user actions', 'autodeleteAnonymousUsers', 'Clean up stale guest users with a scheduled call to the Atlas Backend API.');
  if (isObj(c.recaptchaConfig) && Object.keys(c.recaptchaConfig).length) b.add('differs', 'fraud prevention', 'recaptchaConfig', 'Atlas has its own bot protection (turn it on under Attack protection); reCAPTCHA keys are not used.', 'auth_config');
  if (isObj(c.smsRegionConfig) && Object.keys(c.smsRegionConfig).length) b.add('manual', 'fraud prevention', 'smsRegionConfig', 'Restrict SMS countries in Atlas under SMS settings.');
  if (isObj(c.quota) && Object.keys(c.quota).length) b.add('differs', 'quota', 'quota.signUpQuotaConfig', 'Atlas applies its own sign-up rate limits per IP.');
  const sendEmail = node(c, 'notification', 'sendEmail');
  if (Object.keys(sendEmail).length) b.add('manual', 'templates', 'notification.sendEmail', 'Recreate customised email templates (and the action URL / custom SMTP) in Atlas; template bodies are not copied.');
  if (node(c, 'multiTenant').allowTenants === true || snap.tenants.length) {
    b.add('manual', 'multi-tenancy', 'multiTenant.allowTenants', `${snap.tenants.length} Identity Platform tenant(s). Export each into its own Atlas instance (tenant=<id>), or all of them as organizations of one instance (tenant=all). Each tenant's own providers and MFA settings are not translated here.`);
  }
  b.add('mapped', 'sessions', 'ID token / refresh token', 'Firebase ID tokens live one hour with long-lived refresh tokens; Atlas keeps its own session lifetime (auth_config.session). The firebase bridge preset exchanges a Firebase ID token for an Atlas session.', 'auth_config.session');

  return b.result(`firebase project ${snap.projectId}`, {
    bridge: { preset: 'firebase', vars: { project_id: snap.projectId } },
  });
}
