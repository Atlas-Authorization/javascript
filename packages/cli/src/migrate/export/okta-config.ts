import type { TranslationResult } from '../framework/plugin';
import type { Json } from '../../serialize';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, clampSessionMs, keyOf, socialKey } from './translate-kit';
import { VendorApiError, VendorHttp, nextLink } from './vendor-http';

/**
 * `atlas migrate okta config` — an Okta org's policies and integrations →
 * Atlas config, read with an API token on this machine: password policies,
 * global session policy (lifetimes), authenticator enrollment (which second
 * factors), social identity providers, custom authorization servers (APIs and
 * scopes), OIDC apps (redirect URIs) and groups (roles). Sign-on rules beyond
 * MFA, network zones, hooks and the sign-in widget are reported as manual.
 */
export interface OktaConfigSnapshot {
  domain: string;
  passwordPolicies: Obj[];
  signOnPolicies: Array<Obj & { rules?: Obj[] }>;
  authenticators: Obj[];
  idps: Obj[];
  authorizationServers: Array<Obj & { scopes?: Obj[] }>;
  apps: Obj[];
  groups: Obj[];
  inlineHooks: Obj[];
}

export async function fetchOktaConfig(http: VendorHttp, domain: string): Promise<OktaConfigSnapshot> {
  const all = async (path: string): Promise<Obj[]> => {
    const out: Obj[] = [];
    let next: string | null = path;
    try {
      while (next) {
        const res: { body: unknown; headers: Headers } = await http.get<unknown>(next);
        out.push(...objs(res.body));
        next = nextLink(res.headers.get('link'));
      }
    } catch (err) {
      if (err instanceof VendorApiError && [403, 404].includes(err.status)) return out;
      throw err;
    }
    return out;
  };
  const signOn = (await all('/policies?type=OKTA_SIGN_ON')) as OktaConfigSnapshot['signOnPolicies'];
  for (const p of signOn) p.rules = await all(`/policies/${str(p.id)}/rules`);
  const servers = (await all('/authorizationServers')) as OktaConfigSnapshot['authorizationServers'];
  for (const s of servers) s.scopes = await all(`/authorizationServers/${str(s.id)}/scopes`);
  return {
    domain,
    passwordPolicies: await all('/policies?type=PASSWORD'),
    signOnPolicies: signOn,
    authenticators: await all('/authenticators'),
    idps: await all('/idps'),
    authorizationServers: servers,
    apps: await all('/apps?limit=200&filter=status%20eq%20%22ACTIVE%22'),
    groups: (await all('/groups?limit=200')).filter((g) => str(g.type) !== 'BUILT_IN'),
    inlineHooks: await all('/inlineHooks'),
  };
}

export function translateOktaConfig(snap: OktaConfigSnapshot, opts: { groupsAs?: 'roles' | 'organizations' | 'skip' } = {}): TranslationResult {
  const b = new ConfigBuilder();
  b.set('strategies.password', true);
  b.add('differs', 'authentication', 'password', 'Password sign-in. Okta never exports password hashes: the okta lazy-migration preset checks each password against Okta on first sign-in.', 'auth_config.strategies.password');

  // ── password policy: the default (lowest priority) policy is the org baseline ──
  const pwPolicy = [...snap.passwordPolicies].sort((a, c) => Number(c.priority ?? 0) - Number(a.priority ?? 0))[0];
  if (pwPolicy) {
    const name = str(pwPolicy.name) ?? 'password policy';
    const settings = isObj(pwPolicy.settings) && isObj(pwPolicy.settings.password) ? pwPolicy.settings.password : {};
    const complexity = isObj(settings.complexity) ? settings.complexity : {};
    const min = typeof complexity.minLength === 'number' ? complexity.minLength : 8;
    b.set('passwordPolicy.minLength', Math.max(8, min));
    b.add(min < 8 ? 'differs' : 'mapped', `policies ${name}`, 'settings.password.complexity.minLength', `${min}${min < 8 ? ' (Atlas requires at least 8; existing passwords still sign in)' : ''}.`, 'auth_config.passwordPolicy.minLength');
    if (['minLowerCase', 'minUpperCase', 'minNumber', 'minSymbol'].some((k) => Number(complexity[k] ?? 0) > 0)) {
      b.add('differs', `policies ${name}`, 'settings.password.complexity (character classes)', 'Atlas follows NIST 800-63B: length and breached-password checks, no character-class rules.', 'auth_config.passwordPolicy');
    }
    if (isObj(complexity.dictionary) && isObj(complexity.dictionary.common) && complexity.dictionary.common.exclude === true) {
      b.set('passwordPolicy.checkBreaches', true);
      b.add('mapped', `policies ${name}`, 'settings.password.complexity.dictionary.common.exclude', 'Common / breached passwords are refused.', 'auth_config.passwordPolicy.checkBreaches');
    }
    const age = isObj(settings.age) ? settings.age : {};
    if (Number(age.maxAgeDays ?? 0) > 0) b.add('manual', `policies ${name}`, 'settings.password.age.maxAgeDays', 'Atlas does not expire passwords (NIST 800-63B).');
    if (Number(age.historyCount ?? 0) > 0) b.add('manual', `policies ${name}`, 'settings.password.age.historyCount', 'Atlas does not keep a password history.');
    const lockout = isObj(settings.lockout) ? settings.lockout : {};
    if (Number(lockout.maxAttempts ?? 0) > 0) b.add('mapped', `policies ${name}`, 'settings.password.lockout.maxAttempts', `Okta locks after ${lockout.maxAttempts} attempts; Atlas throttles failed sign-ins per account and IP.`, 'auth_config.rateLimit');
  }
  if (snap.passwordPolicies.length > 1) b.add('differs', 'policies', 'password policies', `${snap.passwordPolicies.length} password policies by group: Atlas has one instance-wide policy (the default one was used).`, 'auth_config.passwordPolicy');

  // ── global session policy ──
  const defaultSignOn = snap.signOnPolicies.find((p) => p.system === true) ?? snap.signOnPolicies[snap.signOnPolicies.length - 1];
  const rule = (defaultSignOn?.rules ?? []).find((r) => r.system !== true && str(r.status) === 'ACTIVE') ?? defaultSignOn?.rules?.[0];
  const session = rule && isObj(rule.actions) && isObj(rule.actions.signon) && isObj(rule.actions.signon.session) ? rule.actions.signon.session : undefined;
  if (session) {
    const area = `policies ${str(defaultSignOn?.name) ?? 'global session'}`;
    const life = Number(session.maxSessionLifetimeMinutes ?? 0);
    const idle = Number(session.maxSessionIdleMinutes ?? 0);
    if (life > 0) {
      b.set('session.absoluteMs', clampSessionMs(life * 60_000));
      b.add('mapped', area, 'actions.signon.session.maxSessionLifetimeMinutes', `${life} minutes.`, 'auth_config.session.absoluteMs');
    }
    if (idle > 0) {
      b.set('session.idleMs', clampSessionMs(idle * 60_000));
      b.add('mapped', area, 'actions.signon.session.maxSessionIdleMinutes', `${idle} minutes idle.`, 'auth_config.session.idleMs');
    }
    if (rule && isObj(rule.actions) && isObj(rule.actions.signon) && rule.actions.signon.requireFactor === true) {
      b.set('mfaPolicy', 'required');
      b.add('mapped', area, 'actions.signon.requireFactor', 'A second factor on every sign-in.', 'auth_config.mfaPolicy');
    }
  }
  if (snap.signOnPolicies.length > 1) b.add('manual', 'policies', 'sign-on policies by group / network zone', 'Okta applies different sign-on rules per group and network zone; Atlas has instance-wide session settings plus step-up. Review the per-group rules by hand.', 'auth_config.stepUp');

  // ── authenticators ──
  for (const a of snap.authenticators) {
    if (str(a.status) !== 'ACTIVE') continue;
    const key = str(a.key);
    const name = str(a.name) ?? key ?? '?';
    if (key === 'google_otp' || key === 'okta_verify') {
      b.set('mfa.factors.totp', true);
      b.add(key === 'okta_verify' ? 'differs' : 'mapped', 'authenticators', `${name} (${key})`, key === 'okta_verify' ? 'Okta Verify push / number challenge has no Atlas counterpart; its TOTP mode maps to authenticator apps (seeds do not move: users re-enrol).' : 'Authenticator apps (users re-enrol: Okta does not export seeds).', 'auth_config.mfa.factors.totp');
    } else if (key === 'webauthn') {
      b.set('mfa.factors.passkey', true);
      b.set('strategies.passkey', true);
      b.add('differs', 'authenticators', `${name} (webauthn)`, 'Security keys and biometrics. Okta does not export WebAuthn credentials: users register again.', 'auth_config.mfa.factors.passkey');
    } else if (key === 'okta_email') {
      b.set('mfa.factors.emailCode', true);
      b.add('mapped', 'authenticators', `${name} (okta_email)`, 'Email code.', 'auth_config.mfa.factors.emailCode');
    } else if (key === 'phone_number') {
      b.add('differs', 'authenticators', `${name} (phone_number)`, 'SMS / voice: phone factors move with --factors; Atlas recommends TOTP or passkeys as the second factor.', 'auth_config.mfa');
    } else if (key && key !== 'okta_password') {
      b.add('manual', 'authenticators', `${name} (${key})`, 'No Atlas counterpart (security question, Duo, RSA, YubiKey OTP, smart card…): those users enrol an Atlas factor.');
    }
  }

  // ── social identity providers ──
  for (const idp of snap.idps) {
    if (str(idp.status) === 'INACTIVE') continue;
    const type = str(idp.type) ?? '';
    const name = str(idp.name) ?? type;
    if (type === 'SAML2' || type === 'OIDC') {
      b.add('mapped', 'identity providers', `${name} (${type})`, 'Enterprise IdP: moves with the data export as an Atlas SSO connection; update the IdP with Atlas\'s ACS URL / redirect URI, and replace Okta routing rules with the connection\'s domains.', 'sso_connections');
      continue;
    }
    const key = socialKey(type);
    if (!key) {
      b.add('manual', 'identity providers', `${name} (${type})`, 'No built-in Atlas provider: add it as a custom OAuth provider.', 'custom_oauth_providers');
      continue;
    }
    const protocol = isObj(idp.protocol) ? idp.protocol : {};
    const client = isObj(protocol.credentials) && isObj(protocol.credentials.client) ? protocol.credentials.client : {};
    b.socialProvider({ atlasKey: key, vendorName: name, area: 'identity providers', setting: `${name} (${type})`, clientId: str(client.client_id), scopes: strs(protocol.scopes) });
  }

  // ── authorization servers → APIs ──
  for (const s of snap.authorizationServers) {
    if (str(s.status) === 'INACTIVE') continue;
    const audiences = strs(s.audiences);
    const scopes = (s.scopes ?? []).filter((sc) => sc.system !== true).map((sc) => str(sc.name)).filter((sc): sc is string => !!sc);
    for (const aud of audiences) {
      b.push('resource_servers', { identifier: aud, name: str(s.name) ?? aud, scopes } as Json);
      b.add('mapped', `authorization servers ${str(s.name) ?? str(s.id)}`, `audiences ${aud}`, `An API with ${scopes.length} custom scope(s); Atlas access tokens for it keep "aud": "${aud}".`, `resource_servers ${aud}`);
    }
    if (objs(s.claims).length) b.add('manual', `authorization servers ${str(s.name) ?? str(s.id)}`, 'claims', 'Custom token claims: recreate them as an Atlas JWT template / session claims.', 'jwt_templates');
  }

  // ── OIDC apps → redirect URLs ──
  const redirects = new Set<string>();
  for (const app of snap.apps) {
    const oauth = isObj(app.settings) && isObj(app.settings.oauthClient) ? app.settings.oauthClient : undefined;
    if (!oauth) continue;
    for (const u of strs(oauth.redirect_uris)) redirects.add(u);
    const grants = strs(oauth.grant_types);
    if (grants.includes('client_credentials')) b.add('manual', `apps ${str(app.label) ?? str(app.name)}`, 'grant_types client_credentials', 'A service app: create an Atlas M2M client for it.', 'oauth_clients');
  }
  let exact = 0;
  for (const url of redirects) {
    if (url.includes('*')) {
      b.add('differs', 'apps', `redirect_uris ${url}`, 'Atlas redirect URLs are exact (no wildcards).', 'redirect_urls');
      continue;
    }
    b.push('redirect_urls', { url });
    exact++;
  }
  if (exact) b.add('mapped', 'apps', 'redirect_uris', `${exact} redirect URI(s).`, 'redirect_urls');

  // ── groups ──
  const groupsAs = opts.groupsAs ?? 'roles';
  if (groupsAs === 'roles') {
    for (const g of snap.groups) {
      const name = str(isObj(g.profile) ? g.profile.name : undefined);
      if (!name) continue;
      const key = keyOf(name);
      b.roles[name] = key;
      b.push('roles', { key, name, description: str(isObj(g.profile) ? g.profile.description : undefined) ?? '', permissions: [] } as Json);
    }
    if (snap.groups.length) b.add('differs', 'groups', 'groups', `${snap.groups.length} group(s) become Atlas app roles (memberships move with the data export). Group rules and app assignments are not translated.`, 'roles');
  } else if (groupsAs === 'organizations' && snap.groups.length) {
    b.add('differs', 'groups', 'groups', 'Groups become organizations with the data export (--groups-as organizations).', 'organizations');
  }

  for (const h of snap.inlineHooks) {
    if (str(h.status) === 'ACTIVE') b.add('manual', 'inline hooks', `${str(h.name) ?? '?'} (${str(h.type) ?? '?'})`, 'Okta inline hook: port it to an Atlas action or webhook.', 'actions');
  }

  return b.result(`Okta org ${snap.domain}`, {
    bridge: { preset: 'okta', vars: { domain: snap.domain } },
    lazy: { preset: 'okta', config: { domain: snap.domain } },
  });
}
