import type { ASTPath } from 'jscodeshift';
import {
  applyImportRules,
  applyReexportRules,
  callOf,
  isReference,
  referencesOf,
  renameEnv,
  vendorTransform,
  type ImportTarget,
  type ModuleRule,
  type VendorContext,
} from './engine';
import { ATLAS, memberOf, moduleBindings, removeIfUnused, type AnyNode } from './shared';

/**
 * iron-session (v8 `getIronSession(cookies(), options)`, v6
 * `withIronSessionApiRoute` / `withIronSessionSsr` / `ironSession`,
 * `next-iron-session`) → Atlas.
 *
 *  - `const session = await getIronSession(cookies(), options)` whose only use is
 *    reading `session.userId` → `const session = await auth()` from
 *    `@atlasauth/nextjs/server` (the Atlas user id, null when signed out); the
 *    `cookies` / options imports go when nothing else uses them;
 *  - any other session (written to, saved, destroyed, holding more than a user
 *    id), the v6 wrappers, `req.session`, `session.save()` / `session.destroy()`
 *    are reported: sign-in and sign-out are Atlas pages and actions now;
 *  - `sealData` / `unsealData` are left alone (they seal other data too) and reported.
 */

const GET_NOTE =
  'getIronSession(): read the signed-in user with auth() ({ userId, sessionId }) or currentUser() from @atlasauth/nextjs/server; sign-in and sign-out (session.save() / destroy()) are Atlas pages and actions now; keep other session data in Atlas user metadata or your database';
const GET_REPORT =
  'getIronSession() is now auth() from @atlasauth/nextjs/server: session.userId is the Atlas user id (null when signed out); delete the iron-session options once nothing else uses them';
const SAVE_NOTE = 'session.save(): sign-in runs on the Atlas pages, which create the session and its cookie; delete this and send users to /sign-in';
const DESTROY_NOTE =
  'session.destroy(): sign-out — call useAuth().signOut() or render <SignOutButton /> from @atlasauth/react, or revoke on the server with atlasClient().sessions.revoke(sessionId) from @atlasauth/nextjs/server';
const REQ_SESSION_NOTE =
  'req.session (iron-session): the signed-in user comes from the Atlas session now (auth() / currentUser() from @atlasauth/nextjs/server, or new AtlasBackend({ jwksUrl, issuer }).authenticateRequest(req) from @atlasauth/backend); keep other data in Atlas user metadata or your database';
const SEAL_NOTE =
  'sealData() / unsealData() are not the sign-in session: keep iron-session for them (sealed links, invites), or use Atlas sign-in tokens (atlasClient().signInTokens.create) for passwordless sign-in links';
const TYPES_NOTE = 'iron-session types: delete them with the session options once nothing uses iron-session';
const MODULE_DECL = 'iron-session type augmentation: delete it once nothing uses iron-session';
const LEGACY_NOTE = 'next-iron-session: read the user with auth() / currentUser() from @atlasauth/nextjs/server and remove the session wrapper';

const WRAPPERS: Record<string, string> = {
  withIronSessionApiRoute:
    'withIronSessionApiRoute(): unwrap the handler and read the user from the Atlas session instead: auth() from @atlasauth/nextjs/server once it moves to the App Router, or new AtlasBackend({ jwksUrl, issuer }).authenticateRequest(req) from @atlasauth/backend',
  withIronSessionSsr:
    'withIronSessionSsr(): unwrap getServerSideProps and read the user from the Atlas session instead: auth() / currentUser() from @atlasauth/nextjs/server once the page moves to the App Router, or new AtlasBackend({ jwksUrl, issuer }).authenticateRequest(req) from @atlasauth/backend',
  ironSession: 'ironSession(): mount atlasMiddleware({ jwksUrl, issuer }) from @atlasauth/express instead and read getAuth(req).userId',
  getIronSession: GET_NOTE,
};

const isIronModule = (s: string) => s === 'iron-session' || s.startsWith('iron-session/') || s === 'next-iron-session';

/** Identifier names inside a detached subtree (for imports a dropped argument used). */
function identifierNames(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) identifierNames(n, out);
    return;
  }
  const n = node as AnyNode;
  if (n.type === 'Identifier' && typeof n.name === 'string') out.add(n.name);
  for (const key of Object.keys(n)) {
    if (key === 'loc' || key === 'original' || key === 'tokens' || key === 'comments' || key === 'extra') continue;
    identifierNames(n[key], out);
  }
}

/** The nearest enclosing function (where a `const session` lives). */
function enclosingFunction(path: ASTPath): ASTPath | null {
  let cur = path.parent as ASTPath | null;
  while (cur && !/Function|Method/.test(cur.node.type)) cur = cur.parent as ASTPath | null;
  return cur;
}

/**
 * `const session = await getIronSession(cookies() | await cookies(), options)`
 * where every use of `session` reads `session.userId`.
 */
function readsOnlyUserId(ref: ASTPath, ctx: VendorContext): boolean {
  if (ctx.facts.isMiddleware) return false;
  const call = callOf(ref);
  if (!call) return false;
  const first = call.args[0] as AnyNode | undefined;
  const inner = first?.type === 'AwaitExpression' ? (first.argument as AnyNode) : first;
  if (!inner || inner.type !== 'CallExpression' || inner.callee?.type !== 'Identifier' || inner.callee.name !== 'cookies') return false;
  const awaited = call.path.parent as ASTPath | null;
  if (!awaited || awaited.node.type !== 'AwaitExpression') return false;
  const declarator = awaited.parent as ASTPath | null;
  const decl = declarator?.node as AnyNode | undefined;
  if (!declarator || !decl || decl.type !== 'VariableDeclarator' || decl.init !== awaited.node || decl.id.type !== 'Identifier') return false;
  const scope = enclosingFunction(declarator);
  if (!scope) return false;
  const { j } = ctx;
  const refs = j(scope)
    .find(j.Identifier, { name: decl.id.name as string })
    .filter((p) => isReference(p))
    .paths();
  if (refs.length === 0) return false;
  return refs.every((p) => {
    const parent = p.parent?.node as AnyNode | undefined;
    const m = memberOf(parent);
    if (!parent || !m || parent.object !== p.node || m.name !== 'userId') return false;
    const grand = (p.parent as ASTPath).parent?.node as AnyNode | undefined;
    if (!grand) return true;
    if (grand.type === 'AssignmentExpression' && grand.left === parent) return false;
    if (grand.type === 'UpdateExpression') return false;
    if (grand.type === 'UnaryExpression' && grand.operator === 'delete') return false;
    if ((grand.type === 'CallExpression' || grand.type === 'NewExpression') && grand.callee === parent) return false;
    return true;
  });
}

const getIronSession: ImportTarget = {
  module: ATLAS.nextServer,
  name: 'auth',
  noReexport: GET_NOTE,
  accept: (ref, ctx) => (readsOnlyUserId(ref, ctx) ? true : GET_NOTE),
  after: (ref, ctx) => {
    const call = callOf(ref);
    if (!call) return;
    const node = call.path.node as AnyNode;
    const used = new Set<string>();
    identifierNames([node.arguments, node.typeParameters, node.typeArguments], used);
    ctx.report(call.path, GET_REPORT);
    node.arguments = [];
    delete node.typeParameters;
    delete node.typeArguments;
    // `cookies`, the options object and the session type, when nothing else uses them.
    for (const name of used) {
      for (const b of moduleBindings(ctx, () => true).filter((x) => x.local === name)) removeIfUnused(ctx, b);
    }
  },
};

const RULES: readonly ModuleRule[] = [
  {
    match: (s) => s === 'iron-session' || s.startsWith('iron-session/'),
    named: {
      getIronSession,
      sealData: { manual: SEAL_NOTE },
      unsealData: { manual: SEAL_NOTE },
      withIronSessionApiRoute: { keep: true },
      withIronSessionSsr: { keep: true },
      ironSession: { keep: true },
      IronSession: { manual: TYPES_NOTE },
      IronSessionData: { manual: TYPES_NOTE },
      IronSessionOptions: { manual: TYPES_NOTE },
      SessionOptions: { manual: TYPES_NOTE },
    },
    otherNamed: 'no Atlas counterpart; migrate it manually',
  },
  { match: 'next-iron-session', otherNamed: LEGACY_NOTE, default: { manual: LEGACY_NOTE }, whole: LEGACY_NOTE },
];

/** The v6 wrappers / express middleware, at each use. */
function wrapperPass(ctx: VendorContext): void {
  for (const b of moduleBindings(ctx, isIronModule)) {
    if (b.imported === 'getIronSession' || !Object.hasOwn(WRAPPERS, b.imported)) continue;
    for (const ref of referencesOf(ctx, b.local)) ctx.manual(ref, WRAPPERS[b.imported]!);
  }
}

/** `session.save()`, `session.destroy()`, `req.session`. */
function sessionPass(ctx: VendorContext): void {
  const { j, root } = ctx;
  const looksLikeSession = (n: AnyNode) =>
    (n.type === 'Identifier' && /session/i.test(n.name)) || memberOf(n)?.name === 'session';
  root.find(j.CallExpression).forEach((path) => {
    const m = memberOf(path.node.callee);
    if (!m || !looksLikeSession(m.object) || path.node.arguments.length > 0) return;
    if (m.name === 'save') ctx.manual(path as ASTPath, SAVE_NOTE);
    else if (m.name === 'destroy') ctx.manual(path as ASTPath, DESTROY_NOTE);
  });
  root.find(j.MemberExpression).forEach((path) => {
    const m = memberOf(path.node);
    if (!m || m.name !== 'session' || m.object.type !== 'Identifier' || !/^req(uest)?$/.test(m.object.name)) return;
    const parent = memberOf(path.parent?.node);
    if (parent && (parent.name === 'save' || parent.name === 'destroy')) return;
    ctx.manual(path as ASTPath, REQ_SESSION_NOTE);
  });
  root.find(j.TSModuleDeclaration).forEach((path) => {
    const id = path.node.id as AnyNode;
    if ((id.type === 'StringLiteral' || id.type === 'Literal') && isIronModule(String(id.value))) ctx.manual(path as ASTPath, MODULE_DECL);
  });
}

const PASSWORD_ENV = /^(SECRET_COOKIE_PASSWORD|IRON_SESSION_[A-Z0-9_]+|IRON_PASSWORD|SESSION_PASSWORD|COOKIE_PASSWORD)$/;

export default vendorTransform({
  mightApply: (source) => /iron-session|IRON_SESSION|SECRET_COOKIE_PASSWORD|SESSION_PASSWORD|COOKIE_PASSWORD/.test(source),
  run(ctx) {
    const usesIron = moduleBindings(ctx, isIronModule).length > 0;
    applyReexportRules(ctx, RULES);
    applyImportRules(ctx, RULES);
    if (usesIron) {
      wrapperPass(ctx);
      sessionPass(ctx);
    }
    renameEnv(ctx, (key) =>
      PASSWORD_ENV.test(key)
        ? { report: `${key}: iron-session cookie password; remove it unless sealData() / unsealData() still use it (Atlas signs its own sessions)` }
        : null,
    );
  },
});
