import type { ASTPath } from 'jscodeshift';
import { callOf, referencesOf, renameEnv, vendorTransform, type VendorContext } from './engine';
import {
  ATLAS,
  ensureBinding,
  memberOf,
  moduleBindings,
  nameOf,
  providerEnvNote,
  removeIfUnused,
  type AnyNode,
  type ModuleBinding,
} from './shared';

/**
 * Passport.js + express-session → the Atlas Express adapter (`@atlasauth/express`).
 *
 *  - `app.use(passport.initialize())` → `app.use(atlasMiddleware({ jwksUrl, issuer }))`,
 *    which verifies the Atlas session (cookie or Bearer) and sets `req.atlas`;
 *    `app.use(passport.session())` is removed (the middleware restores the user);
 *  - `passport.authenticate('jwt' | 'bearer')` used as route middleware →
 *    `requireAuth({ jwksUrl, issuer })` (401 when signed out);
 *  - `req.isAuthenticated()` → `getAuth(req).isSignedIn`;
 *  - strategies (`passport.use(new XStrategy(…))`), the login/callback routes,
 *    `serializeUser` / `deserializeUser`, `req.user`, `req.login()` / `req.logout()`
 *    and `express-session` with its store are reported: social providers, SAML and
 *    OIDC move to the Atlas dashboard and sign-in runs on the Atlas pages.
 */

const SESSION_NOTE =
  'express-session: Atlas keeps the sign-in session in its own __session cookie; remove this (with its store and SESSION_SECRET) unless the session also holds non-auth data';
const STORE_NOTE = 'session store for express-session: remove it together with express-session unless you keep sessions for non-auth data';
const INIT_REPORT =
  'passport.initialize() is now atlasMiddleware() from @atlasauth/express: it verifies the Atlas session (__session cookie or Bearer token) on every request and sets req.atlas (read it with getAuth(req)); set ATLAS_JWKS_URL and ATLAS_ISSUER';
const INIT_NOTE = 'passport.initialize(): mount atlasMiddleware({ jwksUrl, issuer }) from @atlasauth/express with app.use() instead';
const SESSION_REMOVED = 'passport.session() removed: atlasMiddleware() restores the signed-in user on every request';
const PASSPORT_SESSION_NOTE =
  'passport.session(): remove it once atlasMiddleware() from @atlasauth/express is mounted (it restores the signed-in user on every request)';
const USE_NOTE =
  'passport.use(): Passport strategies are replaced by Atlas; configure the sign-in method in the Atlas dashboard (or, to keep Passport, register AtlasStrategy / AtlasJwtStrategy from @atlasauth/passport)';
const SERIALIZE_NOTE =
  'passport.serializeUser/deserializeUser: there is no Passport login session any more; load your user record by getAuth(req).userId (the Atlas user id) where you need it';
const AUTHORIZE_NOTE = 'passport.authorize(): users connect more accounts from <UserProfile /> in Atlas; delete this route';
const REQ_USER_NOTE =
  'req.user is no longer set by Passport: getAuth(req).userId from @atlasauth/express is the Atlas user id; load your own user record by it';
const LOGIN_NOTE = 'req.login(): the Atlas sign-in page creates the session; redirect to /sign-in instead';
const LOGOUT_NOTE =
  'req.logout(): sign out in the browser (useAuth().signOut() or <SignOutButton /> from @atlasauth/react), or revoke on the server with createAtlasClientFromEnv().sessions.revoke(getAuth(req).sessionId) from @atlasauth/backend';
const IS_AUTH_REPORT = 'req.isAuthenticated() is now getAuth(req).isSignedIn from @atlasauth/express; mount atlasMiddleware() before these routes';
const ENSURE_LOGIN_NOTE = 'connect-ensure-login: use requireAuth() from @atlasauth/express (it answers 401; redirect browsers to /sign-in yourself)';

const SOCIAL: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  facebook: 'Facebook',
  twitter: 'X (Twitter)',
  microsoft: 'Microsoft',
  apple: 'Apple',
  discord: 'Discord',
  linkedin: 'LinkedIn',
  gitlab: 'GitLab',
  slack: 'Slack',
  spotify: 'Spotify',
  twitch: 'Twitch',
};

/** Token strategies whose route middleware maps onto `requireAuth()`. */
const TOKEN_STRATEGIES = new Set(['jwt', 'bearer']);

const SESSION_MODULES = new Set(['express-session', 'cookie-session']);
const STORE_MODULES = new Set([
  'connect-redis',
  'connect-mongo',
  'connect-mongodb-session',
  'connect-pg-simple',
  'connect-sqlite3',
  'connect-session-sequelize',
  'connect-session-knex',
  'connect-dynamodb',
  'connect-memcached',
  'memorystore',
  'session-file-store',
  '@quixo3/prisma-session-store',
]);

const isStrategyModule = (s: string) => s.startsWith('passport-') || s === '@node-saml/passport-saml';

/** What a `new <Strategy>(…)` from this module turns into. */
function strategyNote(source: string): string {
  if (source === 'passport-local') {
    return 'passport-local: email/password sign-in runs on the Atlas sign-in page now (existing password hashes move with your users); delete this strategy and the login form, send users to /sign-in';
  }
  if (source === 'passport-jwt' || source === 'passport-http-bearer') {
    return `${source}: Atlas session tokens are verified by atlasMiddleware() / requireAuth() from @atlasauth/express against the instance JWKS; delete this strategy (or, to keep Passport, use AtlasJwtStrategy from @atlasauth/passport)`;
  }
  if (/saml/.test(source)) {
    return `${source}: add the IdP as a SAML enterprise SSO connection in the Atlas dashboard (Atlas hosts the ACS endpoint and routes users by email domain); delete this strategy and its callback route`;
  }
  if (source === 'passport-openidconnect' || source === 'passport-azure-ad') {
    return `${source}: add the IdP as an OIDC enterprise SSO connection in the Atlas dashboard; delete this strategy and its callback route`;
  }
  if (source === 'passport-oauth2' || source === 'passport-oauth') {
    return `${source}: add the provider as a custom OAuth provider in the Atlas dashboard (or an OIDC enterprise SSO connection); delete this strategy and its callback route`;
  }
  const social = Object.keys(SOCIAL).find((k) => source.startsWith(`passport-${k}`));
  if (social) {
    return `${source}: enable ${SOCIAL[social]} under Social connections in the Atlas dashboard (its client id and secret move there); Atlas runs the OAuth callback, so delete this strategy and its callback route`;
  }
  return `${source}: configure this sign-in method in the Atlas dashboard and delete the strategy (or, to keep Passport, use AtlasStrategy from @atlasauth/passport)`;
}

/** What a `passport.authenticate('<name>')` login/callback route turns into. */
function authenticateNote(strategy: string | null): string {
  const label = strategy === null ? 'passport.authenticate(…)' : `passport.authenticate('${strategy}')`;
  if (strategy === 'local') {
    return `${label}: email/password sign-in runs on the Atlas sign-in page now; delete this login route and send users to /sign-in`;
  }
  const social = strategy ? Object.keys(SOCIAL).find((k) => strategy === k || strategy.startsWith(`${k}-`)) : undefined;
  if (social) {
    return `${label}: Atlas runs ${SOCIAL[social]} sign-in and its callback; enable ${SOCIAL[social]} under Social connections in the Atlas dashboard, delete this route and send users to /sign-in`;
  }
  if (strategy && /saml/.test(strategy)) {
    return `${label}: add the IdP as a SAML enterprise SSO connection in the Atlas dashboard (Atlas hosts the ACS endpoint); delete this route and send users to /sign-in`;
  }
  if (strategy === 'oauth2' || strategy === 'openidconnect' || strategy === 'oidc') {
    return `${label}: add the provider as a custom OAuth provider or an OIDC enterprise SSO connection in the Atlas dashboard; delete this route and send users to /sign-in`;
  }
  return `${label}: Atlas hosts sign-in and its callbacks; delete this route and send users to /sign-in (protect API routes with requireAuth() from @atlasauth/express)`;
}

/** The `{ jwksUrl, issuer }` options for the Atlas Express helpers, from the env. */
function verifyOptions(ctx: VendorContext): string {
  const bang = ctx.facts.isTypeScript ? '!' : '';
  return `{ jwksUrl: process.env.ATLAS_JWKS_URL${bang}, issuer: process.env.ATLAS_ISSUER${bang} }`;
}

function stringArg(node: unknown): string | null {
  const n = node as AnyNode | undefined;
  return n && (n.type === 'StringLiteral' || n.type === 'Literal') && typeof n.value === 'string' ? n.value : null;
}

/** `X.use(<call>)` as a whole statement, with `<call>` its only argument. */
function soleUseStatement(callPath: ASTPath): ASTPath | null {
  const parent = callPath.parent as ASTPath | null;
  const parentNode = parent?.node as AnyNode | undefined;
  if (!parent || !parentNode || parentNode.type !== 'CallExpression' || memberOf(parentNode.callee)?.name !== 'use') return null;
  if (parentNode.arguments.length !== 1 || parentNode.arguments[0] !== callPath.node) return null;
  const statement = parent.parent as ASTPath | null;
  return statement && (statement.node as AnyNode).type === 'ExpressionStatement' ? statement : null;
}

/** Is `callPath` an argument of a `.use(…)` call? */
function isUseArgument(callPath: ASTPath): boolean {
  const parentNode = (callPath.parent as ASTPath | null)?.node as AnyNode | undefined;
  return Boolean(parentNode && parentNode.type === 'CallExpression' && memberOf(parentNode.callee)?.name === 'use' && parentNode.arguments.includes(callPath.node));
}

function markBindingStatements(ctx: VendorContext, bindings: ModuleBinding[], note: string): void {
  const seen = new Set<ASTPath>();
  for (const b of bindings) {
    if (seen.has(b.statement)) continue;
    seen.add(b.statement);
    ctx.manual(b.statement, note);
  }
}

/** `express-session` / `cookie-session` calls and session stores. */
function sessionPass(ctx: VendorContext): void {
  for (const b of moduleBindings(ctx, (s) => SESSION_MODULES.has(s))) {
    for (const ref of referencesOf(ctx, b.local)) {
      if (callOf(ref)) ctx.manual(ref, SESSION_NOTE);
    }
  }
  markBindingStatements(ctx, moduleBindings(ctx, (s) => STORE_MODULES.has(s)), STORE_NOTE);
  markBindingStatements(ctx, moduleBindings(ctx, (s) => s === 'connect-ensure-login'), ENSURE_LOGIN_NOTE);
}

/** `new GoogleStrategy(…)` (wherever it is built) → the dashboard setting that replaces it. */
function strategyPass(ctx: VendorContext): Set<string> {
  const { j, root } = ctx;
  const sources = new Map<string, string>();
  for (const b of moduleBindings(ctx, isStrategyModule)) sources.set(b.local, b.source);
  root.find(j.NewExpression).forEach((path) => {
    const callee = path.node.callee as AnyNode;
    const local = callee.type === 'Identifier' ? callee.name : memberOf(callee)?.object.type === 'Identifier' ? memberOf(callee)!.object.name : null;
    const source = local ? sources.get(local) : undefined;
    if (source) ctx.manual(path as ASTPath, strategyNote(source));
  });
  return new Set(sources.keys());
}

/** `passport.*` calls. */
function passportPass(ctx: VendorContext, strategyLocals: Set<string>): void {
  const { j, root } = ctx;
  const bindings = moduleBindings(ctx, (s) => s === 'passport');
  const names = new Set(['passport', ...bindings.filter((b) => b.imported === 'default' || b.imported === '*').map((b) => b.local)]);
  const calls = root.find(j.CallExpression).filter((p) => {
    const m = memberOf(p.node.callee);
    return Boolean(m && m.object.type === 'Identifier' && names.has(m.object.name));
  });

  // initialize() first: passport.session() can only go once atlasMiddleware() is mounted.
  let mounted = referencesOf(ctx, 'atlasMiddleware').length > 0;
  calls.forEach((path) => {
    if (memberOf(path.node.callee)!.name !== 'initialize') return;
    if (!isUseArgument(path as ASTPath)) {
      ctx.manual(path as ASTPath, INIT_NOTE);
      return;
    }
    ctx.report(path as ASTPath, INIT_REPORT);
    const local = ensureBinding(ctx, ATLAS.express, 'atlasMiddleware');
    path.replace(ctx.expr(`${local}(${verifyOptions(ctx)})`) as never);
    ctx.rewrote();
    mounted = true;
  });

  calls.forEach((path) => {
    const node = path.node as AnyNode;
    if (!node.callee) return;
    const m = memberOf(node.callee);
    if (!m) return;
    const p = path as ASTPath;
    switch (m.name) {
      case 'initialize':
        return;
      case 'session':
        removeSessionUse(ctx, p, mounted);
        return;
      case 'authenticate': {
        const strategy = stringArg(node.arguments[0]);
        if (strategy === 'session') {
          removeSessionUse(ctx, p, mounted);
          return;
        }
        if (strategy && TOKEN_STRATEGIES.has(strategy) && node.arguments.length <= 2 && !callOf(p)) {
          ctx.report(
            p,
            `passport.authenticate('${strategy}') is now requireAuth() from @atlasauth/express: it accepts an Atlas session token (Bearer or __session cookie) and answers 401 otherwise; req.user is no longer set, read getAuth(req).userId`,
          );
          const local = ensureBinding(ctx, ATLAS.express, 'requireAuth');
          path.replace(ctx.expr(`${local}(${verifyOptions(ctx)})`) as never);
          ctx.rewrote();
          return;
        }
        if (strategy && TOKEN_STRATEGIES.has(strategy)) {
          ctx.manual(p, `passport.authenticate('${strategy}', …) with a callback: read getAuth(req) from @atlasauth/express (after atlasMiddleware()) and answer the signed-out case yourself`);
          return;
        }
        ctx.manual(p, authenticateNote(strategy));
        return;
      }
      case 'use': {
        const builds = (node.arguments as AnyNode[]).some((a) => {
          if (a.type !== 'NewExpression') return false;
          const callee = a.callee as AnyNode;
          const local = callee.type === 'Identifier' ? callee.name : memberOf(callee)?.object.name;
          return typeof local === 'string' && strategyLocals.has(local);
        });
        if (!builds) ctx.manual(p, USE_NOTE);
        return;
      }
      case 'serializeUser':
      case 'deserializeUser':
        ctx.manual(p, SERIALIZE_NOTE);
        return;
      case 'authorize':
        ctx.manual(p, AUTHORIZE_NOTE);
        return;
      default:
        ctx.manual(p, `passport.${m.name}(): no Atlas counterpart; migrate it manually`);
    }
  });

  for (const b of bindings) removeIfUnused(ctx, b);
}

/** `app.use(passport.session())`: gone once atlasMiddleware() is mounted, else reported. */
function removeSessionUse(ctx: VendorContext, path: ASTPath, mounted: boolean): void {
  const statement = soleUseStatement(path);
  if (!mounted || !statement) {
    ctx.manual(path, PASSPORT_SESSION_NOTE);
    return;
  }
  ctx.report(statement, SESSION_REMOVED);
  ctx.j(statement).remove();
  ctx.rewrote();
}

/** `req.isAuthenticated()`, `req.user`, `req.login()`, `req.logout()`. */
function requestPass(ctx: VendorContext): void {
  const { j, root } = ctx;
  const isReq = (n: AnyNode) => n.type === 'Identifier' && /^req(uest)?$/.test(n.name);
  root.find(j.CallExpression).forEach((path) => {
    const node = path.node as AnyNode;
    const m = memberOf(node.callee);
    if (!m || !isReq(m.object)) return;
    if ((m.name === 'isAuthenticated' || m.name === 'isUnauthenticated') && node.arguments.length === 0) {
      ctx.report(path as ASTPath, IS_AUTH_REPORT);
      const local = ensureBinding(ctx, ATLAS.express, 'getAuth');
      const signedIn = j.memberExpression(j.callExpression(j.identifier(local), [m.object as never]), j.identifier('isSignedIn'));
      path.replace(m.name === 'isAuthenticated' ? signedIn : j.unaryExpression('!', signedIn));
      ctx.rewrote();
      return;
    }
    if (m.name === 'login' || m.name === 'logIn') ctx.manual(path as ASTPath, LOGIN_NOTE);
    else if (m.name === 'logout' || m.name === 'logOut') ctx.manual(path as ASTPath, LOGOUT_NOTE);
  });
  root.find(j.MemberExpression).forEach((path) => {
    const m = memberOf(path.node);
    if (m && m.name === 'user' && isReq(m.object)) ctx.manual(path as ASTPath, REQ_USER_NOTE);
  });
}

function envNote(key: string): string | null {
  if (key === 'SESSION_SECRET' || key === 'COOKIE_SECRET' || key === 'EXPRESS_SESSION_SECRET') {
    return `${key}: only express-session uses it; remove it with express-session (Atlas signs its own sessions)`;
  }
  if (key === 'JWT_SECRET' || key === 'JWT_PUBLIC_KEY') {
    return `${key}: Atlas session tokens verify against the instance JWKS (ATLAS_JWKS_URL); remove it once nothing else signs with it`;
  }
  if (/^SAML_/.test(key)) return `${key}: SAML settings now live on the enterprise SSO connection in the Atlas dashboard`;
  return providerEnvNote(key);
}

export default vendorTransform({
  mightApply: (source) =>
    /passport|express-session|cookie-session|connect-|session-store|memorystore|isAuthenticated|isUnauthenticated|\breq(uest)?\.(user|log[iI]n|log[oO]ut)\b|SESSION_SECRET/.test(source),
  run(ctx) {
    sessionPass(ctx);
    const strategyLocals = strategyPass(ctx);
    passportPass(ctx, strategyLocals);
    requestPass(ctx);
    renameEnv(ctx, (key) => {
      const note = envNote(key);
      return note ? { report: note } : null;
    });
  },
});
