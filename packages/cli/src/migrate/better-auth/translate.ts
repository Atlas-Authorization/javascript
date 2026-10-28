import { literalOf, propOf, type BetterAuthAnalysis, type SourceLoc, type StaticValue } from '@atlasauth/upgrade';
import type { Json } from '../../serialize';

/**
 * Better Auth options → an Atlas config-as-code document (the same per-resource
 * files `atlas config export` writes and `atlas config import` applies) plus a
 * line-by-line report of what mapped 1:1, what maps with a difference and what
 * needs a manual step, each with the file and line of the option.
 *
 * Pure: it works on the static analysis only. Secrets are NEVER read: a value
 * that comes from an environment variable is written as a `${NAME}` placeholder
 * (the import interpolates it from the environment), and a secret hard-coded in
 * source is replaced by a placeholder and flagged.
 */

export type ReportStatus = 'mapped' | 'differs' | 'manual';

export interface ReportEntry {
  status: ReportStatus;
  /** The Better Auth area: `emailAndPassword`, `plugin:organization`, … */
  area: string;
  /** The Better Auth option path (`session.expiresIn`). */
  option: string;
  /** Where it lands in Atlas (`auth_config.session.idleMs`, `oauth_providers google`). */
  atlas?: string;
  note: string;
  file: string;
  line: number;
}

export interface ConfigDocument {
  instance: { allowed_origins?: string[]; auth_config: Record<string, Json> };
  oauth_providers: Json[];
  custom_oauth_providers: Json[];
  permissions: Json[];
  roles: Json[];
  oauth_clients: Json[];
  resource_servers: Json[];
  billing_plans: Json[];
  redirect_urls: Json[];
  jwt_templates: Json[];
}

export interface Translation {
  /** The `betterAuth()` call that was translated. */
  source: SourceLoc | null;
  /** Every other `betterAuth()` call found (not translated). */
  otherInstances: SourceLoc[];
  document: ConfigDocument;
  report: ReportEntry[];
  /** Environment variables the document's `${NAME}` placeholders need at import time. */
  env: Array<{ name: string; for: string }>;
  /** Secrets that are stored through their own write-only endpoint before the config is applied. */
  secrets: Array<{ kind: 'captcha_secret'; provider: string; env: string }>;
  /** Better Auth ids → Atlas ids, for the data import and the code rewrite. */
  mappings: { providers: Record<string, string>; roles: Record<string, string> };
  /** What the session bridge needs to recognise a Better Auth session. */
  bridge: { cookiePrefix: string; sessionCookie: string; secretEnv: string | null; expiresInSeconds: number };
  /** Plugin ids found, in order. */
  plugins: string[];
}

// ───────────────────────────── catalogues ─────────────────────────────

/** Better Auth social provider id → Atlas catalog provider key. */
export const SOCIAL_PROVIDER_MAP: Record<string, string> = {
  apple: 'apple',
  atlassian: 'atlassian',
  cloudflare: 'cloudflare',
  cognito: 'cognito',
  discord: 'discord',
  dropbox: 'dropbox',
  facebook: 'facebook',
  figma: 'figma',
  github: 'github',
  gitlab: 'gitlab',
  google: 'google',
  huggingface: 'huggingface',
  kakao: 'kakao',
  kick: 'kick',
  line: 'line',
  linear: 'linear',
  linkedin: 'linkedin',
  microsoft: 'microsoft',
  naver: 'naver',
  notion: 'notion',
  paybin: 'paybin',
  paypal: 'paypal',
  railway: 'railway',
  reddit: 'reddit',
  roblox: 'roblox',
  salesforce: 'salesforce',
  slack: 'slack',
  spotify: 'spotify',
  tiktok: 'tiktok',
  twitch: 'twitch',
  twitter: 'x',
  vercel: 'vercel',
  vk: 'vk',
  wechat: 'wechat',
  zoom: 'zoom',
};

/**
 * Social providers Better Auth ships that have no same-named Atlas catalog
 * entry: they become custom OAuth providers with these endpoints.
 */
const CUSTOM_SOCIAL: Record<string, { display: string; protocol: 'oauth2' | 'oidc'; authorize: string; token: string; userinfo: string; scopes: string[] }> = {
  polar: {
    display: 'Polar',
    protocol: 'oauth2',
    authorize: 'https://polar.sh/oauth2/authorize',
    token: 'https://api.polar.sh/v1/oauth2/token',
    userinfo: 'https://api.polar.sh/v1/oauth2/userinfo',
    scopes: ['openid', 'profile', 'email'],
  },
};

/** Better Auth `genericOAuth` helper presets → Atlas catalog providers. */
const GENERIC_PRESETS: Record<string, string> = {
  okta: 'okta',
  auth0: 'auth0',
  microsoftEntraId: 'microsoft',
  slack: 'slack',
  line: 'line',
};

/** Better Auth endpoint path → Atlas rate-limit group. */
const RATE_LIMIT_GROUPS: Array<[RegExp, string]> = [
  [/^\/sign-in\/(email|username|social|oauth2|anonymous|phone-number|email-otp)/, 'sign_in'],
  [/^\/sign-in\/magic-link/, 'code_send'],
  [/^\/sign-in/, 'sign_in'],
  [/^\/sign-up/, 'sign_up'],
  [/^\/(forget-password|request-password-reset|reset-password|forget-password\/email-otp|email-otp\/reset-password)/, 'password_reset'],
  [/^\/(send-verification-email|email-otp\/send-verification-otp|phone-number\/send-otp|phone-number\/request-password-reset)/, 'code_send'],
  [/^\/(verify-email|email-otp\/verify-email|phone-number\/verify|two-factor\/verify|two-factor\/)/, 'credential_verify'],
  [/^\/(get-session|list-sessions|token|jwks)/, 'session_tokens'],
  [/^\/siwe\//, 'wallet_sign_in'],
  [/^\/(change-password|change-email|update-user|delete-user|link-social|unlink-account|passkey\/)/, 'account_changes'],
];

const CAPTCHA_PROVIDERS: Record<string, string> = {
  'cloudflare-turnstile': 'turnstile',
  'google-recaptcha': 'recaptcha',
  hcaptcha: 'hcaptcha',
  captchafox: 'captchafox',
  'vercel-botid': 'vercel_botid',
};

/** Payment plugins by package → Atlas billing provider. */
const PAYMENT_PACKAGES: Array<[RegExp, string]> = [
  [/^@better-auth\/stripe$/, 'stripe'],
  [/^@polar-sh\/better-auth/, 'polar'],
  [/^autumn-js\/better-auth|^@useautumn\//, 'autumn'],
  [/^@dodopayments\/better-auth/, 'dodo'],
  [/^@creem_io\/better-auth|^creem\/better-auth/, 'creem'],
  [/chargebee/, 'chargebee'],
  [/^@commet\//, 'commet'],
];

/** Better Auth's built-in organization roles → Atlas system roles. */
const BUILTIN_ORG_ROLES: Record<string, string> = { owner: 'org:admin', admin: 'org:admin', member: 'org:member' };

/** Built-in organization statements → Atlas system permissions. */
const BUILTIN_STATEMENT_PERMS: Record<string, Record<string, string>> = {
  organization: { update: 'org:sys_profile:manage', delete: 'org:sys_profile:manage' },
  member: { create: 'org:sys_memberships:manage', update: 'org:sys_memberships:manage', delete: 'org:sys_memberships:manage' },
  invitation: { create: 'org:sys_memberships:manage', cancel: 'org:sys_memberships:manage' },
  team: { create: 'org:sys_memberships:manage', update: 'org:sys_memberships:manage', delete: 'org:sys_memberships:manage' },
  ac: { read: 'org:sys_memberships:read' },
};

const DAY = 86_400;
const MIN_IDLE_S = 300;
const MAX_ABSOLUTE_S = 90 * DAY;

// ───────────────────────────── the builder ─────────────────────────────

class Builder {
  readonly authConfig: Record<string, Json> = {};
  readonly doc: ConfigDocument = {
    instance: { auth_config: this.authConfig },
    oauth_providers: [],
    custom_oauth_providers: [],
    permissions: [],
    roles: [],
    oauth_clients: [],
    resource_servers: [],
    billing_plans: [],
    redirect_urls: [],
    jwt_templates: [],
  };
  readonly report: ReportEntry[] = [];
  readonly env = new Map<string, string>();
  readonly secrets: Translation['secrets'] = [];
  readonly providers: Record<string, string> = {};
  readonly roles: Record<string, string> = {};
  readonly plugins: string[] = [];
  origins: string[] = [];

  constructor(readonly fallbackLoc: SourceLoc) {}

  set(path: string, value: Json): void {
    const parts = path.split('.');
    let node: Record<string, Json> = this.authConfig;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (!next || typeof next !== 'object' || Array.isArray(next)) node[part] = {};
      node = node[part] as Record<string, Json>;
    }
    node[parts[parts.length - 1]!] = value;
  }

  get(path: string): Json | undefined {
    let node: Json | undefined = this.authConfig;
    for (const part of path.split('.')) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
      node = (node as Record<string, Json>)[part];
    }
    return node;
  }

  add(status: ReportStatus, area: string, option: string, note: string, at?: StaticValue | SourceLoc, atlas?: string): void {
    const loc = !at ? this.fallbackLoc : 'kind' in at ? at.loc : at;
    this.report.push({ status, area, option, ...(atlas ? { atlas } : {}), note, file: loc.file, line: loc.line });
  }

  /**
   * A config string for a value: a literal stays, an env var becomes `${NAME}`.
   * Anything else becomes a `${fallback}` placeholder and a manual entry.
   */
  configString(v: StaticValue | undefined, purpose: string, fallback: string, opts: { secret?: boolean; area: string; option: string }): string {
    if (v?.kind === 'string') {
      if (opts.secret) {
        this.add('manual', opts.area, opts.option, `A secret is hard-coded in source. It was not copied: set ${fallback} in the environment before applying, and move the secret out of the code.`, v);
        this.env.set(fallback, purpose);
        return `\${${fallback}}`;
      }
      return v.value;
    }
    if (v?.kind === 'env') {
      this.env.set(v.name, purpose);
      return `\${${v.name}}`;
    }
    if (v?.kind === 'template' && v.parts.every((p) => typeof p === 'string' || p.kind === 'env')) {
      return v.parts
        .map((p) => {
          if (typeof p === 'string') return p;
          if (p.kind !== 'env') return '';
          this.env.set(p.name, purpose);
          return `\${${p.name}}`;
        })
        .join('');
    }
    this.env.set(fallback, purpose);
    this.add(
      'manual',
      opts.area,
      opts.option,
      v ? `The value cannot be read statically (${describe(v)}); set ${fallback} in the environment before applying.` : `No value found; set ${fallback} in the environment before applying.`,
      v,
    );
    return `\${${fallback}}`;
  }
}

function describe(v: StaticValue): string {
  switch (v.kind) {
    case 'unknown':
      return `${v.reason}: ${v.text}`;
    case 'call':
      return `the result of ${v.callee}()`;
    case 'function':
      return 'a function';
    case 'param':
      return `a parameter (${[v.name, ...v.path].join('.')})`;
    case 'external':
      return `${v.name} from ${v.module}`;
    default:
      return v.kind;
  }
}

const num = (v: StaticValue | undefined): number | undefined => (v?.kind === 'number' ? v.value : undefined);
const bool = (v: StaticValue | undefined): boolean | undefined => (v?.kind === 'boolean' ? v.value : undefined);
const str = (v: StaticValue | undefined): string | undefined => (v?.kind === 'string' ? v.value : undefined);
const isFn = (v: StaticValue | undefined): boolean => v?.kind === 'function';
const present = (v: StaticValue | undefined): v is StaticValue => v !== undefined && v.kind !== 'undefined';
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** `'15m'`, `'7d'`, `'1h'`, `'30s'` or a number (seconds) → seconds. */
function durationSeconds(v: StaticValue | undefined): number | undefined {
  if (v?.kind === 'number') return v.value;
  if (v?.kind !== 'string') return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)?\s*$/i.exec(v.value);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase()[0];
  const mult = unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? DAY : unit === 'w' ? 7 * DAY : 1;
  return Math.round(n * mult);
}

function slug(text: string, max = 48): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (s || 'custom').slice(0, max);
}

/** A Better Auth role / resource name → the `[a-z][a-z0-9_]{1,31}` segment Atlas keys use. */
function keySegment(text: string): string {
  let s = slug(text, 32);
  if (!/^[a-z]/.test(s)) s = `r_${s}`;
  if (s.startsWith('sys_')) s = `app_${s}`;
  if (s.length < 2) s = `${s}_role`;
  return s.slice(0, 32);
}

// ───────────────────────────── entry point ─────────────────────────────

export function translateBetterAuth(analysis: BetterAuthAnalysis): Translation {
  const [first, ...rest] = analysis.instances;
  const fallbackLoc = first?.loc ?? { file: '(none)', line: 0 };
  const b = new Builder(fallbackLoc);

  if (!first) {
    b.add('manual', 'setup', 'betterAuth()', 'No betterAuth({...}) call was found. Point the command at the folder (or file) that creates your Better Auth instance.');
    return finish(b, analysis, null, []);
  }
  for (const other of rest) {
    b.add('manual', 'setup', 'betterAuth()', `Another betterAuth() call is here; only the one at ${first.loc.file}:${first.loc.line} was translated. Pass --entry <file> to pick one.`, other.loc);
  }
  for (const err of analysis.parseErrors) {
    b.add('manual', 'setup', 'parse', `This file could not be parsed (${err.message}); options defined in it were not read.`, { file: err.file, line: 1 });
  }

  const opts = first.options;
  if (opts.kind !== 'object') {
    b.add('manual', 'setup', 'betterAuth(options)', `The options cannot be read statically (${describe(opts)}).`, opts);
    return finish(b, analysis, first.loc, rest.map((r) => r.loc));
  }
  for (const spread of opts.unresolvedSpreads) {
    b.add('manual', 'setup', '...spread', `Options spread from a value that cannot be read (${describe(spread)}); review those options by hand.`, spread);
  }

  translateTopLevel(b, opts);
  translateEmailAndPassword(b, opts);
  translateEmailVerification(b, opts);
  translateSocialProviders(b, opts);
  translateSession(b, opts);
  translateAccount(b, opts);
  translateUser(b, opts);
  translateRateLimit(b, opts);
  translateAdvanced(b, opts);
  translateTrustedOrigins(b, opts);
  translateHooks(b, opts);
  translatePlugins(b, opts, analysis);

  return finish(b, analysis, first.loc, rest.map((r) => r.loc));
}

function finish(b: Builder, analysis: BetterAuthAnalysis, source: SourceLoc | null, others: SourceLoc[]): Translation {
  const opts = analysis.instances[0]?.options;
  const advanced = propOf(opts, 'advanced');
  const prefix = str(propOf(advanced, 'cookiePrefix')) ?? 'better-auth';
  const secret = propOf(opts, 'secret');
  const sessionExpires = num(propOf(propOf(opts, 'session'), 'expiresIn')) ?? 7 * DAY;
  if (b.origins.length) b.doc.instance.allowed_origins = [...new Set(b.origins)];
  return {
    source,
    otherInstances: others,
    document: b.doc,
    report: b.report,
    env: [...b.env.entries()].map(([name, purpose]) => ({ name, for: purpose })).sort((x, y) => (x.name < y.name ? -1 : 1)),
    secrets: b.secrets,
    mappings: { providers: b.providers, roles: b.roles },
    bridge: {
      cookiePrefix: prefix,
      sessionCookie: `${prefix}.session_token`,
      // Better Auth reads BETTER_AUTH_SECRET (or AUTH_SECRET) when `secret` is not set.
      secretEnv: secret?.kind === 'env' ? secret.name : secret ? null : 'BETTER_AUTH_SECRET',
      expiresInSeconds: sessionExpires,
    },
    plugins: b.plugins,
  };
}

// ───────────────────────────── top level ─────────────────────────────

function translateTopLevel(b: Builder, opts: StaticValue): void {
  const appName = propOf(opts, 'appName');
  if (appName) {
    b.add('manual', 'general', 'appName', `Set the application name and branding in the Atlas dashboard (${str(appName) ? `"${str(appName)}"` : 'value from code'}); it is shown on hosted pages and in emails.`, appName);
  }
  const baseURL = propOf(opts, 'baseURL');
  if (baseURL) {
    const origin = originOf(b, baseURL, 'baseURL');
    if (origin) b.origins.push(origin);
    b.add('mapped', 'general', 'baseURL', 'Added to the allowed origins. Atlas serves the auth endpoints itself, so there is no base path to configure.', baseURL, 'instance allowed_origins');
  }
  const basePath = propOf(opts, 'basePath');
  if (basePath) b.add('mapped', 'general', 'basePath', 'Not needed: Atlas hosts the auth endpoints. Remove the Better Auth route handler after the cutover (the code rewrite reports it).', basePath);
  if (propOf(opts, 'secret') || propOf(opts, 'secrets')) {
    b.add('mapped', 'general', 'secret', 'Atlas signs its own sessions with per-instance keys; the Better Auth secret is only used by the session bridge during the cutover window.', propOf(opts, 'secret') ?? propOf(opts, 'secrets'));
  }
  const database = propOf(opts, 'database');
  if (database) b.add('mapped', 'general', 'database', 'Atlas stores users and sessions itself. Your Better Auth database is the source of the export; keep it until the cutover is complete.', database);
  if (propOf(opts, 'secondaryStorage')) b.add('mapped', 'general', 'secondaryStorage', 'Not needed: Atlas runs its own session and rate-limit storage.', propOf(opts, 'secondaryStorage'));
  const disabledPaths = propOf(opts, 'disabledPaths');
  if (disabledPaths) b.add('manual', 'general', 'disabledPaths', 'Atlas has no per-path switch; turn the matching sign-in method or feature off in auth_config instead.', disabledPaths);
  if (propOf(opts, 'onAPIError')) b.add('manual', 'general', 'onAPIError', 'Error pages are Atlas-hosted; route custom handling through your app (the SDK returns typed errors).', propOf(opts, 'onAPIError'));
  if (propOf(opts, 'logger') || propOf(opts, 'telemetry')) b.add('mapped', 'general', 'logger', 'Atlas keeps an audit log and streams it (audit streams); no logger option is needed.', propOf(opts, 'logger') ?? propOf(opts, 'telemetry'));
  if (propOf(opts, 'experimental')) b.add('manual', 'general', 'experimental', 'Experimental Better Auth flags have no Atlas counterpart; review them.', propOf(opts, 'experimental'));
}

function originOf(b: Builder, v: StaticValue, option: string): string | null {
  if (v.kind === 'string') {
    try {
      return new URL(v.value).origin;
    } catch {
      b.add('manual', 'general', option, `"${v.value}" is not a URL.`, v);
      return null;
    }
  }
  if (v.kind === 'env' || v.kind === 'template') {
    return b.configString(v, 'your app origin (allowed origins)', 'APP_ORIGIN', { area: 'general', option });
  }
  if (v.kind === 'object') {
    // Dynamic base URL: { allowedHosts: [...] }
    const hosts = propOf(v, 'allowedHosts');
    const list = hosts?.kind === 'array' ? hosts.items.map(str).filter((h): h is string => Boolean(h)) : [];
    for (const h of list) b.origins.push(h.includes('://') ? h : `https://${h}`);
    return null;
  }
  b.add('manual', 'general', option, `Cannot read the base URL (${describe(v)}); add your app origin to allowed_origins.`, v);
  return null;
}

// ───────────────────────────── email & password ─────────────────────────────

function translateEmailAndPassword(b: Builder, opts: StaticValue): void {
  const area = 'emailAndPassword';
  const ep = propOf(opts, 'emailAndPassword');
  const enabled = bool(propOf(ep, 'enabled'));
  b.set('strategies.password', enabled === true);
  if (!ep) {
    b.add('mapped', area, 'emailAndPassword', 'Not configured, so password sign-in is off in Atlas too.', undefined, 'auth_config.strategies.password');
    return;
  }
  b.add('mapped', area, 'emailAndPassword.enabled', `Password sign-in ${enabled ? 'on' : 'off'}.`, propOf(ep, 'enabled') ?? ep, 'auth_config.strategies.password');

  const requireVerification = bool(propOf(ep, 'requireEmailVerification'));
  b.set('requireEmailVerification', requireVerification === true);
  b.add(
    'mapped',
    area,
    'emailAndPassword.requireEmailVerification',
    requireVerification
      ? 'Sign-up completes only after the address is proven.'
      : 'Off (the Better Auth default): sign-up completes at once and the address stays unverified until it is proven; Atlas reports it as unverified (email_verified false) until then.',
    propOf(ep, 'requireEmailVerification') ?? ep,
    'auth_config.requireEmailVerification',
  );

  const minLen = propOf(ep, 'minPasswordLength');
  if (minLen) {
    const n = num(minLen);
    if (n === undefined) b.add('manual', area, 'emailAndPassword.minPasswordLength', `Cannot read the value (${describe(minLen)}).`, minLen);
    else if (n < 8) {
      b.set('passwordPolicy.minLength', 8);
      b.add('differs', area, 'emailAndPassword.minPasswordLength', `Better Auth allows ${n}; Atlas requires at least 8. Existing shorter passwords still sign in; new ones need 8.`, minLen, 'auth_config.passwordPolicy.minLength');
    } else {
      b.set('passwordPolicy.minLength', n);
      b.add('mapped', area, 'emailAndPassword.minPasswordLength', `${n}.`, minLen, 'auth_config.passwordPolicy.minLength');
    }
  }
  const maxLen = propOf(ep, 'maxPasswordLength');
  if (maxLen) {
    const n = num(maxLen);
    if (n === undefined) b.add('manual', area, 'emailAndPassword.maxPasswordLength', `Cannot read the value (${describe(maxLen)}).`, maxLen);
    else {
      b.set('passwordPolicy.maxLength', clamp(n, 8, 256));
      b.add(n > 256 ? 'differs' : 'mapped', area, 'emailAndPassword.maxPasswordLength', n > 256 ? `Atlas caps passwords at 256 characters (Better Auth: ${n}).` : `${n}.`, maxLen, 'auth_config.passwordPolicy.maxLength');
    }
  }
  if (propOf(ep, 'disableSignUp')) {
    if (bool(propOf(ep, 'disableSignUp'))) {
      b.add('manual', area, 'emailAndPassword.disableSignUp', 'Better Auth closes password sign-up only. In Atlas, sign-up is closed for every method with signUpMode "restricted" (invitations and the allowlist still work); or keep it public and turn sign-up off per social provider (allow_sign_up).', propOf(ep, 'disableSignUp'), 'auth_config.signUpMode');
    }
  }
  const autoSignIn = propOf(ep, 'autoSignIn');
  if (autoSignIn && bool(autoSignIn) === false) {
    b.add('differs', area, 'emailAndPassword.autoSignIn', 'Atlas signs the user in when sign-up completes. To make people sign in again after sign-up, sign them out from your post-sign-up page.', autoSignIn);
  }
  const reset = propOf(ep, 'sendResetPassword');
  if (reset) {
    b.set('accountUx.passwordReset', 'link');
    b.add('differs', area, 'emailAndPassword.sendResetPassword', 'Atlas sends the reset email itself through your email provider, as a link (as Better Auth does). Customise the "password reset" email template instead of this function; switch accountUx.passwordReset to "code" for a one-time code.', reset, 'auth_config.accountUx.passwordReset');
  }
  const resetTtl = num(propOf(ep, 'resetPasswordTokenExpiresIn'));
  if (resetTtl !== undefined) {
    b.add('differs', area, 'emailAndPassword.resetPasswordTokenExpiresIn', `Reset links use the email-link lifetime (verification.magicLink.ttlMinutes), shared with sign-in links. Better Auth: ${Math.round(resetTtl / 60)} min.`, propOf(ep, 'resetPasswordTokenExpiresIn'), 'auth_config.verification.magicLink.ttlMinutes');
    if (b.get('verification.magicLink.ttlMinutes') === undefined) b.set('verification.magicLink.ttlMinutes', clamp(Math.ceil(resetTtl / 60), 1, 1440));
  }
  // Better Auth ends a reset at the sign-in screen; Atlas defaults to signing in.
  b.set('signInAfterReset', false);
  b.add('mapped', area, 'emailAndPassword (reset)', 'A completed password reset ends at the sign-in screen, as in Better Auth.', ep, 'auth_config.signInAfterReset');
  const revoke = propOf(ep, 'revokeSessionsOnPasswordReset');
  if (revoke && bool(revoke) === false) {
    b.add('differs', area, 'emailAndPassword.revokeSessionsOnPasswordReset', 'Atlas always ends the other sessions when a password is reset.', revoke);
  } else if (revoke) {
    b.add('mapped', area, 'emailAndPassword.revokeSessionsOnPasswordReset', 'Atlas ends the other sessions on reset.', revoke);
  }
  if (propOf(ep, 'onPasswordReset')) {
    b.add('manual', area, 'emailAndPassword.onPasswordReset', 'Move this logic to a webhook on the password-change event (user.updated) or an Action.', propOf(ep, 'onPasswordReset'));
  }
  const password = propOf(ep, 'password');
  if (password && (propOf(password, 'hash') || propOf(password, 'verify'))) {
    b.add('manual', area, 'emailAndPassword.password.hash', 'Custom hashing: Atlas imports scrypt (the Better Auth default), bcrypt and Argon2id hashes as they are. For any other scheme, use lazy migration (a verify endpoint Atlas calls on first sign-in).', password);
  }
  if (propOf(ep, 'onExistingUserSignUp') || propOf(ep, 'customSyntheticUser')) {
    b.add('mapped', area, 'emailAndPassword.onExistingUserSignUp', 'Atlas never reveals whether an address is registered on sign-up (a duplicate sign-up is answered like a new one).', propOf(ep, 'onExistingUserSignUp') ?? propOf(ep, 'customSyntheticUser'));
  }
}

function translateEmailVerification(b: Builder, opts: StaticValue): void {
  const area = 'emailVerification';
  const ev = propOf(opts, 'emailVerification');
  if (!ev) return;
  if (propOf(ev, 'sendVerificationEmail')) {
    b.set('accountUx.emailVerification', 'link');
    b.add('differs', area, 'emailVerification.sendVerificationEmail', 'Atlas sends the verification email itself (a link, as Better Auth does) through your own email provider. Customise the "verify email" template instead of this function; set accountUx.emailVerification to "code" or "both" to send a code.', propOf(ev, 'sendVerificationEmail'), 'auth_config.accountUx.emailVerification');
  }
  const expires = num(propOf(ev, 'expiresIn'));
  if (expires !== undefined) {
    b.set('verification.magicLink.ttlMinutes', clamp(Math.ceil(expires / 60), 1, 1440));
    b.add('mapped', area, 'emailVerification.expiresIn', `${Math.round(expires / 60)} min link lifetime.`, propOf(ev, 'expiresIn'), 'auth_config.verification.magicLink.ttlMinutes');
  }
  const onSignUp = propOf(ev, 'sendOnSignUp');
  if (onSignUp) b.add('mapped', area, 'emailVerification.sendOnSignUp', 'Atlas sends the proof during sign-up.', onSignUp);
  const onSignIn = propOf(ev, 'sendOnSignIn');
  if (onSignIn) b.add('mapped', area, 'emailVerification.sendOnSignIn', 'An unverified user signing in is asked to prove the address.', onSignIn);
  const auto = propOf(ev, 'autoSignInAfterVerification');
  if (auto) {
    b.add(bool(auto) ? 'mapped' : 'differs', area, 'emailVerification.autoSignInAfterVerification', bool(auto) ? 'Verifying completes the sign-up and signs the user in.' : 'Atlas signs the user in once the address is verified during sign-up.', auto);
  }
  for (const hook of ['beforeEmailVerification', 'afterEmailVerification', 'onEmailVerification'] as const) {
    const h = propOf(ev, hook);
    if (h) b.add('manual', area, `emailVerification.${hook}`, 'Move this logic to a webhook on email verification (user.updated) or a post-registration Action.', h);
  }
}

// ───────────────────────────── social providers ─────────────────────────────

function translateSocialProviders(b: Builder, opts: StaticValue): void {
  const sp = propOf(opts, 'socialProviders');
  const keys: string[] = [];
  if (sp?.kind === 'object') {
    for (const [id, cfg] of Object.entries(sp.props)) {
      const key = translateSocialProvider(b, id, cfg);
      if (key) keys.push(key);
    }
    for (const spread of sp.unresolvedSpreads) {
      b.add('manual', 'socialProviders', 'socialProviders', `Providers spread from a value that cannot be read (${describe(spread)}).`, spread);
    }
  } else if (sp) {
    b.add('manual', 'socialProviders', 'socialProviders', `Cannot read the providers (${describe(sp)}).`, sp);
  }
  b.set('strategies.oauthProviders', keys);
}

function translateSocialProvider(b: Builder, id: string, cfg: StaticValue): string | null {
  const area = 'socialProviders';
  const option = `socialProviders.${id}`;
  if (cfg.kind !== 'object') {
    b.add('manual', area, option, `Cannot read this provider's options (${describe(cfg)}).`, cfg);
    return null;
  }
  const upper = id.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
  const enabled = bool(propOf(cfg, 'enabled'));
  const clientId = b.configString(propOf(cfg, 'clientId'), `${id} client id`, `${upper}_CLIENT_ID`, { area, option: `${option}.clientId` });
  const scopes = propOf(cfg, 'scope') ?? propOf(cfg, 'scopes');
  const scopeList = scopes?.kind === 'array' ? scopes.items.map(str).filter((s): s is string => Boolean(s)) : undefined;
  const disableSignUp = bool(propOf(cfg, 'disableSignUp')) === true || bool(propOf(cfg, 'disableImplicitSignUp')) === true;

  const custom = CUSTOM_SOCIAL[id];
  if (custom) {
    const providerKey = `${id}_sh`.slice(0, 48);
    b.providers[id] = providerKey;
    const secret = b.configString(propOf(cfg, 'clientSecret'), `${id} client secret`, `${upper}_CLIENT_SECRET`, { area, option: `${option}.clientSecret`, secret: true });
    b.doc.custom_oauth_providers.push({
      provider_key: providerKey,
      display_name: custom.display,
      protocol: custom.protocol,
      authorization_endpoint: custom.authorize,
      token_endpoint: custom.token,
      userinfo_endpoint: custom.userinfo,
      scopes: scopeList ?? custom.scopes,
      client_id: clientId,
      client_secret: secret,
      enabled: enabled !== false,
      allow_sign_in: true,
      allow_sign_up: !disableSignUp,
    });
    b.add('differs', area, option, `Atlas has no built-in "${id}" provider with these endpoints; it becomes the custom OAuth provider "${providerKey}". Register its redirect_uri (shown on the provider) in your ${custom.display} app.`, cfg, `custom_oauth_providers ${providerKey}`);
    return providerKey;
  }

  const atlasKey = SOCIAL_PROVIDER_MAP[id];
  if (!atlasKey) {
    b.add('manual', area, option, `"${id}" is not a Better Auth provider Atlas knows. Configure it as a custom OAuth provider (custom_oauth_providers) with its endpoints.`, cfg);
    return null;
  }
  b.providers[id] = atlasKey;
  const entry: Record<string, Json> = {
    provider: atlasKey,
    enabled: enabled !== false,
    allow_sign_in: true,
    allow_sign_up: !disableSignUp,
    client_id: clientId,
  };
  if (atlasKey === 'apple') {
    entry.values = {
      team_id: '${APPLE_TEAM_ID}',
      key_id: '${APPLE_KEY_ID}',
      private_key: '${APPLE_PRIVATE_KEY}',
    };
    b.env.set('APPLE_TEAM_ID', 'Sign in with Apple team id');
    b.env.set('APPLE_KEY_ID', 'Sign in with Apple key id');
    b.env.set('APPLE_PRIVATE_KEY', 'Sign in with Apple .p8 key contents');
    b.add('differs', area, `${option}.clientSecret`, 'Atlas builds the Apple client secret itself from your team id, key id and .p8 key (no pre-generated JWT); set APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY. Keep the same Services ID so Apple user ids stay the same.', propOf(cfg, 'clientSecret') ?? cfg, `oauth_providers ${atlasKey}`);
    if (propOf(cfg, 'appBundleIdentifier')) b.add('manual', area, `${option}.appBundleIdentifier`, 'Add the iOS app to auth_config.nativeApps (appleAppIds) for native Sign in with Apple.', propOf(cfg, 'appBundleIdentifier'), 'auth_config.nativeApps.appleAppIds');
  } else {
    entry.client_secret = b.configString(propOf(cfg, 'clientSecret'), `${id} client secret`, `${upper}_CLIENT_SECRET`, { area, option: `${option}.clientSecret`, secret: true });
  }
  if (scopeList?.length) entry.scopes = scopeList;
  const values: Record<string, Json> = (entry.values as Record<string, Json>) ?? {};
  if (atlasKey === 'microsoft') {
    const tenant = propOf(cfg, 'tenantId');
    if (tenant) {
      values.tenant = b.configString(tenant, 'Microsoft tenant id', 'MICROSOFT_TENANT_ID', { area, option: `${option}.tenantId` });
      b.add('mapped', area, `${option}.tenantId`, 'Tenant restriction kept.', tenant, `oauth_providers microsoft (tenant)`);
    }
  }
  if (atlasKey === 'cognito') {
    const domain = propOf(cfg, 'domain');
    if (domain) values.domain = b.configString(domain, 'Cognito domain', 'COGNITO_DOMAIN', { area, option: `${option}.domain` });
    else b.add('manual', area, option, 'Set the Cognito user pool domain on the provider.', cfg);
  }
  if (atlasKey === 'google') {
    const hd = propOf(cfg, 'hd') ?? propOf(propOf(cfg, 'authorizationParams') ?? propOf(cfg, 'params'), 'hd');
    if (hd) values.hosted_domain = b.configString(hd, 'Google Workspace domain', 'GOOGLE_HOSTED_DOMAIN', { area, option: `${option}.hd` });
    if (propOf(cfg, 'accessType') || propOf(cfg, 'prompt')) {
      b.add('mapped', area, `${option}.accessType`, 'Atlas asks Google for offline access (refresh tokens) by default.', propOf(cfg, 'accessType') ?? propOf(cfg, 'prompt'));
    }
  }
  if (Object.keys(values).length) entry.values = values;
  b.doc.oauth_providers.push(entry);
  b.add(
    'mapped',
    area,
    option,
    `Keep the same OAuth app so imported accounts relink by provider user id. Add Atlas's callback URL (redirect_uri on the provider) to the app's allowed redirect URLs.`,
    cfg,
    `oauth_providers ${atlasKey}`,
  );
  if (disableSignUp) b.add('mapped', area, `${option}.disableSignUp`, 'Sign-up through this provider is off (sign-in still works).', propOf(cfg, 'disableSignUp') ?? propOf(cfg, 'disableImplicitSignUp'), `oauth_providers ${atlasKey} allow_sign_up`);
  const redirect = propOf(cfg, 'redirectURI');
  if (redirect) b.add('manual', area, `${option}.redirectURI`, 'Atlas receives the callback on its own domain. To keep this exact redirect URI, set a custom redirect URI on the provider in Atlas (on a domain you verify) that forwards to Atlas.', redirect);
  for (const fnKey of ['mapProfileToUser', 'getUserInfo', 'verifyIdToken', 'refreshAccessToken']) {
    const fn = propOf(cfg, fnKey);
    if (fn) b.add('manual', area, `${option}.${fnKey}`, fnKey === 'mapProfileToUser' ? 'Built-in providers use Atlas\'s profile mapping; move extra profile fields into user metadata with a post-login Action.' : 'Atlas runs this step itself for built-in providers; remove the override.', fn);
  }
  if (propOf(cfg, 'overrideUserInfoOnSignIn')) b.add('differs', area, `${option}.overrideUserInfoOnSignIn`, 'Atlas fills empty profile fields from the provider; to overwrite on every sign-in, use a post-login Action.', propOf(cfg, 'overrideUserInfoOnSignIn'));
  return atlasKey;
}

// ───────────────────────────── session ─────────────────────────────

function translateSession(b: Builder, opts: StaticValue): void {
  const area = 'session';
  const s = propOf(opts, 'session');
  const expires = num(propOf(s, 'expiresIn')) ?? 7 * DAY;
  const noRefresh = bool(propOf(s, 'disableSessionRefresh')) === true;
  const loc = propOf(s, 'expiresIn') ?? s;
  if (noRefresh) {
    const abs = clamp(expires, MIN_IDLE_S, MAX_ABSOLUTE_S);
    b.set('session.absoluteMs', abs * 1000);
    b.set('session.idleMs', abs * 1000);
    b.set('session.idleTimeout', false);
    b.add(abs === expires ? 'mapped' : 'differs', area, 'session.expiresIn + disableSessionRefresh', `A fixed lifetime of ${humanDuration(abs)} that activity does not extend${abs !== expires ? ` (Better Auth: ${humanDuration(expires)}; Atlas allows 5 minutes to 90 days)` : ''}.`, loc, 'auth_config.session.absoluteMs');
  } else {
    const idle = clamp(expires, MIN_IDLE_S, MAX_ABSOLUTE_S);
    b.set('session.idleMs', idle * 1000);
    b.set('session.idleTimeout', true);
    b.set('session.absoluteMs', MAX_ABSOLUTE_S * 1000);
    b.add(
      'differs',
      area,
      'session.expiresIn',
      `Better Auth extends a session by ${humanDuration(expires)} whenever it is used and never caps it. Atlas keeps the same inactivity window (idleMs ${humanDuration(idle)}) and adds an absolute cap, set to the maximum of 90 days; lower absoluteMs for a stricter policy.`,
      loc ?? undefined,
      'auth_config.session.idleMs / absoluteMs',
    );
  }
  const updateAge = propOf(s, 'updateAge');
  if (updateAge) b.add('mapped', area, 'session.updateAge', 'Atlas extends the inactivity window on every authenticated request; no refresh interval is needed.', updateAge);
  const freshAge = propOf(s, 'freshAge');
  if (freshAge) {
    const n = num(freshAge);
    if (n === 0) {
      b.set('stepUp.enabled', false);
      b.add('mapped', area, 'session.freshAge', 'Freshness checks off: step-up re-authentication stays off.', freshAge, 'auth_config.stepUp.enabled');
    } else if (n !== undefined) {
      const win = clamp(n, 30, DAY);
      b.set('stepUp.enabled', true);
      b.set('stepUp.windowMs', win * 1000);
      b.add(win === n ? 'mapped' : 'differs', area, 'session.freshAge', `Sensitive actions need a sign-in within ${humanDuration(win)} (Atlas step-up)${win !== n ? `; Atlas allows 30 seconds to 1 day (Better Auth: ${humanDuration(n)})` : ''}.`, freshAge, 'auth_config.stepUp');
    }
  }
  const cache = propOf(s, 'cookieCache');
  if (cache) {
    const maxAge = num(propOf(cache, 'maxAge'));
    const ttl = clamp(maxAge ?? 300, 30, 900);
    b.set('session.jwtTtlSeconds', ttl);
    b.add('differs', area, 'session.cookieCache', `Atlas's short-lived session token plays the role of the cookie cache: it is verified without a database read and refreshed every ${ttl}s (Atlas allows 30-900 s)${propOf(cache, 'strategy') ? '; the token is always a signed JWT' : ''}.`, cache, 'auth_config.session.jwtTtlSeconds');
  }
  for (const k of ['storeSessionInDatabase', 'preserveSessionInDatabase', 'deferSessionRefresh'] as const) {
    if (propOf(s, k)) b.add('mapped', area, `session.${k}`, 'Atlas stores sessions itself; nothing to configure.', propOf(s, k));
  }
  const fields = propOf(s, 'additionalFields');
  if (fields) b.add('manual', area, 'session.additionalFields', 'Store per-session data with the session custom data API (session.customData) and set it from a post-login Action.', fields, 'auth_config.session.customData');
}

function humanDuration(seconds: number): string {
  if (seconds % DAY === 0) return `${seconds / DAY} day${seconds === DAY ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

// ───────────────────────────── account / user ─────────────────────────────

function translateAccount(b: Builder, opts: StaticValue): void {
  const area = 'account';
  const acc = propOf(opts, 'account');
  const linking = propOf(acc, 'accountLinking');
  if (linking) {
    const enabled = bool(propOf(linking, 'enabled'));
    const implicitOff = bool(propOf(linking, 'disableImplicitLinking')) === true;
    if (enabled === false || implicitOff) {
      b.set('accountLinking', 'block');
      b.add('mapped', area, enabled === false ? 'account.accountLinking.enabled' : 'account.accountLinking.disableImplicitLinking', 'A social sign-in whose email belongs to an existing account is refused and names the existing method; users link accounts from their profile.', propOf(linking, enabled === false ? 'enabled' : 'disableImplicitLinking'), 'auth_config.accountLinking');
    } else {
      b.set('accountLinking', 'auto');
      b.add('mapped', area, 'account.accountLinking', 'A social sign-in with a verified email that matches an existing account links to it.', linking, 'auth_config.accountLinking');
    }
    const trusted = propOf(linking, 'trustedProviders');
    if (trusted?.kind === 'array') {
      const trust: Record<string, Json> = {};
      for (const item of trusted.items) {
        const id = str(item);
        if (!id) continue;
        if (id === 'email-password' || id === 'credential') continue;
        const key = SOCIAL_PROVIDER_MAP[id] ?? b.providers[id] ?? slug(id);
        trust[key] = 'always';
      }
      b.set('accountLinkingTrust', trust);
      b.add('mapped', area, 'account.accountLinking.trustedProviders', `These providers link even when they do not assert a verified email: ${Object.keys(trust).join(', ') || '(none)'}.`, trusted, 'auth_config.accountLinkingTrust');
    } else if (trusted) {
      b.add('manual', area, 'account.accountLinking.trustedProviders', `Cannot read the list (${describe(trusted)}); set accountLinkingTrust by hand.`, trusted);
    }
    const requireLocal = propOf(linking, 'requireLocalEmailVerified');
    if (requireLocal) b.add('mapped', area, 'account.accountLinking.requireLocalEmailVerified', 'Atlas only auto-links to an account whose own address is proven.', requireLocal);
    const differentEmails = propOf(linking, 'allowDifferentEmails');
    if (differentEmails) b.add(bool(differentEmails) ? 'mapped' : 'differs', area, 'account.accountLinking.allowDifferentEmails', 'A signed-in user can connect a provider account with a different email from their profile; automatic linking always needs a matching email.', differentEmails);
    const unlinkAll = propOf(linking, 'allowUnlinkingAll');
    if (unlinkAll) b.add('differs', area, 'account.accountLinking.allowUnlinkingAll', 'Atlas never lets a user remove their last way to sign in.', unlinkAll);
    const updateOnLink = propOf(linking, 'updateUserInfoOnLink');
    if (updateOnLink) b.add('differs', area, 'account.accountLinking.updateUserInfoOnLink', 'Atlas fills empty profile fields on link; use a post-login Action to overwrite.', updateOnLink);
  }
  if (propOf(acc, 'encryptOAuthTokens')) b.add('mapped', area, 'account.encryptOAuthTokens', 'Atlas always encrypts stored provider tokens.', propOf(acc, 'encryptOAuthTokens'));
  if (propOf(acc, 'updateAccountOnSignIn')) b.add('mapped', area, 'account.updateAccountOnSignIn', 'Provider tokens are refreshed on every sign-in.', propOf(acc, 'updateAccountOnSignIn'));
  for (const k of ['skipStateCookieCheck', 'storeStateStrategy', 'storeAccountCookie'] as const) {
    if (propOf(acc, k)) b.add('mapped', area, `account.${k}`, 'Atlas runs the OAuth state handling itself.', propOf(acc, k));
  }
}

function translateUser(b: Builder, opts: StaticValue): void {
  const area = 'user';
  const user = propOf(opts, 'user');
  if (!user) return;
  const fields = propOf(user, 'additionalFields');
  if (fields?.kind === 'object') {
    const traits: Json[] = [];
    for (const [key, def] of Object.entries(fields.props)) {
      const type = str(propOf(def, 'type'));
      const traitKey = /^[a-zA-Z][\w.-]{0,63}$/.test(key) ? key : null;
      if (!traitKey) {
        b.add('manual', area, `user.additionalFields.${key}`, 'The field name is not a valid metadata key; rename it in the import.', def);
        continue;
      }
      const trait: Record<string, Json> = { key: traitKey };
      if (type === 'string' || type === 'number' || type === 'boolean') trait.type = type;
      else if (def.kind === 'object' && propOf(def, 'type')?.kind === 'array') {
        const values = (propOf(def, 'type') as Extract<StaticValue, { kind: 'array' }>).items.map(str).filter((s): s is string => Boolean(s));
        trait.type = 'enum';
        trait.enum = values;
      } else {
        b.add('manual', area, `user.additionalFields.${key}`, `Type "${type ?? describe(propOf(def, 'type') ?? def)}" has no typed trait; the value is still imported into public metadata.`, def);
        continue;
      }
      if (bool(propOf(def, 'required'))) trait.required = true;
      trait.userEditable = bool(propOf(def, 'input')) !== false;
      traits.push(trait);
      b.add('mapped', area, `user.additionalFields.${key}`, `Typed trait "${traitKey}" on the user's public metadata${trait.userEditable ? '' : ' (not editable by the user)'}.`, def, 'auth_config.identityTraits');
    }
    if (traits.length) b.set('identityTraits.traits', traits);
  } else if (fields) {
    b.add('manual', area, 'user.additionalFields', `Cannot read the fields (${describe(fields)}); they are imported into public metadata.`, fields);
  }
  if (propOf(user, 'changeEmail')) b.add('mapped', area, 'user.changeEmail', 'Users change their email from the account page; the new address is proven first.', propOf(user, 'changeEmail'));
  const del = propOf(user, 'deleteUser');
  if (del) {
    b.add('mapped', area, 'user.deleteUser', 'Users can delete their account from the account page; deletion has a grace period (compliance.retention).', del);
    for (const k of ['sendDeleteAccountVerification', 'beforeDelete', 'afterDelete'] as const) {
      if (propOf(del, k)) b.add('manual', area, `user.deleteUser.${k}`, 'Move this to a webhook on user.deleted.', propOf(del, k));
    }
  }
  if (propOf(user, 'modelName') || propOf(user, 'fields')) b.add('mapped', area, 'user.modelName', 'Custom table and column names are read by the exporter from your Better Auth config.', propOf(user, 'modelName') ?? propOf(user, 'fields'));
  if (propOf(user, 'validateUserInfo')) b.add('manual', area, 'user.validateUserInfo', 'Move this check to a pre-user-registration Action (and post-login for sign-ins).', propOf(user, 'validateUserInfo'));
}

// ───────────────────────────── rate limits ─────────────────────────────

function translateRateLimit(b: Builder, opts: StaticValue): void {
  const area = 'rateLimit';
  const rl = propOf(opts, 'rateLimit');
  if (!rl) return;
  if (bool(propOf(rl, 'enabled')) === false) {
    b.add('differs', area, 'rateLimit.enabled', 'Atlas always rate-limits its auth endpoints.', propOf(rl, 'enabled'));
  }
  if (propOf(rl, 'window') || propOf(rl, 'max')) {
    b.add('differs', area, 'rateLimit.window/max', `Atlas applies per-endpoint-group defaults instead of one global rule (Better Auth: ${num(propOf(rl, 'max')) ?? 100} per ${num(propOf(rl, 'window')) ?? 10}s).`, propOf(rl, 'window') ?? propOf(rl, 'max'));
  }
  const custom = propOf(rl, 'customRules');
  const rules = new Map<string, { windowSeconds: number; max: number; key: string }>();
  if (custom?.kind === 'object') {
    for (const [path, rule] of Object.entries(custom.props)) {
      const option = `rateLimit.customRules["${path}"]`;
      const group = RATE_LIMIT_GROUPS.find(([re]) => re.test(path))?.[1];
      if (!group) {
        b.add('manual', area, option, 'No matching Atlas endpoint group; Atlas applies its default for this endpoint.', rule);
        continue;
      }
      if (rule.kind === 'boolean' && rule.value === false) {
        b.add('differs', area, option, `Atlas cannot switch off rate limiting for ${group}; the default applies.`, rule);
        continue;
      }
      const windowS = num(propOf(rule, 'window'));
      const max = num(propOf(rule, 'max'));
      if (windowS === undefined || max === undefined) {
        b.add('manual', area, option, `Cannot read the rule (${describe(rule)}); set a rule for the "${group}" group by hand.`, rule, 'auth_config.rateLimit.rules');
        continue;
      }
      const next = { windowSeconds: clamp(Math.round(windowS), 1, 86_400), max: clamp(Math.round(max), 1, 1_000_000), key: 'ip' };
      const prev = rules.get(group);
      // Several Better Auth paths can share one Atlas group: keep the strictest rate.
      if (!prev || next.max / next.windowSeconds < prev.max / prev.windowSeconds) rules.set(group, next);
      b.add(prev ? 'differs' : 'mapped', area, option, prev ? `Shares the "${group}" group with another rule; the stricter one is kept.` : `"${group}" group: ${next.max} per ${next.windowSeconds}s per IP.`, rule, 'auth_config.rateLimit.rules');
    }
  } else if (custom) {
    b.add('manual', area, 'rateLimit.customRules', `Cannot read the rules (${describe(custom)}).`, custom);
  }
  if (rules.size) {
    b.set(
      'rateLimit.rules',
      [...rules.entries()].map(([group, r]) => ({ group, windowSeconds: r.windowSeconds, max: r.max, key: r.key })),
    );
  }
  if (propOf(rl, 'storage') || propOf(rl, 'customStorage')) b.add('mapped', area, 'rateLimit.storage', 'Atlas keeps its own rate-limit counters.', propOf(rl, 'storage') ?? propOf(rl, 'customStorage'));
}

// ───────────────────────────── advanced / origins ─────────────────────────────

function translateAdvanced(b: Builder, opts: StaticValue): void {
  const area = 'advanced';
  const adv = propOf(opts, 'advanced');
  const cross = propOf(adv, 'crossSubDomainCookies');
  if (cross) {
    const enabled = bool(propOf(cross, 'enabled'));
    b.set('session.crossSubdomainCookies', enabled === true);
    b.add('mapped', area, 'advanced.crossSubDomainCookies.enabled', `Session cookie ${enabled ? 'shared across' : 'not shared across'} subdomains.`, propOf(cross, 'enabled') ?? cross, 'auth_config.session.crossSubdomainCookies');
    if (propOf(cross, 'domain')) b.add('manual', area, 'advanced.crossSubDomainCookies.domain', 'The cookie domain follows your Atlas custom domain: add the custom domain (e.g. auth.your-domain.com) in the dashboard.', propOf(cross, 'domain'));
  } else {
    // Better Auth scopes its cookie to one host by default.
    b.set('session.crossSubdomainCookies', false);
  }
  if (!adv) return;
  const prefix = propOf(adv, 'cookiePrefix');
  if (prefix) b.add('differs', area, 'advanced.cookiePrefix', 'Atlas cookie names are fixed. The session bridge reads the old cookie under this prefix during the cutover window.', prefix);
  for (const k of ['cookies', 'defaultCookieAttributes', 'useSecureCookies'] as const) {
    if (propOf(adv, k)) b.add('differs', area, `advanced.${k}`, 'Atlas sets secure, HttpOnly, SameSite cookies itself; cookie names and attributes are not configurable.', propOf(adv, k));
  }
  for (const k of ['disableCSRFCheck', 'disableOriginCheck'] as const) {
    if (bool(propOf(adv, k))) b.add('differs', area, `advanced.${k}`, 'Atlas always checks the request origin against allowed_origins; add every origin that calls it.', propOf(adv, k), 'instance allowed_origins');
  }
  const ip = propOf(adv, 'ipAddress');
  if (ip) b.add('manual', area, 'advanced.ipAddress', 'Atlas reads the client IP from its edge. If requests reach Atlas through your own proxy (the proxy integration), configure the trusted proxy secret in the dashboard.', ip);
  if (propOf(adv, 'trustedProxyHeaders')) b.add('manual', area, 'advanced.trustedProxyHeaders', 'Configure the Atlas proxy integration for requests forwarded through your server.', propOf(adv, 'trustedProxyHeaders'));
  const db = propOf(adv, 'database');
  if (db) b.add('mapped', area, 'advanced.database', 'Atlas issues its own ids; every user keeps its Better Auth id as external_id.', db);
  if (propOf(adv, 'backgroundTasks')) b.add('mapped', area, 'advanced.backgroundTasks', 'Not needed: Atlas runs deferred work itself.', propOf(adv, 'backgroundTasks'));
}

function translateTrustedOrigins(b: Builder, opts: StaticValue): void {
  const area = 'trustedOrigins';
  const to = propOf(opts, 'trustedOrigins');
  if (!to) return;
  if (to.kind === 'function') {
    b.add('manual', area, 'trustedOrigins', 'A function decides the origins at runtime; list the origins in allowed_origins by hand.', to, 'instance allowed_origins');
    return;
  }
  if (to.kind !== 'array') {
    b.add('manual', area, 'trustedOrigins', `Cannot read the list (${describe(to)}).`, to);
    return;
  }
  for (const item of to.items) {
    if (item.kind === 'string') {
      const v = item.value.trim();
      if (/^https?:\/\//.test(v) || /^\*\./.test(v) || /^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/i.test(v)) {
        const origin = /^https?:\/\//.test(v) ? v.replace(/\/+$/, '') : `https://${v}`;
        b.origins.push(origin);
        const wildcard = origin.includes('*');
        b.add(wildcard ? 'differs' : 'mapped', area, `trustedOrigins "${v}"`, wildcard ? 'Wildcard kept. Atlas accepts one wildcard label under a domain you own (https://*.your-domain.com); open or shared-host wildcards are refused.' : 'Allowed origin.', item, 'instance allowed_origins');
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
        b.doc.redirect_urls.push({ url: v.includes('*') ? v.replace(/\*+$/, '') : v });
        b.add('differs', area, `trustedOrigins "${v}"`, 'An app scheme (native/Expo deep link) becomes a redirect URL. Add native apps under auth_config.nativeApps for passkeys and Sign in with Apple.', item, 'redirect_urls');
      } else {
        b.add('manual', area, `trustedOrigins "${v}"`, 'Not an origin Atlas can use; review it.', item);
      }
    } else if (item.kind === 'env' || item.kind === 'template') {
      b.origins.push(b.configString(item, 'a trusted origin', 'TRUSTED_ORIGIN', { area, option: 'trustedOrigins' }));
      b.add('mapped', area, 'trustedOrigins', 'Allowed origin from the environment (filled in at apply time).', item, 'instance allowed_origins');
    } else {
      b.add('manual', area, 'trustedOrigins', `Cannot read this entry (${describe(item)}).`, item);
    }
  }
}

// ───────────────────────────── hooks ─────────────────────────────

const DB_HOOK_TARGETS: Record<string, Record<string, string>> = {
  user: {
    'create.before': 'a pre-user-registration Action (can change or refuse the sign-up)',
    'create.after': 'a post-user-registration Action, or a webhook on user.created',
    'update.before': 'validation in your app before calling the update API, or an identity-trait schema',
    'update.after': 'a webhook on user.updated',
    'delete.before': 'your app (Atlas refuses nothing on delete), or a webhook on user.deleted',
    'delete.after': 'a webhook on user.deleted',
  },
  session: {
    'create.before': 'a post-login Action (can deny the sign-in)',
    'create.after': 'a post-login Action, or a webhook on session.created',
    'delete.after': 'a webhook on session.ended / session.revoked',
  },
  account: {
    'create.after': 'a webhook on user.updated (external account linked)',
  },
  verification: {},
};

function translateHooks(b: Builder, opts: StaticValue): void {
  const dbh = propOf(opts, 'databaseHooks');
  if (dbh?.kind === 'object') {
    for (const [model, ops] of Object.entries(dbh.props)) {
      if (ops.kind !== 'object') continue;
      for (const [op, phases] of Object.entries(ops.props)) {
        if (phases.kind !== 'object') continue;
        for (const [phase, fn] of Object.entries(phases.props)) {
          const target = DB_HOOK_TARGETS[model]?.[`${op}.${phase}`] ?? 'a webhook or Action (no direct equivalent: review it)';
          b.add('manual', 'databaseHooks', `databaseHooks.${model}.${op}.${phase}`, `Move this to ${target}.`, fn);
        }
      }
    }
  } else if (dbh) {
    b.add('manual', 'databaseHooks', 'databaseHooks', `Cannot read the hooks (${describe(dbh)}); move them to Actions and webhooks.`, dbh);
  }
  const hooks = propOf(opts, 'hooks');
  if (hooks) {
    for (const phase of ['before', 'after'] as const) {
      const h = propOf(hooks, phase);
      if (!h) continue;
      b.add('manual', 'hooks', `hooks.${phase}`, phase === 'before' ? 'Request hooks become Actions: pre-user-registration for sign-up checks, post-login to deny or enrich sign-ins.' : 'Post-request logic becomes a post-login Action or a webhook (user.created, session.created, …).', h);
    }
  }
}

// ───────────────────────────── plugins ─────────────────────────────

interface PluginCall {
  id: string;
  call: Extract<StaticValue, { kind: 'call' }>;
  options: StaticValue | undefined;
}

function identifyPlugin(v: StaticValue): PluginCall | null {
  if (v.kind !== 'call') return null;
  const name = v.imported?.name ?? v.callee.split('.').pop() ?? v.callee;
  const module = v.imported?.module ?? '';
  for (const [re, provider] of PAYMENT_PACKAGES) {
    if (re.test(module)) return { id: `payments:${provider}`, call: v, options: v.args[0] };
  }
  return { id: name, call: v, options: v.args[0] };
}

function translatePlugins(b: Builder, opts: StaticValue, analysis: BetterAuthAnalysis): void {
  const plugins = propOf(opts, 'plugins');
  // Methods Better Auth leaves off unless a plugin turns them on.
  b.set('strategies.emailCode', false);
  b.set('strategies.emailLink', false);
  b.set('strategies.passkey', false);
  b.set('strategies.phoneCode', false);
  b.set('strategies.username', false);
  b.set('strategies.anonymous', false);
  b.set('strategies.siwe', false);
  b.set('session.multiSession', false);
  b.set('mfa.factors.passkey', false);
  if (!plugins) return;
  if (plugins.kind !== 'array') {
    b.add('manual', 'plugins', 'plugins', `Cannot read the plugin list (${describe(plugins)}).`, plugins);
    return;
  }
  for (const item of plugins.items) {
    const plugin = identifyPlugin(item);
    if (!plugin) {
      b.add('manual', 'plugins', 'plugins[]', `A plugin entry cannot be read (${describe(item)}); review it by hand.`, item);
      continue;
    }
    b.plugins.push(plugin.id);
    const handler = PLUGIN_HANDLERS[plugin.id];
    if (handler) handler(b, plugin, analysis);
    else if (plugin.id.startsWith('payments:')) translatePayments(b, plugin);
    else b.add('manual', `plugin:${plugin.id}`, `${plugin.id}()`, `No Atlas mapping is known for this plugin${plugin.call.imported ? ` (${plugin.call.imported.module})` : ''}; review what it does.`, plugin.call);
  }
}

type PluginHandler = (b: Builder, p: PluginCall, analysis: BetterAuthAnalysis) => void;

const PLUGIN_HANDLERS: Record<string, PluginHandler> = {
  twoFactor(b, { options: o, call }) {
    const area = 'plugin:twoFactor';
    b.set('mfa.factors.totp', true);
    b.set('mfaPolicy', 'optional');
    b.add('mapped', area, 'twoFactor()', 'Authenticator-app (TOTP) second factor, optional per user. The exporter decrypts two-factor secrets in your app and seals them to the instance, so enrolled users keep their authenticator; with a plain JSON import (atlas import) they enrol again.', call, 'auth_config.mfa.factors.totp');
    const totp = propOf(o, 'totpOptions');
    const digits = num(propOf(totp, 'digits'));
    if (digits !== undefined) {
      const ok = digits === 6 || digits === 8;
      b.set('mfa.totp.digits', ok ? digits : 6);
      b.add(ok ? 'mapped' : 'differs', area, 'twoFactor.totpOptions.digits', ok ? `${digits} digits.` : `Atlas supports 6 or 8 digits; set to 6 (Better Auth: ${digits}).`, propOf(totp, 'digits'), 'auth_config.mfa.totp.digits');
    }
    const period = num(propOf(totp, 'period'));
    if (period !== undefined) {
      const ok = period === 30 || period === 60;
      b.set('mfa.totp.period', ok ? period : 30);
      b.add(ok ? 'mapped' : 'differs', area, 'twoFactor.totpOptions.period', ok ? `${period}s.` : `Atlas supports 30 or 60 seconds; set to 30 (Better Auth: ${period}).`, propOf(totp, 'period'), 'auth_config.mfa.totp.period');
    }
    const otp = propOf(o, 'otpOptions');
    if (propOf(otp, 'sendOTP')) {
      b.set('mfa.factors.emailCode', true);
      b.add('differs', area, 'twoFactor.otpOptions.sendOTP', 'One-time codes as a second factor: Atlas sends them by email through your email provider. If you sent them by SMS, turn on mfa.factors.sms (and configure your SMS provider) instead.', propOf(otp, 'sendOTP'), 'auth_config.mfa.factors.emailCode');
    }
    const backup = propOf(o, 'backupCodeOptions');
    const amount = num(propOf(backup, 'amount'));
    if (amount !== undefined) {
      b.set('mfa.backupCodes.count', clamp(amount, 1, 50));
      b.add('mapped', area, 'twoFactor.backupCodeOptions.amount', `${amount} backup codes.`, propOf(backup, 'amount'), 'auth_config.mfa.backupCodes.count');
    }
    if (propOf(backup, 'length') || propOf(backup, 'customBackupCodesGenerate')) b.add('differs', area, 'twoFactor.backupCodeOptions.length', 'Atlas generates backup codes in its own format.', propOf(backup, 'length') ?? propOf(backup, 'customBackupCodesGenerate'));
    const trust = propOf(o, 'trustDeviceMaxAge');
    const trustS = num(trust) ?? 30 * DAY;
    b.set('mfa.rememberDevice.enabled', true);
    b.set('mfa.rememberDevice.days', clamp(Math.round(trustS / DAY) || 1, 1, 365));
    b.add('mapped', area, 'twoFactor.trustDeviceMaxAge', `A trusted device skips the second factor for ${Math.round(trustS / DAY) || 1} day(s).`, trust ?? call, 'auth_config.mfa.rememberDevice');
    if (propOf(o, 'issuer')) b.add('differs', area, 'twoFactor.issuer', 'The authenticator-app label is your Atlas application name.', propOf(o, 'issuer'));
    if (propOf(o, 'skipVerificationOnEnable')) b.add('differs', area, 'twoFactor.skipVerificationOnEnable', 'Atlas always confirms a first code before turning two-factor on.', propOf(o, 'skipVerificationOnEnable'));
    if (propOf(o, 'allowPasswordless')) b.add('mapped', area, 'twoFactor.allowPasswordless', 'Passkeys and other passwordless methods can stand in where configured.', propOf(o, 'allowPasswordless'));
  },

  passkey(b, { options: o, call }) {
    const area = 'plugin:passkey';
    b.set('strategies.passkey', true);
    b.set('mfa.factors.passkey', true);
    b.add('mapped', area, 'passkey()', 'Passkey sign-in on.', call, 'auth_config.strategies.passkey');
    const rpID = propOf(o, 'rpID');
    b.add(
      'manual',
      area,
      'passkey.rpID',
      `A passkey works only on the relying-party id it was registered for${str(rpID) ? ` ("${str(rpID)}")` : ' (your app\'s domain)'}. Serve Atlas from a custom domain under that domain (e.g. auth.${str(rpID) ?? 'your-domain.com'}) so existing passkeys keep working; the import report lists the passkeys carried over.`,
      rpID ?? call,
    );
    if (propOf(o, 'origin')) b.add('mapped', area, 'passkey.origin', 'The allowed origins carry the WebAuthn origin check.', propOf(o, 'origin'), 'instance allowed_origins');
    if (propOf(o, 'rpName')) b.add('differs', area, 'passkey.rpName', 'The name shown in the passkey prompt is your Atlas application name.', propOf(o, 'rpName'));
    const sel = propOf(o, 'authenticatorSelection');
    const attach = str(propOf(sel, 'authenticatorAttachment'));
    if (attach === 'platform' || attach === 'cross-platform') {
      b.set('passkeyPolicy.attachment', attach);
      b.add('mapped', area, 'passkey.authenticatorSelection.authenticatorAttachment', `${attach} authenticators.`, propOf(sel, 'authenticatorAttachment'), 'auth_config.passkeyPolicy.attachment');
    }
    const uv = str(propOf(sel, 'userVerification'));
    if (uv) {
      b.set('passkeyPolicy.requireUserVerification', uv === 'required');
      b.add(uv === 'discouraged' ? 'differs' : 'mapped', area, 'passkey.authenticatorSelection.userVerification', uv === 'required' ? 'User verification required.' : 'User verification preferred, not required.', propOf(sel, 'userVerification'), 'auth_config.passkeyPolicy.requireUserVerification');
    }
    if (propOf(sel, 'residentKey')) b.add('mapped', area, 'passkey.authenticatorSelection.residentKey', 'Atlas registers discoverable passkeys.', propOf(sel, 'residentKey'));
  },

  magicLink(b, { options: o, call }) {
    const area = 'plugin:magicLink';
    b.set('strategies.emailLink', true);
    b.add('mapped', area, 'magicLink()', 'Email sign-in links on. Atlas sends them through your email provider; customise the "magic link" email template instead of sendMagicLink.', call, 'auth_config.strategies.emailLink');
    const ttl = num(propOf(o, 'expiresIn')) ?? 300;
    b.set('verification.magicLink.ttlMinutes', clamp(Math.ceil(ttl / 60), 1, 1440));
    b.add('mapped', area, 'magicLink.expiresIn', `${Math.ceil(ttl / 60)} min link lifetime (shared with verification and reset links).`, propOf(o, 'expiresIn') ?? call, 'auth_config.verification.magicLink.ttlMinutes');
    if (bool(propOf(o, 'disableSignUp'))) b.add('differs', area, 'magicLink.disableSignUp', 'Atlas cannot close sign-up for one method only; use signUpMode "restricted" to close it for every method.', propOf(o, 'disableSignUp'));
    if (propOf(o, 'generateToken') || propOf(o, 'storeToken')) b.add('differs', area, 'magicLink.generateToken', 'Atlas generates and stores link tokens itself (hashed).', propOf(o, 'generateToken') ?? propOf(o, 'storeToken'));
  },

  emailOTP(b, { options: o, call }) {
    const area = 'plugin:emailOTP';
    b.set('strategies.emailCode', true);
    b.add('mapped', area, 'emailOTP()', 'Email one-time-code sign-in on. Atlas sends the codes through your email provider; customise the email templates instead of sendVerificationOTP.', call, 'auth_config.strategies.emailCode');
    const len = num(propOf(o, 'otpLength'));
    if (len !== undefined) {
      b.set('verification.emailCode.length', clamp(len, 4, 10));
      b.add(len >= 4 && len <= 10 ? 'mapped' : 'differs', area, 'emailOTP.otpLength', `${clamp(len, 4, 10)} digits.`, propOf(o, 'otpLength'), 'auth_config.verification.emailCode.length');
    }
    const ttl = num(propOf(o, 'expiresIn'));
    if (ttl !== undefined) {
      const min = clamp(Math.ceil(ttl / 60), 1, 60);
      b.set('verification.emailCode.ttlMinutes', min);
      b.add(ttl / 60 <= 60 ? 'mapped' : 'differs', area, 'emailOTP.expiresIn', `${min} min code lifetime${ttl / 60 > 60 ? ' (Atlas maximum)' : ''}.`, propOf(o, 'expiresIn'), 'auth_config.verification.emailCode.ttlMinutes');
    }
    const attempts = num(propOf(o, 'allowedAttempts'));
    if (attempts !== undefined) {
      b.set('verification.emailCode.maxAttempts', clamp(attempts, 1, 10));
      b.add('mapped', area, 'emailOTP.allowedAttempts', `${clamp(attempts, 1, 10)} attempts.`, propOf(o, 'allowedAttempts'), 'auth_config.verification.emailCode.maxAttempts');
    }
    if (bool(propOf(o, 'overrideDefaultEmailVerification')) || bool(propOf(o, 'sendVerificationOnSignUp'))) {
      b.set('accountUx.emailVerification', 'code');
      b.add('mapped', area, 'emailOTP.overrideDefaultEmailVerification', 'Email verification uses a code instead of a link.', propOf(o, 'overrideDefaultEmailVerification') ?? propOf(o, 'sendVerificationOnSignUp'), 'auth_config.accountUx.emailVerification');
    }
    const resend = str(propOf(o, 'resendStrategy'));
    if (resend) {
      b.set('verification.emailCode.resendSameCode', resend === 'reuse');
      b.add('mapped', area, 'emailOTP.resendStrategy', resend === 'reuse' ? 'A resend repeats the same code.' : 'A resend issues a new code.', propOf(o, 'resendStrategy'), 'auth_config.verification.emailCode.resendSameCode');
    }
    if (bool(propOf(o, 'disableSignUp'))) b.add('differs', area, 'emailOTP.disableSignUp', 'Atlas cannot close sign-up for one method only; use signUpMode "restricted".', propOf(o, 'disableSignUp'));
    if (propOf(o, 'generateOTP') || propOf(o, 'storeOTP')) b.add('differs', area, 'emailOTP.generateOTP', 'Atlas generates and stores codes itself (hashed).', propOf(o, 'generateOTP') ?? propOf(o, 'storeOTP'));
    if (propOf(o, 'changeEmail')) b.add('mapped', area, 'emailOTP.changeEmail', 'An email change is proven with a code to the new address.', propOf(o, 'changeEmail'));
  },

  phoneNumber(b, { options: o, call }) {
    const area = 'plugin:phoneNumber';
    b.set('strategies.phoneCode', true);
    b.add('mapped', area, 'phoneNumber()', 'SMS code sign-in on. Configure your SMS provider (your own account) in Atlas; sendOTP is no longer used. Phone numbers and their verified state are imported.', call, 'auth_config.strategies.phoneCode');
    const len = num(propOf(o, 'otpLength'));
    if (len !== undefined) {
      b.set('verification.smsCode.length', clamp(len, 4, 10));
      b.add('mapped', area, 'phoneNumber.otpLength', `${clamp(len, 4, 10)} digits.`, propOf(o, 'otpLength'), 'auth_config.verification.smsCode.length');
    }
    const ttl = num(propOf(o, 'expiresIn'));
    if (ttl !== undefined) {
      b.set('verification.smsCode.ttlMinutes', clamp(Math.ceil(ttl / 60), 1, 60));
      b.add('mapped', area, 'phoneNumber.expiresIn', `${clamp(Math.ceil(ttl / 60), 1, 60)} min code lifetime.`, propOf(o, 'expiresIn'), 'auth_config.verification.smsCode.ttlMinutes');
    }
    const attempts = num(propOf(o, 'allowedAttempts'));
    if (attempts !== undefined) {
      b.set('verification.smsCode.maxAttempts', clamp(attempts, 1, 10));
      b.add('mapped', area, 'phoneNumber.allowedAttempts', `${clamp(attempts, 1, 10)} attempts.`, propOf(o, 'allowedAttempts'), 'auth_config.verification.smsCode.maxAttempts');
    }
    const signUp = propOf(o, 'signUpOnVerification');
    if (signUp) b.add('differs', area, 'phoneNumber.signUpOnVerification', 'A verified phone number signs up a new user with no email; Atlas does not need a temporary email (getTempEmail).', signUp);
    if (propOf(o, 'phoneNumberValidator')) b.add('differs', area, 'phoneNumber.phoneNumberValidator', 'Atlas validates numbers as E.164; restrict countries with attackProtection.countries or smsPumping prefixes.', propOf(o, 'phoneNumberValidator'));
  },

  username(b, { options: o, call }) {
    const area = 'plugin:username';
    b.set('strategies.username', true);
    b.add('mapped', area, 'username()', 'Username sign-in on; usernames are imported.', call, 'auth_config.strategies.username');
    const min = num(propOf(o, 'minUsernameLength'));
    const max = num(propOf(o, 'maxUsernameLength'));
    b.set('accountUx.username.minLength', clamp(min ?? 3, 1, 64));
    b.set('accountUx.username.maxLength', clamp(max ?? 30, clamp(min ?? 3, 1, 64), 64));
    b.add(max !== undefined && max > 64 ? 'differs' : 'mapped', area, 'username.minUsernameLength/maxUsernameLength', `${clamp(min ?? 3, 1, 64)}-${clamp(max ?? 30, 1, 64)} characters${max !== undefined && max > 64 ? ' (Atlas maximum 64)' : ''}.`, propOf(o, 'minUsernameLength') ?? propOf(o, 'maxUsernameLength') ?? call, 'auth_config.accountUx.username');
    if (propOf(o, 'usernameValidator')) b.add('differs', area, 'username.usernameValidator', 'Atlas validates with a character set: pick "default" (letters, digits, . _ -), "alphanumeric" or "alphanumeric_underscore" (accountUx.username.charset).', propOf(o, 'usernameValidator'), 'auth_config.accountUx.username.charset');
    if (propOf(o, 'usernameNormalization')) b.add('differs', area, 'username.usernameNormalization', 'Atlas compares usernames case-insensitively.', propOf(o, 'usernameNormalization'));
    if (propOf(o, 'displayUsernameValidator') || propOf(o, 'displayUsernameNormalization')) b.add('manual', area, 'username.displayUsername', 'displayUsername is imported into public metadata (displayUsername).', propOf(o, 'displayUsernameValidator') ?? propOf(o, 'displayUsernameNormalization'));
  },

  anonymous(b, { options: o, call }) {
    const area = 'plugin:anonymous';
    b.set('strategies.anonymous', true);
    b.add('mapped', area, 'anonymous()', 'Guest (anonymous) sign-in on; a guest who signs up keeps their user.', call, 'auth_config.strategies.anonymous');
    if (propOf(o, 'onLinkAccount')) b.add('manual', area, 'anonymous.onLinkAccount', 'Move this to a webhook on user.updated (a guest upgraded to a full account) or a post-login Action.', propOf(o, 'onLinkAccount'));
    if (propOf(o, 'emailDomainName') || propOf(o, 'generateRandomEmail')) b.add('mapped', area, 'anonymous.emailDomainName', 'Atlas guests have no placeholder email.', propOf(o, 'emailDomainName') ?? propOf(o, 'generateRandomEmail'));
    if (propOf(o, 'disableDeleteAnonymousUser')) b.add('differs', area, 'anonymous.disableDeleteAnonymousUser', 'Atlas keeps the guest user and upgrades it in place when it signs up.', propOf(o, 'disableDeleteAnonymousUser'));
  },

  organization(b, { options: o, call }) {
    translateOrganization(b, o, call);
  },

  admin(b, { options: o, call }) {
    const area = 'plugin:admin';
    b.add('mapped', area, 'admin()', 'User management, bans and sessions are in the Atlas dashboard and Backend API (users list/ban/unban/delete, sessions revoke). Bans are imported.', call);
    const defaultRole = str(propOf(o, 'defaultRole')) ?? 'user';
    const adminRoles = propOf(o, 'adminRoles');
    const roles = new Set<string>([defaultRole, 'admin']);
    if (adminRoles?.kind === 'array') {
      for (const r of adminRoles.items) {
        const name = str(r);
        if (name) roles.add(name);
      }
    } else if (str(adminRoles)) {
      roles.add(str(adminRoles)!);
    }
    const custom = propOf(o, 'roles');
    if (custom?.kind === 'object') {
      for (const r of Object.keys(custom.props)) roles.add(r);
    }
    const existing = (b.get('identityTraits.traits') as Json[] | undefined) ?? [];
    if (!existing.some((t) => (t as Record<string, Json>).key === 'role')) {
      b.set('identityTraits.traits', [...existing, { key: 'role', type: 'enum', enum: [...roles], userEditable: false }]);
    }
    b.add('differs', area, 'admin.roles', `Application roles (${[...roles].join(', ')}) are kept on each user as public_metadata.role (a typed, read-only trait), so your checks read it from the session token's metadata. Atlas roles proper are organization roles.`, custom ?? adminRoles ?? call, 'auth_config.identityTraits (role)');
    if (propOf(o, 'adminUserIds')) b.add('manual', area, 'admin.adminUserIds', 'Give these people dashboard access (team members) or set their role trait to an admin role after the import.', propOf(o, 'adminUserIds'));
    if (propOf(o, 'ac')) b.add('manual', area, 'admin.ac', 'Access-control statements for app roles have no instance-level equivalent; enforce them in your app from the role trait.', propOf(o, 'ac'));
    const imp = propOf(o, 'impersonationSessionDuration');
    b.add('differs', area, 'admin.impersonation', `Impersonation uses actor tokens (POST /v1/actor_tokens, or "Impersonate" in the dashboard); the session carries an act claim${num(imp) ? `. Set the actor token lifetime per request (Better Auth: ${humanDuration(num(imp)!)})` : ''}.`, imp ?? call);
    if (propOf(o, 'allowImpersonatingAdmins')) b.add('differs', area, 'admin.allowImpersonatingAdmins', 'Who may impersonate is decided by who can create actor tokens (your secret key holders and dashboard admins).', propOf(o, 'allowImpersonatingAdmins'));
    for (const k of ['defaultBanReason', 'defaultBanExpiresIn', 'bannedUserMessage'] as const) {
      if (propOf(o, k)) b.add('differs', area, `admin.${k}`, k === 'bannedUserMessage' ? 'The banned message is localised text on the hosted pages.' : 'Pass the reason / expiry on each ban call.', propOf(o, k));
    }
  },

  apiKey(b, { options: o, call }) {
    const area = 'plugin:apiKey';
    b.set('endUserApiKeys.selfServiceEnabled', true);
    b.add('mapped', area, 'apiKey()', 'End-user API keys (users manage their own keys; servers verify them with the Backend API). Existing keys are stored hashed and cannot be carried over: users create new ones.', call, 'auth_config.endUserApiKeys.selfServiceEnabled');
    const prefix = str(propOf(o, 'defaultPrefix'));
    if (prefix) {
      const cleaned = prefix.replace(/[^A-Za-z0-9_]/g, '').replace(/_+$/, '').slice(0, 32);
      if (cleaned && /^[A-Za-z]/.test(cleaned)) {
        b.set('endUserApiKeys.keyPrefix', cleaned);
        b.add(cleaned === prefix ? 'mapped' : 'differs', area, 'apiKey.defaultPrefix', cleaned === prefix ? `Prefix "${prefix}".` : `Prefix "${cleaned}" (Atlas adds its own separator; Better Auth: "${prefix}").`, propOf(o, 'defaultPrefix'), 'auth_config.endUserApiKeys.keyPrefix');
      } else {
        b.add('manual', area, 'apiKey.defaultPrefix', `"${prefix}" is not a valid prefix (a letter, then letters, digits or _).`, propOf(o, 'defaultPrefix'));
      }
    }
    const exp = propOf(o, 'keyExpiration');
    const def = propOf(exp, 'defaultExpiresIn');
    if (def) {
      const ms = num(def);
      if (ms !== undefined) {
        b.set('endUserApiKeys.defaultExpiresInSeconds', clamp(Math.round(ms / 1000), 60, 10 * 365 * DAY));
        b.add('mapped', area, 'apiKey.keyExpiration.defaultExpiresIn', `Keys expire after ${humanDuration(Math.round(ms / 1000))} by default.`, def, 'auth_config.endUserApiKeys.defaultExpiresInSeconds');
      }
    }
    const maxDays = num(propOf(exp, 'maxExpiresIn'));
    if (maxDays !== undefined || bool(propOf(exp, 'disableCustomExpiresTime'))) {
      const maxS = maxDays !== undefined ? maxDays * DAY : (num(def) ?? 365 * DAY * 1000) / 1000;
      b.set('endUserApiKeys.maxExpiresInSeconds', clamp(Math.round(maxS), 60, 10 * 365 * DAY));
      b.add('mapped', area, 'apiKey.keyExpiration.maxExpiresIn', `Longest key lifetime ${humanDuration(Math.round(maxS))}.`, propOf(exp, 'maxExpiresIn') ?? propOf(exp, 'disableCustomExpiresTime'), 'auth_config.endUserApiKeys.maxExpiresInSeconds');
    }
    if (propOf(exp, 'minExpiresIn')) b.add('differs', area, 'apiKey.keyExpiration.minExpiresIn', 'Atlas accepts any lifetime from 60 seconds up.', propOf(exp, 'minExpiresIn'));
    const rl = propOf(o, 'rateLimit');
    if (rl) b.add('differs', area, 'apiKey.rateLimit', 'Per-key request quotas (remaining / refill) are not enforced by Atlas; count requests in your API or with the entitlements usage API.', rl);
    const refs = str(propOf(o, 'references'));
    if (refs === 'organization') {
      b.set('endUserApiKeys.allowOrganizationKeys', true);
      b.add('mapped', area, 'apiKey.references', 'Organization-owned keys on.', propOf(o, 'references'), 'auth_config.endUserApiKeys.allowOrganizationKeys');
    }
    if (propOf(o, 'enableSessionForAPIKeys')) b.add('differs', area, 'apiKey.enableSessionForAPIKeys', 'An API key is verified with the Backend API (api_keys verify), not turned into a session.', propOf(o, 'enableSessionForAPIKeys'));
    if (propOf(o, 'permissions')) b.add('manual', area, 'apiKey.permissions', 'Key permissions become scopes: list them in endUserApiKeys.allowedScopes.', propOf(o, 'permissions'), 'auth_config.endUserApiKeys.allowedScopes');
    if (propOf(o, 'enableMetadata')) b.add('mapped', area, 'apiKey.enableMetadata', 'Keys carry claims (endUserApiKeys.allowedClaimNames).', propOf(o, 'enableMetadata'));
    if (propOf(o, 'apiKeyHeaders')) b.add('manual', area, 'apiKey.apiKeyHeaders', 'Your server reads the key from whichever header it likes and verifies it with the Backend API.', propOf(o, 'apiKeyHeaders'));
  },

  jwt(b, { options: o, call }) {
    const area = 'plugin:jwt';
    b.add('mapped', area, 'jwt()', 'Every Atlas session is a signed JWT with a public JWKS. Point services that verified Better Auth JWTs at the Atlas JWKS (/.well-known/jwks.json on your Frontend API host).', call);
    const jwt = propOf(o, 'jwt');
    const aud = propOf(jwt, 'audience');
    if (aud) {
      const v = aud.kind === 'array' ? aud.items.map(str).filter((s): s is string => Boolean(s)) : str(aud);
      if (v) {
        b.set('session.audience', v as Json);
        b.add('mapped', area, 'jwt.jwt.audience', 'Session tokens carry this audience.', aud, 'auth_config.session.audience');
      }
    }
    const exp = durationSeconds(propOf(jwt, 'expirationTime'));
    if (exp !== undefined) {
      const ttl = clamp(exp, 30, 900);
      b.set('session.jwtTtlSeconds', ttl);
      b.add(ttl === exp ? 'mapped' : 'differs', area, 'jwt.jwt.expirationTime', `Session tokens live ${ttl}s and are refreshed automatically by the SDKs${ttl !== exp ? ` (Atlas allows 30-900 s; Better Auth: ${exp}s). For a longer-lived token for another service, use a JWT template with its own lifetime` : ''}.`, propOf(jwt, 'expirationTime'), 'auth_config.session.jwtTtlSeconds');
    }
    if (propOf(jwt, 'issuer')) b.add('differs', area, 'jwt.jwt.issuer', 'The issuer is your Atlas Frontend API URL; update verifiers to accept it.', propOf(jwt, 'issuer'));
    const definePayload = propOf(jwt, 'definePayload');
    if (definePayload) {
      b.add('manual', area, 'jwt.jwt.definePayload', 'Custom claims become the "session" JWT template (claims built from user fields and metadata); add them under jwt_templates.', definePayload, 'jwt_templates session');
    }
    if (propOf(jwt, 'getSubject')) b.add('differs', area, 'jwt.jwt.getSubject', 'sub is the Atlas user id; the Better Auth id is in the external_id claim.', propOf(jwt, 'getSubject'));
    const jwks = propOf(o, 'jwks');
    const alg = str(propOf(propOf(jwks, 'keyPairConfig'), 'alg'));
    if (alg) b.add(alg === 'RS256' ? 'mapped' : 'differs', area, 'jwt.jwks.keyPairConfig.alg', alg === 'RS256' ? 'RS256.' : `Atlas signs sessions with RS256 (Better Auth: ${alg}); JWT templates can use HS256.`, propOf(propOf(jwks, 'keyPairConfig'), 'alg'));
    if (propOf(jwks, 'rotationInterval')) b.add('mapped', area, 'jwt.jwks.rotationInterval', 'Rotate signing keys from the dashboard or Backend API (old keys stay published during the overlap).', propOf(jwks, 'rotationInterval'));
  },

  bearer(b, { call }) {
    b.add('mapped', 'plugin:bearer', 'bearer()', 'Atlas SDKs send the session token as an Authorization: Bearer header for API calls; servers verify it with authenticateRequest().', call);
  },

  multiSession(b, { options: o, call }) {
    b.set('session.multiSession', true);
    b.add('mapped', 'plugin:multiSession', 'multiSession()', 'Several accounts signed in on one browser, with an account switcher.', call, 'auth_config.session.multiSession');
    if (propOf(o, 'maximumSessions')) b.add('differs', 'plugin:multiSession', 'multiSession.maximumSessions', 'Atlas does not cap the accounts per browser. session.maxConcurrentSessions caps sessions per user instead.', propOf(o, 'maximumSessions'));
  },

  oneTap(b, { options: o, call }) {
    const area = 'plugin:oneTap';
    b.add('mapped', area, 'oneTap()', 'Google One Tap works with the Google provider (the sign-in component shows it when Google is on).', call, 'oauth_providers google');
    if (!b.doc.oauth_providers.some((p) => (p as Record<string, Json>).provider === 'google')) {
      b.add('manual', area, 'oneTap.clientId', 'Configure the Google provider (same OAuth client as One Tap) so One Tap has a client id.', propOf(o, 'clientId') ?? call, 'oauth_providers google');
    }
    if (bool(propOf(o, 'disableSignup'))) b.add('differs', area, 'oneTap.disableSignup', 'Set allow_sign_up false on the Google provider (applies to every Google sign-in).', propOf(o, 'disableSignup'));
  },

  siwe(b, { options: o, call }) {
    const area = 'plugin:siwe';
    b.set('strategies.siwe', true);
    b.add('mapped', area, 'siwe()', 'Sign-In with Ethereum on; wallet addresses are imported.', call, 'auth_config.strategies.siwe');
    const domain = propOf(o, 'domain');
    if (domain) {
      const d = b.configString(domain, 'SIWE domain', 'SIWE_DOMAIN', { area, option: 'siwe.domain' });
      b.doc.oauth_providers.push({ provider: 'siwe', settings: { domain: d } });
      b.add('mapped', area, 'siwe.domain', 'Message domain kept.', domain, 'oauth_providers siwe settings.domain');
    }
    if (propOf(o, 'ensLookup')) b.add('mapped', area, 'siwe.ensLookup', 'Atlas resolves ENS names and avatars for wallet users.', propOf(o, 'ensLookup'));
    if (propOf(o, 'getNonce') || propOf(o, 'verifyMessage')) b.add('mapped', area, 'siwe.verifyMessage', 'Atlas issues nonces and verifies signatures itself (incl. smart-contract wallets).', propOf(o, 'getNonce') ?? propOf(o, 'verifyMessage'));
    if (propOf(o, 'anonymous') !== undefined && bool(propOf(o, 'anonymous')) === false) b.add('differs', area, 'siwe.anonymous', 'Atlas lets wallet users sign up without an email; require one with an identity trait if needed.', propOf(o, 'anonymous'));
  },

  captcha(b, { options: o, call }) {
    const area = 'plugin:captcha';
    const provider = str(propOf(o, 'provider'));
    let atlasProvider = provider ? CAPTCHA_PROVIDERS[provider] : undefined;
    const minScore = num(propOf(o, 'minScore'));
    if (provider === 'google-recaptcha' && minScore !== undefined) atlasProvider = 'recaptcha_v3';
    if (!atlasProvider) {
      b.add('manual', area, 'captcha.provider', `Unknown captcha provider "${provider ?? describe(propOf(o, 'provider') ?? call)}". Atlas supports Turnstile, hCaptcha, reCAPTCHA v2/v3/Enterprise, CaptchaFox, Vercel BotID and more.`, propOf(o, 'provider') ?? call);
      return;
    }
    const captcha: Record<string, Json> = { provider: atlasProvider };
    const siteKey = propOf(o, 'siteKey');
    if (atlasProvider !== 'vercel_botid') {
      captcha.siteKey = siteKey ? b.configString(siteKey, 'captcha site key', 'CAPTCHA_SITE_KEY', { area, option: 'captcha.siteKey' }) : '${CAPTCHA_SITE_KEY}';
      if (!siteKey) {
        b.env.set('CAPTCHA_SITE_KEY', 'captcha site key (the public key your sign-in form used)');
        b.add('manual', area, 'captcha.siteKey', 'Better Auth only knows the secret; Atlas renders the widget itself, so set CAPTCHA_SITE_KEY to your public site key.', call);
      }
    }
    if (minScore !== undefined) captcha.minScore = minScore;
    const verify = propOf(o, 'siteVerifyURLOverride');
    if (verify) captcha.verifyUrl = b.configString(verify, 'captcha verify URL', 'CAPTCHA_VERIFY_URL', { area, option: 'captcha.siteVerifyURLOverride' });
    const endpoints = propOf(o, 'endpoints');
    const paths = endpoints?.kind === 'array' ? endpoints.items.map(str).filter((s): s is string => Boolean(s)) : ['/sign-up/email', '/sign-in/email', '/forget-password', '/request-password-reset'];
    const flows: Record<string, Json> = {};
    for (const p of paths) {
      if (p.startsWith('/sign-up')) flows.signUp = { enabled: true };
      else if (p.startsWith('/sign-in')) flows.signIn = { enabled: true };
      else if (/forget-password|request-password-reset|reset-password/.test(p)) flows.passwordReset = { enabled: true };
      else if (/anonymous/.test(p)) flows.guest = { enabled: true };
    }
    captcha.flows = flows;
    b.set('captcha', captcha);
    b.add('mapped', area, 'captcha()', `${atlasProvider} on ${Object.keys(flows).join(', ') || 'no flows'}.`, call, 'auth_config.captcha');
    const secret = propOf(o, 'secretKey');
    if (secret?.kind === 'env') {
      b.secrets.push({ kind: 'captcha_secret', provider: atlasProvider, env: secret.name });
      b.add('mapped', area, 'captcha.secretKey', `Stored write-only from ${secret.name} before the captcha is turned on.`, secret, 'PUT /v1/instance/captcha_secret');
    } else {
      b.secrets.push({ kind: 'captcha_secret', provider: atlasProvider, env: 'CAPTCHA_SECRET_KEY' });
      b.add('manual', area, 'captcha.secretKey', secret?.kind === 'string' ? 'The secret is hard-coded in source; it was not copied. Set CAPTCHA_SECRET_KEY before applying.' : 'Set CAPTCHA_SECRET_KEY before applying; it is stored write-only.', secret ?? call, 'PUT /v1/instance/captcha_secret');
    }
  },

  haveIBeenPwned(b, { options: o, call }) {
    b.set('passwordPolicy.checkBreaches', true);
    b.add('mapped', 'plugin:haveIBeenPwned', 'haveIBeenPwned()', 'Breached passwords are refused (k-anonymity range check).', call, 'auth_config.passwordPolicy.checkBreaches');
    if (propOf(o, 'customPasswordCompromisedMessage')) b.add('differs', 'plugin:haveIBeenPwned', 'haveIBeenPwned.customPasswordCompromisedMessage', 'Change the message through localization overrides.', propOf(o, 'customPasswordCompromisedMessage'));
  },

  customSession(b, { call }) {
    b.add('manual', 'plugin:customSession', 'customSession()', 'Extra session fields become claims in the "session" JWT template (from user fields and metadata), or session custom data set by a post-login Action. Clients read them with useSession() / auth().', call, 'jwt_templates session');
  },

  genericOAuth(b, { options: o, call }) {
    translateGenericOAuth(b, o, call);
  },

  sso(b, { options: o, call }) {
    const area = 'plugin:sso';
    b.add('mapped', area, 'sso()', 'Enterprise SSO (SAML 2.0 and OIDC) per organization, with domain verification and JIT provisioning.', call, 'sso_connections');
    b.add('manual', area, 'sso providers', 'SSO connections registered at runtime live in your database (ssoProvider). Recreate each one in Atlas (dashboard, Backend API or the sso_connections config file) on its organization, and ask the IdP admin to add the Atlas ACS / redirect URL.', call, 'sso_connections');
    const defaults = propOf(o, 'defaultSSO');
    if (defaults?.kind === 'array') {
      for (const d of defaults.items) {
        const domain = str(propOf(d, 'domain'));
        const pid = str(propOf(d, 'providerId'));
        b.add('manual', area, `sso.defaultSSO ${pid ?? domain ?? ''}`.trim(), `Create this ${propOf(d, 'samlConfig') ? 'SAML' : 'OIDC'} connection in Atlas${domain ? ` with allowed domain ${domain}` : ''} and attach it to its organization.`, d, 'sso_connections');
      }
    }
    if (propOf(o, 'provisionUser') || propOf(o, 'organizationProvisioning')) b.add('mapped', area, 'sso.provisionUser', 'JIT provisioning and organization seating are per connection (default role, claim → role mapping); custom logic goes to a post-login Action.', propOf(o, 'provisionUser') ?? propOf(o, 'organizationProvisioning'));
    if (propOf(o, 'domainVerification')) b.add('mapped', area, 'sso.domainVerification', 'Organizations verify their domains in Atlas (DNS TXT).', propOf(o, 'domainVerification'));
    if (bool(propOf(o, 'trustEmailVerified'))) b.add('differs', area, 'sso.trustEmailVerified', 'Atlas treats emails on a verified domain of the connection as verified.', propOf(o, 'trustEmailVerified'));
  },

  oidcProvider(b, { options: o, call }) {
    translateOAuthServer(b, o, call, 'oidcProvider');
  },
  oauthProvider(b, { options: o, call }) {
    translateOAuthServer(b, o, call, 'oauthProvider');
  },
  mcp(b, { options: o, call }) {
    const area = 'plugin:mcp';
    b.set('oauthProvider.dynamicRegistration', true);
    b.set('oauthProvider.requirePkce', true);
    b.add('mapped', area, 'mcp()', 'MCP clients register dynamically and authorize with PKCE against Atlas as the OAuth server; your MCP server verifies Atlas access tokens (protected-resource metadata points at Atlas).', call, 'auth_config.oauthProvider');
    const resource = propOf(o, 'resource');
    if (resource) {
      const id = b.configString(resource, 'MCP resource identifier', 'MCP_RESOURCE_URL', { area, option: 'mcp.resource' });
      b.doc.resource_servers.push({ identifier: id, name: 'MCP server', scopes: ['openid', 'profile', 'email', 'offline_access'] });
      b.add('mapped', area, 'mcp.resource', 'The MCP server is an API (resource server) Atlas issues tokens for.', resource, 'resource_servers');
    }
    if (propOf(o, 'loginPage')) b.add('mapped', area, 'mcp.loginPage', 'The hosted Atlas sign-in and consent pages are used.', propOf(o, 'loginPage'));
    if (propOf(o, 'oidcConfig')) translateOAuthServer(b, propOf(o, 'oidcConfig'), call, 'mcp.oidcConfig');
  },
  deviceAuthorization(b, { options: o, call }) {
    const area = 'plugin:deviceAuthorization';
    b.add('mapped', area, 'deviceAuthorization()', 'The device authorization grant (RFC 8628) is part of Atlas as an OAuth server: give each device app the device_code grant on its OAuth client.', call, 'oauth_clients grant_types');
    const exp = durationSeconds(propOf(o, 'expiresIn'));
    if (exp !== undefined) {
      b.set('oauthProvider.tokenLifetimes.deviceCodeSeconds', exp);
      b.add('mapped', area, 'deviceAuthorization.expiresIn', `Device codes expire after ${humanDuration(exp)}.`, propOf(o, 'expiresIn'), 'auth_config.oauthProvider.tokenLifetimes.deviceCodeSeconds');
    }
    for (const k of ['interval', 'userCodeLength', 'deviceCodeLength', 'generateDeviceCode', 'generateUserCode'] as const) {
      if (propOf(o, k)) b.add('differs', area, `deviceAuthorization.${k}`, 'Atlas uses its own polling interval and code format.', propOf(o, k));
    }
    if (propOf(o, 'validateClient')) b.add('mapped', area, 'deviceAuthorization.validateClient', 'Only registered OAuth clients with the device_code grant may start the flow.', propOf(o, 'validateClient'));
    if (propOf(o, 'verificationUri')) b.add('differs', area, 'deviceAuthorization.verificationUri', 'The verification page is hosted by Atlas.', propOf(o, 'verificationUri'));
  },

  stripe(b, p) {
    translatePayments(b, { ...p, id: 'payments:stripe' });
  },

  lastLoginMethod(b, { call }) {
    b.set('accountUx.lastSignInMethod.enabled', true);
    b.add('mapped', 'plugin:lastLoginMethod', 'lastLoginMethod()', 'The sign-in page highlights the method used last.', call, 'auth_config.accountUx.lastSignInMethod');
  },
  nextCookies(b, { call }) {
    b.add('mapped', 'plugin:nextCookies', 'nextCookies()', 'Not needed: the Atlas Next.js SDK sets cookies in server actions itself.', call);
  },
  openAPI(b, { call }) {
    b.add('mapped', 'plugin:openAPI', 'openAPI()', 'Atlas publishes its own OpenAPI document for every endpoint.', call);
  },
  oneTimeToken(b, { call }) {
    b.add('differs', 'plugin:oneTimeToken', 'oneTimeToken()', 'Use sign-in tokens (POST /v1/sign_in_tokens) to hand a session to another device or app.', call);
  },
  oAuthProxy(b, { call }) {
    b.add('mapped', 'plugin:oAuthProxy', 'oAuthProxy()', 'Not needed: provider callbacks land on Atlas, so preview deployments work once their origins are allowed (a wildcard under your domain).', call);
  },
  expo(b, { call }) {
    b.add('manual', 'plugin:expo', 'expo()', 'Use @atlasauth/expo; add the app scheme as a redirect URL and the app under auth_config.nativeApps.', call, 'redirect_urls / auth_config.nativeApps');
  },
  scim(b, { call }) {
    b.add('mapped', 'plugin:scim', 'scim()', 'SCIM 2.0 provisioning is built in per organization connection; issue a SCIM token for each directory.', call);
  },
  electron(b, { call }) {
    b.add('manual', 'plugin:electron', 'electron()', 'Use @atlasauth/electron (system-browser sign-in with PKCE).', call);
  },
  i18n(b, { call }) {
    b.add('differs', 'plugin:i18n', 'i18n()', 'Atlas localises hosted pages and emails (auth_config.localization and localization overrides).', call, 'auth_config.localization');
  },
};
PLUGIN_HANDLERS.haveibeenpwned = PLUGIN_HANDLERS.haveIBeenPwned!;
PLUGIN_HANDLERS.api_key = PLUGIN_HANDLERS.apiKey!;

// ───────────────────────────── organization ─────────────────────────────

function translateOrganization(b: Builder, o: StaticValue | undefined, call: StaticValue): void {
  const area = 'plugin:organization';
  b.add('mapped', area, 'organization()', 'Organizations, members, invitations and roles; organizations and memberships are imported.', call);

  const allowCreate = propOf(o, 'allowUserToCreateOrganization');
  if (allowCreate) {
    if (bool(allowCreate) === false) b.add('manual', area, 'organization.allowUserToCreateOrganization', 'To stop users creating organizations, refuse it in a pre-organization-create Action (or create organizations only from your backend).', allowCreate);
    else if (isFn(allowCreate)) b.add('manual', area, 'organization.allowUserToCreateOrganization', 'Move this check to a pre-organization-create Action.', allowCreate);
  }
  const limit = propOf(o, 'organizationLimit');
  if (limit) {
    const n = num(limit);
    if (n !== undefined) {
      b.set('organizations.maxOrganizationsPerUser', clamp(n, 0, 1_000_000));
      b.add('mapped', area, 'organization.organizationLimit', `${n} organizations per user.`, limit, 'auth_config.organizations.maxOrganizationsPerUser');
    } else b.add('manual', area, 'organization.organizationLimit', 'A function decides the limit; enforce it in a pre-organization-create Action.', limit);
  }
  const members = propOf(o, 'membershipLimit');
  const membersN = num(members) ?? (members ? undefined : 100);
  if (membersN !== undefined) {
    b.set('organizations.defaultMaxAllowedMemberships', clamp(membersN, 0, 1_000_000));
    b.add('mapped', area, 'organization.membershipLimit', `${membersN} members per organization${members ? '' : ' (the Better Auth default)'}.`, members ?? call, 'auth_config.organizations.defaultMaxAllowedMemberships');
  } else if (members) b.add('manual', area, 'organization.membershipLimit', 'A function decides the limit; set per-organization max_allowed_memberships or enforce it in a pre-member-add Action.', members);
  const invTtl = num(propOf(o, 'invitationExpiresIn')) ?? 48 * 3600;
  const ttl = clamp(invTtl, 3600, 90 * DAY);
  b.set('organizations.invitationTtlSeconds', ttl);
  b.add(ttl === invTtl ? 'mapped' : 'differs', area, 'organization.invitationExpiresIn', `Invitations expire after ${humanDuration(ttl)}${ttl !== invTtl ? ' (Atlas allows 1 hour to 90 days)' : ''}.`, propOf(o, 'invitationExpiresIn') ?? call, 'auth_config.organizations.invitationTtlSeconds');
  const invLimit = propOf(o, 'invitationLimit');
  const invN = num(invLimit) ?? (invLimit ? undefined : 100);
  if (invN !== undefined) {
    b.set('organizations.maxPendingInvitationsPerOrganization', clamp(invN, 0, 1_000_000));
    b.add('mapped', area, 'organization.invitationLimit', `${invN} pending invitations per organization.`, invLimit ?? call, 'auth_config.organizations.maxPendingInvitationsPerOrganization');
  } else if (invLimit) b.add('manual', area, 'organization.invitationLimit', 'A function decides the limit; enforce it in a pre-invitation-create Action.', invLimit);
  if (propOf(o, 'sendInvitationEmail')) b.add('differs', area, 'organization.sendInvitationEmail', 'Atlas sends invitation emails itself (customise the invitation template); the accept link goes to the hosted page or your app.', propOf(o, 'sendInvitationEmail'));
  if (propOf(o, 'requireEmailVerificationOnInvitation')) b.add('mapped', area, 'organization.requireEmailVerificationOnInvitation', 'Accepting an invitation always needs a proven email matching the invitation.', propOf(o, 'requireEmailVerificationOnInvitation'));
  if (propOf(o, 'cancelPendingInvitationsOnReInvite')) b.add('differs', area, 'organization.cancelPendingInvitationsOnReInvite', 'Re-inviting an address refreshes its pending invitation.', propOf(o, 'cancelPendingInvitationsOnReInvite'));
  if (bool(propOf(o, 'disableOrganizationDeletion'))) {
    b.set('organizations.allowDeletionFromApp', false);
    b.add('mapped', area, 'organization.disableOrganizationDeletion', 'Organizations cannot be deleted from the app (the Backend API still can).', propOf(o, 'disableOrganizationDeletion'), 'auth_config.organizations.allowDeletionFromApp');
  }
  const hooks = propOf(o, 'organizationHooks') ?? propOf(o, 'organizationCreation');
  if (hooks?.kind === 'object') {
    for (const [name, fn] of Object.entries(hooks.props)) {
      const target = /^before(Create|CreateOrganization)/.test(name)
        ? 'a pre-organization-create Action'
        : /^before(AddMember|CreateInvitation|AcceptInvitation)/.test(name)
          ? name.includes('Invitation') ? 'a pre-invitation-create Action' : 'a pre-member-add Action'
          : 'a webhook (organization.*, organizationMembership.*, organizationInvitation.* events)';
      b.add('manual', area, `organization.${hooks === propOf(o, 'organizationHooks') ? 'organizationHooks' : 'organizationCreation'}.${name}`, `Move this to ${target}.`, fn);
    }
  } else if (hooks) b.add('manual', area, 'organization.organizationHooks', 'Move these hooks to Actions (pre-organization-create, pre-member-add, pre-invitation-create) and webhooks.', hooks);

  const teams = propOf(o, 'teams');
  if (teams && bool(propOf(teams, 'enabled')) !== false) {
    b.add('mapped', area, 'organization.teams', 'Teams inside organizations; teams and team members are imported.', teams);
    const maxTeams = num(propOf(teams, 'maximumTeams'));
    if (maxTeams !== undefined) {
      b.set('organizations.maxTeamsPerOrganization', clamp(maxTeams, 0, 1_000_000));
      b.add('mapped', area, 'organization.teams.maximumTeams', `${maxTeams} teams per organization.`, propOf(teams, 'maximumTeams'), 'auth_config.organizations.maxTeamsPerOrganization');
    } else if (propOf(teams, 'maximumTeams')) b.add('manual', area, 'organization.teams.maximumTeams', 'A function decides the limit; review it.', propOf(teams, 'maximumTeams'));
    const maxMembers = num(propOf(teams, 'maximumMembersPerTeam'));
    if (maxMembers !== undefined) {
      b.set('organizations.maxMembersPerTeam', clamp(maxMembers, 0, 1_000_000));
      b.add('mapped', area, 'organization.teams.maximumMembersPerTeam', `${maxMembers} members per team.`, propOf(teams, 'maximumMembersPerTeam'), 'auth_config.organizations.maxMembersPerTeam');
    }
    if (propOf(teams, 'defaultTeam')) b.add('manual', area, 'organization.teams.defaultTeam', 'Create the default team from a webhook on organization.created.', propOf(teams, 'defaultTeam'));
    if (propOf(teams, 'allowRemovingAllTeams')) b.add('mapped', area, 'organization.teams.allowRemovingAllTeams', 'An organization may have no teams.', propOf(teams, 'allowRemovingAllTeams'));
  }
  const dac = propOf(o, 'dynamicAccessControl');
  if (dac) {
    const on = bool(propOf(dac, 'enabled')) === true;
    b.set('organizations.allowCustomRolesFromApp', on);
    b.add('mapped', area, 'organization.dynamicAccessControl', on ? 'Organization admins can create their own roles from the app.' : 'Custom roles only from the dashboard / Backend API.', dac, 'auth_config.organizations.allowCustomRolesFromApp');
    const maxRoles = num(propOf(dac, 'maximumRolesPerOrganization'));
    if (maxRoles !== undefined) {
      b.set('organizations.maxCustomRolesPerOrganization', clamp(maxRoles, 0, 1_000_000));
      b.add('mapped', area, 'organization.dynamicAccessControl.maximumRolesPerOrganization', `${maxRoles} custom roles per organization.`, propOf(dac, 'maximumRolesPerOrganization'), 'auth_config.organizations.maxCustomRolesPerOrganization');
    }
  } else {
    b.set('organizations.allowCustomRolesFromApp', false);
  }

  // Roles: built-ins map onto the Atlas system roles; custom ones are created.
  const creator = str(propOf(o, 'creatorRole')) ?? 'owner';
  const roles = propOf(o, 'roles');
  const permissions = new Map<string, string>();
  const roleDocs: Json[] = [];
  const roleKeys: Record<string, string> = { ...BUILTIN_ORG_ROLES };
  if (roles?.kind === 'object') {
    for (const [name, role] of Object.entries(roles.props)) {
      const statements = statementsOfRole(role);
      const builtIn = BUILTIN_ORG_ROLES[name];
      if (builtIn && statements === null) {
        roleKeys[name] = builtIn;
        continue;
      }
      if (statements === null) {
        b.add('manual', area, `organization.roles.${name}`, `Cannot read this role's permissions (${describe(role)}); create the role by hand.`, role, 'roles');
        continue;
      }
      const key = builtIn && name !== 'admin' ? builtIn : `org:${keySegment(name === 'admin' ? 'admin_ba' : name)}`;
      if (builtIn && name !== 'admin') {
        roleKeys[name] = builtIn;
        b.add('differs', area, `organization.roles.${name}`, `Mapped to the Atlas system role ${builtIn}, whose permissions are fixed; your customised statements for "${name}" are not applied (create a custom role instead if they matter).`, role, `roles ${builtIn}`);
        continue;
      }
      roleKeys[name] = key;
      const perms: string[] = [];
      for (const [resource, actions] of Object.entries(statements)) {
        for (const action of actions) {
          const sys = BUILTIN_STATEMENT_PERMS[resource]?.[action];
          if (sys) {
            if (!perms.includes(sys)) perms.push(sys);
            continue;
          }
          if (BUILTIN_STATEMENT_PERMS[resource]) continue; // e.g. ac:create → dashboard-managed
          const pkey = `org:${keySegment(resource)}:${keySegment(action)}`;
          permissions.set(pkey, `${resource}: ${action}`);
          if (!perms.includes(pkey)) perms.push(pkey);
        }
      }
      roleDocs.push({ key, name: titleCase(name), description: `Migrated from the Better Auth "${name}" role.`, permissions: perms.sort() });
      b.add('mapped', area, `organization.roles.${name}`, `Custom role ${key} with ${perms.length} permission(s).`, role, `roles ${key}`);
    }
  } else if (roles) {
    b.add('manual', area, 'organization.roles', `Cannot read the roles (${describe(roles)}); create them by hand.`, roles);
  }
  if (propOf(o, 'ac')) b.add('mapped', area, 'organization.ac', 'Every statement became a permission (org:<resource>:<action>); Better Auth\'s built-in organization/member/invitation/team statements map onto Atlas system permissions.', propOf(o, 'ac'), 'permissions');
  b.doc.permissions.push(
    ...[...permissions.entries()].sort(([a], [c]) => (a < c ? -1 : 1)).map(([key, description]) => ({ key, name: key.split(':').slice(1).join(' '), description })),
  );
  b.doc.roles.push(...roleDocs);
  const creatorKey = roleKeys[creator] ?? `org:${keySegment(creator)}`;
  b.set('organizations.creatorRole', creatorKey);
  b.add(creator === 'owner' || creator === 'admin' ? 'mapped' : 'differs', area, 'organization.creatorRole', `The creator is seated as ${creatorKey}.`, propOf(o, 'creatorRole') ?? call, 'auth_config.organizations.creatorRole');
  Object.assign(b.roles, roleKeys);
  b.add('differs', area, 'organization (owner role)', 'Better Auth "owner" and "admin" both map to the Atlas org:admin role (which can also delete the organization). A custom "admin" role with its own statements becomes org:admin_ba.', call, 'roles');
}

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** `ac.newRole({ project: ['create'] })` → { project: ['create'] }; null when unreadable. */
function statementsOfRole(role: StaticValue): Record<string, string[]> | null {
  let stmts: StaticValue | undefined;
  if (role.kind === 'call' && /(^|\.)newRole$/.test(role.callee)) stmts = role.args[0];
  else if (role.kind === 'object' && propOf(role, 'statements')) stmts = propOf(role, 'statements');
  if (!stmts || stmts.kind !== 'object') return null;
  const out: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(stmts.props)) {
    if (actions.kind !== 'array') return null;
    out[resource] = actions.items.map(str).filter((s): s is string => Boolean(s));
  }
  if (stmts.unresolvedSpreads.length) return null;
  return out;
}

// ───────────────────────────── generic OAuth ─────────────────────────────

function translateGenericOAuth(b: Builder, o: StaticValue | undefined, call: StaticValue): void {
  const area = 'plugin:genericOAuth';
  const configs = propOf(o, 'config');
  if (configs?.kind !== 'array') {
    b.add('manual', area, 'genericOAuth.config', `Cannot read the provider list (${configs ? describe(configs) : 'missing'}).`, configs ?? call);
    return;
  }
  const keys = (b.get('strategies.oauthProviders') as string[] | undefined) ?? [];
  for (const entry of configs.items) {
    // Better Auth presets: okta({...}), auth0({...}), keycloak({...}), microsoftEntraId({...}) …
    let cfg: StaticValue | undefined = entry;
    let preset: string | undefined;
    if (entry.kind === 'call') {
      preset = entry.imported?.name ?? entry.callee;
      cfg = entry.args[0];
    }
    const providerId = str(propOf(cfg, 'providerId')) ?? preset;
    if (!providerId || !cfg) {
      b.add('manual', area, 'genericOAuth.config[]', `Cannot read this provider (${describe(entry)}).`, entry);
      continue;
    }
    const option = `genericOAuth.config["${providerId}"]`;
    const upper = slug(providerId).toUpperCase();
    const clientId = b.configString(propOf(cfg, 'clientId'), `${providerId} client id`, `${upper}_CLIENT_ID`, { area, option: `${option}.clientId` });
    const clientSecret = b.configString(propOf(cfg, 'clientSecret'), `${providerId} client secret`, `${upper}_CLIENT_SECRET`, { area, option: `${option}.clientSecret`, secret: true });
    const scopes = propOf(cfg, 'scopes');
    const scopeList = scopes?.kind === 'array' ? scopes.items.map(str).filter((s): s is string => Boolean(s)) : undefined;
    const presetKey = preset ? GENERIC_PRESETS[preset] : undefined;
    if (presetKey) {
      b.providers[providerId] = presetKey;
      const e: Record<string, Json> = { provider: presetKey, enabled: true, allow_sign_in: true, allow_sign_up: true, client_id: clientId, client_secret: clientSecret };
      const domain = propOf(cfg, 'issuer') ?? propOf(cfg, 'domain');
      if (domain && (presetKey === 'okta' || presetKey === 'auth0')) {
        const d = b.configString(domain, `${presetKey} domain`, `${upper}_DOMAIN`, { area, option: `${option}.issuer` });
        e.values = { domain: d.replace(/^https?:\/\//, '').replace(/\/.*$/, '') };
      }
      if (presetKey === 'microsoft' && propOf(cfg, 'tenantId')) e.values = { tenant: b.configString(propOf(cfg, 'tenantId'), 'Microsoft tenant id', 'MICROSOFT_TENANT_ID', { area, option: `${option}.tenantId` }) };
      if (scopeList?.length) e.scopes = scopeList;
      b.doc.oauth_providers.push(e);
      keys.push(presetKey);
      b.add('mapped', area, option, `Built-in Atlas provider "${presetKey}". Keep the same OAuth app and add Atlas's callback URL to it.`, entry, `oauth_providers ${presetKey}`);
      continue;
    }
    const key = keySegmentProvider(providerId);
    b.providers[providerId] = key;
    const discovery = propOf(cfg, 'discoveryUrl');
    const doc: Record<string, Json> = {
      provider_key: key,
      display_name: titleCase(providerId),
      protocol: discovery ? 'oidc' : 'oauth2',
      client_id: clientId,
      client_secret: clientSecret,
      enabled: true,
      allow_sign_in: true,
      allow_sign_up: !(bool(propOf(cfg, 'disableSignUp')) || bool(propOf(cfg, 'disableImplicitSignUp'))),
    };
    if (discovery) {
      const url = b.configString(discovery, `${providerId} discovery URL`, `${upper}_DISCOVERY_URL`, { area, option: `${option}.discoveryUrl` });
      doc.discovery_url = url;
      const issuer = propOf(cfg, 'issuer');
      doc.issuer = issuer ? b.configString(issuer, `${providerId} issuer`, `${upper}_ISSUER`, { area, option: `${option}.issuer` }) : url.replace(/\/\.well-known\/openid-configuration\/?$/, '');
    } else {
      const endpoints: Array<[string, string]> = [['authorizationUrl', 'authorization_endpoint'], ['tokenUrl', 'token_endpoint'], ['userInfoUrl', 'userinfo_endpoint']];
      for (const [baKey, atlasKey] of endpoints) {
        const v = propOf(cfg, baKey);
        if (v) doc[atlasKey] = b.configString(v, `${providerId} ${baKey}`, `${upper}_${slug(baKey).toUpperCase()}`, { area, option: `${option}.${baKey}` });
        else if (baKey !== 'userInfoUrl') b.add('manual', area, `${option}.${baKey}`, `Missing ${baKey}; set ${atlasKey} on the custom provider.`, cfg);
      }
    }
    if (scopeList?.length) doc.scopes = scopeList;
    const pkce = bool(propOf(cfg, 'pkce'));
    if (pkce !== undefined) doc.pkce = pkce;
    const auth = str(propOf(cfg, 'authentication'));
    doc.token_endpoint_auth_method = auth === 'basic' ? 'client_secret_basic' : 'client_secret_post';
    const authParams = literalOf(propOf(cfg, 'authorizationUrlParams'));
    if (authParams && typeof authParams === 'object') doc.authorization_params = stringMap(authParams as Record<string, unknown>);
    const tokenParams = literalOf(propOf(cfg, 'tokenUrlParams'));
    if (tokenParams && typeof tokenParams === 'object') doc.token_params = stringMap(tokenParams as Record<string, unknown>);
    for (const k of ['prompt', 'accessType', 'responseMode'] as const) {
      const v = str(propOf(cfg, k));
      if (v) {
        const params = (doc.authorization_params as Record<string, Json> | undefined) ?? {};
        params[k === 'accessType' ? 'access_type' : k === 'responseMode' ? 'response_mode' : 'prompt'] = v;
        doc.authorization_params = params;
      }
    }
    const mapping = profileMappingOf(propOf(cfg, 'mapProfileToUser'));
    if (mapping) {
      doc.profile_mapping = mapping.mapping;
      b.add(mapping.complete ? 'mapped' : 'differs', area, `${option}.mapProfileToUser`, mapping.complete ? 'Translated into a declarative profile mapping.' : `Partly translated into a profile mapping; check: ${mapping.skipped.join(', ')}.`, propOf(cfg, 'mapProfileToUser'), `custom_oauth_providers ${key} profile_mapping`);
    } else if (propOf(cfg, 'mapProfileToUser')) {
      b.add('manual', area, `${option}.mapProfileToUser`, 'Write the equivalent profile_mapping (claim paths and templates) on the custom provider; preview it with POST /v1/custom_oauth_providers/profile_mapping/preview.', propOf(cfg, 'mapProfileToUser'));
    }
    if (propOf(cfg, 'getUserInfo')) b.add('manual', area, `${option}.getUserInfo`, 'Atlas reads the profile from the userinfo endpoint / id_token (profile_source); custom fetch logic is not supported.', propOf(cfg, 'getUserInfo'));
    if (propOf(cfg, 'overrideUserInfo')) doc.profile_mapping = { ...((doc.profile_mapping as Record<string, Json>) ?? {}), update_on_sign_in: true };
    b.doc.custom_oauth_providers.push(doc);
    keys.push(key);
    b.add('mapped', area, option, `Custom ${doc.protocol === 'oidc' ? 'OpenID Connect' : 'OAuth 2.0'} provider "${key}". Register its redirect_uri (shown on the provider) at the identity provider.`, entry, `custom_oauth_providers ${key}`);
  }
  b.set('strategies.oauthProviders', [...new Set(keys)]);
}

function keySegmentProvider(id: string): string {
  let key = slug(id, 48);
  if (key.length < 2) key = `${key}_oauth`;
  if (SOCIAL_PROVIDER_MAP[key] || Object.values(SOCIAL_PROVIDER_MAP).includes(key) || GENERIC_PRESETS[key]) key = `${key}_custom`;
  return key.slice(0, 48);
}

function stringMap(obj: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = String(v);
  return out;
}

/** `(profile) => ({ email: profile.mail, name: `${profile.first} ${profile.last}` })` → a profile_mapping. */
function profileMappingOf(fn: StaticValue | undefined): { mapping: Record<string, Json>; complete: boolean; skipped: string[] } | null {
  if (!fn || fn.kind !== 'function' || !fn.returns || fn.returns.kind !== 'object') return null;
  const param = fn.params[0];
  const FIELD: Record<string, string> = {
    id: 'id',
    email: 'email',
    emailVerified: 'email_verified',
    name: 'full_name',
    firstName: 'first_name',
    lastName: 'last_name',
    image: 'image_url',
    username: 'username',
    phoneNumber: 'phone_number',
  };
  const fields: Record<string, Json> = {};
  const publicMeta: Record<string, Json> = {};
  const skipped: string[] = [];
  const exprOf = (v: StaticValue): Json | null => {
    if (v.kind === 'param' && v.name === param && v.path.length) return v.path.join('.');
    if (v.kind === 'string' || v.kind === 'number' || v.kind === 'boolean') return { value: v.value };
    if (v.kind === 'template' && v.parts.every((p) => typeof p === 'string' || (p.kind === 'param' && p.name === param))) {
      return {
        template: v.parts.map((p) => (typeof p === 'string' ? p : `{{${(p as Extract<StaticValue, { kind: 'param' }>).path.join('.')}}}`)).join(''),
      };
    }
    if (v.kind === 'unknown' && /\?\?|\|\|/.test(v.text)) return null;
    return null;
  };
  for (const [k, v] of Object.entries(fn.returns.props)) {
    const expr = exprOf(v);
    if (expr === null) {
      skipped.push(k);
      continue;
    }
    const target = FIELD[k];
    if (target) fields[target] = expr;
    else publicMeta[k] = expr;
  }
  if (!Object.keys(fields).length && !Object.keys(publicMeta).length) return null;
  const mapping: Record<string, Json> = {};
  if (Object.keys(fields).length) mapping.fields = fields;
  if (Object.keys(publicMeta).length) mapping.public_metadata = publicMeta;
  return { mapping, complete: skipped.length === 0 && fn.returns.unresolvedSpreads.length === 0, skipped };
}

// ───────────────────────────── OAuth / OIDC server ─────────────────────────────

function translateOAuthServer(b: Builder, o: StaticValue | undefined, call: StaticValue, name: string): void {
  const area = `plugin:${name.split('.')[0]}`;
  b.add('mapped', area, `${name}()`, 'Atlas is an OAuth 2.1 / OpenID Connect provider ("Sign in with Atlas"): clients, consent, discovery, JWKS, introspection and revocation are built in. Clients get new client ids: update each relying party.', call, 'auth_config.oauthProvider');
  const dcr = propOf(o, 'allowDynamicClientRegistration');
  if (dcr) {
    b.set('oauthProvider.dynamicRegistration', bool(dcr) === true);
    b.add('mapped', area, `${name}.allowDynamicClientRegistration`, `Dynamic client registration ${bool(dcr) ? 'on' : 'off'}.`, dcr, 'auth_config.oauthProvider.dynamicRegistration');
  }
  const pkce = propOf(o, 'requirePKCE') ?? propOf(o, 'clientRegistrationRequirePKCE');
  if (pkce) {
    b.set('oauthProvider.requirePkce', bool(pkce) !== false);
    b.add('mapped', area, `${name}.requirePKCE`, 'PKCE required.', pkce, 'auth_config.oauthProvider.requirePkce');
  }
  const lifetimes: Array<[string, string]> = [
    ['accessTokenExpiresIn', 'accessTokenSeconds'],
    ['idTokenExpiresIn', 'idTokenSeconds'],
    ['refreshTokenExpiresIn', 'refreshTokenAbsoluteSeconds'],
    ['codeExpiresIn', 'authorizationCodeSeconds'],
  ];
  for (const [baKey, atlasKey] of lifetimes) {
    const v = durationSeconds(propOf(o, baKey));
    if (v === undefined) continue;
    b.set(`oauthProvider.tokenLifetimes.${atlasKey}`, v);
    b.add('mapped', area, `${name}.${baKey}`, `${humanDuration(v)}.`, propOf(o, baKey), `auth_config.oauthProvider.tokenLifetimes.${atlasKey}`);
  }
  const scopes = propOf(o, 'scopes');
  if (scopes?.kind === 'array') {
    const standard = new Set(['openid', 'profile', 'email', 'offline_access', 'phone', 'address']);
    const custom = scopes.items.map(str).filter((s): s is string => Boolean(s) && !standard.has(s!));
    if (custom.length) {
      b.set('oauthProvider.customScopes', custom.map((s) => ({ name: s, description: s, claims: [] })));
      b.add('mapped', area, `${name}.scopes`, `Custom scopes: ${custom.join(', ')}. Add the claims each scope releases.`, scopes, 'auth_config.oauthProvider.customScopes');
    }
  }
  const trusted = propOf(o, 'trustedClients');
  if (trusted?.kind === 'array') {
    for (const c of trusted.items) {
      const nameV = str(propOf(c, 'name')) ?? str(propOf(c, 'clientId')) ?? 'Migrated client';
      const redirects = propOf(c, 'redirectURLs') ?? propOf(c, 'redirectUrls') ?? propOf(c, 'redirect_uris');
      const uris = redirects?.kind === 'array' ? redirects.items.map(str).filter((s): s is string => Boolean(s)) : [];
      const type = str(propOf(c, 'type'));
      b.doc.oauth_clients.push({
        name: nameV,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: type === 'public' || type === 'native' || type === 'user-agent-based' ? 'none' : 'client_secret_basic',
        first_party: bool(propOf(c, 'skipConsent')) === true,
      });
      b.add('differs', area, `${name}.trustedClients "${nameV}"`, 'Created as an OAuth client with a NEW client id and secret (shown once on creation, or rotate with atlas client rotate). skipConsent → first_party (no consent screen).', c, 'oauth_clients');
    }
  } else if (trusted) b.add('manual', area, `${name}.trustedClients`, `Cannot read the clients (${describe(trusted)}); create them as OAuth clients.`, trusted);
  b.add('manual', area, `${name} clients`, 'Clients registered at runtime live in your database (oauthApplication / oauthClient). Re-create each as an Atlas OAuth client and send the relying party its new client id and secret.', call, 'oauth_clients');
  for (const k of ['loginPage', 'consentPage'] as const) {
    if (propOf(o, k)) b.add('mapped', area, `${name}.${k}`, 'Atlas hosts the sign-in and consent pages (branded); a custom consent UI can use the consent API.', propOf(o, k));
  }
  for (const k of ['getAdditionalUserInfoClaim', 'customIdTokenClaims', 'customAccessTokenClaims', 'customUserInfoClaims'] as const) {
    if (propOf(o, k)) b.add('manual', area, `${name}.${k}`, 'Custom claims become JWT templates released by scope (oauthProvider.tokenClaims).', propOf(o, k), 'auth_config.oauthProvider.tokenClaims');
  }
  if (propOf(o, 'useJWTPlugin')) b.add('mapped', area, `${name}.useJWTPlugin`, 'Access tokens are signed JWTs (accessTokenFormat "jwt").', propOf(o, 'useJWTPlugin'));
}

// ───────────────────────────── payments ─────────────────────────────

function translatePayments(b: Builder, p: PluginCall): void {
  const provider = p.id.split(':')[1] ?? 'stripe';
  const area = `plugin:${provider}`;
  const o = p.options;
  b.add('mapped', area, `${p.call.callee}()`, `End-user billing on ${provider === 'stripe' ? 'Stripe' : provider} with your own account: connect it in Atlas (billing provider settings) with your API key and webhook secret; plans become Atlas billing plans and the plan slug is in the session token (pla). Existing subscriptions are imported with their customer and subscription ids.`, p.call, 'billing_plans');
  // Polar & co. configure products on a `checkout({ products })` entry of `use: [...]`.
  const use = propOf(o, 'use');
  const checkoutCall = use?.kind === 'array' ? use.items.find((i) => i.kind === 'call' && /(^|\.)checkout$/i.test(i.callee)) : undefined;
  const checkoutProducts = checkoutCall?.kind === 'call' ? propOf(checkoutCall.args[0], 'products') : undefined;
  const plans =
    provider === 'stripe'
      ? propOf(propOf(o, 'subscription'), 'plans')
      : (propOf(o, 'products') ?? checkoutProducts ?? propOf(propOf(o, 'checkout'), 'products') ?? propOf(o, 'plans'));
  const orgBilling = bool(propOf(propOf(o, 'organization'), 'enabled')) === true;
  if (!plans) {
    if (provider !== 'stripe') b.add('manual', area, `${p.call.callee}() products`, 'Create the billing plans in Atlas with their product / price ids (billing_plans).', p.call, 'billing_plans');
    return;
  }
  if (plans.kind === 'function') {
    b.add('manual', area, 'subscription.plans', 'Plans come from a function at runtime; create the billing plans in Atlas (billing_plans) with their price ids.', plans, 'billing_plans');
    return;
  }
  if (plans.kind !== 'array') {
    b.add('manual', area, 'subscription.plans', `Cannot read the plans (${describe(plans)}).`, plans, 'billing_plans');
    return;
  }
  for (const plan of plans.items) {
    const name = str(propOf(plan, 'name')) ?? str(propOf(plan, 'slug')) ?? str(propOf(plan, 'productId'));
    if (!name) {
      b.add('manual', area, 'plan', `Cannot read this plan (${describe(plan)}).`, plan, 'billing_plans');
      continue;
    }
    const planSlug = slug(str(propOf(plan, 'slug')) ?? name, 64);
    const priceV = propOf(plan, 'priceId') ?? propOf(plan, 'productId') ?? propOf(plan, 'id');
    const doc: Record<string, Json> = { name: titleCase(name), slug: planSlug, interval: 'month', active: true, audience: orgBilling ? 'org' : 'user' };
    if (provider !== 'stripe') doc.provider = provider;
    if (priceV) {
      const price = b.configString(priceV, `${name} price id`, `${slug(name).toUpperCase()}_PRICE_ID`, { area, option: `plan "${name}" priceId` });
      if (provider === 'stripe') doc.stripe_price_id = price;
      else doc.provider_price_id = price;
    } else if (propOf(plan, 'lookupKey')) {
      b.add('manual', area, `plan "${name}" lookupKey`, 'Atlas references Stripe prices by id: replace the lookup key with the price id.', propOf(plan, 'lookupKey'), 'billing_plans stripe_price_id');
    }
    const annual = propOf(plan, 'annualDiscountPriceId');
    if (annual) doc.annual_price_id = b.configString(annual, `${name} annual price id`, `${slug(name).toUpperCase()}_ANNUAL_PRICE_ID`, { area, option: `plan "${name}" annualDiscountPriceId` });
    const limits = literalOf(propOf(plan, 'limits'));
    if (limits && typeof limits === 'object' && !Array.isArray(limits)) doc.limits = limits as Json;
    else if (propOf(plan, 'limits')) b.add('manual', area, `plan "${name}" limits`, 'Cannot read the limits; set them on the plan.', propOf(plan, 'limits'), 'billing_plans limits');
    const trial = num(propOf(propOf(plan, 'freeTrial'), 'days'));
    if (trial !== undefined) doc.trial_days = clamp(trial, 0, 3650);
    if (propOf(plan, 'seatPriceId')) {
      doc.pricing_model = 'per_seat';
      b.add('differs', area, `plan "${name}" seatPriceId`, 'Per-seat pricing: the plan price is charged per member.', propOf(plan, 'seatPriceId'), 'billing_plans pricing_model');
    }
    if (propOf(plan, 'group')) b.add('differs', area, `plan "${name}" group`, 'Plan groups are expressed with kind base/addon.', propOf(plan, 'group'));
    b.doc.billing_plans.push(doc);
    b.add('mapped', area, `plan "${name}"`, `Billing plan "${planSlug}"${doc.trial_days !== undefined ? ` with a ${doc.trial_days}-day trial` : ''}. Set the amount and currency for display.`, plan, `billing_plans ${planSlug}`);
  }
  if (bool(propOf(o, 'createCustomerOnSignUp'))) b.add('mapped', area, 'createCustomerOnSignUp', 'A billing customer is created when it is first needed (checkout or portal).', propOf(o, 'createCustomerOnSignUp'));
  for (const k of ['onEvent', 'onSubscriptionComplete', 'onSubscriptionUpdate', 'onSubscriptionCancel', 'onCustomerCreate'] as const) {
    if (propOf(o, k) || propOf(propOf(o, 'subscription'), k)) b.add('manual', area, k, 'Move this to a webhook on billing.subscription.* events.', propOf(o, k) ?? propOf(propOf(o, 'subscription'), k));
  }
  if (propOf(o, 'stripeWebhookSecret') || propOf(o, 'webhookSecret')) b.add('manual', area, 'webhook secret', 'Point your billing provider\'s webhook at Atlas (the billing provider settings show the URL) and store the new signing secret there.', propOf(o, 'stripeWebhookSecret') ?? propOf(o, 'webhookSecret'));
}
