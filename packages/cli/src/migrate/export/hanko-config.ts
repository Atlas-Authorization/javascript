import type { TranslationResult } from '../framework/plugin';
import { parseYaml, type YamlDoc } from './mini-yaml';
import { isObj, objs, str, strs } from './record-set';
import { ConfigBuilder, clampSessionMs, socialKey } from './translate-kit';
import type { Json } from '../../serialize';

/**
 * `atlas migrate hanko config` — a self-hosted Hanko's `config.yaml` → Atlas
 * config, every report line carrying file:line. (Hanko Cloud keeps its settings
 * in the console: there is no file or API to read, so the guide lists the
 * settings to copy by hand.) Secrets (`secrets.keys`, `third_party.providers.*.secret`,
 * SMTP and database credentials) are never read into the output: a client
 * secret becomes a `${NAME}` placeholder.
 */

export interface HankoSetting {
  value: unknown;
  /** The config.yaml path (`password.min_length`). */
  setting: string;
  file?: string;
  line?: number;
}

export interface HankoSettings {
  origin: string;
  values: Map<string, HankoSetting>;
  /** The public API URL, when the operator gave it (bridge and lazy variables). */
  apiUrl?: string;
}

/** Go durations (`12h`, `1h30m`, `90s`) → ms; a bare number is seconds. */
export function goDurationMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 0 ? v * 1000 : undefined;
  const s = str(v);
  if (!s) return undefined;
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  let total = 0;
  let matched = '';
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    matched += m[0];
    total += Number(m[1]) * units[m[2]!]!;
  }
  return matched === s && total > 0 ? total : undefined;
}

/** Read config.yaml: every scalar and list under its dotted path, with its line. */
export function settingsFromYaml(text: string, file: string, apiUrl?: string): HankoSettings {
  const doc: YamlDoc = parseYaml(text);
  const values = new Map<string, HankoSetting>();
  const walk = (node: unknown, path: string) => {
    if (isObj(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    // Secrets (`secrets.keys`, client secrets, SMTP and database credentials) are not even kept in memory.
    if (/^database\.|\.secret$|\.smtp\.(password|user)$/.test(path)) return;
    if (/^secrets\./.test(path)) {
      values.set(path, { value: '(not read)', setting: path, file, line: doc.line(path) });
      return;
    }
    values.set(path, { value: node, setting: path, file, line: doc.line(path) });
  };
  walk(doc.value, '');
  values.delete('');
  return { origin: `Hanko config ${file}`, values, apiUrl };
}

export function translateHankoConfig(s: HankoSettings): TranslationResult {
  const b = new ConfigBuilder();
  const has = (p: string) => s.values.has(p);
  const val = (p: string) => s.values.get(p)?.value;
  const add = (status: 'mapped' | 'differs' | 'manual', area: string, path: string, note: string, atlas?: string) => {
    const v = s.values.get(path);
    b.report.push({ status, area, setting: path, note, ...(atlas ? { atlas } : {}), ...(v?.file ? { file: v.file, line: v.line } : {}) });
  };
  /** Report a path that holds a list (the line of its first item is the list's own). */
  const lineOfList = (path: string): { file?: string; line?: number } => {
    const v = s.values.get(path);
    return v?.file ? { file: v.file, line: v.line } : {};
  };

  // ── sessions ──
  const life = goDurationMs(val('session.lifespan'));
  if (life) {
    b.set('session.absoluteMs', clampSessionMs(life));
    add(clampSessionMs(life) === life ? 'mapped' : 'differs', 'sessions', 'session.lifespan', 'The session JWT lifetime becomes the absolute session lifetime; Atlas refreshes short-lived tokens inside it.', 'auth_config.session.absoluteMs');
  }
  if (has('session.cookie.name') && val('session.cookie.name') !== 'hanko') add('differs', 'sessions', 'session.cookie.name', `Your session cookie is "${String(val('session.cookie.name'))}": the Hanko bridge preset reads "hanko", so pass the cookie name to the middleware when you add it.`);
  if (has('session.cookie.domain') || has('session.cookie.same_site')) add('differs', 'sessions', has('session.cookie.domain') ? 'session.cookie.domain' : 'session.cookie.same_site', 'Atlas manages its own session cookie (cross-subdomain by default); set the cookie domain in the Atlas custom-domain settings if you need a specific one.');
  if (has('session.audience')) add('differs', 'sessions', 'session.audience', 'Atlas session tokens carry their own audience; read it from the instance when your API checks it.');
  if (has('session.enable_auth_token_header') && val('session.enable_auth_token_header') === false) add('differs', 'sessions', 'session.enable_auth_token_header', 'Atlas SDKs send the session token as a bearer header or cookie as configured per app.');

  // ── password, email, username ──
  if (has('password.enabled')) {
    const on = val('password.enabled') === true;
    b.set('strategies.password', on);
    add('mapped', 'passwords', 'password.enabled', on ? 'Password sign-in on.' : 'Password sign-in off.', 'auth_config.strategies.password');
  }
  const minLen = val('password.min_length');
  if (typeof minLen === 'number') {
    b.set('passwordPolicy.minLength', Math.max(minLen, 6));
    add(minLen >= 6 ? 'mapped' : 'differs', 'passwords', 'password.min_length', minLen >= 6 ? `Minimum ${minLen} characters.` : `Hanko allowed ${minLen}; Atlas requires at least 6.`, 'auth_config.passwordPolicy.minLength');
  }
  for (const p of ['password.optional', 'password.acquire_on_registration', 'password.acquire_on_login']) {
    if (has(p)) add('differs', 'passwords', p, 'When a password is asked for is decided by the sign-up and sign-in methods enabled in Atlas, not by acquire/optional rules.');
  }
  if (has('passcode.email.enabled') || has('email.enabled')) {
    const on = val('passcode.email.enabled') !== false && val('email.enabled') !== false;
    b.set('strategies.emailCode', on);
    add('mapped', 'email', has('passcode.email.enabled') ? 'passcode.email.enabled' : 'email.enabled', on ? 'Email one-time-code sign-in (Hanko passcodes) on.' : 'Email code sign-in off.', 'auth_config.strategies.emailCode');
  }
  if (has('email.require_verification')) {
    const on = val('email.require_verification') === true;
    b.set('requireEmailVerification', on);
    add('mapped', 'email', 'email.require_verification', on ? 'Email addresses are verified before sign-in.' : 'Email verification not required.', 'auth_config.requireEmailVerification');
  }
  if (has('email.can_login_with_unverified') && val('email.can_login_with_unverified') === true) add('differs', 'email', 'email.can_login_with_unverified', 'Users with an unverified address could sign in; Atlas lets them in only when email verification is not required.');
  if (has('username.enabled') && val('username.enabled') === true) add('manual', 'username', 'username.enabled', `Usernames: add the username field to the Atlas sign-up and sign-in identifiers${typeof val('username.min_length') === 'number' ? ` (Hanko minimum ${String(val('username.min_length'))} characters)` : ''}.`);
  if (has('passcode.ttl')) add('differs', 'email', 'passcode.ttl', 'Atlas uses its own code lifetime.');
  if (has('passcode.smtp.host') || has('smtp.host')) add('manual', 'email', has('passcode.smtp.host') ? 'passcode.smtp.host' : 'smtp.host', 'Connect your own email provider in Atlas (SMTP credentials are not copied) and recreate the email templates.');
  if (has('service.name')) add('manual', 'branding', 'service.name', `Service name "${String(val('service.name'))}" appears in emails and passkey prompts: set it in Atlas branding.`);

  // ── passkeys and security keys ──
  if (has('passkey.enabled')) {
    const on = val('passkey.enabled') === true;
    b.set('strategies.passkey', on);
    add('mapped', 'passkeys', 'passkey.enabled', on ? 'Passkey sign-in on.' : 'Passkey sign-in off.', 'auth_config.strategies.passkey');
  }
  for (const p of ['passkey.user_verification', 'passkey.attestation_preference', 'passkey.limit']) {
    if (has(p)) add('differs', 'passkeys', p, 'Atlas applies its own WebAuthn ceremony settings.');
  }
  const rp = str(val('webauthn.relying_party.id'));
  if (rp) add('differs', 'passkeys', 'webauthn.relying_party.id', `Passkeys were registered for "${rp}": they keep working only when Atlas serves sign-in on that domain (export with --set hanko-rp-id=${rp}).`);

  // ── multi-factor ──
  if (has('mfa.totp.enabled')) {
    const on = val('mfa.totp.enabled') === true;
    b.set('mfa.factors.totp', on);
    add('mapped', 'multi-factor', 'mfa.totp.enabled', `Authenticator-app second factor ${on ? 'on' : 'off'}.${on ? ' Secrets move with the database export (the Admin API never returns them).' : ''}`, 'auth_config.mfa.factors.totp');
  }
  if (has('mfa.security_keys.enabled')) {
    const on = val('mfa.security_keys.enabled') === true;
    b.set('mfa.factors.passkey', on);
    add('mapped', 'multi-factor', 'mfa.security_keys.enabled', `Security-key second factor ${on ? 'on' : 'off'}.`, 'auth_config.mfa.factors.passkey');
  }
  for (const p of ['mfa.optional', 'mfa.acquire_on_registration', 'mfa.acquire_on_login']) {
    if (has(p)) add('differs', 'multi-factor', p, 'Whether a second factor is required is the Atlas MFA policy ("require a second factor"); enrolment prompts are not configured per flow.');
  }

  // ── origins and redirect URLs ──
  const origins = new Set<string>();
  for (const p of ['server.public.cors.allow_origins', 'webauthn.relying_party.origins']) {
    const list = Array.isArray(val(p)) ? strs(val(p)) : [];
    for (const o of list) {
      if (o.includes('*')) add('differs', 'origins', p, `Atlas allowed origins are exact: list each origin ${o} covered.`);
      else origins.add(o);
    }
  }
  if (origins.size) {
    b.instance.allowed_origins = [...origins];
    add('mapped', 'origins', has('server.public.cors.allow_origins') ? 'server.public.cors.allow_origins' : 'webauthn.relying_party.origins', `${origins.size} origin(s) for the browser SDK.`, 'instance.allowed_origins');
  }
  const urls = new Set<string>();
  let wildcard = false;
  for (const p of ['third_party.allowed_redirect_urls', 'saml.allowed_redirect_urls']) {
    for (const u of Array.isArray(val(p)) ? strs(val(p)) : []) {
      if (u.includes('*')) wildcard = true;
      else urls.add(u);
    }
  }
  for (const p of ['third_party.default_redirect_url', 'third_party.error_redirect_url', 'saml.default_redirect_url']) {
    const u = str(val(p));
    if (u && !u.includes('*')) urls.add(u);
  }
  for (const u of urls) b.push('redirect_urls', { url: u });
  if (urls.size || wildcard) {
    const p = has('third_party.allowed_redirect_urls') ? 'third_party.allowed_redirect_urls' : 'third_party.default_redirect_url';
    add(wildcard ? 'differs' : 'mapped', 'redirect URLs', p, `${urls.size} redirect URL(s)${wildcard ? '; wildcard entries are not translated (Atlas redirect URLs are exact: list each one)' : ''}.`, 'redirect_urls');
  }

  // ── third-party providers ──
  const names = new Set<string>();
  for (const path of s.values.keys()) {
    const m = /^third_party\.providers\.([A-Za-z0-9_]+)\./.exec(path);
    if (m) names.add(m[1]!);
  }
  for (const name of [...names].sort()) {
    const base = `third_party.providers.${name}`;
    if (val(`${base}.enabled`) !== true) continue;
    const rawId = str(val(`${base}.client_id`));
    const clientId = rawId && !/^\$\{|^env:/i.test(rawId) ? rawId : undefined;
    const custom = name.startsWith('custom_');
    if (!custom) {
      const key = socialKey(name);
      if (!key) {
        add('manual', 'providers', `${base}.enabled`, `"${name}" is not a built-in Atlas provider: add it as a custom OAuth provider.`, 'custom_oauth_providers');
        continue;
      }
      b.socialProvider({ atlasKey: key, vendorName: name, area: 'providers', setting: `${base}.enabled`, clientId, allowSignUp: val(`${base}.allow_signup`) !== false });
      const last = b.report[b.report.length - 1]!;
      Object.assign(last, lineOfList(`${base}.enabled`));
      continue;
    }
    const providerKey = name.slice('custom_'.length).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'oidc';
    const upper = providerKey.toUpperCase();
    const doc: Record<string, Json> = {
      provider_key: providerKey,
      display_name: str(val(`${base}.display_name`)) ?? providerKey,
      protocol: 'oidc',
      client_id: clientId ?? b.placeholder(`${upper}_CLIENT_ID`, `${providerKey} client id`),
      client_secret: b.placeholder(`${upper}_CLIENT_SECRET`, `${providerKey} client secret`),
      enabled: true,
      allow_sign_in: true,
      allow_sign_up: val(`${base}.allow_signup`) !== false,
    };
    const discovery = str(val(`${base}.discovery_endpoint`));
    if (discovery) doc.discovery_url = discovery;
    const scopes = Array.isArray(val(`${base}.scopes`)) ? strs(val(`${base}.scopes`)) : [];
    if (scopes.length) doc.scopes = scopes;
    b.push('custom_oauth_providers', doc);
    b.providers[name] = providerKey;
    add('differs', 'providers', `${base}.enabled`, `Custom OIDC provider "${name}" becomes "${providerKey}". Add Atlas's redirect URI to the upstream app and set ${upper}_CLIENT_SECRET. Imported identities keep provider "${name}"; map it with provider_map ${name}=${providerKey}.`, `custom_oauth_providers ${providerKey}`);
  }

  // ── SAML, webhooks, everything else ──
  if (val('saml.enabled') === true) {
    const idps = Array.isArray(val('saml.identity_providers')) ? objs(val('saml.identity_providers')) : [];
    for (const idp of idps) {
      if (idp.enabled === false) continue;
      const meta = str(idp.metadata_url);
      b.report.push({
        status: 'manual',
        area: 'SAML',
        setting: `saml.identity_providers ${str(idp.name) ?? str(idp.domain) ?? '?'}`,
        note: `SAML identity provider for ${str(idp.domain) ?? 'its domain'}${meta ? ` (metadata ${meta})` : ''}: users' SAML identities move with the data export; create the SSO connection in Atlas with this metadata, then give the IdP Atlas's ACS URL and entity id.`,
        atlas: 'sso_connections',
        ...lineOfList('saml.identity_providers'),
      });
    }
    if (!idps.length) add('manual', 'SAML', 'saml.enabled', 'SAML is on: create each IdP as an Atlas SSO connection (config.yaml lists none; they may live in the database).');
  }
  if (has('webhooks.enabled') && val('webhooks.enabled') === true) add('manual', 'webhooks', 'webhooks.enabled', 'Recreate each Hanko webhook as an Atlas webhook (event names differ).');
  if ([...s.values.keys()].some((k) => k.startsWith('rate_limiter.'))) add('differs', 'attack protection', [...s.values.keys()].find((k) => k.startsWith('rate_limiter.'))!, 'Atlas applies its own rate limits.');
  if (has('account_deletion.enabled')) add('differs', 'account', 'account_deletion.enabled', `Account deletion by users is ${val('account_deletion.enabled') === true ? 'on' : 'off'}: enable or disable "users can delete their account" in Atlas account settings.`);
  if ([...s.values.keys()].some((k) => k.startsWith('secrets.'))) add('manual', 'secrets', [...s.values.keys()].find((k) => k.startsWith('secrets.'))!, 'secrets.keys signed Hanko sessions and encrypted its data: not carried over, Atlas signs its own tokens.');

  // ── bridge and lazy ──
  const issuer = str(val('session.issuer'));
  const result: Pick<TranslationResult, 'bridge' | 'lazy'> = {};
  if (s.apiUrl) {
    const api = s.apiUrl.replace(/\/+$/, '');
    result.bridge = issuer && issuer.replace(/\/+$/, '') !== api ? { preset: 'hanko_jwt', vars: { base_url: api, issuer } } : { preset: 'hanko', vars: { base_url: api } };
    result.lazy = { preset: 'hanko', config: { base_url: api } };
    if (issuer) add('mapped', 'bridge', 'session.issuer', `The bridge checks tokens issued by ${issuer}.`, 'migrations hanko bridge');
  } else if (issuer) {
    add('differs', 'bridge', 'session.issuer', `Tokens carry iss ${issuer}: pass --set hanko-api-url=<your public API URL> so the bridge is set up with it.`);
  }
  return b.result(s.origin, result);
}
