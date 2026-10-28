import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { TranslationResult } from '../framework/plugin';
import { DAY, FRAMEWORK_PROVIDER_MAP, MAX_ABSOLUTE_S, MIN_IDLE_S, TranslationBuilder, clamp, humanDuration, type ConfigValue, type Where } from './report';

/**
 * Config translators for the server-rendered frameworks — Devise (Rails) and
 * Django (contrib.auth, django-allauth, python-social-auth) — reading the
 * app's Ruby / Python source line by line. Nothing runs and no secrets file is
 * read (`.env`, `credentials.yml.enc`): `ENV[...]`, `os.environ[...]` and
 * django-environ lookups are carried by NAME as `${NAME}` placeholders.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', 'env', '.env', 'site-packages', '__pycache__', '.tox', 'vendor', 'tmp', 'log', 'public', 'dist', 'build', '.bundle', 'storage', 'coverage']);

function walk(root: string, accept: (rel: string) => boolean, depth = 6, dir = root, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    let st: Stats;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (depth > 0 && !SKIP_DIRS.has(name) && !name.startsWith('.')) walk(root, accept, depth - 1, path, out);
    } else if (accept(rel(root, path))) out.push(path);
  }
  return out;
}

const rel = (root: string, path: string): string => relative(root, path).split(sep).join('/');

/** A setting's source text for a report note: shortened, and withheld when the name says secret. */
function snippet(name: string, text: string): string {
  if (/SECRET|KEY|PASSWORD|TOKEN|PEPPER|CREDENTIAL/i.test(name)) return 'value not shown';
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}

function upperSnake(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

/** Scan a line, calling `on` for each character outside a '…' / "…" string literal. */
function scan(line: string, on: (c: string, i: number) => boolean | void): void {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (on(c, i) === true) return;
  }
}

/** The line without its `#` comment (Ruby and Python). */
function stripComment(line: string): string {
  let end = line.length;
  scan(line, (c, i) => {
    if (c === '#') {
      end = i;
      return true;
    }
  });
  return line.slice(0, end);
}

/** Split on top-level commas (outside brackets and strings). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  scan(s, (c, i) => {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  });
  const last = s.slice(start).trim();
  if (last) out.push(last);
  return out;
}

// ── Devise (Rails) ──────────────────────────────────────────────────────────

interface RubyStatement {
  code: string;
  line: number;
}

/** Logical Ruby statements: comments dropped, continuation lines (trailing `,` / `\` / open brackets) joined. */
function rubyStatements(text: string): RubyStatement[] {
  const out: RubyStatement[] = [];
  const lines = text.split(/\r?\n/);
  let pending: RubyStatement | null = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const code = stripComment(lines[i]!).trim();
    if (!code) continue;
    if (pending) pending.code += ` ${code}`;
    else pending = { code, line: i + 1 };
    scan(code, (c) => {
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
    });
    if (depth > 0 || /[,\\]$/.test(code)) {
      if (pending.code.endsWith('\\')) pending.code = pending.code.slice(0, -1);
      continue;
    }
    out.push(pending);
    pending = null;
    depth = 0;
  }
  if (pending) out.push(pending);
  return out;
}

/** The argument text of a `name arg, …` / `name(arg, …)` call at the start of `code`, or undefined. */
function callArgs(code: string, name: string): string | undefined {
  if (!code.startsWith(name)) return undefined;
  const rest = code.slice(name.length);
  if (/^\s*\(/.test(rest) && rest.trimEnd().endsWith(')')) {
    const inner = rest.trim().slice(1, -1);
    let depth = 0;
    let balanced = true;
    scan(inner, (c) => {
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c) && --depth < 0) balanced = false;
    });
    if (balanced) return inner.trim();
  }
  return /^\s/.test(rest) ? rest.trim() : undefined;
}

function rubyValue(raw: string, at: Where): ConfigValue {
  const e = raw.trim();
  let m = /^(['"])(.*)\1$/.exec(e);
  if (m && !(m[1] === '"' && m[2]!.includes('#{'))) return { kind: 'literal', value: m[2]!, at };
  if (/^-?\d+(\.\d+)?$/.test(e)) return { kind: 'literal', value: Number(e), at };
  if (e === 'true' || e === 'false') return { kind: 'literal', value: e === 'true', at };
  if ((m = /^:(\w+)$/.exec(e))) return { kind: 'literal', value: m[1]!, at };
  m = /^ENV(?:\[\s*['"]([A-Za-z_]\w*)['"]\s*\]|\.fetch\(\s*['"]([A-Za-z_]\w*)['"][^)]*\))$/.exec(e);
  if (m) return { kind: 'env', name: (m[1] ?? m[2])!, at };
  return { kind: 'opaque', text: e.length > 60 ? `${e.slice(0, 57)}…` : e, at };
}

const RUBY_UNITS: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: DAY, week: 7 * DAY, fortnight: 14 * DAY, month: 30 * DAY, year: 365 * DAY };

/** `30.minutes`, `2.hours`, `1.day`, `4.weeks`, or plain seconds. */
function rubyDuration(e: string): number | undefined {
  const s = e.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(\d+(?:\.\d+)?)\.(second|minute|hour|day|week|fortnight|month|year)s?$/.exec(s);
  return m ? Math.round(Number(m[1]) * RUBY_UNITS[m[2]!]!) : undefined;
}

/** Symbols in `[:a, :b]`, `%i[a b]` or `:a`. */
function rubySymbols(e: string): string[] {
  const s = e.trim();
  const pct = /^%[iw][[(](.*)[\])]$/.exec(s);
  if (pct) return pct[1]!.split(/\s+/).filter(Boolean);
  return [...s.matchAll(/:(\w+)/g)].map((m) => m[1]!);
}

/** Keyword arguments (`key: value` or `:key => value`) and positional ones. */
function rubyArgs(args: string[]): { positional: string[]; keywords: Map<string, string> } {
  const positional: string[] = [];
  const keywords = new Map<string, string>();
  for (const a of args) {
    const m = /^(\w+):\s+(.*)$/s.exec(a) ?? /^:(\w+)\s*=>\s*(.*)$/s.exec(a);
    if (m) keywords.set(m[1]!, m[2]!.trim());
    else positional.push(a);
  }
  return { positional, keywords };
}

function underscore(name: string): string {
  return name
    .replace(/::/g, '/')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

interface DeviseModel {
  name: string;
  file: string;
  line: number;
  modules: Map<string, Where>;
  options: Map<string, { expr: string; at: Where }>;
}

function deviseModels(project: string): DeviseModel[] {
  const models: DeviseModel[] = [];
  for (const path of walk(join(project, 'app/models'), (r) => r.endsWith('.rb'))) {
    const file = rel(project, path);
    let model: DeviseModel | undefined;
    let className: string | undefined;
    for (const st of rubyStatements(readFileSync(path, 'utf8'))) {
      const cls = /^class\s+([\w:]+)/.exec(st.code);
      if (cls) className = cls[1];
      const call = callArgs(st.code, 'devise');
      if (call === undefined || !className) continue;
      model ??= { name: className, file, line: st.line, modules: new Map(), options: new Map() };
      const { positional, keywords } = rubyArgs(splitTop(call));
      for (const p of positional) for (const sym of rubySymbols(p)) model.modules.set(sym, { file, line: st.line });
      for (const [k, v] of keywords) model.options.set(k, { expr: v, at: { file, line: st.line } });
    }
    if (model) models.push(model);
  }
  // The `User` model is the primary one when there are several.
  return models.sort((a, b) => Number(b.name === 'User') - Number(a.name === 'User'));
}

/** Settings with nothing to carry over (Rails / Warden plumbing, form behaviour Atlas's hosted pages own). */
const DEVISE_PLUMBING: Record<string, string> = {
  parent_controller: 'Devise controllers are replaced by Atlas hosted pages.',
  skip_session_storage: 'Rails session plumbing; Atlas keeps its own session.',
  sign_out_via: 'Atlas signs out through its own endpoint (POST).',
  'responder.error_status': 'Turbo form responses; Atlas hosted pages render their own.',
  'responder.redirect_status': 'Turbo form responses; Atlas hosted pages render their own.',
  navigational_formats: 'Controller format plumbing.',
  http_authenticatable: 'HTTP Basic sign-in has no Atlas counterpart; use API keys or M2M tokens for machine clients.',
  params_authenticatable: 'Controller plumbing.',
  clean_up_csrf_token_on_authentication: 'Atlas hosted pages handle CSRF themselves.',
  email_regexp: 'Atlas validates email addresses itself.',
  scoped_views: 'Devise views are replaced by Atlas hosted pages (customise them in the Atlas dashboard).',
  sign_out_all_scopes: 'Atlas has one user pool; sign-out ends the Atlas session.',
  send_email_changed_notification: 'Atlas sends its own account emails; choose which in the email templates.',
  send_password_change_notification: 'Atlas sends its own account emails; choose which in the email templates.',
  reload_routes: 'Rails routing plumbing.',
  omniauth_path_prefix: 'OmniAuth routes are replaced by Atlas social sign-in.',
  router_name: 'Rails routing plumbing.',
};

export function translateDevise(project: string): TranslationResult {
  const initializer = 'config/initializers/devise.rb';
  const initPath = join(project, initializer);
  const statements = existsSync(initPath) ? rubyStatements(readFileSync(initPath, 'utf8')) : [];
  const models = deviseModels(project);
  const model = models[0];
  const setupLine = statements.find((s) => /^Devise\.setup\b/.test(s.code))?.line ?? 1;
  const where: Where = statements.length ? { file: initializer, line: setupLine } : model ? { file: model.file, line: model.line } : { file: '(none)', line: 0 };
  const origin = statements.length ? `Devise config at ${initializer}:${setupLine}` : model ? `Devise model at ${model.file}:${model.line}` : 'Devise config (not found)';
  const b = new TranslationBuilder(origin, where);
  if (!statements.length && !model) {
    b.add('manual', 'setup', 'devise', `No ${initializer} and no model calling devise were found under ${project}. Point the command at the Rails app's root folder.`);
    return b.result();
  }
  const area = 'devise';

  // The initializer: `config.x = …` settings and `config.omniauth :provider, …` calls.
  const settings = new Map<string, { expr: string; at: Where }>();
  const omniauth: Array<{ strategy: string; args: string[]; at: Where }> = [];
  for (const st of statements) {
    const at = { file: initializer, line: st.line };
    const oaArgs = callArgs(st.code, 'config.omniauth');
    const oa = oaArgs === undefined ? undefined : splitTop(oaArgs);
    if (oa?.length && /^:\w+$/.test(oa[0]!)) {
      omniauth.push({ strategy: oa[0]!.slice(1), args: oa.slice(1), at });
      continue;
    }
    if (/^config\.warden\b/.test(st.code)) {
      b.add('manual', area, 'warden', 'Warden hooks and strategies run inside your app; move what they do to Atlas Actions (post-sign-in, pre-sign-up) or your own middleware.', at);
      continue;
    }
    const set = /^config\.([\w.]+)\s*=\s*(.+)$/.exec(st.code);
    if (set && !settings.has(set[1]!)) settings.set(set[1]!, { expr: set[2]!.trim(), at });
  }
  const used = new Set<string>();
  const take = (name: string) => {
    used.add(name);
    return settings.get(name);
  };

  const mods = model?.modules ?? new Map<string, Where>();
  const modAt = (name: string): Where | undefined => mods.get(name);
  const modelAt: Where = model ? { file: model.file, line: model.line } : where;
  const modelName = model?.name ?? 'User';

  // Sign-in methods.
  if (mods.has('database_authenticatable') || mods.has('two_factor_authenticatable')) {
    b.set('strategies.password', true);
    b.add('mapped', 'models', mods.has('database_authenticatable') ? ':database_authenticatable' : ':two_factor_authenticatable', 'Email and password sign-in on. bcrypt hashes (encrypted_password) carry over in the export.', modAt('database_authenticatable') ?? modAt('two_factor_authenticatable'), 'auth_config.strategies.password');
  }
  const keys = take('authentication_keys');
  if (keys) {
    const list = rubySymbols(keys.expr);
    if (list.some((k) => k === 'username' || k === 'login')) {
      b.set('strategies.username', true);
      b.add(
        list.includes('login') ? 'differs' : 'mapped',
        area,
        'authentication_keys',
        list.includes('login') ? 'A virtual :login (username or email): Atlas signs in with either in the same field when username sign-in is on.' : 'Username sign-in on.',
        keys.at,
        'auth_config.strategies.username',
      );
    } else b.add(list.length === 1 && list[0] === 'email' ? 'mapped' : 'manual', area, 'authentication_keys', list.length === 1 && list[0] === 'email' ? 'Sign in with email.' : `Sign-in keys ${list.join(', ')}: Atlas signs in with email, username or phone; other keys need a custom flow.`, keys.at);
  }
  for (const name of ['case_insensitive_keys', 'strip_whitespace_keys']) {
    const s = take(name);
    if (s) b.add('mapped', area, name, 'Atlas trims and compares email addresses case-insensitively.', s.at);
  }
  const reg = modAt('registerable');
  if (model && !reg) {
    b.set('signUpMode', 'restricted');
    b.add('mapped', 'models', ':registerable', `${modelName} is not :registerable, so users cannot sign themselves up: Atlas sign-up is restricted (invitations and the allowlist still work).`, modelAt, 'auth_config.signUpMode');
  } else if (reg) b.add('mapped', 'models', ':registerable', 'Self sign-up stays open.', reg);

  // Passwords.
  const stretches = take('stretches');
  if (stretches) b.add('mapped', area, 'stretches', 'The bcrypt cost is stored in each hash; Atlas verifies any cost and rehashes on first sign-in.', stretches.at);
  const pepper = take('pepper');
  if (pepper) b.add('mapped', area, 'pepper', 'The export carries the pepper with each bcrypt hash, so passwords verify unchanged. The value is never written to the config files.', pepper.at);
  const length = take('password_length');
  if (length) {
    const m = /^(\d+)\s*\.\.\.?\s*(\d+)$/.exec(length.expr);
    if (m) {
      b.minPasswordLength(Number(m[1]), area, 'password_length', length.at, 'Devise');
      const max = Number(m[2]);
      b.set('passwordPolicy.maxLength', clamp(max, 8, 256));
      if (max > 256) b.add('differs', area, 'password_length (max)', `Atlas caps passwords at 256 characters (Devise: ${max}).`, length.at, 'auth_config.passwordPolicy.maxLength');
    } else b.add('manual', area, 'password_length', `Cannot read "${length.expr}" statically; set auth_config.passwordPolicy.minLength yourself.`, length.at);
  }
  if (modAt('validatable')) b.add('mapped', 'models', ':validatable', 'Atlas checks the email format and the password length (password_length) too.', modAt('validatable'));
  const pwned = modAt('pwned_password') ?? gemAt(project, 'devise-pwned_password');
  if (pwned) {
    b.set('passwordPolicy.checkBreaches', true);
    b.add('mapped', modAt('pwned_password') ? 'models' : 'Gemfile', modAt('pwned_password') ? ':pwned_password' : 'devise-pwned_password', 'New passwords are checked against breached-password data.', pwned, 'auth_config.passwordPolicy.checkBreaches');
  }
  const encryptor = take('encryptor');
  const encryptable = modAt('encryptable');
  if (encryptable || encryptor) {
    const scope = underscore(modelName.split('::').pop()!);
    b.lazy = { preset: 'devise_json', config: scope === 'user' ? {} : { scope, path: `/${scope}s/sign_in` } };
    b.add(
      'manual',
      encryptable ? 'models' : area,
      encryptable ? ':encryptable' : 'encryptor',
      `devise-encryptable digests${encryptor ? ` (${encryptor.expr})` : ''} do not carry over. Turn on lazy migration (preset devise_json, your app's base URL): Atlas checks each password against your Rails sign-in once, then stores its own hash. Users who never sign in during the window reset their password.`,
      encryptable ?? encryptor!.at,
      'lazy migration devise_json',
    );
  }

  // Recovery.
  if (modAt('recoverable')) {
    b.set('accountUx.passwordReset', 'link');
    b.add('mapped', 'models', ':recoverable', 'Password reset by emailed link. Atlas sends it through your email provider; customise the "password reset" template instead of the Devise mailer view.', modAt('recoverable'), 'auth_config.accountUx.passwordReset');
  }
  const resetWithin = take('reset_password_within');
  if (resetWithin) {
    const s = rubyDuration(resetWithin.expr);
    if (s !== undefined) {
      const minutes = clamp(Math.ceil(s / 60), 1, 1440);
      if (b.get('verification.magicLink.ttlMinutes') === undefined) b.set('verification.magicLink.ttlMinutes', minutes);
      b.add('differs', area, 'reset_password_within', `Reset links use the email-link lifetime (verification.magicLink.ttlMinutes, up to 1 day), shared with sign-in links. Devise: ${humanDuration(s)}. Reset links sent before the switch stop working.`, resetWithin.at, 'auth_config.verification.magicLink.ttlMinutes');
    } else b.add('manual', area, 'reset_password_within', `Cannot read "${resetWithin.expr}" statically.`, resetWithin.at);
  }
  const signInAfterReset = take('sign_in_after_reset_password');
  if (signInAfterReset) {
    const v = signInAfterReset.expr === 'true';
    b.set('signInAfterReset', v);
    b.add('mapped', area, 'sign_in_after_reset_password', v ? 'A completed reset signs the user in.' : 'A completed reset ends at the sign-in screen.', signInAfterReset.at, 'auth_config.signInAfterReset');
  }

  // Email confirmation.
  const confirmable = modAt('confirmable');
  const unconfirmed = take('allow_unconfirmed_access_for');
  const confirmWithin = take('confirm_within');
  const reconfirmable = take('reconfirmable');
  if (confirmable) {
    b.set('requireEmailVerification', true);
    b.set('accountUx.emailVerification', 'link');
    b.add('mapped', 'models', ':confirmable', 'Email verification required, by emailed link. confirmed_at carries over: confirmed users stay verified.', confirmable, 'auth_config.requireEmailVerification');
    if (unconfirmed) {
      const s = rubyDuration(unconfirmed.expr);
      b.add(s === 0 ? 'mapped' : 'differs', area, 'allow_unconfirmed_access_for', s === 0 ? 'No grace period: unconfirmed users cannot sign in.' : 'Atlas has no grace period: users confirm their email before their first session.', unconfirmed.at, 'auth_config.requireEmailVerification');
    }
    if (confirmWithin) {
      const s = rubyDuration(confirmWithin.expr);
      if (s !== undefined && b.get('verification.magicLink.ttlMinutes') === undefined) b.set('verification.magicLink.ttlMinutes', clamp(Math.ceil(s / 60), 1, 1440));
      b.add(s !== undefined && s <= DAY ? 'mapped' : 'differs', area, 'confirm_within', `Verification links last up to 1 day in Atlas (verification.magicLink.ttlMinutes)${s !== undefined ? `; Devise: ${humanDuration(s)}` : ''}. Users can ask for a new link.`, confirmWithin.at, 'auth_config.verification.magicLink.ttlMinutes');
    }
    if (reconfirmable) b.add('mapped', area, 'reconfirmable', 'A changed email is verified before it replaces the old one.', reconfirmable.at);
  } else {
    if (model) {
      b.set('requireEmailVerification', false);
      b.add('mapped', 'models', ':confirmable', `${modelName} is not :confirmable: email verification stays optional. The export marks emails unverified unless you pass --set trust-unconfirmable=true.`, modelAt, 'auth_config.requireEmailVerification');
    }
    for (const [name, s] of [['allow_unconfirmed_access_for', unconfirmed], ['confirm_within', confirmWithin], ['reconfirmable', reconfirmable]] as const) {
      if (s) b.add('mapped', area, name, `No effect in Devise: ${modelName} is not :confirmable.`, s.at);
    }
  }

  // Lockout.
  const lockable = modAt('lockable');
  const lockSettings = ['lock_strategy', 'unlock_strategy', 'maximum_attempts', 'unlock_in', 'unlock_keys', 'last_attempt_warning'].map((n) => [n, take(n)] as const);
  if (lockable) {
    const max = settings.get('maximum_attempts')?.expr ?? '20';
    const unlockIn = rubyDuration(settings.get('unlock_in')?.expr ?? '1.hour');
    const strategy = settings.get('lock_strategy')?.expr;
    if (strategy === ':none') b.add('differs', area, 'lock_strategy', "Devise never locks accounts. Atlas's brute-force protection is on by default; turn it off with attack_protection.brute_force if you really want none.", settings.get('lock_strategy')!.at, 'auth_config.attackProtection.bruteForce');
    else {
      b.set('attackProtection.bruteForce.enabled', true);
      b.add(
        'differs',
        'models',
        ':lockable',
        `Atlas's brute-force protection locks sign-in progressively after repeated failures and unlocks on its own; it has no fixed attempt count or unlock email. Devise: lock after ${max} failures${unlockIn !== undefined ? `, unlock after ${humanDuration(unlockIn)}` : ''}. locked_at carries over: a locked user stays locked.`,
        lockable,
        'auth_config.attackProtection.bruteForce',
      );
    }
    for (const [name, s] of lockSettings) if (s && !(name === 'lock_strategy' && strategy === ':none')) b.add('differs', area, name, 'Covered by the :lockable entry: Atlas uses progressive lockout tiers instead.', s.at, 'auth_config.attackProtection.bruteForce');
  } else for (const [name, s] of lockSettings) if (s) b.add('mapped', area, name, `No effect in Devise: ${modelName} is not :lockable. Atlas's brute-force protection stays on (its default).`, s.at);

  // Session lifetime: :timeoutable is an idle timeout, :rememberable the remember-me cookie.
  const timeoutable = modAt('timeoutable');
  const rememberable = modAt('rememberable');
  const timeoutIn = take('timeout_in');
  const rememberFor = take('remember_for');
  const extend = take('extend_remember_period');
  const sessionArea = 'sessions';
  let idle: number | undefined;
  if (timeoutable) {
    idle = timeoutIn ? rubyDuration(timeoutIn.expr) : 30 * 60;
    if (idle === undefined) b.add('manual', area, 'timeout_in', `Cannot read "${timeoutIn!.expr}" statically; set auth_config.session.idleMs yourself.`, timeoutIn!.at);
    else b.session(idle, true, sessionArea, timeoutIn ? 'timeout_in' : 'timeout_in (default 30 minutes)', timeoutIn?.at ?? timeoutable, 'Devise');
  } else if (timeoutIn) b.add('mapped', area, 'timeout_in', `No effect in Devise: ${modelName} is not :timeoutable.`, timeoutIn.at);
  if (rememberable) {
    const s = rememberFor ? rubyDuration(rememberFor.expr) : 14 * DAY;
    const setting = rememberFor ? 'remember_for' : 'remember_for (default 2 weeks)';
    if (s === undefined) b.add('manual', area, 'remember_for', `Cannot read "${rememberFor!.expr}" statically; set auth_config.session.absoluteMs yourself.`, rememberFor!.at);
    else if (idle !== undefined) {
      const abs = clamp(s, Math.max(MIN_IDLE_S, idle), MAX_ABSOLUTE_S);
      b.set('session.absoluteMs', abs * 1000);
      b.add('differs', sessionArea, setting, `Sessions end after ${humanDuration(abs)} at most${abs !== s ? ` (Devise: ${humanDuration(s)}; Atlas allows up to 90 days)` : ''}. Devise skips the idle timeout for users who ticked "remember me"; Atlas applies it to every session.`, rememberFor?.at ?? rememberable, 'auth_config.session.absoluteMs');
    } else {
      b.session(s, extend?.expr === 'true', sessionArea, setting, rememberFor?.at ?? rememberable, 'Devise');
      b.add('differs', 'models', ':rememberable', 'Devise keeps users signed in past the browser session only when they tick "remember me"; every Atlas session lasts the configured lifetime.', rememberable);
    }
    if (extend) b.add('mapped', area, 'extend_remember_period', extend.expr === 'true' ? 'Activity extends the session.' : 'Activity does not extend the session.', extend.at);
  } else {
    if (rememberFor) b.add('mapped', area, 'remember_for', `No effect in Devise: ${modelName} is not :rememberable.`, rememberFor.at);
    if (extend) b.add('mapped', area, 'extend_remember_period', `No effect in Devise: ${modelName} is not :rememberable.`, extend.at);
    if (!timeoutable && model) b.add('differs', sessionArea, 'session lifetime', 'Devise sessions end when the browser closes (no :rememberable or :timeoutable); Atlas sessions keep its default lifetime. Set auth_config.session to shorten them.', modelAt, 'auth_config.session');
  }
  const expireAll = take('expire_all_remember_me_on_sign_out');
  if (expireAll) b.add('differs', area, 'expire_all_remember_me_on_sign_out', "Atlas sign-out ends the current session; sign the user out everywhere with the revoke-all-sessions API or the user's session list.", expireAll.at);
  if (modAt('trackable')) b.add('mapped', 'models', ':trackable', 'Atlas records every sign-in itself (time, IP, device). The old sign-in counters stay in your database if you need them.', modAt('trackable'));

  // Two-factor (devise-two-factor), invitations, magic links, passkeys.
  const totp = modAt('two_factor_authenticatable');
  if (totp) {
    b.set('mfa.factors.totp', true);
    b.set('mfaPolicy', 'optional');
    b.add('mapped', 'models', ':two_factor_authenticatable', 'Authenticator-app (TOTP) MFA on, optional per user. otp_secret carries over in the export: enrolled users keep their authenticator.', totp, 'auth_config.mfa.factors.totp');
  }
  const backup = modAt('two_factor_backupable');
  if (backup) {
    const count = Number(model?.options.get('otp_number_of_backup_codes')?.expr ?? '10');
    b.set('mfa.backupCodes.count', Number.isFinite(count) ? clamp(count, 1, 20) : 10);
    b.add('mapped', 'models', ':two_factor_backupable', `${Number.isFinite(count) ? count : 10} backup codes per user. Unused codes carry over (their bcrypt digests).`, backup, 'auth_config.mfa.backupCodes.count');
  }
  if (modAt('invitable')) b.add('differs', 'models', ':invitable', 'Atlas invitations: an emailed sign-up link. Pending devise_invitable invitations do not carry over; send them again from Atlas.', modAt('invitable'), 'invitations');
  const magic = modAt('magic_link_authenticatable');
  if (magic) {
    b.set('strategies.emailLink', true);
    b.add('differs', 'models', ':magic_link_authenticatable', 'Email sign-in links on. Atlas sends them through your email provider; customise the "magic link" template instead of the devise-passwordless mailer.', magic, 'auth_config.strategies.emailLink');
  }
  const passkeys = modAt('passkey_authenticatable') ?? gemAt(project, 'webauthn');
  if (passkeys) {
    b.set('strategies.passkey', true);
    b.add('differs', modAt('passkey_authenticatable') ? 'models' : 'Gemfile', modAt('passkey_authenticatable') ? ':passkey_authenticatable' : 'webauthn', 'Passkey sign-in on. Passkeys registered in the Rails app are not in the export: users add them again in Atlas (a passkey belongs to its domain).', passkeys, 'auth_config.strategies.passkey');
  }
  const KNOWN = new Set(['database_authenticatable', 'registerable', 'recoverable', 'rememberable', 'validatable', 'confirmable', 'lockable', 'timeoutable', 'trackable', 'omniauthable', 'two_factor_authenticatable', 'two_factor_backupable', 'encryptable', 'invitable', 'magic_link_authenticatable', 'passkey_authenticatable', 'pwned_password']);
  for (const [name, at] of mods) if (!KNOWN.has(name)) b.add('manual', 'models', `:${name}`, `:${name} comes from a Devise extension this step does not know; check what it enforces and rebuild it with Atlas settings or Actions.`, at);
  for (const other of models.slice(1)) {
    b.add('manual', 'models', other.name, `A second Devise model (${other.name}). An Atlas instance has one user pool: export it separately (--set users-table=${underscore(other.name)}s) into its own instance, or import its users into this one and tell them apart with a role or metadata.`, { file: other.file, line: other.line });
  }

  // OmniAuth providers.
  const listed = new Set(rubySymbols(model?.options.get('omniauth_providers')?.expr ?? ''));
  for (const o of omniauth) {
    listed.delete(o.strategy);
    const setting = `omniauth :${o.strategy}`;
    if (o.strategy === 'saml') {
      b.add('manual', 'omniauth', setting, 'SAML: create an Atlas enterprise SSO connection for the IdP (its metadata URL or certificate and SSO URL). Atlas routes users to it by email domain.', o.at, 'sso_connections');
      continue;
    }
    if (o.strategy === 'openid_connect') {
      b.add('manual', 'omniauth', setting, 'Generic OpenID Connect: add it as a custom OIDC provider (custom_oauth_providers, with the issuer) or, for a workforce IdP, an enterprise SSO connection.', o.at, 'custom_oauth_providers');
      continue;
    }
    const atlasKey = FRAMEWORK_PROVIDER_MAP[o.strategy];
    if (!atlasKey) {
      b.add('manual', 'omniauth', setting, `"${o.strategy}" has no same-named Atlas provider: add it as a custom OAuth / OIDC provider (custom_oauth_providers) with its endpoints.`, o.at, 'custom_oauth_providers');
      continue;
    }
    const { positional, keywords } = rubyArgs(o.args);
    const upper = upperSnake(atlasKey);
    const clientId = b.configString(positional[0] ? rubyValue(positional[0], o.at) : undefined, `${atlasKey} client id`, `${upper}_CLIENT_ID`, { area: 'omniauth', setting: `${setting} client id` });
    const clientSecret = b.configString(positional[1] ? rubyValue(positional[1], o.at) : undefined, `${atlasKey} client secret`, `${upper}_CLIENT_SECRET`, { secret: true, area: 'omniauth', setting: `${setting} client secret` });
    const scope = keywords.get('scope');
    const scopeValue = scope ? rubyValue(scope, o.at) : undefined;
    const scopes = scopeValue?.kind === 'literal' && typeof scopeValue.value === 'string' ? scopeValue.value.split(/[\s,]+/).filter(Boolean) : undefined;
    b.oauthProvider({ sourceId: o.strategy, atlasKey, clientId, clientSecret, scopes, area: 'omniauth', setting, at: o.at });
  }
  for (const strategy of listed) b.add('manual', 'omniauth', `omniauth_providers :${strategy}`, `${strategy} is listed on the model but not configured in ${initializer} (an OmniAuth::Builder middleware?): add it in Atlas with the same OAuth app.`, model?.options.get('omniauth_providers')?.at);

  // Secrets and mail.
  const secretKey = take('secret_key');
  if (secretKey) {
    const literal = rubyValue(secretKey.expr, secretKey.at).kind === 'literal';
    b.add(
      literal ? 'manual' : 'mapped',
      area,
      'secret_key',
      `Devise signs its confirmation, reset and unlock tokens with it; Atlas issues its own, so links sent before the switch stop working.${literal ? ' It is hard-coded in source: move it out of the code (Atlas never needs it).' : ''}`,
      secretKey.at,
    );
  }
  const sender = take('mailer_sender');
  if (sender) {
    const v = rubyValue(sender.expr, sender.at);
    b.add('manual', area, 'mailer_sender', `Set the sender address${v.kind === 'literal' ? ` (${v.value})` : ''} in Atlas's email settings: Atlas sends the account emails itself.`, sender.at, 'email settings');
  }
  const paranoid = take('paranoid');
  if (paranoid) b.add('mapped', area, 'paranoid', 'Atlas answers reset and confirmation requests the same way whether or not the account exists.', paranoid.at);

  // Everything else the initializer sets.
  for (const [name, s] of settings) {
    if (used.has(name)) continue;
    if (DEVISE_PLUMBING[name]) b.add('mapped', area, name, `Nothing to carry over: ${DEVISE_PLUMBING[name]}`, s.at);
    else b.add('manual', area, name, `Not translated (${snippet(name, s.expr)}): check whether your app relies on it.`, s.at);
  }

  sessionStore(project, b);
  return b.result();
}

/** The line of `gem "<name>"` in the Gemfile, if any. */
function gemAt(project: string, name: string): Where | undefined {
  const path = join(project, 'Gemfile');
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp(`^\\s*gem\\s+['"]${name.replace(/[-]/g, '\\-')}['"]`).test(stripComment(l)));
  return i < 0 ? undefined : { file: 'Gemfile', line: i + 1 };
}

/** The Rails session store → bridge preset (cookie store: devise; activerecord-session_store: devise_active_record). */
function sessionStore(project: string, b: TranslationBuilder): void {
  let found: { store: string; key?: string; at: Where } | undefined;
  let appModule: string | undefined;
  for (const file of ['config/initializers/session_store.rb', 'config/application.rb', 'config/environments/production.rb']) {
    const path = join(project, file);
    if (!existsSync(path)) continue;
    for (const st of rubyStatements(readFileSync(path, 'utf8'))) {
      const mod = /^module\s+(\w+)/.exec(st.code);
      if (mod && file === 'config/application.rb') appModule ??= mod[1];
      const idx = st.code.search(/\bsession_store\b/);
      const args = idx < 0 ? undefined : callArgs(st.code.slice(idx), 'session_store');
      const parts = args === undefined ? [] : splitTop(args);
      if (parts.length && /^:\w+$/.test(parts[0]!) && !found) {
        const key = rubyArgs(parts.slice(1)).keywords.get('key');
        const kv = key ? rubyValue(key, { file, line: st.line }) : undefined;
        found = { store: parts[0]!.slice(1), key: kv?.kind === 'literal' ? String(kv.value) : undefined, at: { file, line: st.line } };
      }
    }
  }
  const store = found?.store ?? 'cookie_store';
  const cookieName = found?.key ?? (appModule ? `_${underscore(appModule)}_session` : undefined);
  const setting = found ? `session_store :${store}` : 'session_store (default cookie_store)';
  const vars: Record<string, string> = cookieName ? { cookie_name: cookieName } : {};
  if (store === 'cookie_store') {
    b.bridge = { preset: 'devise', vars };
    b.add(
      'mapped',
      'bridge',
      setting,
      `Cookie-store sessions are opened on your server: pass deviseExtractor({ cookieName${cookieName ? ` ("${cookieName}")` : ''}, secretKeyBase, bridgeSecret }) to the bridge middleware (preset devise). secret_key_base never leaves your server. JSON (or hybrid) cookie serializer only.`,
      found?.at,
      'bridge preset devise',
    );
    const serializer = cookieSerializer(project);
    if (serializer) {
      const ok = serializer.value === 'json' || serializer.value === 'hybrid';
      b.add(ok ? 'mapped' : 'manual', 'bridge', 'cookies_serializer', ok ? `:${serializer.value}: the bridge extractor can read the session.` : `:${serializer.value}: the bridge extractor reads JSON cookies only. Switch to :hybrid a few weeks before the cutover (it rewrites cookies as JSON), or users sign in once more.`, serializer.at);
    }
  } else if (store === 'active_record_store') {
    b.bridge = { preset: 'devise_active_record', vars };
    b.add('mapped', 'bridge', setting, 'activerecord-session_store sessions: the export imports the sessions table and the bridge matches the session cookie (preset devise_active_record).', found?.at, 'bridge preset devise_active_record');
  } else {
    b.add('manual', 'bridge', setting, `:${store} sessions live in a cache the export cannot read: users sign in once more after the switch, or read the session yourself in a custom extractToken.`, found?.at);
  }
  if (!cookieName && b.bridge) b.add('manual', 'bridge', 'cookie_name', 'Could not tell the session cookie name: set cookie_name in the bridge settings (_<app>_session by default).', found?.at);
}

function cookieSerializer(project: string): { value: string; at: Where } | undefined {
  for (const file of ['config/initializers/cookies_serializer.rb', 'config/application.rb']) {
    const path = join(project, file);
    if (!existsSync(path)) continue;
    for (const st of rubyStatements(readFileSync(path, 'utf8'))) {
      const m = /cookies_serializer\s*=\s*:(\w+)/.exec(st.code);
      if (m) return { value: m[1]!, at: { file, line: st.line } };
    }
  }
  return undefined;
}

// ── Django ──────────────────────────────────────────────────────────────────

/** A Python literal as read from settings, located by line. */
type Py =
  | { t: 'str'; v: string; line: number }
  | { t: 'num'; v: number; line: number }
  | { t: 'bool'; v: boolean; line: number }
  | { t: 'none'; line: number }
  | { t: 'list'; items: Py[]; line: number }
  | { t: 'dict'; entries: Array<[Py, Py]>; line: number }
  | { t: 'env'; name: string; line: number }
  | { t: 'expr'; text: string; line: number };

interface Tok {
  k: 'str' | 'fstr' | 'num' | 'name' | 'op' | 'nl';
  v: string;
  line: number;
  col: number;
  start: number;
  end: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let depth = 0;
  const push = (k: Tok['k'], v: string, start: number) => out.push({ k, v, line, col: start - lineStart, start, end: i });
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') {
      if (depth === 0) push('nl', '', i);
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      line++;
      lineStart = i;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const str = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(src.slice(i, i + 5));
    if (str && (str[1] || c === '"' || c === "'")) {
      const start = i;
      const startLine = line;
      const startCol = i - lineStart;
      const q = str[2]!;
      i += str[0].length;
      let value = '';
      while (i < src.length && !src.startsWith(q, i)) {
        if (src[i] === '\\' && !/[rR]/.test(str[1]!)) {
          value += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (src[i] === '\n') {
          line++;
          lineStart = i + 1;
        }
        value += src[i];
        i++;
      }
      i += q.length;
      out.push({ k: /[fF]/.test(str[1]!) ? 'fstr' : 'str', v: value, line: startLine, col: startCol, start, end: i });
      continue;
    }
    const num = /^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 40));
    if (num) {
      const start = i;
      i += num[0].length;
      push('num', num[0].replace(/_/g, ''), start);
      continue;
    }
    const name = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 200));
    if (name) {
      const start = i;
      i += name[0].length;
      push('name', name[0], start);
      continue;
    }
    const two = src.slice(i, i + 2);
    const start = i;
    if (['+=', '==', '!=', '<=', '>=', '**', '//', '->', ':='].includes(two)) {
      i += 2;
      push('op', two, start);
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    i++;
    push('op', c, start);
  }
  return out;
}

/** Calls that read the environment: os.environ.get / os.getenv / django-environ env(), env.str() … / python-decouple config(). */
const ENV_CALLS = /^(os\.environ\.get|os\.getenv|environ\.get|getenv|env|env\.(str|int|bool|float|list|tuple|dict|json|url|db|db_url|cache|cache_url|email|email_url|path)|config)$/;

class PyParser {
  i = 0;
  constructor(private readonly toks: Tok[], private readonly src: string) {}

  peek(): Tok | undefined {
    return this.toks[this.i];
  }

  isOp(v: string): boolean {
    const t = this.peek();
    return t?.k === 'op' && t.v === v;
  }

  text(from: number): string {
    const a = this.toks[from];
    const z = this.toks[Math.max(from, this.i - 1)];
    return a && z ? this.src.slice(a.start, z.end).replace(/\s+/g, ' ') : '';
  }

  /** Skip to the bracket closing the one just opened. */
  skipToClose(): void {
    let depth = 1;
    while (this.peek()) {
      const t = this.toks[this.i++]!;
      if (t.k !== 'op') continue;
      if ('([{'.includes(t.v)) depth++;
      else if (')]}'.includes(t.v) && --depth === 0) return;
    }
  }

  expr(): Py {
    const from = this.i;
    let left = this.unary();
    while (this.peek()?.k === 'op' && ['+', '-', '*', '/', '//', '|', '%'].includes(this.peek()!.v)) {
      const op = this.toks[this.i++]!.v;
      const right = this.unary();
      if (left.t === 'num' && right.t === 'num') {
        const v = op === '+' ? left.v + right.v : op === '-' ? left.v - right.v : op === '*' ? left.v * right.v : op === '/' ? left.v / right.v : op === '//' ? Math.floor(left.v / right.v) : NaN;
        left = Number.isNaN(v) ? { t: 'expr', text: this.text(from), line: left.line } : { t: 'num', v, line: left.line };
      } else if (op === '+' && left.t === 'list' && right.t === 'list') left = { t: 'list', items: [...left.items, ...right.items], line: left.line };
      else if (op === '+' && left.t === 'str' && right.t === 'str') left = { t: 'str', v: left.v + right.v, line: left.line };
      else left = { t: 'expr', text: this.text(from), line: left.line };
    }
    const t = this.peek();
    if (t?.k === 'name' && ['if', 'for', 'and', 'or', 'in', 'not', 'is'].includes(t.v)) {
      // A conditional or comprehension: keep its text.
      while (this.peek() && !(this.peek()!.k === 'op' && [',', ')', ']', '}', ':'].includes(this.peek()!.v))) {
        const n = this.toks[this.i++]!;
        if (n.k === 'op' && '([{'.includes(n.v)) this.skipToClose();
      }
      return { t: 'expr', text: this.text(from), line: left.line };
    }
    return left;
  }

  unary(): Py {
    if (this.isOp('-')) {
      this.i++;
      const v = this.unary();
      return v.t === 'num' ? { ...v, v: -v.v } : v;
    }
    if (this.peek()?.k === 'name' && this.peek()!.v === 'not') {
      this.i++;
      const v = this.unary();
      return v.t === 'bool' ? { ...v, v: !v.v } : { t: 'expr', text: 'not …', line: v.line };
    }
    return this.atom();
  }

  /** Items up to `close`; null when the bracket holds a comprehension. */
  items(close: string): { items: Py[]; dict: Array<[Py, Py]> | null; comma: boolean } | null {
    const items: Py[] = [];
    let dict: Array<[Py, Py]> | null = null;
    let comma = false;
    while (this.peek() && !this.isOp(close)) {
      if (this.isOp('**') || this.isOp('*')) {
        this.i++;
        this.expr();
      } else {
        const k = this.expr();
        if (this.isOp(':')) {
          this.i++;
          (dict ??= []).push([k, this.expr()]);
        } else items.push(k);
      }
      if (this.isOp(',')) {
        this.i++;
        comma = true;
      } else if (!this.isOp(close)) {
        this.skipToClose();
        return null;
      }
    }
    this.i++;
    return { items, dict, comma };
  }

  atom(): Py {
    const t = this.toks[this.i++];
    if (!t || t.k === 'nl') return { t: 'expr', text: '', line: t?.line ?? 0 };
    const from = this.i - 1;
    if (t.k === 'str') {
      let v = t.v;
      while (this.peek()?.k === 'str') v += this.toks[this.i++]!.v;
      return { t: 'str', v, line: t.line };
    }
    if (t.k === 'fstr') return { t: 'expr', text: this.text(from), line: t.line };
    if (t.k === 'num') return { t: 'num', v: Number(t.v), line: t.line };
    if (t.k === 'op') {
      const close = t.v === '[' ? ']' : t.v === '(' ? ')' : t.v === '{' ? '}' : null;
      if (!close) return { t: 'expr', text: t.v, line: t.line };
      const r = this.items(close);
      if (!r) return { t: 'expr', text: this.text(from), line: t.line };
      if (t.v === '{' && r.dict) return { t: 'dict', entries: r.dict, line: t.line };
      if (t.v === '(' && r.items.length === 1 && !r.comma) return r.items[0]!;
      return { t: 'list', items: r.items, line: t.line };
    }
    // A name: True / False / None, or a dotted chain with calls and subscripts.
    if (t.v === 'True' || t.v === 'False') return { t: 'bool', v: t.v === 'True', line: t.line };
    if (t.v === 'None') return { t: 'none', line: t.line };
    let path = t.v;
    let result: Py | undefined;
    for (;;) {
      if (this.isOp('.') && this.toks[this.i + 1]?.k === 'name') {
        path += `.${this.toks[this.i + 1]!.v}`;
        this.i += 2;
      } else if (this.isOp('(')) {
        this.i++;
        const args: Py[] = [];
        while (this.peek() && !this.isOp(')')) {
          if (this.peek()?.k === 'name' && this.toks[this.i + 1]?.k === 'op' && this.toks[this.i + 1]!.v === '=') this.i += 2;
          else if (this.isOp('*') || this.isOp('**')) this.i++;
          args.push(this.expr());
          if (this.isOp(',')) this.i++;
          else if (!this.isOp(')')) {
            this.skipToClose();
            this.i--;
          }
        }
        this.i++;
        const first = args[0];
        result = !result && ENV_CALLS.test(path) && first?.t === 'str' ? { t: 'env', name: first.v, line: t.line } : { t: 'expr', text: this.text(from), line: t.line };
        path = '';
      } else if (this.isOp('[')) {
        this.i++;
        const key = this.expr();
        if (!this.isOp(']')) this.skipToClose();
        else this.i++;
        result = !result && /^(os\.)?environ$/.test(path) && key.t === 'str' ? { t: 'env', name: key.v, line: t.line } : { t: 'expr', text: this.text(from), line: t.line };
        path = '';
      } else break;
    }
    return result && path === '' ? result : { t: 'expr', text: this.text(from), line: t.line };
  }
}

interface Setting {
  name: string;
  value: Py;
  file: string;
  line: number;
  text: string;
}

/** Module-level `NAME = …` / `NAME += …` assignments of every settings file, base files first. */
function djangoSettings(project: string): { files: string[]; settings: Map<string, Setting>; overrides: Setting[] } {
  const files = walk(project, (r) => /(^|\/)settings\.py$/.test(r) || /(^|\/)settings\/[^/]+\.py$/.test(r)).map((p) => rel(project, p));
  const rank = (f: string) => {
    const base = f.split('/').pop()!;
    return base === 'settings.py' ? 0 : base === 'base.py' || base === 'common.py' || base === 'defaults.py' ? 1 : base === '__init__.py' ? 2 : 3;
  };
  files.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const settings = new Map<string, Setting>();
  const overrides: Setting[] = [];
  for (const file of files) {
    const src = readFileSync(join(project, file), 'utf8');
    const toks = tokenize(src);
    let i = 0;
    while (i < toks.length) {
      const t = toks[i]!;
      const op = toks[i + 1];
      if (t.k === 'name' && t.col === 0 && /^[A-Z][A-Z0-9_]*$/.test(t.v) && op?.k === 'op' && (op.v === '=' || op.v === '+=')) {
        let end = i + 2;
        while (end < toks.length && toks[end]!.k !== 'nl') end++;
        const stmt = toks.slice(i + 2, end);
        const value = stmt.length ? new PyParser(stmt, src).expr() : { t: 'expr' as const, text: '', line: t.line };
        const s: Setting = { name: t.v, value, file, line: t.line, text: stmt.length ? src.slice(stmt[0]!.start, stmt[stmt.length - 1]!.end) : '' };
        const prev = settings.get(t.v);
        if (op.v === '+=' && prev?.value.t === 'list' && value.t === 'list') prev.value = { ...prev.value, items: [...prev.value.items, ...value.items] };
        else if (!prev) settings.set(t.v, s);
        else if (prev.text.replace(/\s+/g, '') !== s.text.replace(/\s+/g, '')) overrides.push(s);
        i = end;
      }
      i++;
    }
  }
  return { files, settings, overrides };
}

const pyStr = (v: Py | undefined): string | undefined => (v?.t === 'str' ? v.v : undefined);
const pyStrings = (v: Py | undefined): Array<{ v: string; line: number }> => (v?.t === 'list' ? v.items.flatMap((x) => (x.t === 'str' ? [{ v: x.v, line: x.line }] : [])) : []);
function pyGet(v: Py | undefined, key: string): Py | undefined {
  if (v?.t !== 'dict') return undefined;
  return v.entries.find(([k]) => k.t === 'str' && k.v === key)?.[1];
}

/** Django hashers → how their hashes carry over. */
const DJANGO_HASHERS: Record<string, { alg: string; status: 'mapped' | 'differs' | 'manual' }> = {
  PBKDF2PasswordHasher: { alg: 'pbkdf2_sha256', status: 'mapped' },
  PBKDF2SHA1PasswordHasher: { alg: 'pbkdf2_sha1', status: 'mapped' },
  Argon2PasswordHasher: { alg: 'argon2', status: 'mapped' },
  BCryptSHA256PasswordHasher: { alg: 'bcrypt_sha256', status: 'mapped' },
  BCryptPasswordHasher: { alg: 'bcrypt', status: 'mapped' },
  ScryptPasswordHasher: { alg: 'scrypt', status: 'mapped' },
  MD5PasswordHasher: { alg: 'md5', status: 'differs' },
  SHA1PasswordHasher: { alg: 'sha1', status: 'differs' },
  UnsaltedMD5PasswordHasher: { alg: 'unsalted_md5', status: 'differs' },
  UnsaltedSHA1PasswordHasher: { alg: 'unsalted_sha1', status: 'differs' },
  CryptPasswordHasher: { alg: 'crypt', status: 'manual' },
};

/** python-social-auth backends → [settings prefix, provider name in UserSocialAuth, Atlas key]. */
const SOCIAL_CORE: Record<string, [string, string, string]> = {
  GoogleOAuth2: ['GOOGLE_OAUTH2', 'google-oauth2', 'google'],
  GithubOAuth2: ['GITHUB', 'github', 'github'],
  FacebookOAuth2: ['FACEBOOK', 'facebook', 'facebook'],
  AppleIdAuth: ['APPLE_ID', 'apple-id', 'apple'],
  TwitterOAuth2: ['TWITTER_OAUTH2', 'twitter-oauth2', 'x'],
  MicrosoftOAuth2: ['MICROSOFT_GRAPH', 'microsoft-graph', 'microsoft'],
  AzureADOAuth2: ['AZUREAD_OAUTH2', 'azuread-oauth2', 'microsoft'],
  AzureADV2OAuth2: ['AZUREAD_V2_OAUTH2', 'azuread-v2-oauth2', 'microsoft'],
  AzureADTenantOAuth2: ['AZUREAD_TENANT_OAUTH2', 'azuread-tenant-oauth2', 'microsoft'],
  LinkedinOAuth2: ['LINKEDIN_OAUTH2', 'linkedin-oauth2', 'linkedin'],
  LinkedinOpenIdConnect: ['LINKEDIN_OPENIDCONNECT', 'linkedin-openidconnect', 'linkedin'],
  GitLabOAuth2: ['GITLAB', 'gitlab', 'gitlab'],
  DiscordOAuth2: ['DISCORD', 'discord', 'discord'],
  SlackOAuth2: ['SLACK', 'slack', 'slack'],
  OktaOAuth2: ['OKTA_OAUTH2', 'okta-oauth2', 'okta'],
  Auth0OAuth2: ['AUTH0', 'auth0', 'auth0'],
};

/** Prefixes of auth-related settings: one left unread gets a manual entry. */
const DJANGO_AUTH_PREFIXES = /^(ACCOUNT_|SOCIALACCOUNT_|MFA_|HEADLESS_|SESSION_|SOCIAL_AUTH_|PASSWORD_|AUTH_|AUTHENTICATION_|LOGIN_|LOGOUT_|OTP_|TWO_FACTOR_|USERSESSIONS_)/;

const DJANGO_PLUMBING: Record<string, string> = {
  SESSION_COOKIE_SECURE: 'Atlas sets its own cookie flags (Secure, HttpOnly, SameSite).',
  SESSION_COOKIE_HTTPONLY: 'Atlas sets its own cookie flags (Secure, HttpOnly, SameSite).',
  SESSION_COOKIE_SAMESITE: 'Atlas sets its own cookie flags (Secure, HttpOnly, SameSite).',
  SESSION_COOKIE_PATH: 'Atlas sets its own cookie path.',
  SESSION_SERIALIZER: 'Session plumbing; the bridge reads the session the way Django wrote it (JSON).',
  PASSWORD_RESET_TIMEOUT: 'Reset links use the Atlas email-link lifetime (verification.magicLink.ttlMinutes).',
  ACCOUNT_UNIQUE_EMAIL: 'Atlas keeps one account per email address.',
  ACCOUNT_EMAIL_REQUIRED: 'Atlas accounts have an email address.',
  ACCOUNT_SESSION_REMEMBER: 'Atlas sessions last the configured lifetime; there is no "remember me" box.',
  ACCOUNT_LOGOUT_ON_GET: 'Atlas signs out through its own endpoint.',
  ACCOUNT_LOGOUT_REDIRECT_URL: 'Set where users land after sign-out in your app or the Atlas hosted pages settings.',
  ACCOUNT_DEFAULT_HTTP_PROTOCOL: 'Atlas links are always HTTPS.',
  SOCIALACCOUNT_AUTO_SIGNUP: 'Atlas creates the account on the first social sign-in (allow_sign_up on each provider).',
  SOCIALACCOUNT_QUERY_EMAIL: 'Atlas asks each provider for the email address.',
  SOCIALACCOUNT_STORE_TOKENS: 'Pass --set oauth-tokens=true to the export to carry stored provider tokens.',
  HEADLESS_ONLY: "Atlas serves both hosted pages and an API; your frontend can keep its own screens on Atlas's frontend API.",
};

export function translateDjango(project: string): TranslationResult {
  const { files, settings, overrides } = djangoSettings(project);
  const main = files[0];
  const b = new TranslationBuilder(main ? `Django settings at ${main}` : 'Django settings (not found)', main ? { file: main, line: 1 } : { file: '(none)', line: 0 });
  if (!main || !settings.size) {
    b.add('manual', 'setup', 'settings', `No Django settings module (settings.py or settings/*.py) was found under ${project}. Point the command at the project folder (where manage.py is).`);
    return b.result();
  }
  const used = new Set<string>();
  const take = (name: string): Setting | undefined => {
    used.add(name);
    return settings.get(name);
  };
  const at = (s: Setting, v?: Py): Where => ({ file: s.file, line: v?.line ?? s.line });
  const cv = (s: Setting, v: Py | undefined): ConfigValue | undefined => {
    if (!v || v.t === 'none') return undefined;
    if (v.t === 'str' || v.t === 'num' || v.t === 'bool') return { kind: 'literal', value: v.v, at: at(s, v) };
    if (v.t === 'env') return { kind: 'env', name: v.name, at: at(s, v) };
    return { kind: 'opaque', text: v.t === 'expr' ? (v.text.length > 60 ? `${v.text.slice(0, 57)}…` : v.text) : v.t, at: at(s, v) };
  };
  const num = (s: Setting | undefined): number | undefined => (s?.value.t === 'num' ? s.value.v : undefined);
  const bool = (s: Setting | undefined): boolean | undefined => (s?.value.t === 'bool' ? s.value.v : undefined);

  const appsSetting = take('INSTALLED_APPS');
  const apps = pyStrings(appsSetting?.value);
  const app = (name: string) => apps.find((a) => a.v === name);
  const appAt = (name: string): Where | undefined => (appsSetting && app(name) ? at(appsSetting, { t: 'none', line: app(name)!.line }) : undefined);
  const allauth = !!app('allauth.account');
  const headless = !!app('allauth.headless');

  // Sign-in methods.
  b.set('strategies.password', true);
  let loginMethods: string[] | undefined;
  const methods = take('ACCOUNT_LOGIN_METHODS');
  const legacyMethod = take('ACCOUNT_AUTHENTICATION_METHOD');
  if (methods) loginMethods = pyStrings(methods.value).map((m) => m.v);
  else if (legacyMethod && pyStr(legacyMethod.value)) loginMethods = pyStr(legacyMethod.value)!.split('_');
  if (allauth) {
    const s = methods ?? legacyMethod;
    const list = loginMethods ?? ['username'];
    if (list.includes('username')) b.set('strategies.username', true);
    if (list.includes('phone')) b.set('strategies.phoneCode', true);
    b.add(
      'mapped',
      'allauth',
      s ? s.name : 'ACCOUNT_LOGIN_METHODS (default username)',
      `Sign in with ${list.join(' or ')} and a password.`,
      s ? at(s) : appAt('allauth.account'),
      'auth_config.strategies',
    );
    if (legacyMethod && methods) b.add('mapped', 'allauth', 'ACCOUNT_AUTHENTICATION_METHOD', 'Superseded by ACCOUNT_LOGIN_METHODS.', at(legacyMethod));
  } else for (const s of [methods, legacyMethod]) if (s) b.add('mapped', 'allauth', s.name, 'No effect: django-allauth is not in INSTALLED_APPS.', at(s));

  const backends = take('AUTHENTICATION_BACKENDS');
  const backendList = backends ? pyStrings(backends.value) : [{ v: 'django.contrib.auth.backends.ModelBackend', line: 0 }];
  const social: Array<{ cls: string; line: number }> = [];
  for (const be of backendList) {
    const where = backends ? at(backends, { t: 'none', line: be.line }) : undefined;
    const setting = backends ? `AUTHENTICATION_BACKENDS ${be.v.split('.').pop()}` : 'AUTHENTICATION_BACKENDS (default ModelBackend)';
    if (be.v === 'django.contrib.auth.backends.ModelBackend') {
      if (!allauth) b.set('strategies.username', true);
      b.add('mapped', 'auth', setting, allauth ? 'Username and password (the Django admin): allauth decides how users sign in.' : 'Sign in with username (USERNAME_FIELD) and password: username sign-in on.', where, 'auth_config.strategies.password');
    } else if (be.v.startsWith('allauth.')) b.add('mapped', 'auth', setting, 'django-allauth sign-in: see the ACCOUNT_* entries.', where);
    else if (be.v.startsWith('social_core.backends.')) social.push({ cls: be.v.split('.').pop()!, line: be.line });
    else b.add('manual', 'auth', setting, `A custom or directory backend (${be.v}): connect the directory as an Atlas enterprise SSO connection (SAML, OIDC or LDAP), or check passwords against it with lazy migration.`, where);
  }

  const signup = take('ACCOUNT_SIGNUP_FIELDS');
  if (signup) {
    const fields = pyStrings(signup.value).map((f) => f.v.replace(/\*$/, '').replace(/^password1$/, 'password'));
    if (fields.includes('username')) b.set('strategies.username', true);
    b.add('mapped', 'allauth', 'ACCOUNT_SIGNUP_FIELDS', `Sign-up asks for ${fields.filter((f) => f !== 'password2').join(', ')}${fields.includes('password2') ? ' (Atlas has no password confirmation box)' : ''}.`, at(signup), 'auth_config.strategies');
  }
  const usernameRequired = take('ACCOUNT_USERNAME_REQUIRED');
  if (usernameRequired) {
    if (bool(usernameRequired) === true) b.set('strategies.username', true);
    b.add('mapped', 'allauth', 'ACCOUNT_USERNAME_REQUIRED', bool(usernameRequired) ? 'Users pick a username.' : 'No username.', at(usernameRequired), 'auth_config.strategies.username');
  }

  // Email verification.
  const verification = take('ACCOUNT_EMAIL_VERIFICATION');
  if (allauth || verification) {
    const mode = pyStr(verification?.value) ?? 'optional';
    b.set('requireEmailVerification', mode === 'mandatory');
    if (mode !== 'none') b.set('accountUx.emailVerification', 'link');
    b.add(
      'mapped',
      'allauth',
      verification ? 'ACCOUNT_EMAIL_VERIFICATION' : 'ACCOUNT_EMAIL_VERIFICATION (default optional)',
      mode === 'mandatory' ? 'Email verification required before the first session. Verified addresses (account_emailaddress.verified) carry over.' : mode === 'none' ? 'No email verification.' : 'Email verification is sent but not required to sign in.',
      verification ? at(verification) : appAt('allauth.account'),
      'auth_config.requireEmailVerification',
    );
  }
  const byCode = take('ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED');
  if (byCode) {
    if (bool(byCode)) b.set('accountUx.emailVerification', 'code');
    b.add('mapped', 'allauth', 'ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED', bool(byCode) ? 'Email verification by code.' : 'Email verification by link.', at(byCode), 'auth_config.accountUx.emailVerification');
  }
  const loginByCode = take('ACCOUNT_LOGIN_BY_CODE_ENABLED');
  if (loginByCode) {
    b.set('strategies.emailCode', bool(loginByCode) === true);
    b.add('mapped', 'allauth', 'ACCOUNT_LOGIN_BY_CODE_ENABLED', bool(loginByCode) ? 'Sign in with a one-time email code.' : 'No sign-in by email code.', at(loginByCode), 'auth_config.strategies.emailCode');
  }
  const loginOnReset = take('ACCOUNT_LOGIN_ON_PASSWORD_RESET');
  if (loginOnReset) {
    b.set('signInAfterReset', bool(loginOnReset) === true);
    b.add('mapped', 'allauth', 'ACCOUNT_LOGIN_ON_PASSWORD_RESET', bool(loginOnReset) ? 'A completed reset signs the user in.' : 'A completed reset ends at the sign-in screen.', at(loginOnReset), 'auth_config.signInAfterReset');
  }

  // Rate limits.
  for (const name of ['ACCOUNT_RATE_LIMITS', 'ACCOUNT_LOGIN_ATTEMPTS_LIMIT', 'ACCOUNT_LOGIN_ATTEMPTS_TIMEOUT']) {
    const s = take(name);
    if (s) b.add('differs', 'allauth', name, "Atlas rate-limits sign-in, sign-up, codes and resets itself and locks sign-in progressively after repeated failures (attack_protection.brute_force); the limits are not set per action.", at(s), 'auth_config.attackProtection.bruteForce');
  }
  for (const name of ['ACCOUNT_ADAPTER', 'SOCIALACCOUNT_ADAPTER', 'HEADLESS_ADAPTER', 'MFA_ADAPTER']) {
    const s = take(name);
    if (!s) continue;
    const mfa = name === 'MFA_ADAPTER';
    b.add('manual', 'allauth', name, mfa ? `A custom MFA adapter (${pyStr(s.value) ?? s.text}): run the export script inside your app so the adapter decrypts TOTP secrets and recovery codes.` : `A custom adapter (${pyStr(s.value) ?? s.text}): move its hooks (signup checks, redirects, user population) to Atlas Actions.`, at(s));
  }

  // Passwords: hashers and validators.
  const hashers = take('PASSWORD_HASHERS');
  let customHasher = false;
  if (hashers) {
    pyStrings(hashers.value).forEach((h, idx) => {
      const cls = h.v.split('.').pop()!;
      const known = h.v.startsWith('django.contrib.auth.hashers.') ? DJANGO_HASHERS[cls] : undefined;
      const where = at(hashers, { t: 'none', line: h.line });
      const setting = `PASSWORD_HASHERS ${cls}`;
      const first = idx === 0 ? ' (new hashes)' : '';
      if (!known) {
        customHasher = true;
        b.add('manual', 'passwords', setting, `${h.v} is a custom hasher: its hashes do not carry over. ${headless ? 'Turn on lazy migration (preset allauth_headless): Atlas checks each password against your app once, then stores its own hash.' : 'Those users reset their password, or add django-allauth headless so Atlas can check passwords against your app on first sign-in (lazy migration preset allauth_headless).'}`, where, headless ? 'lazy migration allauth_headless' : undefined);
      } else if (known.status === 'manual') b.add('manual', 'passwords', setting, `${known.alg} hashes (Unix crypt) do not carry over: those users reset their password${headless ? ' or migrate lazily (preset allauth_headless)' : ''}.`, where);
      else b.add(known.status, 'passwords', setting, `${known.alg} hashes${first} carry over in the export; Atlas verifies them and rehashes on first sign-in${known.status === 'differs' ? ' (a legacy digest: flagged in the dry run)' : ''}.`, where);
    });
  } else b.add('mapped', 'passwords', 'PASSWORD_HASHERS (default)', "Django's default pbkdf2_sha256 hashes (and argon2 / bcrypt_sha256 / scrypt ones) carry over; Atlas verifies them and rehashes on first sign-in.", { file: main, line: 1 });

  const validators = take('AUTH_PASSWORD_VALIDATORS');
  if (validators?.value.t === 'list') {
    for (const item of validators.value.items) {
      const name = pyStr(pyGet(item, 'NAME')) ?? '';
      const cls = name.split('.').pop()!;
      const where = at(validators, item);
      if (cls === 'MinimumLengthValidator') {
        const n = pyGet(pyGet(item, 'OPTIONS'), 'min_length');
        b.minPasswordLength(n?.t === 'num' ? n.v : 8, 'passwords', 'MinimumLengthValidator', where, 'Django');
      } else if (cls === 'CommonPasswordValidator') {
        b.set('passwordPolicy.checkBreaches', true);
        b.add('differs', 'passwords', cls, "New passwords are checked against breached-password data, a larger list than Django's common-passwords file.", where, 'auth_config.passwordPolicy.checkBreaches');
      } else if (cls === 'UserAttributeSimilarityValidator' || cls === 'NumericPasswordValidator') {
        b.add('differs', 'passwords', cls, `Atlas has no ${cls === 'NumericPasswordValidator' ? 'all-digits' : 'similarity-to-name-or-email'} rule; the minimum length and breached-password checks apply.`, where);
      } else b.add('manual', 'passwords', cls || 'validator', `A custom validator (${name || 'unreadable'}): Atlas cannot run it. Enforce what it checks with a pre-sign-up Action, or drop it.`, where);
    }
  } else if (validators) b.add('manual', 'passwords', 'AUTH_PASSWORD_VALIDATORS', 'Cannot read the validators statically; set auth_config.passwordPolicy yourself.', at(validators));
  const legacyMin = take('ACCOUNT_PASSWORD_MIN_LENGTH');
  if (legacyMin && num(legacyMin) !== undefined && b.get('passwordPolicy.minLength') === undefined) b.minPasswordLength(num(legacyMin)!, 'allauth', 'ACCOUNT_PASSWORD_MIN_LENGTH', at(legacyMin), 'allauth');
  else if (legacyMin) b.add('mapped', 'allauth', 'ACCOUNT_PASSWORD_MIN_LENGTH', 'Superseded by MinimumLengthValidator.', at(legacyMin));

  const userModel = take('AUTH_USER_MODEL');
  if (userModel) b.add('mapped', 'auth', 'AUTH_USER_MODEL', `The export reads ${pyStr(userModel.value) ?? 'this model'} (the export script finds it; with a dumpdata file pass --set user-model=${pyStr(userModel.value) ?? 'app_label.model'}).`, at(userModel));

  // Sessions → the bridge.
  const engineS = take('SESSION_ENGINE');
  const engine = pyStr(engineS?.value) ?? 'django.contrib.sessions.backends.db';
  const cookieS = take('SESSION_COOKIE_NAME');
  const cookie = pyStr(cookieS?.value);
  const vars: Record<string, string> = cookie && cookie !== 'sessionid' ? { cookie_name: cookie } : {};
  const engineSetting = engineS ? 'SESSION_ENGINE' : 'SESSION_ENGINE (default database sessions)';
  const engineAt = engineS ? at(engineS) : undefined;
  if (/\.backends\.(db|cached_db)$/.test(engine)) {
    b.bridge = { preset: 'django', vars };
    b.add('mapped', 'bridge', engineSetting, 'Database sessions: the export imports the live django_session rows and the bridge matches the session cookie (preset django).', engineAt, 'bridge preset django');
  } else if (/\.backends\.signed_cookies$/.test(engine)) {
    b.bridge = { preset: 'django_signed_cookies', vars };
    b.add('mapped', 'bridge', engineSetting, 'Signed-cookie sessions are opened on your server: pass djangoSignedCookieExtractor({ secretKey, bridgeSecret }) to the bridge middleware (preset django_signed_cookies). SECRET_KEY never leaves your server.', engineAt, 'bridge preset django_signed_cookies');
  } else if (/\.backends\.(cache|file)$/.test(engine)) {
    b.add('manual', 'bridge', engineSetting, `${engine.split('.').pop()} sessions cannot be exported: users sign in once more after the switch. Switching to cached_db a session lifetime before the cutover lets the bridge carry them.`, engineAt);
  } else b.add('manual', 'bridge', engineSetting, `A custom session engine (${engine}): users sign in once more, or read the session yourself in a custom extractToken.`, engineAt);
  if (cookieS) b.add('mapped', 'bridge', 'SESSION_COOKIE_NAME', `The bridge reads "${cookie ?? cookieS.text}".`, at(cookieS), b.bridge ? `bridge preset ${b.bridge.preset}` : undefined);

  const ageS = take('SESSION_COOKIE_AGE');
  const everyS = take('SESSION_SAVE_EVERY_REQUEST');
  const rolling = bool(everyS) === true;
  const age = ageS ? num(ageS) : 14 * DAY;
  if (age === undefined) b.add('manual', 'sessions', 'SESSION_COOKIE_AGE', `Cannot read ${ageS!.text} statically; set auth_config.session yourself.`, at(ageS!));
  else b.session(age, rolling, 'sessions', ageS ? 'SESSION_COOKIE_AGE' : 'SESSION_COOKIE_AGE (default 2 weeks)', ageS ? at(ageS) : undefined, 'Django');
  if (everyS) b.add('mapped', 'sessions', 'SESSION_SAVE_EVERY_REQUEST', rolling ? 'Activity extends the session.' : 'Activity does not extend the session.', at(everyS), 'auth_config.session.idleTimeout');
  const browserClose = take('SESSION_EXPIRE_AT_BROWSER_CLOSE');
  if (browserClose && bool(browserClose)) b.add('differs', 'sessions', 'SESSION_EXPIRE_AT_BROWSER_CLOSE', 'Atlas sessions outlive the browser for the configured lifetime; shorten auth_config.session if that matters.', at(browserClose), 'auth_config.session');
  else if (browserClose) b.add('mapped', 'sessions', 'SESSION_EXPIRE_AT_BROWSER_CLOSE', 'Sessions outlive the browser, as in Atlas.', at(browserClose));
  const domain = take('SESSION_COOKIE_DOMAIN');
  if (domain && pyStr(domain.value)) {
    b.set('session.crossSubdomainCookies', true);
    b.add('mapped', 'sessions', 'SESSION_COOKIE_DOMAIN', `Sessions are shared across subdomains of ${pyStr(domain.value)!.replace(/^\./, '')}.`, at(domain), 'auth_config.session.crossSubdomainCookies');
  } else if (domain) b.add('mapped', 'sessions', 'SESSION_COOKIE_DOMAIN', 'Host-only session cookie.', at(domain));

  const secret = take('SECRET_KEY');
  if (secret) {
    const literal = secret.value.t === 'str';
    b.add(
      literal ? 'manual' : 'mapped',
      'auth',
      'SECRET_KEY',
      `Atlas never needs it: only the signed-cookie bridge extractor and the export script use it, on your server.${literal ? ' It is hard-coded in settings: move it to the environment.' : ''}`,
      at(secret),
    );
  }

  // django-allauth social accounts.
  const providersS = take('SOCIALACCOUNT_PROVIDERS');
  for (const a of apps) {
    const m = /^allauth\.socialaccount\.providers\.(\w+)$/.exec(a.v);
    if (!m) continue;
    const id = m[1]!;
    const setting = `allauth.socialaccount.providers.${id}`;
    const where = appAt(a.v);
    const cfg = pyGet(providersS?.value, id);
    if (cfg && providersS) {
      for (const [k] of cfg.t === 'dict' ? cfg.entries : []) {
        const key = k.t === 'str' ? k.v : '';
        if (!['APP', 'APPS', 'Apps', 'SCOPE'].includes(key)) b.add('manual', 'socialaccount', `SOCIALACCOUNT_PROVIDERS.${id}.${key}`, `Provider option ${key}: set its Atlas counterpart on the provider (extra authorization parameters, fields) if your app depends on it.`, at(providersS, k));
      }
    }
    if (id === 'saml') {
      b.add('manual', 'socialaccount', setting, 'SAML: create an Atlas enterprise SSO connection for each IdP (the SocialApp rows or APPS entries hold their metadata). Atlas routes users to it by email domain.', where, 'sso_connections');
      continue;
    }
    if (id === 'openid_connect') {
      b.add('manual', 'socialaccount', setting, 'Generic OpenID Connect: add each server as a custom OIDC provider (custom_oauth_providers, with the issuer) or, for a workforce IdP, an enterprise SSO connection.', where, 'custom_oauth_providers');
      continue;
    }
    const atlasKey = FRAMEWORK_PROVIDER_MAP[id];
    if (!atlasKey) {
      b.add('manual', 'socialaccount', setting, `"${id}" has no same-named Atlas provider: add it as a custom OAuth / OIDC provider (custom_oauth_providers) with its endpoints.`, where, 'custom_oauth_providers');
      continue;
    }
    const appCfg = pyGet(cfg, 'APP') ?? (() => {
      const list = pyGet(cfg, 'APPS');
      return list?.t === 'list' ? list.items[0] : undefined;
    })();
    const upper = upperSnake(atlasKey);
    let clientId: string;
    let clientSecret: string;
    if (appCfg && providersS) {
      clientId = b.configString(cv(providersS, pyGet(appCfg, 'client_id')), `${atlasKey} client id`, `${upper}_CLIENT_ID`, { area: 'socialaccount', setting: `SOCIALACCOUNT_PROVIDERS.${id} client_id` });
      clientSecret = b.configString(cv(providersS, pyGet(appCfg, 'secret')), `${atlasKey} client secret`, `${upper}_CLIENT_SECRET`, { secret: true, area: 'socialaccount', setting: `SOCIALACCOUNT_PROVIDERS.${id} secret` });
    } else {
      b.env.set(`${upper}_CLIENT_ID`, `${atlasKey} client id`);
      b.env.set(`${upper}_CLIENT_SECRET`, `${atlasKey} client secret`);
      clientId = `\${${upper}_CLIENT_ID}`;
      clientSecret = `\${${upper}_CLIENT_SECRET}`;
      b.add('manual', 'socialaccount', `SocialApp ${id}`, `No APP in SOCIALACCOUNT_PROVIDERS: the client id and secret live in a SocialApp row in the database, where this step cannot read them. Set ${upper}_CLIENT_ID and ${upper}_CLIENT_SECRET before applying.`, where);
    }
    const scopes = pyStrings(pyGet(cfg, 'SCOPE')).map((s) => s.v);
    b.oauthProvider({ sourceId: id, atlasKey, clientId, clientSecret, scopes, area: 'socialaccount', setting, at: where });
  }
  for (const name of ['SOCIALACCOUNT_EMAIL_AUTHENTICATION', 'SOCIALACCOUNT_EMAIL_AUTHENTICATION_AUTO_CONNECT']) {
    const s = take(name);
    if (!s) continue;
    if (bool(s)) b.set('accountLinking', 'auto');
    b.add('mapped', 'socialaccount', name, bool(s) ? 'A social sign-in with a verified email that matches an existing account links to it.' : 'Social sign-ins do not link by email.', at(s), 'auth_config.accountLinking');
  }

  // python-social-auth (social_django).
  for (const { cls, line } of social) {
    const where = backends ? at(backends, { t: 'none', line }) : undefined;
    const setting = `AUTHENTICATION_BACKENDS ${cls}`;
    if (cls === 'SAMLAuth') {
      b.add('manual', 'social_django', setting, 'SAML: create an Atlas enterprise SSO connection for each IdP in SOCIAL_AUTH_SAML_ENABLED_IDPS.', where, 'sso_connections');
      continue;
    }
    const known = SOCIAL_CORE[cls];
    if (!known) {
      b.add('manual', 'social_django', setting, `${cls} has no known Atlas provider: add it as a custom OAuth / OIDC provider (custom_oauth_providers).`, where, 'custom_oauth_providers');
      continue;
    }
    const [prefix, sourceId, atlasKey] = known;
    const upper = upperSnake(atlasKey);
    const keyS = take(`SOCIAL_AUTH_${prefix}_KEY`);
    const secretS = take(`SOCIAL_AUTH_${prefix}_SECRET`);
    const clientId = b.configString(keyS ? cv(keyS, keyS.value) : undefined, `${atlasKey} client id`, `${upper}_CLIENT_ID`, { area: 'social_django', setting: `SOCIAL_AUTH_${prefix}_KEY` });
    const clientSecret = b.configString(secretS ? cv(secretS, secretS.value) : undefined, `${atlasKey} client secret`, `${upper}_CLIENT_SECRET`, { secret: true, area: 'social_django', setting: `SOCIAL_AUTH_${prefix}_SECRET` });
    const scopeS = take(`SOCIAL_AUTH_${prefix}_SCOPE`);
    b.oauthProvider({ sourceId, atlasKey, clientId, clientSecret, scopes: pyStrings(scopeS?.value).map((s) => s.v), area: 'social_django', setting, at: where });
  }
  if (app('social_django')) {
    b.add('differs', 'social_django', 'social_django', 'python-social-auth links (UserSocialAuth) are not in the export: users relink on their first social sign-in, by verified email (account linking auto).', appAt('social_django'), 'auth_config.accountLinking');
    if (b.get('accountLinking') === undefined) b.set('accountLinking', 'auto');
  }

  // MFA.
  if (app('allauth.mfa')) {
    const typesS = take('MFA_SUPPORTED_TYPES');
    const types = typesS ? pyStrings(typesS.value).map((t) => t.v) : ['recovery_codes', 'totp'];
    const where = typesS ? at(typesS) : appAt('allauth.mfa');
    const setting = typesS ? 'MFA_SUPPORTED_TYPES' : 'MFA_SUPPORTED_TYPES (default)';
    b.set('mfaPolicy', 'optional');
    if (types.includes('totp')) {
      b.set('mfa.factors.totp', true);
      b.add('mapped', 'mfa', `${setting} totp`, 'Authenticator-app (TOTP) MFA on, optional per user. Enrolled authenticators carry over (the export script decrypts their secrets).', where, 'auth_config.mfa.factors.totp');
    }
    if (types.includes('recovery_codes')) {
      const countS = take('MFA_RECOVERY_CODE_COUNT');
      const count = num(countS) ?? 10;
      b.set('mfa.backupCodes.count', clamp(count, 1, 20));
      b.add('mapped', 'mfa', `${setting} recovery_codes`, `${count} recovery codes per user. Unused codes carry over with the export script.`, where, 'auth_config.mfa.backupCodes.count');
      if (countS) b.add(count === clamp(count, 1, 20) ? 'mapped' : 'differs', 'mfa', 'MFA_RECOVERY_CODE_COUNT', `${clamp(count, 1, 20)} codes.`, at(countS), 'auth_config.mfa.backupCodes.count');
    }
    if (types.includes('webauthn')) {
      b.set('mfa.factors.passkey', true);
      b.add('mapped', 'mfa', `${setting} webauthn`, 'Security keys and passkeys as a second factor. Registered keys carry over when you pass the RP id to the export (--set rp-id=<your domain>).', where, 'auth_config.mfa.factors.passkey');
    }
    const passkeyLogin = take('MFA_PASSKEY_LOGIN_ENABLED');
    if (passkeyLogin) {
      b.set('strategies.passkey', bool(passkeyLogin) === true);
      b.add('mapped', 'mfa', 'MFA_PASSKEY_LOGIN_ENABLED', bool(passkeyLogin) ? 'Passkey sign-in on.' : 'No passkey sign-in.', at(passkeyLogin), 'auth_config.strategies.passkey');
    }
    for (const [name, key] of [['MFA_TOTP_PERIOD', 'mfa.totp.period'], ['MFA_TOTP_DIGITS', 'mfa.totp.digits']] as const) {
      const s = take(name);
      if (s && num(s) !== undefined) {
        b.set(key, num(s)!);
        b.add('mapped', 'mfa', name, `${num(s)}.`, at(s), `auth_config.${key}`);
      }
    }
  }
  for (const otp of ['django_otp', 'two_factor']) {
    if (app(otp)) b.add('manual', 'mfa', otp, `${otp === 'two_factor' ? 'django-two-factor-auth' : 'django-otp'} devices are not in the export: users enrol their authenticator again in Atlas (turn on mfa.factors.totp).`, appAt(otp), 'auth_config.mfa.factors.totp');
  }
  if (app('allauth.usersessions')) b.add('mapped', 'allauth', 'allauth.usersessions', "Atlas lists a user's sessions and lets them sign out others itself.", appAt('allauth.usersessions'));

  // Headless → lazy migration.
  if (headless) {
    const loginField = loginMethods && !loginMethods.includes('email') && loginMethods.includes('username') ? 'username' : undefined;
    b.lazy = { preset: 'allauth_headless', config: loginField ? { login_field: loginField } : {} };
    b.add('mapped', 'allauth', 'allauth.headless', `Lazy migration can check passwords against your app's headless login endpoint (preset allauth_headless, your site URL as base_url)${customHasher ? ': needed for the custom hasher' : ', for any hash that does not carry over'}.`, appAt('allauth.headless'), 'lazy migration allauth_headless');
  }
  const frontendUrls = take('HEADLESS_FRONTEND_URLS');
  if (frontendUrls) b.add('manual', 'allauth', 'HEADLESS_FRONTEND_URLS', "Links in Atlas's emails open Atlas's hosted pages. To keep your own screens, point the email templates at your URLs and complete the flow with the Atlas frontend API.", at(frontendUrls));
  for (const name of ['LOGIN_URL', 'LOGIN_REDIRECT_URL', 'LOGOUT_REDIRECT_URL']) {
    const s = take(name);
    if (s) b.add('manual', 'auth', name, `${pyStr(s.value) ?? s.text}: send users to Atlas's sign-in and pass this as the redirect (an allowed redirect URL in Atlas).`, at(s), 'redirect_urls');
  }

  // Everything else that looks auth-related.
  for (const [name, s] of settings) {
    if (used.has(name) || !DJANGO_AUTH_PREFIXES.test(name)) continue;
    if (DJANGO_PLUMBING[name]) b.add('mapped', 'settings', name, `Nothing to carry over: ${DJANGO_PLUMBING[name]}`, at(s));
    else b.add('manual', 'settings', name, `Not translated (${snippet(name, s.text)}): check whether your app relies on it.`, at(s));
  }
  for (const o of overrides) {
    const base = settings.get(o.name)!;
    if (!used.has(o.name) && !DJANGO_AUTH_PREFIXES.test(o.name) && o.name !== 'SECRET_KEY') continue;
    b.add('manual', 'settings', o.name, `Also set in ${o.file}:${o.line} (${snippet(o.name, o.text)}); the translation used ${base.file}:${base.line}. Check which one production runs with.`, { file: o.file, line: o.line });
  }
  return b.result();
}
