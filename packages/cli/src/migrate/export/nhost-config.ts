import type { Json } from '../../serialize';
import type { TranslationResult } from '../framework/plugin';
import { addAt } from './source-lines';
import { ConfigBuilder, clampSessionMs, keyOf, socialKey } from './translate-kit';

/**
 * `atlas migrate nhost config` — `nhost/nhost.toml` (the Nhost CLI's project
 * config, the same file Nhost Cloud deploys) → Atlas config, every report
 * line pointing at its file:line. Only the `[auth…]` tables are read, plus
 * the Hasura JWT secret's issuer for the bridge. `{{ secrets.NAME }}` values
 * stay out: client secrets become Atlas `${NAME}` placeholders.
 */

// ── a small TOML reader (tables, arrays of tables, strings, numbers, booleans, arrays, inline tables) ──

export interface TomlValue {
  value: unknown;
  line: number;
}

/**
 * Flatten a TOML document to dotted keys → value with its line:
 * `auth.method.emailPassword.passwordMinLength` → { value: 9, line: 42 }.
 * Array-of-tables entries are indexed (`auth.session.accessToken.customClaims.0.key`).
 * Enough TOML for nhost.toml; not a general parser (no dates, no dotted keys
 * with quotes inside headers).
 */
export function readToml(text: string): Map<string, TomlValue> {
  const out = new Map<string, TomlValue>();
  const counters = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  let prefix = '';
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let raw = stripComment(lines[i]!).trim();
    if (!raw) continue;
    const aot = /^\[\[\s*([^\]]+?)\s*\]\]$/.exec(raw);
    if (aot) {
      const base = aot[1]!.trim();
      const n = counters.get(base) ?? 0;
      counters.set(base, n + 1);
      prefix = `${base}.${n}`;
      out.set(prefix, { value: {}, line: lineNo });
      continue;
    }
    const table = /^\[\s*([^\]]+?)\s*\]$/.exec(raw);
    if (table) {
      prefix = table[1]!.trim();
      out.set(prefix, { value: {}, line: lineNo });
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    const key = unquoteKey(raw.slice(0, eq).trim());
    let rhs = raw.slice(eq + 1).trim();
    // Multi-line arrays / inline tables: read on until the brackets balance.
    while (!balanced(rhs) && i + 1 < lines.length) {
      i++;
      rhs += ` ${stripComment(lines[i]!).trim()}`;
    }
    raw = rhs;
    let value: unknown;
    try {
      value = new ValueParser(raw).parse();
    } catch {
      value = raw;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    out.set(path, { value, line: lineNo });
    flattenInto(out, path, value, lineNo);
  }
  return out;
}

function flattenInto(out: Map<string, TomlValue>, path: string, value: unknown, line: number): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      out.set(`${path}.${k}`, { value: v, line });
      flattenInto(out, `${path}.${k}`, v, line);
    }
  }
}

function unquoteKey(k: string): string {
  return k.replace(/^["'](.*)["']$/, '$1');
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
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

class ValueParser {
  private i = 0;
  constructor(private readonly s: string) {}

  parse(): unknown {
    const v = this.value();
    this.ws();
    if (this.i < this.s.length) throw new Error('trailing');
    return v;
  }

  private ws(): void {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i]!)) this.i++;
  }

  private value(): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.string(c);
    if (c === '[') {
      this.i++;
      const arr: unknown[] = [];
      for (;;) {
        this.ws();
        if (this.s[this.i] === ']') {
          this.i++;
          return arr;
        }
        if (this.i >= this.s.length) throw new Error('unterminated array');
        arr.push(this.value());
      }
    }
    if (c === '{') {
      this.i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        this.ws();
        if (this.s[this.i] === '}') {
          this.i++;
          return obj;
        }
        const m = /^("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(this.s.slice(this.i));
        if (!m) throw new Error('bad inline table');
        this.i += m[0].length;
        obj[unquoteKey(m[1]!)] = this.value();
      }
    }
    const m = /^(true|false|[+-]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?\d+)?)/.exec(this.s.slice(this.i));
    if (!m) throw new Error('bad value');
    this.i += m[0].length;
    if (m[1] === 'true') return true;
    if (m[1] === 'false') return false;
    return Number(m[1]!.replace(/_/g, ''));
  }

  private string(q: string): string {
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i++]!;
      if (c === q) return out;
      if (c === '\\' && q === '"') {
        const e = this.s[this.i++]!;
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
      } else out += c;
    }
    throw new Error('unterminated string');
  }
}

// ── the translator ──────────────────────────────────────────────────────────

const SECRET_REF = /^\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}$/;

export function translateNhostConfig(file: { path: string; text: string }, opts: { authUrl?: string } = {}): TranslationResult {
  const b = new ConfigBuilder();
  const toml = readToml(file.text);
  const get = (k: string) => toml.get(`auth.${k}`);
  const val = (k: string) => get(k)?.value;
  const put = (status: 'mapped' | 'differs' | 'manual', k: string, note: string, atlas?: string) => {
    const at = get(k);
    addAt(b, at ? file.path : undefined, at?.line, status, 'auth', `auth.${k}`, note, atlas);
  };
  if (![...toml.keys()].some((k) => k === 'auth' || k.startsWith('auth.'))) {
    b.add('manual', 'auth', '[auth]', `${file.path} has no [auth] section: nothing to translate.`);
  }

  // ── sign-up ──
  if (val('signUp.enabled') === false || val('signUp.disableNewUsers') === true) {
    b.set('signUpMode', 'restricted');
    put('mapped', val('signUp.enabled') === false ? 'signUp.enabled' : 'signUp.disableNewUsers', 'Self sign-up is closed (invitations and the allowlist still work).', 'auth_config.signUpMode');
  }
  if (val('signUp.disableAutoSignup') === true) put('differs', 'signUp.disableAutoSignup', 'Nhost does not create accounts on passwordless sign-in; Atlas signs up unknown users from the same flow unless sign-up is restricted.', 'auth_config.signUpMode');
  if (typeof val('signUp.turnstile.secretKey') === 'string') put('differs', 'signUp.turnstile.secretKey', 'Turnstile on sign-up: Atlas has its own bot protection (captcha); the Turnstile secret is not copied.', 'auth_config.captcha');

  // ── methods ──
  const emailPassword = get('method.emailPassword');
  if (emailPassword) {
    b.set('strategies.password', true);
    put('mapped', 'method.emailPassword', 'Email + password sign-in. Imported bcrypt hashes verify as they are and are upgraded to Argon2id.', 'auth_config.strategies.password');
  }
  const min = val('method.emailPassword.passwordMinLength');
  if (typeof min === 'number') {
    b.set('passwordPolicy.minLength', Math.max(8, min));
    put(min < 8 ? 'differs' : 'mapped', 'method.emailPassword.passwordMinLength', min < 8 ? `Nhost allows ${min}; Atlas requires at least 8 (existing passwords still sign in).` : `${min} characters minimum.`, 'auth_config.passwordPolicy.minLength');
  }
  if (val('method.emailPassword.hibpEnabled') === true) {
    b.set('passwordPolicy.checkBreaches', true);
    put('mapped', 'method.emailPassword.hibpEnabled', 'Breached passwords (Have I Been Pwned) are rejected.', 'auth_config.passwordPolicy.checkBreaches');
  }
  const verify = val('method.emailPassword.emailVerificationRequired');
  if (typeof verify === 'boolean') {
    b.set('requireEmailVerification', verify);
    put('mapped', 'method.emailPassword.emailVerificationRequired', verify ? 'Email addresses must be verified before sign-in.' : 'Unverified email addresses may sign in.', 'auth_config.requireEmailVerification');
  }
  const flags: Array<[string, string, string]> = [
    ['method.anonymous.enabled', 'strategies.anonymous', 'Anonymous users.'],
    ['method.emailPasswordless.enabled', 'strategies.emailLink', 'Magic links.'],
    ['method.otp.email.enabled', 'strategies.emailCode', 'One-time email codes.'],
    ['method.smsPasswordless.enabled', 'strategies.phoneCode', 'SMS codes (sent through your Atlas SMS settings).'],
    ['method.webauthn.enabled', 'strategies.passkey', 'Security keys / passkeys. Existing keys move with the export when the relying-party id stays the same.'],
  ];
  for (const [k, atlas, note] of flags) {
    if (val(k) === true) {
      b.set(atlas, true);
      put('mapped', k, note, `auth_config.${atlas}`);
    }
  }
  const rpId = val('method.webauthn.relyingParty.id');
  if (typeof rpId === 'string' && rpId) put('mapped', 'method.webauthn.relyingParty.id', `Relying party "${rpId}": keep sign-in on this domain (or a parent) so imported passkeys keep working.`, 'auth_config.passkeyPolicy');

  // ── OAuth ──
  for (const [k, entry] of toml) {
    const m = /^auth\.method\.oauth\.([A-Za-z0-9]+)\.enabled$/.exec(k);
    if (!m || entry.value !== true) continue;
    const name = m[1]!;
    const atlas = socialKey(name) ?? (name === 'azuread' || name === 'entraid' ? 'microsoft' : null);
    const clientId = val(`method.oauth.${name}.clientId`);
    const cid = typeof clientId === 'string' && clientId && !SECRET_REF.test(clientId) ? clientId : undefined;
    if (atlas) {
      b.socialProvider({ atlasKey: atlas, vendorName: name, area: 'auth oauth', setting: `auth.method.oauth.${name}`, clientId: cid });
      const last = b.report[b.report.length - 1]!;
      last.file = file.path;
      last.line = entry.line;
      if (name === 'azuread' || name === 'entraid') {
        const tenant = val(`method.oauth.${name}.tenant`);
        put('differs', `method.oauth.${name}.tenant`, `Microsoft sign-in${typeof tenant === 'string' && tenant ? ` for tenant ${tenant}` : ''}: set the tenant on Atlas's microsoft provider (or add the tenant as an enterprise OIDC connection).`, 'oauth_providers microsoft');
      }
    } else {
      put('manual', `method.oauth.${name}.enabled`, `"${name}" is not an Atlas built-in provider: add it as a custom OAuth/OIDC provider (or an enterprise connection for WorkOS) with the same client id.`, 'custom_oauth_providers');
    }
  }

  // ── sessions and tokens ──
  const refresh = val('session.refreshToken.expiresIn');
  if (typeof refresh === 'number' && refresh > 0) {
    const ms = clampSessionMs(refresh * 1000);
    b.set('session.absoluteMs', ms);
    put(ms === refresh * 1000 ? 'mapped' : 'differs', 'session.refreshToken.expiresIn', `Sessions last ${refresh} s${ms !== refresh * 1000 ? ' (clamped to Atlas\'s 5-minute to 90-day range)' : ''}.`, 'auth_config.session.absoluteMs');
  }
  const access = val('session.accessToken.expiresIn');
  if (typeof access === 'number' && access > 0) {
    b.set('session.jwtTtlSeconds', access);
    put('mapped', 'session.accessToken.expiresIn', `Access tokens live ${access} s.`, 'auth_config.session.jwtTtlSeconds');
  }
  const claims: Record<string, string> = {};
  for (const [k, entry] of toml) {
    const m = /^auth\.session\.accessToken\.customClaims\.(\d+)\.key$/.exec(k);
    if (!m || typeof entry.value !== 'string') continue;
    const v = toml.get(`auth.session.accessToken.customClaims.${m[1]}.value`)?.value;
    if (typeof v === 'string') claims[entry.value] = v;
  }
  if (Object.keys(claims).length) {
    const at = [...toml.entries()].find(([k]) => k.startsWith('auth.session.accessToken.customClaims'))?.[1];
    addAt(b, at ? file.path : undefined, at?.line, 'manual', 'auth', 'auth.session.accessToken.customClaims', `Custom Hasura claims (${Object.entries(claims).map(([c, p]) => `${c} ← ${p}`).join(', ')}) read from the database: recreate them as an Atlas JWT template, Hasura shape (https://hasura.io/jwt/claims), with values from user metadata.`, 'jwt_templates');
  }
  b.add('differs', 'hasura', 'hasura.jwtSecrets', 'Hasura must trust Atlas tokens: add Atlas\'s JWKS URL as a Hasura JWT secret (jwk_url) next to the Nhost one during the cutover, with the "hasura" JWT template.', 'jwt_templates hasura');

  // ── roles ──
  const allowed = val('user.roles.allowed');
  if (Array.isArray(allowed)) {
    const custom = allowed.filter((r): r is string => typeof r === 'string' && !['user', 'me', 'anonymous', 'public'].includes(r));
    for (const r of custom) {
      const key = keyOf(r);
      b.roles[r] = key;
      b.push('roles', { key, name: r, description: 'Hasura role from Nhost', permissions: [] } as Json);
    }
    if (custom.length) put('mapped', 'user.roles.allowed', `${custom.length} Hasura role(s) become Atlas app roles; assignments move with the data export.`, 'roles');
  }
  const def = val('user.roles.default');
  if (typeof def === 'string' && def !== 'user') put('manual', 'user.roles.default', `New users get the Hasura role "${def}": assign the matching Atlas app role in a sign-up action.`, 'actions');

  // ── user rules ──
  for (const k of ['user.email.allowed', 'user.emailDomains.allowed']) {
    const v = val(k);
    if (Array.isArray(v) && v.length) put('manual', k, `Sign-up limited to ${v.join(', ')}: add them to the Atlas allowlist (restrictions.allowlistOnly).`, 'auth_config.restrictions');
  }
  for (const k of ['user.email.blocked', 'user.emailDomains.blocked']) {
    const v = val(k);
    if (Array.isArray(v) && v.length) put('manual', k, `Blocked: ${v.join(', ')}. Add them to the Atlas blocklist.`, 'blocklist');
  }
  if (val('user.gravatar.enabled') === true) put('differs', 'user.gravatar.enabled', 'Nhost fills avatarUrl from Gravatar; Atlas shows initials or the social profile picture. Imported avatar URLs are kept.', 'user image');
  const locales = val('user.locale.allowed');
  if (Array.isArray(locales) && locales.length > 1) put('differs', 'user.locale.allowed', 'Per-user locale is kept in public metadata; set the Atlas localization languages to match.', 'auth_config.localization');

  // ── MFA ──
  if (val('totp.enabled') === true) {
    b.set('mfa.factors.totp', true);
    put('mapped', 'totp.enabled', 'Authenticator apps. Secrets move with the export (decrypted on your machine with AUTH_ENCRYPTION_KEY on current Nhost).', 'auth_config.mfa.factors.totp');
  }
  if (val('elevatedPrivileges.mode') === 'required' || val('elevatedPrivileges.mode') === 'recommended') {
    put('differs', 'elevatedPrivileges.mode', 'Nhost elevates with a security key before sensitive changes; Atlas uses step-up (reverification) for the same actions.', 'auth_config.stepUp');
  }

  // ── redirects ──
  const clientUrl = val('redirections.clientUrl');
  if (typeof clientUrl === 'string' && clientUrl) put('mapped', 'redirections.clientUrl', `${clientUrl} becomes an Atlas redirect URL.`, 'redirect_urls');
  const urls = val('redirections.allowedUrls');
  if (Array.isArray(urls)) for (const u of urls) if (typeof u === 'string' && /^https?:\/\//.test(u)) b.push('redirect_urls', { url: u } as Json);
  if (Array.isArray(urls) && urls.length) put('mapped', 'redirections.allowedUrls', `${urls.length} allowed redirect URL(s).`, 'redirect_urls');
  if (typeof clientUrl === 'string' && /^https?:\/\//.test(clientUrl)) b.push('redirect_urls', { url: clientUrl } as Json);

  // ── what the bridge and lazy presets need ──
  const issuer = toml.get('hasura.jwtSecrets.0.issuer');
  if (typeof issuer?.value === 'string' && issuer.value) {
    addAt(b, file.path, issuer.line, 'mapped', 'hasura', 'hasura.jwtSecrets.issuer', `Access tokens carry iss "${issuer.value}": the nhost_jwt bridge preset accepts them with its issuer variable set to that value.`, 'migrations bridge nhost_jwt');
  }
  return b.result(file.path, {
    bridge: { preset: 'nhost', vars: {} },
    lazy: { preset: 'nhost', config: opts.authUrl ? { auth_url: opts.authUrl.replace(/\/+$/, '') } : {} },
  });
}
