import type { ASTPath } from 'jscodeshift';
import { applyImportRules, referencesOf, renameEnv, vendorTransform, type ModuleRule, type VendorContext } from './engine';
import { memberOf, moduleBindings, providerEnvNote, type AnyNode } from './shared';

/**
 * Lucia (v2 `lucia({...})` + `auth.handleRequest()`, v3 `new Lucia(adapter, …)`,
 * the `@lucia-auth/*` adapters, `oslo` / `arctic`) → Atlas.
 *
 * Lucia is a session library the app wires up itself, so there is no call whose
 * shape Atlas can serve one-to-one: `validateSession()` returns Lucia's
 * `{ user, session }` (with the app's own user attributes) where Atlas has
 * `auth()` → `{ userId, sessionId, claims }`. This codemod therefore marks each
 * piece with the exact Atlas call that replaces it and reports it with file:line:
 *
 *  - reading the session (`validateSession`, v2 `handleRequest().validate()`,
 *    `readSessionCookie`, `sessionCookieName`) → `auth()` / `currentUser()` from
 *    `@atlasauth/nextjs/server`, `getAuth(req)` from `@atlasauth/express`, or
 *    `AtlasBackend#authenticateRequest()` from `@atlasauth/backend`;
 *  - creating sessions and cookies, keys and users → the Atlas sign-in/up pages;
 *  - invalidating sessions → `signOut()` in the browser or the sessions API;
 *  - `new Lucia(…)`, adapters, OAuth (`arctic`, `@lucia-auth/oauth`) and TOTP;
 *  - password hashing (`oslo/password`, `@node-rs/argon2`, `@node-rs/bcrypt`):
 *    Atlas owns passwords now.
 */

const VERIFY_HOW =
  'Atlas verifies its own session: in Next.js call auth() from @atlasauth/nextjs/server ({ userId, sessionId }) or currentUser() for the profile, in Express getAuth(req) from @atlasauth/express, elsewhere new AtlasBackend({ jwksUrl, issuer }).authenticateRequest(request) from @atlasauth/backend';
const READ_COOKIE =
  'Atlas reads its own __session cookie and Bearer header; drop this and read the session with auth() from @atlasauth/nextjs/server or getAuth(req) from @atlasauth/express';
const SIGN_IN =
  'sign-in and sign-up run on the Atlas pages, which create the session and set its cookie; delete this and send users to /sign-in (or render <SignIn /> / <SignUp /> from @atlasauth/react)';
const SIGN_OUT =
  'sign-out: call useAuth().signOut() or render <SignOutButton /> from @atlasauth/react in the browser, or revoke on the server with atlasClient().sessions.revoke(sessionId) from @atlasauth/nextjs/server';
const REVOKE_ALL =
  "revoke every session of a user with atlasClient().users.revokeSessions(userId) from @atlasauth/nextjs/server (or createAtlasClientFromEnv() from @atlasauth/backend)";
const LIST_SESSIONS = "list a user's sessions with atlasClient().users.listSessions(userId) from @atlasauth/nextjs/server";
const EXPIRE = 'Atlas expires sessions itself; delete this job';
const USERS = 'users live in Atlas now; use atlasClient().users (get / update / delete) from @atlasauth/nextjs/server';

const NEW_LUCIA =
  'new Lucia(adapter, …): Atlas stores users and sessions now; delete this instance with its adapter, sessionCookie and getUserAttributes options once nothing calls it (export your users first with `atlas migrate lucia export`)';
const V2_LUCIA =
  'lucia({ adapter, … }): Atlas stores users and sessions now; delete this instance with its adapter and middleware options once nothing calls it (export your users first with `atlas migrate lucia export`)';
const MODULE_DECL = 'Lucia type registration: delete it with the Lucia instance';
const ADAPTER =
  'Lucia database adapter: Atlas stores users and sessions now; remove it with the Lucia instance (keep your user table only for your own data)';
const SOCIAL =
  'OAuth sign-in: enable the provider under Social connections in the Atlas dashboard (its client id and secret move there); Atlas runs the authorize and callback steps, so delete these routes';
const MFA = 'TOTP / two-factor: enable authenticator-app MFA in the Atlas dashboard; enrolment and challenge run in <UserProfile /> and the sign-in page';
const PASSWORD =
  'password hashing: Atlas owns passwords now (sign-up and sign-in collect, hash and verify them on the Atlas pages; existing hashes are imported with your users); delete this';
const MIDDLEWARE =
  'Lucia v2 middleware adapter: use createAtlasMiddleware() from @atlasauth/nextjs/compat, atlasMiddleware() from @atlasauth/express or the @atlasauth/hono / @atlasauth/fastify adapters';
const TYPES = "Lucia's User / Session types: use CurrentUser and ServerAuth from @atlasauth/nextjs/server";

/** Methods on a Lucia instance (v3) or `auth` / `authRequest` (v2) → what replaces them. */
const METHODS: Record<string, string> = {
  validateSession: VERIFY_HOW,
  handleRequest: VERIFY_HOW,
  validateBearerToken: VERIFY_HOW,
  readSessionCookie: READ_COOKIE,
  readBearerToken: READ_COOKIE,
  createSession: SIGN_IN,
  createSessionCookie: SIGN_IN,
  setSession: SIGN_IN,
  useKey: SIGN_IN,
  createKey: SIGN_IN,
  createUser: SIGN_IN,
  createBlankSessionCookie: SIGN_OUT,
  invalidateSession: SIGN_OUT,
  invalidateUserSessions: REVOKE_ALL,
  getUserSessions: LIST_SESSIONS,
  getAllUserSessions: LIST_SESSIONS,
  deleteExpiredSessions: EXPIRE,
  getUser: USERS,
  updateUserAttributes: USERS,
  deleteUser: USERS,
  updateKeyPassword: USERS,
  deleteKey: USERS,
};

/** Method names only Lucia uses: flagged on any receiver in a file that imports Lucia. */
const DISTINCT = new Set([
  'validateSession',
  'handleRequest',
  'validateBearerToken',
  'readSessionCookie',
  'readBearerToken',
  'createSessionCookie',
  'createBlankSessionCookie',
  'invalidateUserSessions',
  'getUserSessions',
  'getAllUserSessions',
  'deleteExpiredSessions',
  'useKey',
  'createKey',
  'updateKeyPassword',
]);

/** Members read (not called) on a Lucia instance. */
const PROPERTIES: Record<string, string> = {
  sessionCookieName: READ_COOKIE,
};

const isLuciaModule = (s: string) => s === 'lucia' || s.startsWith('lucia/') || s.startsWith('@lucia-auth/');
const isPasswordModule = (s: string) => s === 'oslo/password' || s === '@node-rs/argon2' || s === '@node-rs/bcrypt';

const RULES: readonly ModuleRule[] = [
  {
    match: 'lucia',
    named: {
      Lucia: { keep: true },
      lucia: { keep: true },
      TimeSpan: { keep: true },
      generateId: { keep: true },
      generateIdFromEntropySize: { keep: true },
      verifyRequestOrigin: { keep: true },
      LuciaError: { keep: true },
      User: { manual: TYPES },
      Session: { manual: TYPES },
      DatabaseUserAttributes: { manual: MODULE_DECL },
      DatabaseSessionAttributes: { manual: MODULE_DECL },
      Cookie: { manual: 'Lucia Cookie type: Atlas sets its own cookies; remove the cookie plumbing' },
    },
    otherNamed: 'no Atlas counterpart; migrate it manually',
  },
  { match: 'lucia/middleware', otherNamed: MIDDLEWARE, whole: MIDDLEWARE },
  { match: (s) => s.startsWith('lucia/polyfill'), whole: 'Lucia polyfill: remove it with Lucia' },
  {
    match: (s) => s.startsWith('@lucia-auth/adapter-'),
    otherNamed: ADAPTER,
    default: { manual: ADAPTER },
    whole: ADAPTER,
  },
  {
    match: (s) => s === '@lucia-auth/oauth' || s.startsWith('@lucia-auth/oauth/') || s === 'arctic' || s === 'oslo/oauth2' || s === '@oslojs/oauth2',
    otherNamed: SOCIAL,
    default: { manual: SOCIAL },
    whole: SOCIAL,
  },
  {
    match: (s) => s === 'oslo/otp' || s === '@oslojs/otp',
    otherNamed: MFA,
    whole: MFA,
  },
  {
    match: (s) => s.startsWith('lucia/') || s.startsWith('@lucia-auth/'),
    otherNamed: 'no Atlas counterpart; migrate it manually',
  },
];

function receiverIsLucia(object: AnyNode, fileImportsLucia: boolean, method: string): boolean {
  if (object.type === 'Identifier') {
    if (/lucia/i.test(object.name)) return true;
    if (object.name === 'auth' || object.name === 'authRequest') return fileImportsLucia || DISTINCT.has(method);
  }
  const m = memberOf(object);
  return Boolean(m && /lucia/i.test(m.name));
}

function label(object: AnyNode, member: string, call: boolean): string {
  const prefix = object.type === 'Identifier' ? `${object.name}.` : '.';
  return `${prefix}${member}${call ? '()' : ''}`;
}

/** Calls and reads on the Lucia instance. */
function instancePass(ctx: VendorContext, fileImportsLucia: boolean): void {
  const { j, root } = ctx;
  root.find(j.MemberExpression).forEach((path) => {
    const m = memberOf(path.node);
    if (!m) return;
    const parent = path.parent?.node as AnyNode | undefined;
    const isCall = Boolean(parent && parent.type === 'CallExpression' && parent.callee === path.node);
    const table = isCall ? METHODS : PROPERTIES;
    const note = Object.hasOwn(table, m.name) ? table[m.name] : undefined;
    if (!note) return;
    if (!receiverIsLucia(m.object, fileImportsLucia, m.name) && !(fileImportsLucia && DISTINCT.has(m.name))) return;
    ctx.manual(path as ASTPath, `${label(m.object, m.name, isCall)}: ${note}`);
  });
}

/** `new Lucia(…)` (v3), `lucia({ … })` (v2) and `declare module 'lucia'`. */
function setupPass(ctx: VendorContext): void {
  const { j, root } = ctx;
  for (const b of moduleBindings(ctx, (s) => s === 'lucia')) {
    const note = b.imported === 'Lucia' ? NEW_LUCIA : b.imported === 'lucia' ? V2_LUCIA : null;
    if (!note) continue;
    for (const ref of referencesOf(ctx, b.local)) {
      const parent = ref.parent?.node as AnyNode | undefined;
      if (parent && (parent.type === 'NewExpression' || parent.type === 'CallExpression') && parent.callee === ref.node) ctx.manual(ref, note);
    }
  }
  root.find(j.TSModuleDeclaration).forEach((path) => {
    const id = path.node.id as AnyNode;
    if ((id.type === 'StringLiteral' || id.type === 'Literal') && id.value === 'lucia') ctx.manual(path as ASTPath, MODULE_DECL);
  });
}

/** `new Argon2id().hash(…)`, `hash()` / `verify()` from `@node-rs/argon2`: Atlas owns passwords. */
function passwordPass(ctx: VendorContext): void {
  for (const b of moduleBindings(ctx, isPasswordModule)) {
    for (const ref of referencesOf(ctx, b.local)) ctx.manual(ref, PASSWORD);
  }
}

export default vendorTransform({
  mightApply: (source) => /lucia|oslo|arctic|@node-rs\/(argon2|bcrypt)|LUCIA_/i.test(source),
  run(ctx) {
    const fileImportsLucia = moduleBindings(ctx, (s) => isLuciaModule(s) || s === 'oslo' || s.startsWith('oslo/') || s.startsWith('@oslojs/')).length > 0;
    applyImportRules(ctx, RULES);
    setupPass(ctx);
    instancePass(ctx, fileImportsLucia);
    passwordPass(ctx);
    renameEnv(ctx, (key) => {
      if (/^LUCIA_/.test(key)) return { report: `${key}: Lucia setting; remove it with Lucia (Atlas configures sessions in the dashboard)` };
      const note = providerEnvNote(key);
      return note ? { report: note } : null;
    });
  },
});
