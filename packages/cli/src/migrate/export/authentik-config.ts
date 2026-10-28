import type { TranslationResult } from '../framework/plugin';
import { authentikList } from './authentik';
import { parseYaml } from './mini-yaml';
import { VendorApiError, VendorHttp } from './vendor-http';
import { isObj, objs, str, strs, type Obj } from './record-set';
import { ConfigBuilder, clampSessionMs, socialKey } from './translate-kit';
import type { Json } from '../../serialize';

/**
 * `atlas migrate authentik config` — an authentik instance's settings → Atlas
 * config. authentik keeps its configuration as objects (flows, stages,
 * policies, sources, providers, applications, brands), so there are two
 * readers of the same model and one translation:
 *
 *   - a BLUEPRINT file (`ak export_blueprint`, or the YAML you keep in
 *     version control): `entries: [{ model, identifiers, attrs }]`, every
 *     report line carrying file:line. Tags (`!Env X`, `!KeyOf name`, `!File …`)
 *     are read as references, never as values: a secret or id written with a
 *     tag is never copied.
 *   - the API (`/api/v3` with an API token): the same objects, listed.
 *
 * Secrets are never copied; a client secret becomes a `${NAME}` placeholder.
 */

export interface AuthentikEntry {
  /** The lowercase model (`authentik_stages_password.passwordstage`). */
  model: string;
  identifiers: Obj;
  attrs: Obj;
  file?: string;
  line?: number;
}

export interface AuthentikSnapshot {
  origin: string;
  /** The authentik URL, when known (the API reader, or a flag): it builds the bridge issuer. */
  baseUrl?: string;
  entries: AuthentikEntry[];
  /** The snapshot lists every flow (the API): an absent enrollment flow then means sign-up is closed. */
  complete: boolean;
}

// ── readers ─────────────────────────────────────────────────────────────────

/** `key: !Env NAME` → `key: "@env:NAME"`: tagged values are references, not values. */
function neutralizeTags(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*(?:-\s+)?[^\s#:][^:#]*:\s+)!([A-Za-z]+)\s+(.*?)\s*$/.exec(line);
      if (!m) return line;
      const first = m[3]!.replace(/^[[(]\s*/, '').split(/[\s,\])]/)[0]!.replace(/^['"]|['"]$/g, '');
      return `${m[1]}"@${m[2]!.toLowerCase()}:${first}"`;
    })
    .join('\n');
}

export function snapshotFromBlueprint(text: string, file: string, baseUrl?: string): AuthentikSnapshot {
  const doc = parseYaml(neutralizeTags(text));
  const root = isObj(doc.value) ? doc.value : {};
  const entries: AuthentikEntry[] = [];
  objs(root.entries).forEach((e, i) => {
    const model = str(e.model)?.toLowerCase();
    if (!model) return;
    entries.push({
      model,
      identifiers: isObj(e.identifiers) ? e.identifiers : {},
      attrs: isObj(e.attrs) ? e.attrs : {},
      file,
      line: doc.line(`entries.${i}.model`) ?? doc.line(`entries.${i}`),
    });
  });
  return { origin: `authentik blueprint ${file}`, baseUrl, entries, complete: false };
}

export const AUTHENTIK_CONFIG_ENDPOINTS: Array<[string, string]> = [
  ['/policies/password/', 'authentik_policies_password.passwordpolicy'],
  ['/stages/password/', 'authentik_stages_password.passwordstage'],
  ['/stages/user_login/', 'authentik_stages_user_login.userloginstage'],
  ['/stages/user_write/', 'authentik_stages_user_write.userwritestage'],
  ['/stages/identification/', 'authentik_stages_identification.identificationstage'],
  ['/stages/email/', 'authentik_stages_email.emailstage'],
  ['/stages/authenticator/totp/', 'authentik_stages_authenticator_totp.authenticatortotpstage'],
  ['/stages/authenticator/webauthn/', 'authentik_stages_authenticator_webauthn.authenticatorwebauthnstage'],
  ['/stages/authenticator/sms/', 'authentik_stages_authenticator_sms.authenticatorsmsstage'],
  ['/stages/authenticator/static/', 'authentik_stages_authenticator_static.authenticatorstaticstage'],
  ['/stages/authenticator/validate/', 'authentik_stages_authenticator_validate.authenticatorvalidatestage'],
  ['/flows/instances/', 'authentik_flows.flow'],
  ['/sources/oauth/', 'authentik_sources_oauth.oauthsource'],
  ['/sources/saml/', 'authentik_sources_saml.samlsource'],
  ['/sources/ldap/', 'authentik_sources_ldap.ldapsource'],
  ['/providers/oauth2/', 'authentik_providers_oauth2.oauth2provider'],
  ['/providers/saml/', 'authentik_providers_saml.samlprovider'],
  ['/core/applications/', 'authentik_core.application'],
  ['/core/brands/', 'authentik_brands.brand'],
];

/** Read the settings objects through the API (the token needs read access to them). */
export async function fetchAuthentikConfig(o: { baseUrl: string; token: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<AuthentikSnapshot> {
  const base = o.baseUrl.replace(/\/+$/, '');
  const http = new VendorHttp({ vendor: 'authentik', baseUrl: `${base}/api/v3`, headers: { authorization: `Bearer ${o.token}` }, fetchImpl: o.fetchImpl, sleep: o.sleep });
  const entries: AuthentikEntry[] = [];
  let missing = 0;
  for (const [path, model] of AUTHENTIK_CONFIG_ENDPOINTS) {
    let list: Obj[];
    try {
      list = await authentikList(http, path);
    } catch (err) {
      // An authentik without that object type, or a token that cannot read it.
      if (err instanceof VendorApiError && [403, 404].includes(err.status)) {
        missing++;
        continue;
      }
      throw err;
    }
    for (const attrs of list) entries.push({ model, identifiers: { pk: attrs.pk ?? attrs.pbm_uuid, name: attrs.name, slug: attrs.slug }, attrs });
  }
  return { origin: `authentik ${base.replace(/^https?:\/\//, '')}`, baseUrl: base, entries, complete: missing === 0 };
}

// ── translation ─────────────────────────────────────────────────────────────

const UNITS: Record<string, number> = { weeks: 604_800_000, days: 86_400_000, hours: 3_600_000, minutes: 60_000, seconds: 1000, milliseconds: 1 };

/** authentik's timedelta strings: `hours=1,minutes=30`, `seconds=0`, `days=1`. */
export function timedeltaMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  const s = str(v);
  if (!s) return undefined;
  let total = 0;
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^([a-z]+)=(-?\d+(?:\.\d+)?)$/.exec(part);
    const unit = m ? UNITS[m[1]!] : undefined;
    if (!m || unit === undefined) return undefined;
    total += Number(m[2]) * unit;
  }
  return total;
}

const isRef = (v: unknown): boolean => typeof v === 'string' && v.startsWith('@');
/** A literal string attribute (a tagged reference or an empty value is not one). */
const lit = (v: unknown): string | undefined => (isRef(v) ? undefined : str(v));
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
/** The `@env:NAME` a tagged value reads, for the report. */
const envName = (v: unknown): string | undefined => (typeof v === 'string' && v.startsWith('@env:') ? v.slice(5) : undefined);

const OIDC_SOURCE_TYPES = new Set(['openidconnect', 'okta', 'keycloak', 'authentik', 'entraid_oidc']);

export function translateAuthentikConfig(snap: AuthentikSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  const m = (suffix: string) => snap.entries.filter((e) => e.model.endsWith(`.${suffix}`));
  const add = (status: 'mapped' | 'differs' | 'manual', area: string, e: AuthentikEntry, attr: string | null, note: string, atlas?: string) => {
    const name = str(e.identifiers.name) ?? str(e.identifiers.slug) ?? str(e.attrs.name) ?? str(e.attrs.slug) ?? '?';
    b.report.push({
      status,
      area,
      setting: `${e.model} ${name}${attr ? `.${attr}` : ''}`,
      note,
      ...(atlas ? { atlas } : {}),
      ...(e.file ? { file: e.file, line: e.line } : {}),
    });
  };

  // ── passwords ──
  const policies = m('passwordpolicy');
  policies.forEach((p, i) => {
    if (i > 0) {
      add('differs', 'passwords', p, null, 'Atlas has one password policy: only the first authentik policy was translated; fold the rules of this one into it.');
      return;
    }
    const min = num(p.attrs.length_min);
    if (min !== undefined) {
      b.set('passwordPolicy.minLength', Math.max(min, 6));
      add(min >= 6 ? 'mapped' : 'differs', 'passwords', p, 'length_min', min >= 6 ? `Minimum ${min} characters.` : `authentik allowed ${min} characters; Atlas requires at least 6.`, 'auth_config.passwordPolicy.minLength');
    }
    for (const [attr, key, label] of [
      ['amount_digits', 'requireNumber', 'a digit'],
      ['amount_uppercase', 'requireUppercase', 'an uppercase letter'],
      ['amount_lowercase', 'requireLowercase', 'a lowercase letter'],
      ['amount_symbols', 'requireSymbol', 'a symbol'],
    ] as const) {
      if ((num(p.attrs[attr]) ?? 0) > 0) {
        b.set(`passwordPolicy.${key}`, true);
        add('mapped', 'passwords', p, attr, `Passwords need ${label}${(num(p.attrs[attr]) ?? 0) > 1 ? ' (Atlas asks for one, not a count)' : ''}.`, `auth_config.passwordPolicy.${key}`);
      }
    }
    if (p.attrs.check_have_i_been_pwned === true) add('manual', 'passwords', p, 'check_have_i_been_pwned', 'Turn on breached-password protection in Atlas attack protection (the Have I Been Pwned check does not carry over).');
    if (p.attrs.check_zxcvbn === true) add('differs', 'passwords', p, 'check_zxcvbn', 'The zxcvbn strength score has no Atlas setting; Atlas rejects common and breached passwords instead.');
    if (str(p.attrs.password_field) && p.attrs.password_field !== 'password') add('differs', 'passwords', p, 'password_field', 'Policy applied to a custom prompt field; Atlas applies its policy to the password field.');
  });

  // ── sessions ──
  for (const s of m('userloginstage')) {
    const ms = timedeltaMs(s.attrs.session_duration);
    if (ms === 0) add('differs', 'sessions', s, 'session_duration', 'authentik ended the session with the browser (seconds=0); Atlas sessions persist until their idle and absolute limits (auth_config.session).');
    else if (ms !== undefined) {
      b.set('session.absoluteMs', clampSessionMs(ms));
      add(clampSessionMs(ms) === ms ? 'mapped' : 'differs', 'sessions', s, 'session_duration', 'Session duration becomes the absolute session lifetime.', 'auth_config.session.absoluteMs');
    }
    if (s.attrs.terminate_other_sessions === true) add('manual', 'sessions', s, 'terminate_other_sessions', 'Signing in no longer ends the user\'s other sessions: use a session limit or revoke sessions from an Action.');
    if (str(s.attrs.network_binding) && s.attrs.network_binding !== 'no_binding') add('differs', 'sessions', s, 'network_binding', 'Sessions are not bound to the client network; Atlas applies device and risk checks instead.');
    if (str(s.attrs.geoip_binding) && s.attrs.geoip_binding !== 'no_binding') add('differs', 'sessions', s, 'geoip_binding', 'Sessions are not bound to the client location; Atlas applies device and risk checks instead.');
    if (timedeltaMs(s.attrs.remember_me_offset)) add('differs', 'sessions', s, 'remember_me_offset', 'Atlas has no separate "remember me" lifetime.');
  }

  // ── sign-up, sign-in methods ──
  const flows = m('flow');
  const enrollment = flows.find((f) => f.attrs.designation === 'enrollment');
  if (enrollment) {
    b.set('signUpMode', 'public');
    add('mapped', 'sign-up', enrollment, 'designation', 'An enrollment flow exists: public sign-up.', 'auth_config.signUpMode');
  } else if (snap.complete) {
    b.set('signUpMode', 'restricted');
    b.add('mapped', 'sign-up', 'flows (no enrollment flow)', 'No enrollment flow: sign-up is closed (invitations and imports still work).', 'auth_config.signUpMode');
  }
  const recovery = flows.find((f) => f.attrs.designation === 'recovery');
  if (recovery) add('mapped', 'sign-in', recovery, 'designation', 'A recovery flow exists: password reset by email is on in Atlas by default.', 'auth_config.strategies.password');
  for (const s of m('identificationstage')) {
    const passwordless = s.attrs.passwordless_flow;
    if (passwordless !== undefined && passwordless !== null && passwordless !== '') {
      b.set('strategies.passkey', true);
      add('mapped', 'sign-in', s, 'passwordless_flow', 'Passwordless (WebAuthn) sign-in becomes passkey sign-in.', 'auth_config.strategies.passkey');
    }
    const fields = strs(s.attrs.user_fields);
    if (fields.length) add('differs', 'sign-in', s, 'user_fields', `Sign-in by ${fields.join(', ')}: Atlas accepts the identifiers the sign-up form collects (email, username, phone); check the instance's sign-in identifiers.`);
    if (strs(s.attrs.sources).length) add('mapped', 'sign-in', s, 'sources', 'The social and SAML sources offered here are translated below.');
  }
  for (const s of m('userwritestage')) {
    if (s.attrs.create_users_as_inactive === true) add('differs', 'sign-up', s, 'create_users_as_inactive', 'New users were created inactive until activated by another stage; Atlas holds sign-ups with its email verification and approval settings instead.');
  }
  for (const s of m('emailstage')) {
    add('manual', 'email', s, null, `Connect your own email provider in Atlas (SMTP host ${lit(s.attrs.host) ?? 'from authentik settings'} is not copied) and recreate the template "${lit(s.attrs.template) ?? 'email/…'}" as an Atlas email template.`);
    const exp = num(s.attrs.token_expiry);
    if (exp !== undefined) add('differs', 'email', s, 'token_expiry', `Links expired after ${exp} minutes; Atlas uses its own link and code lifetimes.`);
  }

  // ── multi-factor ──
  for (const s of m('authenticatortotpstage')) {
    b.set('mfa.factors.totp', true);
    add('mapped', 'multi-factor', s, null, `Authenticator-app second factor on${num(s.attrs.digits) === 8 || s.attrs.digits === '8' ? ' (8-digit devices keep their shape when imported)' : ''}. Enrolled devices move with the database export (seeds included).`, 'auth_config.mfa.factors.totp');
  }
  for (const s of m('authenticatorwebauthnstage')) {
    b.set('mfa.factors.passkey', true);
    add('mapped', 'multi-factor', s, null, 'WebAuthn second factor on. Devices move only with the database export and the same RP id (your authentik host).', 'auth_config.mfa.factors.passkey');
    if (lit(s.attrs.authenticator_attachment)) add('differs', 'multi-factor', s, 'authenticator_attachment', 'Atlas lets the user pick a platform or roaming authenticator.');
  }
  for (const s of m('authenticatorsmsstage')) {
    b.set('mfa.factors.sms', true);
    add('mapped', 'multi-factor', s, null, 'SMS second factor on.', 'auth_config.mfa.factors.sms');
    add('manual', 'multi-factor', s, 'provider', `Connect your own SMS provider (${lit(s.attrs.provider) ?? 'twilio / generic'}); its credentials are not copied.`);
  }
  for (const s of m('authenticatorstaticstage')) {
    add('differs', 'multi-factor', s, null, 'Static recovery tokens move as backup codes with the database export; Atlas generates its own codes for new enrolments.', 'auth_config.mfa');
  }
  for (const s of m('authenticatorvalidatestage')) {
    const action = lit(s.attrs.not_configured_action);
    add(
      'differs',
      'multi-factor',
      s,
      'not_configured_action',
      action === 'deny' ? 'Users without a factor were refused: turn on "require a second factor" in the Atlas MFA settings.' : action === 'configure' ? 'Users without a factor had to enrol one: turn on "require a second factor" in the Atlas MFA settings.' : 'Users without a factor skipped the check; Atlas asks for a second factor only from users who enrolled one unless you require it.',
      'auth_config.mfa',
    );
  }

  // ── social and SAML sources ──
  for (const s of m('oauthsource')) {
    if (s.attrs.enabled === false) continue;
    const slug = lit(s.identifiers.slug) ?? lit(s.attrs.slug) ?? '?';
    const type = lit(s.attrs.provider_type)?.toLowerCase() ?? '';
    const key = OIDC_SOURCE_TYPES.has(type) ? null : socialKey(type);
    const clientId = lit(s.attrs.consumer_key);
    if (key) {
      b.socialProvider({ atlasKey: key, vendorName: slug, area: 'sources', setting: `${s.model} ${slug}.provider_type`, clientId });
      const last = b.report[b.report.length - 1]!;
      if (s.file) Object.assign(last, { file: s.file, line: s.line });
      continue;
    }
    if (OIDC_SOURCE_TYPES.has(type) || type === 'oauth' || type === '') {
      const providerKey = slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'oidc';
      const upper = providerKey.toUpperCase();
      const doc: Record<string, Json> = {
        provider_key: providerKey,
        display_name: str(s.attrs.name) ?? slug,
        protocol: 'oidc',
        client_id: clientId ?? b.placeholder(`${upper}_CLIENT_ID`, `${slug} client id`),
        client_secret: b.placeholder(`${upper}_CLIENT_SECRET`, `${slug} client secret`),
        enabled: true,
        allow_sign_in: true,
        allow_sign_up: s.attrs.enrollment_flow !== null,
      };
      const wellKnown = lit(s.attrs.oidc_well_known_url);
      if (wellKnown) doc.discovery_url = wellKnown;
      if (lit(s.attrs.authorization_url)) doc.authorization_url = lit(s.attrs.authorization_url)!;
      if (lit(s.attrs.access_token_url)) doc.token_url = lit(s.attrs.access_token_url)!;
      if (lit(s.attrs.profile_url)) doc.userinfo_url = lit(s.attrs.profile_url)!;
      b.push('custom_oauth_providers', doc);
      b.providers[slug] = providerKey;
      add('differs', 'sources', s, 'provider_type', `Source "${slug}" (${type || 'oauth'}) becomes the custom OIDC provider "${providerKey}". Add Atlas's redirect URI to the upstream app and set ${upper}_CLIENT_SECRET. Imported identities keep provider "${slug}"; map it with provider_map ${slug}=${providerKey}.`, `custom_oauth_providers ${providerKey}`);
      continue;
    }
    add('manual', 'sources', s, 'provider_type', `"${type}" is not a built-in Atlas provider: add it as a custom OAuth provider with the same upstream app.`, 'custom_oauth_providers');
  }
  for (const s of m('samlsource')) {
    add('mapped', 'sources', s, null, 'SAML source: moves with the data export as an SSO connection. Give the IdP Atlas\'s ACS URL and entity id (they replace authentik\'s) before turning it on.', 'sso_connections');
  }
  for (const s of m('ldapsource')) {
    add('manual', 'sources', s, null, 'LDAP source: authentik checks these passwords against your directory. Connect the directory to Atlas (SCIM or an LDAP-backed connection), or let those users move by lazy migration (the authentik preset signs them in through authentik first).');
  }

  // ── applications, providers, the bridge ──
  const providers = m('oauth2provider');
  const apps = m('application');
  const redirects = new Set<string>();
  let wildcard = false;
  for (const p of providers) {
    const list = Array.isArray(p.attrs.redirect_uris) ? p.attrs.redirect_uris : typeof p.attrs.redirect_uris === 'string' ? p.attrs.redirect_uris.split('\n').map((url) => ({ matching_mode: 'strict', url })) : [];
    for (const r of list) {
      const url = isObj(r) ? lit(r.url) : lit(r);
      const regex = isObj(r) && r.matching_mode === 'regex';
      if (!url) continue;
      if (regex || url.includes('*')) wildcard = true;
      else redirects.add(url);
    }
    if (p.attrs.signing_key === null || p.attrs.signing_key === '') {
      add('manual', 'providers', p, 'signing_key', 'No signing key: authentik signs tokens with the client secret (HS256), which the session bridge cannot verify. Select a certificate on the provider before the cutover.');
    }
  }
  for (const url of redirects) b.push('redirect_urls', { url });
  if (redirects.size || wildcard) {
    const p = providers[0]!;
    add(wildcard ? 'differs' : 'mapped', 'providers', p, 'redirect_uris', `${redirects.size} redirect URI(s) become redirect URLs${wildcard ? '; regex and wildcard URIs are not translated (Atlas redirect URLs are exact: list each one)' : ''}.`, 'redirect_urls');
  }
  for (const a of apps) {
    add('manual', 'applications', a, null, 'Application: the policy bindings that decide who may open it become Atlas roles or organization membership checks in your app; the launch URL and icon are not copied.');
  }
  for (const p of m('samlprovider')) add('manual', 'providers', p, null, 'SAML provider (authentik as the identity provider): configure Atlas as the SAML IdP for that service provider, or keep authentik for it.');
  for (const br of m('brand')) {
    add('manual', 'branding', br, 'branding_title', `Brand "${lit(br.attrs.branding_title) ?? lit(br.attrs.domain) ?? ''}": recreate the logo, title and colours in Atlas branding.`);
  }

  // Bridge and lazy presets, when the snapshot tells enough.
  const result: Pick<TranslationResult, 'bridge' | 'lazy'> = {};
  // The application of the one provider: linked by primary key (API), or the only application (blueprint).
  const linked =
    providers.length === 1
      ? (apps.find((a) => a.attrs.provider !== undefined && !isRef(a.attrs.provider) && String(a.attrs.provider) === String(providers[0]!.identifiers.pk)) ?? (apps.length === 1 ? apps[0] : undefined))
      : undefined;
  const appSlug = lit(linked?.attrs.slug ?? linked?.identifiers.slug);
  const only = providers.length === 1 && appSlug ? { p: providers[0]!, slug: appSlug } : undefined;
  if (snap.baseUrl && only) {
    const clientId = lit(only.p.attrs.client_id);
    result.bridge = { preset: 'authentik', vars: { issuer: `${snap.baseUrl}/application/o/${only.slug}`, ...(clientId ? { client_id: clientId } : {}) } };
    add('mapped', 'bridge', only.p, 'client_id', `The bridge accepts tokens of "${only.slug}" (issuer ${snap.baseUrl}/application/o/${only.slug}/).`, 'migrations authentik bridge');
  } else if (providers.length > 1) {
    add('differs', 'bridge', providers[0]!, null, `${providers.length} OAuth2 providers: the bridge accepts one provider's tokens at a time; pass --set authentik-issuer and --set authentik-client-id for the one your app uses.`);
  }
  const subModes = [...new Set(providers.map((p) => lit(p.attrs.sub_mode) ?? 'hashed_user_id'))];
  for (const mode of subModes) {
    if (mode === 'user_uuid' || mode === 'user_upn') add('differs', 'providers', providers.find((p) => (lit(p.attrs.sub_mode) ?? 'hashed_user_id') === mode)!, 'sub_mode', `Subject mode ${mode}: export with --set authentik-sub-mode=${mode}; lazy migration cannot read it from a session, so use the database export.`);
  }
  if (subModes.length > 1) add('differs', 'providers', providers[0]!, 'sub_mode', `Providers use different subject modes (${subModes.join(', ')}); the export keys users by one of them.`);
  const authFlow = flows.find((f) => f.attrs.designation === 'authentication');
  if (snap.baseUrl) {
    const subMode = subModes.length === 1 && ['hashed_user_id', 'user_id', 'user_username', 'user_email'].includes(subModes[0]!) ? subModes[0]! : undefined;
    result.lazy = { preset: 'authentik', config: { base_url: snap.baseUrl, ...(lit(authFlow?.attrs.slug ?? authFlow?.identifiers.slug) ? { flow_slug: lit(authFlow?.attrs.slug ?? authFlow?.identifiers.slug)! } : {}), ...(subMode ? { sub_mode: subMode } : {}) } };
  }

  // Env names a blueprint read, for the operator.
  for (const e of snap.entries) for (const [k, v] of Object.entries(e.attrs)) if (envName(v) && /secret|password|token/i.test(k)) add('manual', 'secrets', e, k, `Read from the environment (${envName(v)}) in the blueprint: set the Atlas value separately, secrets are never copied.`);

  return b.result(snap.origin, result);
}
