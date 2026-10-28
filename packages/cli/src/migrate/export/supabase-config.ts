import type { TranslationResult } from '../framework/plugin';
import { isObj, type Obj } from './record-set';
import { ConfigBuilder, clampSessionMs, socialKey } from './translate-kit';
import { VendorHttp } from './vendor-http';

/**
 * `atlas migrate supabase config` — Supabase Auth settings → Atlas config.
 *
 * Two readers, one translation:
 *   - the project's `supabase/config.toml` (the `[auth…]` tables), every
 *     report line carrying file:line;
 *   - the Management API, `GET https://api.supabase.com/v1/projects/{ref}/config/auth`
 *     with a personal access token (the hosted project's live settings),
 *     report lines naming the API field.
 * The API's flat fields are folded onto the config.toml paths, so both read
 * the same way below.
 */

export interface SettingValue {
  value: unknown;
  /** The vendor setting (config.toml path or API field). */
  setting: string;
  file?: string;
  line?: number;
}

export interface SupabaseAuthSettings {
  origin: string;
  /** Values by config.toml path (`auth.email.enable_confirmations`). */
  values: Map<string, SettingValue>;
  /** The project ref, when known (bridge preset variable). */
  projectRef?: string;
}

// ── config.toml ────────────────────────────────────────────────────────────

/**
 * A TOML reader for config.toml's shape: `[a.b.c]` tables, `key = value` with
 * basic / literal strings, numbers, booleans and (multi-line) arrays of
 * scalars, `#` comments. Keys come back as dotted paths with their 1-based line.
 */
export function parseToml(text: string): Map<string, { value: unknown; line: number }> {
  const out = new Map<string, { value: unknown; line: number }>();
  const lines = text.split(/\r?\n/);
  let table = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]!).trim();
    if (!raw) continue;
    const header = /^\[\s*([A-Za-z0-9_.\-"]+)\s*\]$/.exec(raw);
    if (header) {
      table = header[1]!.replace(/"/g, '');
      continue;
    }
    const kv = /^([A-Za-z0-9_\-"]+)\s*=\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const line = i + 1;
    let rhs = kv[2]!;
    // A multi-line array runs until its closing bracket.
    if (rhs.startsWith('[') && !balanced(rhs)) {
      while (i + 1 < lines.length && !balanced(rhs)) rhs += ` ${stripComment(lines[++i]!).trim()}`;
    }
    const key = kv[1]!.replace(/"/g, '');
    out.set(table ? `${table}.${key}` : key, { value: tomlValue(rhs.trim()), line });
  }
  return out;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function balanced(s: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return depth <= 0;
}

function tomlValue(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"')) {
    const end = s.lastIndexOf('"');
    return JSON.parse(s.slice(0, end + 1).replace(/\\'/g, "'"));
  }
  if (s.startsWith("'")) return s.slice(1, s.indexOf("'", 1));
  if (s.startsWith('[')) {
    const inner = s.slice(1, s.lastIndexOf(']'));
    const items: unknown[] = [];
    let cur = '';
    let quote: string | null = null;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]!;
      if (quote) {
        cur += c;
        if (c === '\\' && quote === '"') cur += inner[++i] ?? '';
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
        cur += c;
      } else if (c === ',') {
        if (cur.trim()) items.push(tomlValue(cur.trim()));
        cur = '';
      } else cur += c;
    }
    if (cur.trim()) items.push(tomlValue(cur.trim()));
    return items;
  }
  const n = Number(s.replace(/_/g, ''));
  return Number.isFinite(n) ? n : s;
}

export function settingsFromToml(text: string, file = 'supabase/config.toml'): SupabaseAuthSettings {
  const values = new Map<string, SettingValue>();
  for (const [path, v] of parseToml(text)) {
    if (path === 'project_id' || path.startsWith('auth.') || path === 'auth') values.set(path, { value: v.value, setting: path, file, line: v.line });
  }
  return { origin: file, values };
}

// ── Management API ─────────────────────────────────────────────────────────

/** Management API field → config.toml path (`!` negates a boolean). */
const API_FIELDS: Record<string, string> = {
  site_url: 'auth.site_url',
  jwt_exp: 'auth.jwt_expiry',
  disable_signup: '!auth.enable_signup',
  external_anonymous_users_enabled: 'auth.enable_anonymous_sign_ins',
  security_manual_linking_enabled: 'auth.enable_manual_linking',
  password_min_length: 'auth.minimum_password_length',
  refresh_token_rotation_enabled: 'auth.enable_refresh_token_rotation',
  security_refresh_token_reuse_interval: 'auth.refresh_token_reuse_interval',
  security_update_password_require_reauthentication: 'auth.email.secure_password_change',
  security_captcha_enabled: 'auth.captcha.enabled',
  external_email_enabled: 'auth.email.enabled',
  mailer_autoconfirm: '!auth.email.enable_confirmations',
  mailer_secure_email_change_enabled: 'auth.email.double_confirm_changes',
  mailer_otp_exp: 'auth.email.otp_expiry',
  mailer_otp_length: 'auth.email.otp_length',
  smtp_host: 'auth.email.smtp.host',
  external_phone_enabled: 'auth.sms.enabled',
  sms_autoconfirm: '!auth.sms.enable_confirmations',
  sms_provider: 'auth.sms.provider',
  mfa_max_enrolled_factors: 'auth.mfa.max_enrolled_factors',
  mfa_totp_enroll_enabled: 'auth.mfa.totp.enroll_enabled',
  mfa_phone_enroll_enabled: 'auth.mfa.phone.enroll_enabled',
  mfa_web_authn_enroll_enabled: 'auth.mfa.web_authn.enroll_enabled',
  passkey_enabled: 'auth.passkey.enabled',
  webauthn_rp_id: 'auth.webauthn.rp_id',
  sessions_timebox: 'auth.sessions.timebox',
  sessions_inactivity_timeout: 'auth.sessions.inactivity_timeout',
};

export async function fetchSupabaseAuthConfig(opts: { projectRef: string; accessToken: string; fetchImpl?: typeof fetch; apiUrl?: string }): Promise<SupabaseAuthSettings> {
  if (!/^[a-z0-9]{10,40}$/.test(opts.projectRef)) throw new Error(`Not a Supabase project ref: ${opts.projectRef}`);
  const http = new VendorHttp({ vendor: 'Supabase', baseUrl: opts.apiUrl ?? 'https://api.supabase.com', headers: { authorization: `Bearer ${opts.accessToken}` }, fetchImpl: opts.fetchImpl });
  const { body } = await http.get<Obj>(`/v1/projects/${opts.projectRef}/config/auth`);
  return { ...settingsFromApi(isObj(body) ? body : {}, `supabase project ${opts.projectRef}`), projectRef: opts.projectRef };
}

export function settingsFromApi(api: Obj, origin: string): SupabaseAuthSettings {
  const values = new Map<string, SettingValue>();
  const put = (path: string, value: unknown, setting: string) => {
    if (value !== null && value !== undefined) values.set(path, { value, setting });
  };
  for (const [field, target] of Object.entries(API_FIELDS)) {
    const v = api[field];
    if (target.startsWith('!')) put(target.slice(1), typeof v === 'boolean' ? !v : v, field);
    else put(target, v, field);
  }
  if (typeof api.uri_allow_list === 'string') put('auth.additional_redirect_urls', api.uri_allow_list.split(',').map((s) => s.trim()).filter(Boolean), 'uri_allow_list');
  if (typeof api.password_required_characters === 'string') put('auth.password_requirements', requirementsOf(api.password_required_characters), 'password_required_characters');
  for (const [field, v] of Object.entries(api)) {
    let m = /^external_([a-z0-9_]+?)_(enabled|client_id|url|skip_nonce_check|email_optional)$/.exec(field);
    if (m && !['email', 'phone', 'anonymous_users'].includes(m[1]!)) put(`auth.external.${m[1]}.${m[2]}`, v, field);
    m = /^hook_([a-z_]+)_(enabled|uri)$/.exec(field);
    if (m) put(`auth.hook.${m[1]}.${m[2]}`, v, field);
    m = /^rate_limit_([a-z_]+)$/.exec(field);
    if (m) put(`auth.rate_limit.${m[1]}`, v, field);
  }
  return { origin, values };
}

/** The API's character-set string → the config.toml requirement name. */
function requirementsOf(chars: string): string {
  const sets = chars.split(':');
  if (sets.length >= 4) return 'lower_upper_letters_digits_symbols';
  if (sets.length === 3) return 'lower_upper_letters_digits';
  if (sets.length === 2) return 'letters_digits';
  return '';
}

// ── translation ────────────────────────────────────────────────────────────

/** Go durations (`24h`, `1h30m`, `90s`) or seconds → ms. */
export function durationMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 0 ? v * 1000 : undefined;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(h|m|s|ms)/g;
  let m: RegExpExecArray | null;
  let matched = '';
  while ((m = re.exec(v.trim()))) {
    matched += m[0];
    total += Number(m[1]) * { h: 3600_000, m: 60_000, s: 1000, ms: 1 }[m[2] as 'h' | 'm' | 's' | 'ms'];
  }
  return matched === v.trim() && total > 0 ? total : undefined;
}

/** Supabase's provider names → Atlas built-in keys. */
const PROVIDERS: Record<string, string> = { azure: 'microsoft', linkedin_oidc: 'linkedin', twitter: 'x', x: 'x' };

/** `env(NAME)` is config.toml's way to keep a secret out of the file. */
const fromEnv = (v: unknown): string | undefined => (typeof v === 'string' ? /^env\(([A-Z0-9_]+)\)$/.exec(v.trim())?.[1] : undefined);

export function translateSupabaseConfig(s: SupabaseAuthSettings): TranslationResult {
  const b = new ConfigBuilder();
  const get = (path: string) => s.values.get(path);
  const val = (path: string) => s.values.get(path)?.value;
  const add = (status: 'mapped' | 'differs' | 'manual', area: string, path: string, note: string, atlas?: string) => {
    const v = get(path);
    b.report.push({ status, area, setting: v?.setting ?? path, note, ...(atlas ? { atlas } : {}), ...(v?.file ? { file: v.file, line: v.line } : {}) });
  };
  const has = (path: string) => s.values.has(path);

  // ── general ──
  if (has('auth.enable_signup')) {
    const open = val('auth.enable_signup') !== false;
    b.set('signUpMode', open ? 'public' : 'restricted');
    add('mapped', 'general', 'auth.enable_signup', open ? 'Public sign-up.' : 'Sign-up closed (invitations and the allowlist still work).', 'auth_config.signUpMode');
  }
  if (has('auth.enable_anonymous_sign_ins')) {
    b.set('strategies.anonymous', val('auth.enable_anonymous_sign_ins') === true);
    add('mapped', 'general', 'auth.enable_anonymous_sign_ins', val('auth.enable_anonymous_sign_ins') === true ? 'Guest (anonymous) sign-in on.' : 'Anonymous sign-in off.', 'auth_config.strategies.anonymous');
  }
  if (val('auth.enable_manual_linking') === true) add('differs', 'general', 'auth.enable_manual_linking', 'Atlas links accounts from the signed-in user (user.createExternalAccount) without a separate switch.');
  const urls = [val('auth.site_url'), ...(Array.isArray(val('auth.additional_redirect_urls')) ? (val('auth.additional_redirect_urls') as unknown[]) : [])].filter((u): u is string => typeof u === 'string' && !!u.trim());
  let wildcard = false;
  for (const url of new Set(urls)) {
    if (url.includes('*')) {
      wildcard = true;
      continue;
    }
    b.push('redirect_urls', { url });
  }
  if (urls.length) add(wildcard ? 'differs' : 'mapped', 'URL configuration', has('auth.additional_redirect_urls') ? 'auth.additional_redirect_urls' : 'auth.site_url', `${urls.length} site / redirect URL(s) become redirect URLs${wildcard ? '; Atlas redirect URLs are exact, so list each URL a wildcard covered' : ''}.`, 'redirect_urls');

  // ── tokens and sessions ──
  if (has('auth.jwt_expiry')) add('differs', 'sessions', 'auth.jwt_expiry', `Supabase access tokens lived ${val('auth.jwt_expiry')}s. Atlas issues short-lived session tokens (60s by default) refreshed by its SDKs; lifetime is the session's.`, 'auth_config.session.jwtTtlSeconds');
  if (has('auth.enable_refresh_token_rotation')) add('mapped', 'sessions', 'auth.enable_refresh_token_rotation', 'Atlas always rotates refresh tokens.', 'auth_config.session');
  if (has('auth.refresh_token_reuse_interval')) add('differs', 'sessions', 'auth.refresh_token_reuse_interval', 'Atlas has its own reuse grace window for concurrent refreshes.');
  const timebox = durationMs(val('auth.sessions.timebox'));
  if (timebox) {
    b.set('session.absoluteMs', clampSessionMs(timebox));
    add(clampSessionMs(timebox) === timebox ? 'mapped' : 'differs', 'sessions', 'auth.sessions.timebox', 'Session time-box becomes the absolute session lifetime.', 'auth_config.session.absoluteMs');
  }
  const idle = durationMs(val('auth.sessions.inactivity_timeout'));
  if (idle) {
    b.set('session.idleMs', clampSessionMs(idle));
    add(clampSessionMs(idle) === idle ? 'mapped' : 'differs', 'sessions', 'auth.sessions.inactivity_timeout', 'Inactivity timeout becomes the idle session lifetime.', 'auth_config.session.idleMs');
  }

  // ── passwords ──
  const minLen = val('auth.minimum_password_length');
  if (typeof minLen === 'number') {
    b.set('passwordPolicy.minLength', Math.max(minLen, 6));
    add('mapped', 'passwords', 'auth.minimum_password_length', `Minimum ${minLen} characters.`, 'auth_config.passwordPolicy.minLength');
  }
  const req = val('auth.password_requirements');
  if (typeof req === 'string' && req) {
    b.set('passwordPolicy.requireNumber', true);
    if (req.startsWith('lower_upper')) {
      b.set('passwordPolicy.requireLowercase', true);
      b.set('passwordPolicy.requireUppercase', true);
    }
    if (req.endsWith('symbols')) b.set('passwordPolicy.requireSymbol', true);
    add(req === 'letters_digits' ? 'differs' : 'mapped', 'passwords', 'auth.password_requirements', req === 'letters_digits' ? 'Letters and digits: Atlas requires a digit (letters are not a separate rule).' : `Character requirements "${req}".`, 'auth_config.passwordPolicy');
  }
  if (val('auth.email.secure_password_change') === true) add('mapped', 'passwords', 'auth.email.secure_password_change', 'Atlas asks for the current password (or a fresh sign-in) before a password change.');

  // ── email ──
  const emailOn = val('auth.email.enabled') !== false;
  b.set('strategies.password', emailOn);
  b.set('strategies.emailLink', emailOn);
  b.set('strategies.emailCode', emailOn);
  add('mapped', 'email', has('auth.email.enabled') ? 'auth.email.enabled' : 'auth.email.enable_signup', emailOn ? 'Email sign-in on: password, magic link and one-time code, as in Supabase.' : 'Email sign-in off.', 'auth_config.strategies.password / emailLink / emailCode');
  if (has('auth.email.enable_confirmations')) {
    const on = val('auth.email.enable_confirmations') === true;
    b.set('requireEmailVerification', on);
    add('mapped', 'email', 'auth.email.enable_confirmations', on ? 'Email addresses are confirmed before sign-in.' : 'Email confirmation off.', 'auth_config.requireEmailVerification');
  }
  if (has('auth.email.double_confirm_changes')) add('differs', 'email', 'auth.email.double_confirm_changes', 'Atlas verifies the new address on an email change; it does not also mail the old one.');
  if (has('auth.email.otp_length') || has('auth.email.otp_expiry')) add('differs', 'email', has('auth.email.otp_length') ? 'auth.email.otp_length' : 'auth.email.otp_expiry', 'Atlas uses 6-digit codes with its own expiry.');
  if (has('auth.email.smtp.host')) add('manual', 'email', 'auth.email.smtp.host', 'Configure your SMTP server (or email provider) in Atlas; credentials are not copied.');
  for (const [path] of s.values) {
    const m = /^auth\.email\.template\.([a-z_]+)\.(subject|content_path)$/.exec(path);
    if (m && path.endsWith('subject')) add('manual', 'email', path, `Recreate the "${m[1]}" email template in Atlas (Supabase's {{ .ConfirmationURL }} variables differ).`);
  }

  // ── phone ──
  if (val('auth.sms.enable_signup') === true || val('auth.sms.enabled') === true) {
    b.set('strategies.phoneCode', true);
    add('mapped', 'phone', has('auth.sms.enabled') ? 'auth.sms.enabled' : 'auth.sms.enable_signup', 'SMS code sign-in on.', 'auth_config.strategies.phoneCode');
  }
  for (const provider of ['twilio', 'twilio_verify', 'messagebird', 'textlocal', 'vonage']) {
    if (val(`auth.sms.${provider}.enabled`) === true) add('manual', 'phone', `auth.sms.${provider}.enabled`, `Connect your ${provider.replace('_', ' ')} account as Atlas's SMS provider (credentials are not copied).`);
  }
  if (typeof val('auth.sms.provider') === 'string') add('manual', 'phone', 'auth.sms.provider', `Connect your ${String(val('auth.sms.provider'))} account as Atlas's SMS provider (credentials are not copied).`);

  // ── MFA and passkeys ──
  const mfa = (factor: string, atlas: string, label: string) => {
    const path = `auth.mfa.${factor}.enroll_enabled`;
    if (!has(path)) return;
    const on = val(path) === true;
    b.set(`mfa.factors.${atlas}`, on);
    add('mapped', 'multi-factor', path, `${label} second factor ${on ? 'on' : 'off'}.${on && factor === 'totp' ? ' Enrolled authenticators move with the export (secrets included).' : ''}`, `auth_config.mfa.factors.${atlas}`);
  };
  mfa('totp', 'totp', 'Authenticator app');
  mfa('phone', 'sms', 'SMS');
  mfa('web_authn', 'passkey', 'WebAuthn');
  if (has('auth.mfa.max_enrolled_factors')) add('differs', 'multi-factor', 'auth.mfa.max_enrolled_factors', 'Atlas has no cap on enrolled factors.');
  if (val('auth.passkey.enabled') === true) {
    b.set('strategies.passkey', true);
    add('mapped', 'passkeys', 'auth.passkey.enabled', 'Passkey sign-in on.', 'auth_config.strategies.passkey');
  }
  if (typeof val('auth.webauthn.rp_id') === 'string') add('differs', 'passkeys', 'auth.webauthn.rp_id', `Passkeys were registered for "${String(val('auth.webauthn.rp_id'))}": they keep working only when Atlas serves sign-in on that domain (export with --rp-id ${String(val('auth.webauthn.rp_id'))}).`);

  // ── providers ──
  const providers = new Set<string>();
  for (const [path] of s.values) {
    const m = /^auth\.external\.([a-z0-9_]+)\./.exec(path);
    if (m) providers.add(m[1]!);
  }
  for (const p of [...providers].sort()) {
    const base = `auth.external.${p}`;
    if (val(`${base}.enabled`) !== true) continue;
    const key = PROVIDERS[p] ?? socialKey(p);
    if (!key) {
      add('manual', 'providers', `${base}.enabled`, `"${p}" is not a built-in Atlas provider; add it as a custom OAuth / OIDC provider${val(`${base}.url`) ? ` (issuer ${String(val(`${base}.url`))})` : ''}.`, 'custom_oauth_providers');
      continue;
    }
    const raw = val(`${base}.client_id`);
    const clientId = typeof raw === 'string' && raw && !fromEnv(raw) ? raw : undefined;
    const v = get(`${base}.enabled`);
    b.socialProvider({ atlasKey: key, vendorName: p, area: 'providers', setting: v?.setting ?? `${base}.enabled`, clientId });
    const last = b.report[b.report.length - 1];
    if (last && v?.file) Object.assign(last, { file: v.file, line: v.line });
    if (p === 'azure' && typeof val(`${base}.url`) === 'string') add('differs', 'providers', `${base}.url`, `Azure tenant URL ${String(val(`${base}.url`))}: set the tenant on Atlas's microsoft provider (single-tenant apps).`, 'oauth_providers microsoft');
    if (val(`${base}.skip_nonce_check`) === true) add('differs', 'providers', `${base}.skip_nonce_check`, 'Atlas always checks the nonce on ID tokens.');
  }

  // ── hooks, captcha, third-party auth, rate limits ──
  for (const [path] of s.values) {
    const hook = /^auth\.hook\.([a-z_]+)\.enabled$/.exec(path);
    if (hook && val(path) === true) {
      const name = hook[1]!;
      const to = name === 'custom_access_token' ? 'a JWT template (custom claims)' : name === 'send_email' || name === 'send_sms' ? 'your own delivery provider in Atlas' : name === 'before_user_created' ? 'a before-sign-up action' : 'Atlas attack protection settings';
      add('manual', 'auth hooks', path, `The ${name} hook moves to ${to}.`);
    }
    const third = /^auth\.third_party\.([a-z0-9_]+)\.enabled$/.exec(path);
    if (third && val(path) === true) add('manual', 'third-party auth', path, `Supabase accepted ${third[1]} tokens: point that integration at Atlas, or migrate it too.`);
  }
  if (val('auth.captcha.enabled') === true) add('differs', 'attack protection', 'auth.captcha.enabled', 'Atlas has its own bot protection; captcha keys are not used.');
  if ([...s.values.keys()].some((k) => k.startsWith('auth.rate_limit.'))) add('differs', 'attack protection', [...s.values.keys()].find((k) => k.startsWith('auth.rate_limit.'))!, 'Atlas applies its own rate limits.');

  const vars: Record<string, string> = {};
  if (s.projectRef) vars.project_ref = s.projectRef;
  return b.result(s.origin, {
    bridge: { preset: 'supabase', vars },
    ...(s.projectRef ? { lazy: { preset: 'supabase', config: { url: `https://${s.projectRef}.supabase.co` } } } : {}),
  });
}
