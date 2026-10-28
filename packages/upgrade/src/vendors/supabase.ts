import type { ASTNode, ASTPath, CallExpression } from 'jscodeshift';
import {
  applyImportRules,
  dropJsxAttrs,
  fixProviderProps,
  renameEnv,
  vendorTransform,
  type ModuleRule,
  type VendorContext,
} from './engine';
import { ATLAS, reportRoute } from './shared';

/**
 * Supabase Auth → Atlas. The Supabase client stays (it is also the database
 * client); only its AUTH surface moves:
 *
 *  - `<client>.auth.getUser()` / `getSession()` / `signOut()` →
 *    `getSupabaseUserCompat()` / `getSupabaseSessionCompat()` / `supabaseSignOutCompat()`
 *    from `@atlasauth/react` in the browser and `@atlasauth/nextjs/compat` on the
 *    server (both resolve Supabase's `{ data, error }` shape);
 *  - `signInWithOAuth` and `onAuthStateChange` in the browser → their compat peers;
 *  - `@supabase/auth-helpers-react` hooks and `SessionContextProvider`, and the
 *    `@supabase/auth-ui-react` `<Auth>` widget → Atlas;
 *  - `updateSession(request)` in `middleware.ts` → the Atlas middleware;
 *  - credential flows (`signInWithPassword`, `signUp`, OTP, MFA, admin) are
 *    reported: they run on Atlas's own pages and APIs.
 */

const RULES: readonly ModuleRule[] = [
  {
    match: '@supabase/auth-helpers-react',
    named: {
      SessionContextProvider: {
        module: ATLAS.react,
        name: 'AtlasProvider',
        after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: ['supabaseClient', 'initialSession'] }),
      },
      useUser: { module: ATLAS.reactCompat, name: 'useSupabaseUserCompat' },
      useSession: { module: ATLAS.reactCompat, name: 'useSupabaseSessionCompat' },
      useSessionContext: {
        manual: 'useSessionContext(): use useUser() / useAuth() from @atlasauth/react ({ isLoaded, isSignedIn, user })',
      },
    },
    keepOthers: true,
  },
  {
    match: '@supabase/auth-ui-react',
    named: {
      Auth: {
        module: ATLAS.react,
        name: 'SignIn',
        after: (ref, ctx) => {
          const parent = ref.parent?.node as { type?: string; attributes?: ASTNode[] } | undefined;
          if (parent?.type !== 'JSXOpeningElement') return;
          const names = (parent.attributes ?? [])
            .map((a) => (a as { name?: { name?: string } }).name?.name)
            .filter((n): n is string => Boolean(n));
          const dropped = dropJsxAttrs(parent, names);
          if (dropped.length > 0) {
            ctx.report(ref, `<Auth> is now Atlas's <SignIn />; its props (${dropped.join(', ')}) are configured in the Atlas dashboard instead`);
          }
        },
      },
    },
    otherNamed: 'Supabase Auth UI: use <SignIn />, <SignUp /> and <UserProfile /> from @atlasauth/react',
  },
  {
    match: '@supabase/auth-ui-shared',
    otherNamed: 'Supabase Auth UI theme: style the Atlas components with the appearance prop or the dashboard designer',
  },
  {
    match: (s) => s === '@supabase/supabase-js' || s === '@supabase/ssr' || s.startsWith('@supabase/auth-helpers-'),
    keepOthers: true,
  },
];

/** Methods whose call moves to a compat helper, per side. */
const COMPAT: Record<string, { client?: string; server?: string }> = {
  getUser: { client: 'getSupabaseUserCompat', server: 'getSupabaseUserCompat' },
  getSession: { client: 'getSupabaseSessionCompat', server: 'getSupabaseSessionCompat' },
  signOut: { client: 'supabaseSignOutCompat', server: 'supabaseSignOutCompat' },
  signInWithOAuth: { client: 'supabaseSignInWithOAuthCompat' },
  onAuthStateChange: { client: 'onSupabaseAuthStateChangeCompat' },
};

const MANUAL: Record<string, string> = {
  signInWithPassword: 'credentials are collected on the Atlas sign-in page now: replace this form with <SignIn /> (or send users to /sign-in)',
  signInWithOtp: 'one-time-code sign-in runs on the Atlas sign-in page: enable email/SMS codes in the Atlas dashboard and render <SignIn />',
  signInWithIdToken: 'native ID-token sign-in: use the Atlas native SDK (Google/Apple sign-in) for this platform',
  signInWithSSO: 'enterprise SSO: add the SSO connection in the Atlas dashboard; <SignIn /> routes users by email domain',
  signInAnonymously: 'anonymous sessions: enable anonymous users in the Atlas dashboard (anonymous sign-in)',
  signUp: 'sign-up runs on the Atlas sign-up page: render <SignUp /> (or send users to /sign-up)',
  verifyOtp: 'code verification happens inside the Atlas sign-in/up flow; remove this step',
  resend: 'resending verification codes happens inside the Atlas flow; remove this call',
  resetPasswordForEmail: 'password reset is built into the Atlas sign-in page ("Forgot password")',
  updateUser: 'profile/email/password changes: use <UserProfile /> or the user API (@atlasauth/backend users.update)',
  exchangeCodeForSession: 'OAuth/magic-link callback: Atlas completes callbacks itself; delete this route',
  refreshSession: 'Atlas refreshes sessions on its own; remove this call',
  setSession: 'Atlas manages the session cookie; remove this call',
  getClaims: 'read verified claims with auth() from @atlasauth/nextjs/server (server) or useAuth() (browser)',
  reauthenticate: 'step-up / re-verification: use useReverification() from @atlasauth/react',
  linkIdentity: 'account linking: users connect accounts from <UserProfile />',
  unlinkIdentity: 'account linking: users disconnect accounts from <UserProfile />',
  getUserIdentities: 'linked accounts: read user.externalAccounts with @atlasauth/backend',
};

/** `<expr>.auth.<method>` — returns the method name and whether it is nested (`auth.mfa.x`). */
function authMember(callee: ASTNode): { method: string; nested?: string } | null {
  const c = callee as { type?: string; computed?: boolean; property?: { type?: string; name?: string }; object?: ASTNode };
  if (c.type !== 'MemberExpression' && c.type !== 'OptionalMemberExpression') return null;
  if (c.computed || c.property?.type !== 'Identifier' || !c.property.name) return null;
  const obj = c.object as { type?: string; computed?: boolean; property?: { type?: string; name?: string }; object?: ASTNode } | undefined;
  if (!obj || (obj.type !== 'MemberExpression' && obj.type !== 'OptionalMemberExpression') || obj.computed) return null;
  if (obj.property?.type === 'Identifier' && obj.property.name === 'auth') return { method: c.property.name };
  // supabase.auth.mfa.enroll / supabase.auth.admin.createUser
  const inner = obj.object as { type?: string; property?: { type?: string; name?: string } } | undefined;
  if (
    inner &&
    (inner.type === 'MemberExpression' || inner.type === 'OptionalMemberExpression') &&
    inner.property?.type === 'Identifier' &&
    inner.property.name === 'auth' &&
    obj.property?.type === 'Identifier'
  ) {
    return { method: c.property.name, nested: obj.property.name };
  }
  return null;
}

/** A file is "supabase-ish" when it imports a supabase module or names a supabase client. */
function usesSupabase(ctx: VendorContext): boolean {
  const { j, root } = ctx;
  const sources = root.find(j.ImportDeclaration).nodes().map((n) => String(n.source.value));
  return sources.some((s) => s.startsWith('@supabase/') || /supabase/i.test(s));
}

function rewriteAuthCalls(ctx: VendorContext): void {
  const { j, root } = ctx;
  const fileIsSupabase = usesSupabase(ctx);
  root.find(j.CallExpression).forEach((path: ASTPath<CallExpression>) => {
    const member = authMember(path.node.callee);
    if (!member) return;
    // Only receivers that are plausibly a Supabase client.
    const receiverText = j(path.get('callee')).toSource();
    if (!fileIsSupabase && !/supabase/i.test(receiverText)) return;

    if (member.nested === 'admin') {
      ctx.manual(path, `auth.admin.${member.method}(): use the Atlas Backend API (@atlasauth/backend, e.g. users.${adminPeer(member.method)})`);
      return;
    }
    if (member.nested === 'mfa') {
      ctx.manual(path, `auth.mfa.${member.method}(): MFA enrolment and challenge run inside the Atlas sign-in flow and <UserProfile />`);
      return;
    }
    if (member.nested) {
      ctx.manual(path, `auth.${member.nested}.${member.method}(): no Atlas counterpart — migrate it manually`);
      return;
    }

    const peer = COMPAT[member.method];
    if (peer) {
      const side = ctx.facts.kind;
      if (member.method === 'getUser' && path.node.arguments.length > 0) {
        ctx.manual(path, 'auth.getUser(jwt) with a token: verify Atlas session tokens with AtlasBackend from @atlasauth/backend (instance JWKS)');
        return;
      }
      const name = side === 'client' ? peer.client : side === 'server' ? peer.server : undefined;
      if (!name) {
        ctx.manual(
          path,
          side === 'unknown'
            ? `auth.${member.method}(): this file could be browser or server code; use ${peer.client ?? peer.server} from ${peer.client ? '@atlasauth/react/compat (browser)' : ''}${peer.client && peer.server ? ' or ' : ''}${peer.server ? '@atlasauth/nextjs/compat (server)' : ''}`
            : `auth.${member.method}() on the server: start sign-in by redirecting to /sign-in; listen for changes in the browser`,
        );
        return;
      }
      const local = ctx.ensureImport(side === 'client' ? ATLAS.reactCompat : ATLAS.nextCompat, name);
      path.node.callee = j.identifier(local);
      ctx.rewrote();
      return;
    }
    const note = MANUAL[member.method];
    ctx.manual(path, `auth.${member.method}(): ${note ?? 'no Atlas counterpart — migrate it manually'}`);
  });
}

function adminPeer(method: string): string {
  const map: Record<string, string> = {
    createUser: 'create',
    deleteUser: 'delete',
    getUserById: 'get',
    listUsers: 'list',
    updateUserById: 'update',
    inviteUserByEmail: 'invitations.create',
    generateLink: 'signInTokens.create',
  };
  return map[method] ?? method;
}

/** middleware.ts: `return updateSession(request)` → the Atlas middleware. */
function rewriteMiddleware(ctx: VendorContext): void {
  if (!ctx.facts.isMiddleware) return;
  const { j, root } = ctx;
  root.find(j.ImportDeclaration).forEach((decl) => {
    const source = String(decl.node.source.value);
    if (!/supabase/i.test(source) || source.startsWith('@supabase/')) return;
    const specs = decl.node.specifiers ?? [];
    const spec = specs.find((s) => s.type === 'ImportSpecifier' && s.imported.name === 'updateSession');
    if (!spec) return;
    const local = spec.local?.name ?? 'updateSession';
    const calls = root.find(j.CallExpression, { callee: { type: 'Identifier', name: local } });
    if (calls.length === 0) return;
    const factory = ctx.ensureImport(ATLAS.nextCompat, 'createAtlasMiddleware');
    const hasInstance = root.find(j.VariableDeclarator, { id: { type: 'Identifier', name: 'atlasMiddleware' } }).length > 0;
    if (!hasInstance) {
      const [statement] = ctx.statements(`const atlasMiddleware = ${factory}();`);
      const imports = root.find(j.ImportDeclaration);
      imports.at(imports.length - 1).insertAfter(statement);
    }
    calls.forEach((call) => {
      call.node.callee = j.identifier('atlasMiddleware');
      call.node.arguments = call.node.arguments.slice(0, 1);
      ctx.rewrote();
    });
    decl.node.specifiers = specs.filter((s) => s !== spec);
    if (decl.node.specifiers.length === 0) j(decl).remove();
    ctx.report(
      decl,
      "middleware: Supabase's updateSession() is replaced by the Atlas middleware, which verifies the session and sends signed-out visitors on matched routes to /sign-in (pass publicRoutes to open more); delete utils/supabase/middleware once nothing else uses it",
    );
  });
}

export default vendorTransform({
  mightApply: (source) => /supabase|\.auth\.|SUPABASE_/i.test(source),
  run(ctx) {
    reportRoute(ctx, /(^|\/)auth\/(callback|confirm)\/route\.[cm]?[jt]sx?$/, 'Supabase auth callback route: Atlas completes OAuth and magic-link callbacks itself; delete this route');
    rewriteMiddleware(ctx);
    applyImportRules(ctx, RULES);
    rewriteAuthCalls(ctx);
    renameEnv(ctx, (key) =>
      key === 'SUPABASE_JWT_SECRET'
        ? { report: 'SUPABASE_JWT_SECRET: verify Atlas session tokens against the instance JWKS (ATLAS_JWKS_URL) with AtlasBackend from @atlasauth/backend' }
        : null,
    );
  },
});
