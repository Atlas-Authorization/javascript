import { analyzeCalls, propOf, type CallAnalysis, type FoundCall, type StaticValue } from '@atlasauth/upgrade';
import type { TranslationResult } from '../framework/plugin';
import { DAY, FRAMEWORK_PROVIDER_MAP, TranslationBuilder, type ConfigValue, type Where } from './report';

/**
 * Config translators for the JavaScript frameworks — Auth.js / NextAuth,
 * Lucia, Passport (+ express-session) and iron-session — reading the app's
 * source statically (nothing runs, `.env` files are never read; env vars are
 * carried by NAME as `${NAME}` placeholders).
 */

// ── StaticValue helpers ─────────────────────────────────────────────────────

const at = (v: StaticValue | undefined, fallback: Where): Where => (v ? v.loc : fallback);

function cv(v: StaticValue | undefined): ConfigValue | undefined {
  if (!v) return undefined;
  if (v.kind === 'string' || v.kind === 'number' || v.kind === 'boolean') return { kind: 'literal', value: v.value, at: v.loc };
  if (v.kind === 'env') return { kind: 'env', name: v.name, at: v.loc };
  return { kind: 'opaque', text: describe(v), at: v.loc };
}

function describe(v: StaticValue): string {
  switch (v.kind) {
    case 'unknown':
      return v.text.length > 60 ? `${v.text.slice(0, 57)}…` : v.text;
    case 'call':
      return `${v.callee}(…)`;
    case 'external':
      return `${v.name} from ${v.module}`;
    case 'function':
      return 'a function';
    case 'param':
      return `parameter ${v.name}`;
    case 'template':
      return 'a template string';
    default:
      return v.kind;
  }
}

const str = (v: StaticValue | undefined): string | undefined => (v?.kind === 'string' ? v.value : undefined);
const num = (v: StaticValue | undefined): number | undefined => (v?.kind === 'number' ? v.value : undefined);
const bool = (v: StaticValue | undefined): boolean | undefined => (v?.kind === 'boolean' ? v.value : undefined);

/** The object a call's options resolve to (following a function that returns one: Auth.js lazy init). */
function objectOf(v: StaticValue | undefined): StaticValue | undefined {
  if (!v) return undefined;
  if (v.kind === 'object') return v;
  if (v.kind === 'function' && v.returns?.kind === 'object') return v.returns;
  return undefined;
}

function upperSnake(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

function originOf(calls: FoundCall[], what: string): { origin: string; where: Where } {
  const first = calls[0];
  return first ? { origin: `${what} at ${first.loc.file}:${first.loc.line}`, where: first.loc } : { origin: `${what} (not found)`, where: { file: '(none)', line: 0 } };
}

function notFound(b: TranslationBuilder, analysis: CallAnalysis, area: string, what: string): TranslationResult {
  b.add('manual', area, what, `No ${what} was found under ${analysis.root} (${analysis.filesScanned} files scanned). Point the command at the folder that sets it up.`);
  for (const e of analysis.parseErrors) b.add('manual', 'setup', 'parse', `This file could not be parsed (${e.message}); settings in it were not read.`, { file: e.file, line: 1 });
  return b.result();
}

// ── Auth.js / NextAuth ──────────────────────────────────────────────────────

const AUTHJS_ENTRY = [
  { id: 'nextauth', module: /^next-auth$/, names: ['default', 'NextAuth'] },
  { id: 'core', module: /^@auth\/core$/, names: ['Auth'] },
  { id: 'framework', module: /^@auth\/(express|sveltekit|solid-start|qwik|astro|fastify|hono|nuxt)$/, names: '*' as const },
];

/** Auth.js email-ish providers: magic links through an email service. */
const EMAIL_PROVIDERS = new Set(['email', 'nodemailer', 'resend', 'sendgrid', 'postmark', 'mailgun', 'forwardemail', 'loops']);

export function translateAuthJs(project: string): TranslationResult {
  const analysis = analyzeCalls(project, AUTHJS_ENTRY, ['next-auth', '@auth/']);
  const calls = analysis.calls.filter((c) => c.matcher !== 'framework' || /Auth\$?$/.test(c.imported.name));
  const { origin, where } = originOf(calls, 'Auth.js config');
  const b = new TranslationBuilder(origin, where);
  if (!calls.length) return notFound(b, analysis, 'setup', 'NextAuth() / Auth.js call');
  const call = calls[0]!;
  for (const other of calls.slice(1)) b.add('manual', 'setup', 'NextAuth()', `Another Auth.js call is here; only the one at ${call.loc.file}:${call.loc.line} was translated.`, other.loc);
  const opts = objectOf(call.matcher === 'core' ? call.args[1] : call.args[0]);
  if (!opts) {
    b.add('manual', 'setup', 'config', 'The Auth.js config cannot be read statically; review its settings by hand.', call.loc);
    return b.result();
  }
  const area = 'authjs';
  const version = analysis.dependencies['next-auth'] ?? analysis.dependencies['@auth/core'] ?? '';
  const v4 = /^[~^]?4\./.test(version);

  // Providers.
  const providers = propOf(opts, 'providers');
  let hasCredentials = false;
  let hasPasskey = false;
  if (providers?.kind === 'array') {
    for (const p of providers.items) {
      const module = p.kind === 'call' ? p.imported?.module : p.kind === 'external' ? p.module : undefined;
      const id = module?.split('/').pop()?.toLowerCase();
      const cfg = p.kind === 'call' ? p.args[0] : undefined;
      if (!id) {
        b.add('manual', 'providers', 'providers[]', `A provider that cannot be read statically (${describe(p)}).`, p.loc);
        continue;
      }
      if (id === 'credentials') {
        hasCredentials = true;
        b.set('strategies.password', true);
        b.add(
          'differs',
          'providers',
          'Credentials',
          'Atlas owns password sign-in: your authorize() is no longer called. Passwords your app stored with bcrypt, Argon2, scrypt or PBKDF2 carry over in the export; for any other scheme turn on lazy migration (preset authjs_credentials) so Atlas asks your old Credentials endpoint once per user.',
          p.loc,
          'auth_config.strategies.password',
        );
        continue;
      }
      if (EMAIL_PROVIDERS.has(id)) {
        b.set('strategies.emailLink', true);
        b.add('differs', 'providers', id, 'Email sign-in links on. Atlas sends them through your email provider (configure it in Atlas); customise the "magic link" template instead of sendVerificationRequest.', p.loc, 'auth_config.strategies.emailLink');
        continue;
      }
      if (id === 'passkey' || id === 'webauthn') {
        hasPasskey = true;
        b.set('strategies.passkey', true);
        b.add('mapped', 'providers', id, 'Passkey sign-in on. Registered passkeys are imported when you pass the RP id to the export (same domain).', p.loc, 'auth_config.strategies.passkey');
        continue;
      }
      const atlasKey = FRAMEWORK_PROVIDER_MAP[id];
      if (!atlasKey) {
        b.add('manual', 'providers', id, `"${id}" has no same-named Atlas provider: add it as a custom OAuth / OIDC provider (custom_oauth_providers) with its endpoints.`, p.loc);
        continue;
      }
      const upper = upperSnake(id);
      // v5 reads AUTH_<PROVIDER>_ID / _SECRET when the provider is passed without options.
      const idEnv = v4 ? `${upper}_CLIENT_ID` : `AUTH_${upper}_ID`;
      const secretEnv = v4 ? `${upper}_CLIENT_SECRET` : `AUTH_${upper}_SECRET`;
      const clientId = b.configString(cv(propOf(cfg, 'clientId')) ?? (cfg ? undefined : { kind: 'env', name: idEnv, at: p.loc }), `${id} client id`, idEnv, { area: 'providers', setting: `${id}.clientId` });
      const clientSecret =
        atlasKey === 'apple' ? undefined : b.configString(cv(propOf(cfg, 'clientSecret')) ?? (cfg ? undefined : { kind: 'env', name: secretEnv, at: p.loc }), `${id} client secret`, secretEnv, { area: 'providers', setting: `${id}.clientSecret`, secret: true });
      const scope = str(propOf(propOf(propOf(cfg, 'authorization'), 'params'), 'scope'));
      const values: Record<string, string> = {};
      if (atlasKey === 'microsoft') {
        const tenant = propOf(cfg, 'tenantId') ?? propOf(cfg, 'issuer');
        if (tenant) values.tenant = b.configString(cv(tenant), 'Microsoft tenant', 'MICROSOFT_TENANT_ID', { area: 'providers', setting: `${id}.tenantId` });
      }
      if (atlasKey === 'apple') {
        for (const [k, env, label] of [['team_id', 'APPLE_TEAM_ID', 'team id'], ['key_id', 'APPLE_KEY_ID', 'key id'], ['private_key', 'APPLE_PRIVATE_KEY', '.p8 key contents']] as const) {
          values[k] = `\${${env}}`;
          b.env.set(env, `Sign in with Apple ${label}`);
        }
        b.add('differs', 'providers', `${id}.clientSecret`, 'Atlas builds the Apple client secret itself from your team id, key id and .p8 key; keep the same Services ID so Apple user ids stay the same.', p.loc, 'oauth_providers apple');
      }
      b.oauthProvider({ sourceId: id, atlasKey, clientId, clientSecret, scopes: scope?.split(/[\s,]+/).filter(Boolean), values, area: 'providers', setting: id, at: p.loc });
      for (const fn of ['profile', 'userinfo', 'token']) {
        const f = propOf(cfg, fn);
        if (f) b.add('manual', 'providers', `${id}.${fn}`, fn === 'profile' ? "Atlas maps the provider's profile itself; move extra profile fields into user metadata with a post-login Action." : 'Atlas runs this step itself for built-in providers; remove the override.', f.loc);
      }
      if (bool(propOf(cfg, 'allowDangerousEmailAccountLinking'))) {
        b.set('accountLinking', 'auto');
        b.add('differs', 'providers', `${id}.allowDangerousEmailAccountLinking`, 'Atlas links a social sign-in to an existing account only when the provider asserts a verified email.', propOf(cfg, 'allowDangerousEmailAccountLinking')!.loc, 'auth_config.accountLinking');
      }
    }
  } else if (providers) {
    b.add('manual', 'providers', 'providers', `Cannot read the providers (${describe(providers)}).`, providers.loc);
  }

  // Session.
  const session = propOf(opts, 'session');
  const adapter = propOf(opts, 'adapter');
  const strategy = str(propOf(session, 'strategy')) ?? (adapter && !hasCredentials ? 'database' : 'jwt');
  const maxAge = num(propOf(session, 'maxAge')) ?? 30 * DAY;
  b.session(maxAge, true, area, 'session.maxAge', at(propOf(session, 'maxAge') ?? session, call.loc), 'Auth.js');
  if (propOf(session, 'updateAge')) b.add('mapped', area, 'session.updateAge', 'Atlas extends a used session itself and refreshes its short-lived token every minute; nothing to set.', propOf(session, 'updateAge')!.loc);
  if (propOf(opts, 'jwt')) {
    const jwt = propOf(opts, 'jwt');
    if (propOf(jwt, 'encode') || propOf(jwt, 'decode')) b.add('manual', area, 'jwt.encode/decode', 'A custom JWT encoding: the bridge extractor reads the default Auth.js JWE only; open your format in a custom extractToken.', jwt!.loc);
    else b.add('mapped', area, 'jwt', 'Atlas signs its own session tokens (RS256, JWKS published); verify them with the Atlas SDKs instead of next-auth/jwt.', jwt!.loc);
  }
  if (adapter) {
    const name = adapter.kind === 'call' ? adapter.callee : describe(adapter);
    b.add('mapped', area, 'adapter', `${name}: your users, accounts, authenticators and sessions are read from this database by the export (dump the tables, then atlas migrate authjs export --set dump=<dir>).`, adapter.loc);
  }
  b.bridge = { preset: strategy === 'database' ? 'authjs' : 'authjs_jwt', vars: {} };
  b.add(
    'mapped',
    'bridge',
    'session.strategy',
    strategy === 'database'
      ? 'Database sessions: imported with the export; the bridge matches the session cookie (preset authjs).'
      : 'JWT sessions: the bridge decrypts the cookie on your server with AUTH_SECRET and exchanges a one-time assertion (preset authjs_jwt, a bridge secret in the bridge settings).',
    at(propOf(session, 'strategy') ?? session, call.loc),
    `bridge preset ${b.bridge.preset}`,
  );
  if (hasCredentials) b.lazy = { preset: 'authjs_credentials', config: {} };

  // Everything else.
  const secret = propOf(opts, 'secret');
  if (secret) b.add('mapped', area, 'secret', 'Atlas signs its own sessions; AUTH_SECRET is only needed by the bridge extractor (JWT sessions) during the cutover.', secret.loc);
  const callbacks = propOf(opts, 'callbacks');
  if (callbacks?.kind === 'object') {
    for (const [name, fn] of Object.entries(callbacks.props)) {
      const note: Record<string, string> = {
        signIn: 'Allow/deny logic moves to a pre-sign-in or post-login Action (return deny with a reason).',
        jwt: 'Extra token claims come from a JWT template (custom claims from user metadata) or a post-login Action.',
        session: 'Extra session fields: read them from the Atlas session claims or user metadata (useUser / auth()).',
        redirect: 'Allowed redirect targets are the instance redirect URLs (redirect_urls).',
        authorized: 'Route protection: the Atlas middleware (publicRoutes / protect) replaces it.',
      };
      b.add('manual', 'callbacks', `callbacks.${name}`, note[name] ?? 'Move this logic to an Atlas Action.', fn.loc);
    }
  }
  const events = propOf(opts, 'events');
  if (events?.kind === 'object') for (const [name, fn] of Object.entries(events.props)) b.add('manual', 'events', `events.${name}`, 'Subscribe to the matching Atlas webhook (user.created, session.created, session.ended …) instead.', fn.loc);
  const pages = propOf(opts, 'pages');
  if (pages?.kind === 'object') {
    for (const [name, v] of Object.entries(pages.props)) {
      b.add('manual', 'pages', `pages.${name}`, `Atlas hosts sign-in, sign-up, verification and error pages (themeable), or embed the components on your own route${str(v) ? ` (${str(v)})` : ''}.`, v.loc, 'auth_config.accountUx');
    }
  }
  const cookies = propOf(opts, 'cookies');
  if (cookies) {
    const name = str(propOf(propOf(cookies, 'sessionToken'), 'name'));
    if (name) b.bridge.vars.cookie_name = name;
    b.add(name ? 'mapped' : 'manual', 'bridge', 'cookies.sessionToken', name ? `The bridge reads the session from "${name}" (pass cookieName to authJsExtractor).` : 'Custom cookie settings: pass the session cookie name to authJsExtractor.', cookies.loc);
  }
  if (propOf(opts, 'trustHost') || propOf(opts, 'useSecureCookies') || propOf(opts, 'basePath')) {
    b.add('mapped', area, 'trustHost / useSecureCookies / basePath', 'Not needed: Atlas serves the auth endpoints on its own domain with secure cookies.', (propOf(opts, 'trustHost') ?? propOf(opts, 'useSecureCookies') ?? propOf(opts, 'basePath'))!.loc);
  }
  if (propOf(opts, 'theme')) b.add('differs', area, 'theme', 'Brand the hosted pages in Atlas (colors, logo) instead.', propOf(opts, 'theme')!.loc, 'instance branding');
  if (bool(propOf(propOf(opts, 'experimental'), 'enableWebAuthn')) && !hasPasskey) b.add('mapped', area, 'experimental.enableWebAuthn', 'Passkeys are a stable Atlas sign-in method.', propOf(opts, 'experimental')!.loc, 'auth_config.strategies.passkey');
  return b.result();
}

// ── Lucia ───────────────────────────────────────────────────────────────────

/** arctic provider class → [Atlas key, index of clientId, index of clientSecret]. */
const ARCTIC: Record<string, [string, number, number | null]> = {
  GitHub: ['github', 0, 1],
  Google: ['google', 0, 1],
  Discord: ['discord', 0, 1],
  Facebook: ['facebook', 0, 1],
  Twitter: ['x', 0, 1],
  Twitch: ['twitch', 0, 1],
  Spotify: ['spotify', 0, 1],
  LinkedIn: ['linkedin', 0, 1],
  Slack: ['slack', 0, 1],
  Reddit: ['reddit', 0, 1],
  Notion: ['notion', 0, 1],
  Zoom: ['zoom', 0, 1],
  Dropbox: ['dropbox', 0, 1],
  Atlassian: ['atlassian', 0, 1],
  Salesforce: ['salesforce', 1, 2],
  Line: ['line', 0, 1],
  Kakao: ['kakao', 0, 1],
  Naver: ['naver', 0, 1],
  VK: ['vk', 0, 1],
  Apple: ['apple', 0, null],
  MicrosoftEntraId: ['microsoft', 1, 2],
  GitLab: ['gitlab', 1, 2],
  Auth0: ['auth0', 1, 2],
  Okta: ['okta', 2, 3],
  Bitbucket: ['bitbucket', 0, 1],
  Amazon: ['amazon', 0, 1],
  Shopify: ['shopify', 1, 2],
};

/** `new TimeSpan(30, "d")` (lucia / oslo) or v2 milliseconds → seconds. */
function timeSpanSeconds(v: StaticValue | undefined): number | undefined {
  if (v?.kind === 'call' && /TimeSpan$/.test(v.callee) && v.args[0]?.kind === 'number' && v.args[1]?.kind === 'string') {
    const unit = { ms: 0.001, s: 1, m: 60, h: 3600, d: DAY, w: 7 * DAY }[v.args[1].value];
    return unit !== undefined ? Math.round(v.args[0].value * unit) : undefined;
  }
  return undefined;
}

export function translateLucia(project: string): TranslationResult {
  const analysis = analyzeCalls(
    project,
    [
      { id: 'v3', module: /^lucia$/, names: ['Lucia'], construct: true },
      { id: 'v2', module: /^lucia$/, names: ['lucia'], construct: false },
      { id: 'arctic', module: /^arctic$/, names: '*', construct: true },
      { id: 'oauth_v2', module: /^@lucia-auth\/oauth\/providers$/, names: '*', construct: false },
    ],
    ['lucia', 'arctic'],
  );
  const core = analysis.calls.filter((c) => c.matcher === 'v3' || c.matcher === 'v2');
  const { origin, where } = originOf(core.length ? core : analysis.calls, 'Lucia');
  const b = new TranslationBuilder(origin, where);
  if (!analysis.calls.length) return notFound(b, analysis, 'setup', 'Lucia setup (new Lucia(...) or arctic providers)');
  const area = 'lucia';
  b.set('strategies.password', true);
  b.bridge = { preset: 'lucia', vars: {} };
  const call = core[0];
  if (call) {
    const opts = objectOf(call.matcher === 'v3' ? call.args[1] : call.args[0]);
    const cookie = propOf(opts, 'sessionCookie');
    const name = str(propOf(cookie, 'name'));
    if (name) b.bridge.vars.cookie_name = name;
    b.add('mapped', 'bridge', 'sessionCookie.name', `The bridge reads "${name ?? 'auth_session'}" (preset lucia).`, at(propOf(cookie, 'name') ?? cookie, call.loc), 'bridge preset lucia');
    if (bool(propOf(cookie, 'expires')) === false) b.add('differs', area, 'sessionCookie.expires', 'Browser-session cookies: Atlas keeps the session until it expires; a "remember me" off at sign-in gives a browser-session cookie per user.', propOf(cookie, 'expires')!.loc);
    const domain = propOf(propOf(cookie, 'attributes'), 'domain');
    if (domain) b.add('manual', area, 'sessionCookie.attributes.domain', 'Shared cookies across subdomains: turn on session.crossSubdomainCookies and verify the parent domain in Atlas.', domain.loc, 'auth_config.session.crossSubdomainCookies');
    if (call.matcher === 'v3') {
      const span = propOf(opts, 'sessionExpiresIn');
      const seconds = timeSpanSeconds(span) ?? 30 * DAY;
      b.session(seconds, true, area, 'sessionExpiresIn', at(span, call.loc), 'Lucia');
    } else {
      const span = propOf(opts, 'sessionExpiresIn');
      const active = num(propOf(span, 'activePeriod')) ?? DAY * 1000;
      const idle = num(propOf(span, 'idlePeriod')) ?? 14 * DAY * 1000;
      b.session(Math.round((active + idle) / 1000), true, area, 'sessionExpiresIn.activePeriod + idlePeriod', at(span, call.loc), 'Lucia');
      if (propOf(opts, 'csrfProtection')) b.add('mapped', area, 'csrfProtection', 'Atlas checks the origin of every state-changing request itself.', propOf(opts, 'csrfProtection')!.loc);
    }
    for (const key of ['getUserAttributes', 'getSessionAttributes']) {
      const fn = propOf(opts, key);
      if (fn) b.add('manual', area, key, key === 'getUserAttributes' ? 'User fields: read them from the Atlas user (currentUser()) or put app fields in user metadata (imported from the export).' : 'Session attributes: use session custom data (set from a post-login Action).', fn.loc);
    }
    const adapter = call.args[0];
    if (call.matcher === 'v3' && adapter) b.add('mapped', area, 'adapter', `${describe(adapter)}: users, keys and sessions are read from this database by the export.`, adapter.loc);
  } else {
    b.add('manual', area, 'session management', 'No Lucia instance was found (the Lucia guide implements sessions in your code): the export reads your session table (ids hashed with sha256 are detected).', where);
    b.session(30 * DAY, true, area, 'session lifetime (guide default 30 days)', where, 'Lucia');
  }
  for (const c of analysis.calls.filter((x) => x.matcher === 'arctic' || x.matcher === 'oauth_v2')) {
    const cls = c.imported.name;
    const known = c.matcher === 'arctic' ? ARCTIC[cls] : FRAMEWORK_PROVIDER_MAP[cls] ? ([FRAMEWORK_PROVIDER_MAP[cls]!, -1, -1] as [string, number, number]) : undefined;
    if (!known) {
      b.add('manual', 'providers', cls, `No same-named Atlas provider for ${cls}: add it as a custom OAuth provider.`, c.loc);
      continue;
    }
    const [atlasKey, idIdx, secretIdx] = known;
    const upper = upperSnake(atlasKey);
    // @lucia-auth/oauth v2: github(auth, { clientId, clientSecret }).
    const options = idIdx < 0 ? c.args[1] : undefined;
    const clientId = b.configString(cv(idIdx < 0 ? propOf(options, 'clientId') : c.args[idIdx]), `${cls} client id`, `${upper}_CLIENT_ID`, { area: 'providers', setting: `${cls}.clientId` });
    const clientSecret =
      secretIdx === null ? undefined : b.configString(cv(secretIdx < 0 ? propOf(options, 'clientSecret') : c.args[secretIdx]), `${cls} client secret`, `${upper}_CLIENT_SECRET`, { area: 'providers', setting: `${cls}.clientSecret`, secret: true });
    const values: Record<string, string> = {};
    if (atlasKey === 'apple') {
      for (const [k, env] of [['team_id', 'APPLE_TEAM_ID'], ['key_id', 'APPLE_KEY_ID'], ['private_key', 'APPLE_PRIVATE_KEY']] as const) {
        values[k] = `\${${env}}`;
        b.env.set(env, `Sign in with Apple ${k.replace('_', ' ')}`);
      }
    }
    if (atlasKey === 'microsoft') values.tenant = b.configString(cv(c.args[0]), 'Microsoft tenant', 'MICROSOFT_TENANT_ID', { area: 'providers', setting: `${cls}.tenant` });
    b.oauthProvider({ sourceId: cls.toLowerCase(), atlasKey, clientId, clientSecret, values, area: 'providers', setting: `new ${cls}(…)`, at: c.loc });
  }
  return b.result();
}

// ── Passport + express-session ──────────────────────────────────────────────

/** Passport strategy package → Atlas provider (or a special kind). */
const PASSPORT_STRATEGIES: Record<string, string> = {
  'passport-google-oauth20': 'google',
  'passport-google-oauth2': 'google',
  'passport-google-oidc': 'google',
  'passport-github2': 'github',
  'passport-github': 'github',
  'passport-facebook': 'facebook',
  'passport-microsoft': 'microsoft',
  'passport-apple': 'apple',
  'passport-discord': 'discord',
  'passport-gitlab2': 'gitlab',
  'passport-linkedin-oauth2': 'linkedin',
  'passport-slack-oauth2': 'slack',
  'passport-slack': 'slack',
  'passport-spotify': 'spotify',
  'passport-twitch-new': 'twitch',
  'passport-auth0': 'auth0',
  'passport-okta-oauth20': 'okta',
  'passport-bitbucket-oauth2': 'bitbucket',
  'passport-amazon': 'amazon',
};

export function translatePassport(project: string): TranslationResult {
  const analysis = analyzeCalls(
    project,
    [
      { id: 'strategy', module: /^(passport-[a-z0-9-]+|@node-saml\/passport-saml|@passport-js\/[a-z0-9-]+|passport-azure-ad)$/, names: '*', construct: true },
      { id: 'session', module: /^express-session$/, names: ['default'], construct: false },
      { id: 'cookie_session', module: /^cookie-session$/, names: ['default'], construct: false },
    ],
    ['passport', 'express-session', 'cookie-session'],
  );
  const strategies = analysis.calls.filter((c) => c.matcher === 'strategy');
  const { origin, where } = originOf(strategies.length ? strategies : analysis.calls, 'Passport');
  const b = new TranslationBuilder(origin, where);
  if (!analysis.calls.length) return notFound(b, analysis, 'setup', 'passport.use(new …Strategy()) / express-session');
  b.bridge = { preset: 'passport', vars: {} };

  for (const c of strategies) {
    const module = c.imported.module;
    const opts = objectOf(c.args[0]);
    const atlasKey = PASSPORT_STRATEGIES[module];
    if (atlasKey) {
      const upper = upperSnake(atlasKey);
      const clientId = b.configString(cv(propOf(opts, 'clientID') ?? propOf(opts, 'clientId')), `${atlasKey} client id`, `${upper}_CLIENT_ID`, { area: 'strategies', setting: `${module}.clientID` });
      const clientSecret = atlasKey === 'apple' ? undefined : b.configString(cv(propOf(opts, 'clientSecret')), `${atlasKey} client secret`, `${upper}_CLIENT_SECRET`, { area: 'strategies', setting: `${module}.clientSecret`, secret: true });
      const scope = propOf(opts, 'scope');
      const scopes = scope?.kind === 'array' ? scope.items.map(str).filter((s): s is string => Boolean(s)) : str(scope)?.split(/[\s,]+/);
      const values: Record<string, string> = {};
      if (atlasKey === 'auth0' || atlasKey === 'okta') {
        const domain = propOf(opts, 'domain') ?? propOf(opts, 'audience');
        values.domain = b.configString(cv(domain), `${atlasKey} domain`, `${upper}_DOMAIN`, { area: 'strategies', setting: `${module}.domain` });
      }
      if (atlasKey === 'microsoft' && propOf(opts, 'tenant')) values.tenant = b.configString(cv(propOf(opts, 'tenant')), 'Microsoft tenant', 'MICROSOFT_TENANT_ID', { area: 'strategies', setting: `${module}.tenant` });
      b.oauthProvider({ sourceId: atlasKey, atlasKey, clientId, clientSecret, scopes, values, area: 'strategies', setting: `new ${c.callee}(…) from ${module}`, at: c.loc });
      if (propOf(opts, 'callbackURL')) b.add('mapped', 'strategies', `${module}.callbackURL`, "Atlas receives the provider callback on its own domain: add Atlas's redirect_uri to the OAuth app (keep the old one until the cutover ends).", propOf(opts, 'callbackURL')!.loc);
      b.add('manual', 'strategies', `${module} verify callback`, 'Your verify(accessToken, refreshToken, profile, done) logic (find-or-create the user) moves to Atlas: identities link by provider user id; put extra steps in a post-login Action.', c.loc);
      continue;
    }
    if (module === 'passport-local') {
      const field = str(propOf(opts, 'usernameField')) ?? 'username';
      b.set('strategies.password', true);
      if (field !== 'email') b.set('strategies.username', true);
      b.add('differs', 'strategies', 'passport-local', `Password sign-in by ${field === 'email' ? 'email' : `${field} (Atlas usernames)`}; Atlas verifies passwords itself. Hashes your app stored with bcrypt, Argon2, PBKDF2 or passport-local-mongoose carry over in the export.`, c.loc, field === 'email' ? 'auth_config.strategies.password' : 'auth_config.strategies.username');
      continue;
    }
    if (module === 'passport-jwt' || module === 'passport-http-bearer' || module === 'passport-headerapikey') {
      b.add('manual', 'strategies', module, 'Bearer-token APIs: verify Atlas session tokens (or Atlas API keys / M2M tokens) with requireAuth() from the Atlas Express adapter or the Backend SDK instead.', c.loc);
      continue;
    }
    if (module === 'passport-saml' || module === '@node-saml/passport-saml') {
      const entryPoint = propOf(opts, 'entryPoint');
      const entry = str(entryPoint) ?? (entryPoint ? describe(entryPoint) : 'from the IdP metadata');
      b.add('manual', 'sso', module, `Create a SAML connection in Atlas (enterprise SSO) with the IdP SSO URL (${entry}), its certificate and issuer, then update the IdP with Atlas's ACS URL and entity id.`, c.loc, 'sso_connections');
      continue;
    }
    if (module === 'passport-openidconnect' || module === 'passport-azure-ad' || module === 'passport-oauth2') {
      b.add('manual', 'strategies', module, `Add this identity provider as a custom ${module === 'passport-oauth2' ? 'OAuth 2.0' : 'OIDC'} provider in Atlas (custom_oauth_providers) or as an enterprise OIDC connection, with the same client id.`, c.loc, 'custom_oauth_providers');
      continue;
    }
    if (module === 'passport-magic-link' || module === 'passport-magic-login') {
      b.set('strategies.emailLink', true);
      b.add('differs', 'strategies', module, 'Email sign-in links on; Atlas sends them through your email provider.', c.loc, 'auth_config.strategies.emailLink');
      continue;
    }
    b.add('manual', 'strategies', module, 'A Passport strategy with no Atlas counterpart to map automatically; review it.', c.loc);
  }

  for (const c of analysis.calls.filter((x) => x.matcher === 'session')) {
    const opts = objectOf(c.args[0]);
    const name = str(propOf(opts, 'name')) ?? 'connect.sid';
    b.bridge.vars.cookie_name = name;
    b.add('mapped', 'bridge', 'session({ name })', `The bridge reads "${name}" and pulls the session id out with expressSessionExtractor() (preset passport).`, at(propOf(opts, 'name') ?? opts, c.loc), 'bridge preset passport');
    const cookie = propOf(opts, 'cookie');
    const maxAgeMs = num(propOf(cookie, 'maxAge')) ?? num(propOf(cookie, 'expires'));
    const rolling = bool(propOf(opts, 'rolling')) === true;
    if (maxAgeMs !== undefined) b.session(Math.round(maxAgeMs / 1000), rolling, 'express-session', 'cookie.maxAge', at(propOf(cookie, 'maxAge'), c.loc), 'express-session');
    else b.add('differs', 'express-session', 'cookie.maxAge', 'Browser-session cookies (no maxAge): Atlas sessions have a lifetime (default 7 days idle); set auth_config.session to taste.', at(cookie, c.loc), 'auth_config.session');
    const store = propOf(opts, 'store');
    b.add(
      store ? 'mapped' : 'manual',
      'express-session',
      'store',
      store
        ? `${describe(store)}: dump its sessions (table, collection or keys) and the export imports the live ones for the bridge.`
        : 'MemoryStore: sessions live in process memory and cannot be exported; signed-in users sign in once more after the switch.',
      at(store, c.loc),
    );
    if (propOf(opts, 'secret')) b.add('mapped', 'express-session', 'secret', 'Only the bridge extractor uses it (to check the cookie signature) during the cutover.', propOf(opts, 'secret')!.loc);
  }
  for (const c of analysis.calls.filter((x) => x.matcher === 'cookie_session')) {
    b.add('manual', 'bridge', 'cookie-session', 'cookie-session keeps the whole session in a signed cookie (keygrip); the bridge cannot read it. Users sign in once more after the switch, or open the cookie yourself in a custom extractToken.', c.loc);
  }
  return b.result();
}

// ── iron-session ────────────────────────────────────────────────────────────

export function translateIronSession(project: string): TranslationResult {
  const analysis = analyzeCalls(
    project,
    [{ id: 'iron', module: /^(iron-session(\/.*)?|next-iron-session)$/, names: ['getIronSession', 'withIronSessionApiRoute', 'withIronSessionSsr', 'ironSession', 'withIronSession', 'default', 'sealData', 'unsealData'] }],
    ['iron-session'],
  );
  const { origin, where } = originOf(analysis.calls, 'iron-session');
  const b = new TranslationBuilder(origin, where);
  if (!analysis.calls.length) return notFound(b, analysis, 'setup', 'getIronSession() / withIronSession…() call');
  b.set('strategies.password', true);
  let seen = false;
  for (const c of analysis.calls) {
    if (c.imported.name === 'sealData' || c.imported.name === 'unsealData') {
      b.add('mapped', 'iron-session', c.imported.name, 'Sealing other data (magic links, invites) is unrelated to sign-in and keeps working.', c.loc);
      continue;
    }
    const opts = [...c.args].reverse().map(objectOf).find((o) => o && (propOf(o, 'cookieName') || propOf(o, 'password')));
    if (!opts || seen) continue;
    seen = true;
    const name = str(propOf(opts, 'cookieName'));
    b.bridge = { preset: 'iron_session', vars: name ? { cookie_name: name } : {} };
    b.add(
      name ? 'mapped' : 'manual',
      'bridge',
      'cookieName',
      name ? `The bridge reads "${name}": pass ironSessionExtractor({ cookieName, password, bridgeSecret }) to the middleware; the password stays on your server.` : 'Set cookie_name in the bridge settings to your iron-session cookieName.',
      at(propOf(opts, 'cookieName'), c.loc),
      'bridge preset iron_session',
    );
    const password = propOf(opts, 'password');
    if (password?.kind === 'env') b.add('mapped', 'bridge', 'password', `Read from ${password.name} by the bridge extractor on your server (never sent to Atlas).`, password.loc);
    else if (password) b.add('manual', 'bridge', 'password', 'The session password is not read from an environment variable: pass it to ironSessionExtractor on your server (it never goes to Atlas).', password.loc);
    const ttl = num(propOf(opts, 'ttl'));
    const ttlSeconds = ttl === undefined ? 14 * DAY : ttl;
    if (ttlSeconds === 0) b.add('differs', 'iron-session', 'ttl: 0', 'Atlas sessions always expire; the longest is 90 days.', at(propOf(opts, 'ttl'), c.loc), 'auth_config.session');
    else b.session(ttlSeconds, false, 'iron-session', 'ttl', at(propOf(opts, 'ttl'), c.loc), 'iron-session');
    const domain = propOf(propOf(opts, 'cookieOptions'), 'domain');
    if (domain) b.add('manual', 'iron-session', 'cookieOptions.domain', 'Shared cookies across subdomains: turn on session.crossSubdomainCookies.', domain.loc, 'auth_config.session.crossSubdomainCookies');
  }
  b.add('manual', 'users', 'user store', 'iron-session has no user store: export your users table (atlas migrate iron-session export --set dump=<dir>, with --set users-table=… and the column settings as needed).', where);
  return b.result();
}
