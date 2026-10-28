import type { ASTPath } from 'jscodeshift';
import {
  applyImportRules,
  applyReexportRules,
  callOf,
  fixProviderProps,
  renameEnv,
  vendorTransform,
  type ImportTarget,
  type ModuleRule,
  type VendorContext,
} from './engine';
import { ATLAS, middlewareExport, reportRoute, rewriteAuthPaths } from './shared';

/**
 * Auth.js / NextAuth (v4 `next-auth`, v5 `next-auth` + `auth.ts`, `@auth/*`) → Atlas.
 *
 *  - `next-auth/react`: `SessionProvider` → `<AtlasProvider>`; `useSession`,
 *    `signIn`, `signOut`, `getSession` → the `@atlasauth/react` compat helpers
 *    that keep next-auth's shapes.
 *  - `next-auth`: `getServerSession` → `getServerSessionCompat`; `NextAuth(config)`
 *    → `nextAuthCompat(config)` (v5 `handlers/auth/signIn/signOut` destructuring
 *    and the v4 route handler both keep working).
 *  - `next-auth/middleware`: `withAuth` / the default export → `createAtlasMiddleware()`;
 *    a v5 `export { auth as middleware } from '@/auth'` too.
 *  - `next-auth/jwt` `await getToken({ req })` in App Router server code →
 *    `(await auth()).claims` (the verified claims, or null);
 *  - providers, adapters, the other JWT helpers and the auth config: reported for a human.
 */

const PROVIDER_DROP = ['session', 'basePath', 'baseUrl', 'refetchInterval', 'refetchOnWindowFocus', 'refetchWhenOffline'];

const ADAPTER_NOTE =
  'database adapter: Atlas stores users and sessions now; remove the adapter from the Auth.js config and move existing users with `atlas import --from authjs`';

const GET_TOKEN_NOTE =
  'getToken(): in an App Router server component or route handler use (await auth()).claims from @atlasauth/nextjs/server (sub is the user id); elsewhere verify the Atlas session token with new AtlasBackend({ jwksUrl, issuer }).authenticateRequest(req) from @atlasauth/backend';

const GET_TOKEN_REPORT =
  'getToken() is now (await auth()).claims from @atlasauth/nextjs/server: the verified Atlas session claims or null (sub is the Atlas user id; email and name are present only when enabled as session claims)';

const pagesRouterCall = (ref: ASTPath): true | string => {
  const call = callOf(ref);
  if (call && call.args.length >= 2) {
    return 'Pages-router getServerSession(req, res, …): call getServerSessionCompat() from an App Router server component or route handler, or verify the session token with AtlasBackend from @atlasauth/backend';
  }
  return true;
};

const configNote = (ref: ASTPath, ctx: VendorContext) => {
  const call = callOf(ref);
  if (call && call.args.length > 0) {
    ctx.report(
      ref,
      'the config passed to NextAuth() is now ignored: enable its providers in the Atlas dashboard, port callbacks to Atlas Actions, then delete it (and uninstall next-auth)',
    );
  }
};

const getServerSession = {
  module: ATLAS.nextCompat,
  name: 'getServerSessionCompat',
  accept: pagesRouterCall,
} as const;

/**
 * `next-auth/jwt` `getToken({ req })` → `(await auth()).claims`: the verified
 * Atlas session claims, or null when signed out (`sub` is the user id). Only in
 * App Router server code, where `auth()` reads the request itself; a raw token,
 * middleware or the Pages router is reported.
 */
const getToken: ImportTarget = {
  module: ATLAS.nextServer,
  name: 'auth',
  noReexport: GET_TOKEN_NOTE,
  accept: (ref, ctx) => {
    const call = callOf(ref);
    const parent = call?.path.parent?.node as { type?: string } | undefined;
    if (!call || parent?.type !== 'AwaitExpression' || call.args.length > 1) return GET_TOKEN_NOTE;
    if (ctx.facts.isMiddleware) {
      return 'getToken() in middleware: createAtlasMiddleware() from @atlasauth/nextjs/compat verifies the session there; read the claims in the page or route with auth() from @atlasauth/nextjs/server';
    }
    if (ctx.facts.kind !== 'server' || !/(^|\/)(src\/)?app\//.test(ctx.facts.path)) return GET_TOKEN_NOTE;
    const options = call.args[0] as { type?: string; properties?: Array<{ key?: { name?: string; value?: unknown } }> } | undefined;
    if (options && options.type !== 'ObjectExpression') return GET_TOKEN_NOTE;
    if ((options?.properties ?? []).some((p) => p.key?.name === 'raw' || p.key?.value === 'raw')) return GET_TOKEN_NOTE;
    return true;
  },
  after: (ref, ctx) => {
    const call = callOf(ref);
    const awaited = call?.path.parent as ASTPath | undefined;
    if (!call || !awaited) return;
    const { j } = ctx;
    const local = (ref.node as { name: string }).name;
    ctx.report(call.path, GET_TOKEN_REPORT);
    awaited.replace(j.memberExpression(j.awaitExpression(j.callExpression(j.identifier(local), [])), j.identifier('claims')));
  },
};

const nextAuthDefault = { module: ATLAS.nextCompat, name: 'nextAuthCompat', after: configNote } as const;

const authConfigType = {
  manual: 'auth config type: delete it with the config once providers are enabled in the Atlas dashboard',
} as const;

const RULES: readonly ModuleRule[] = [
  {
    match: 'next-auth/react',
    named: {
      SessionProvider: {
        module: ATLAS.react,
        name: 'AtlasProvider',
        after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: PROVIDER_DROP }),
      },
      useSession: {
        module: ATLAS.reactCompat,
        name: 'useNextAuthSession',
        after: (ref, ctx) => {
          const call = callOf(ref);
          if (call && call.args.length > 0) {
            ctx.report(
              ref,
              'useSession({ required, onUnauthenticated }) options are not enforced by useNextAuthSession(): protect the route in middleware or wrap the page in <SignedIn>/<RedirectToSignIn>',
            );
          }
        },
      },
      signIn: {
        module: ATLAS.reactCompat,
        name: 'nextAuthSignIn',
        after: (ref, ctx) => {
          const first = callOf(ref)?.args[0] as { type?: string; value?: unknown } | undefined;
          if (first && (first.type === 'StringLiteral' || first.type === 'Literal') && first.value === 'credentials') {
            ctx.report(ref, "signIn('credentials', …): credentials are collected on the Atlas sign-in page now; remove your own password form");
          }
        },
      },
      signOut: { module: ATLAS.reactCompat, name: 'nextAuthSignOut' },
      getSession: {
        module: ATLAS.reactCompat,
        name: 'getNextAuthSession',
        accept: (ref, ctx) => {
          const call = callOf(ref);
          if (ctx.facts.kind === 'server' || (call && call.args.length > 0)) {
            return 'getSession() on the server: use getServerSessionCompat() from @atlasauth/nextjs/compat in an App Router server component';
          }
          return true;
        },
      },
      getCsrfToken: { manual: 'getCsrfToken(): Atlas protects its own forms; remove the CSRF plumbing' },
      getProviders: { manual: 'getProviders(): the Atlas sign-in page lists every enabled method; render <SignIn /> instead' },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: (s) => s === 'next-auth' || s === 'next-auth/next',
    default: nextAuthDefault,
    named: {
      getServerSession,
      unstable_getServerSession: getServerSession,
      Session: { module: ATLAS.nextCompat, name: 'NextAuthServerSession', typeOnly: true },
      NextAuthOptions: authConfigType,
      AuthOptions: authConfigType,
      NextAuthConfig: authConfigType,
      User: { manual: "next-auth's User type: use NextAuthServerSession['user'] from @atlasauth/nextjs/compat" },
      DefaultSession: {
        manual: 'module augmentation of next-auth types: add custom fields to the Atlas session token (JWT templates / Actions) and read them from auth().claims',
      },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: 'next-auth/middleware',
    default: { module: ATLAS.nextCompat, name: 'createAtlasMiddleware', accept: withAuthAccept, after: withAuthAfter },
    named: {
      withAuth: { module: ATLAS.nextCompat, name: 'createAtlasMiddleware', accept: withAuthAccept, after: withAuthAfter },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: 'next-auth/jwt',
    named: { getToken },
    otherNamed:
      'Auth.js JWT helpers: read the verified session with auth() from @atlasauth/nextjs/server (its claims), or verify a bearer token with AtlasBackend from @atlasauth/backend',
  },
  {
    match: (s) => s === 'next-auth/adapters' || /^@(auth|next-auth)\/[a-z0-9-]+-adapter$/.test(s),
    otherNamed: ADAPTER_NOTE,
    default: { manual: ADAPTER_NOTE },
  },
  {
    match: (s) =>
      s.startsWith('next-auth/providers') ||
      s.startsWith('next-auth/adapters') ||
      s.startsWith('@next-auth/') ||
      s.startsWith('@auth/core/providers'),
    otherNamed:
      'provider/adapter config: enable this sign-in provider in the Atlas dashboard; move existing users with `atlas import --from authjs`',
    default: {
      manual:
        'provider/adapter config: enable this sign-in provider in the Atlas dashboard; move existing users with `atlas import --from authjs`',
    },
  },
  {
    match: (s) => s.startsWith('@auth/') || s.startsWith('next-auth/'),
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
];

function withAuthAccept(ref: ASTPath): true | string {
  const call = callOf(ref);
  if (call && call.args.length > 0) {
    return 'middleware with custom auth logic: Atlas middleware protects every matched route; move the authorized()/callback checks into the page (auth().has(…)) or Atlas Actions';
  }
  return true;
}

/** `export default withAuth` (no call) → `export default createAtlasMiddleware()`. */
function withAuthAfter(ref: ASTPath, ctx: VendorContext): void {
  if (callOf(ref)) return;
  const parent = ref.parent?.node as { type?: string; declaration?: unknown } | undefined;
  if (parent?.type === 'ExportDefaultDeclaration' && parent.declaration === ref.node) {
    parent.declaration = ctx.j.callExpression(ctx.j.identifier((ref.node as { name: string }).name), []);
  }
}

const ENV_NOTE: Record<string, string> = {
  NEXTAUTH_SECRET: 'NEXTAUTH_SECRET: Atlas signs sessions itself; server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)',
  AUTH_SECRET: 'AUTH_SECRET: Atlas signs sessions itself; server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)',
  NEXTAUTH_URL: 'NEXTAUTH_URL: not needed with Atlas; set NEXT_PUBLIC_ATLAS_FRONTEND_API instead',
  AUTH_URL: 'AUTH_URL: not needed with Atlas; set NEXT_PUBLIC_ATLAS_FRONTEND_API instead',
};

export default vendorTransform({
  mightApply: (source, path) => /next-auth|@auth\/|NEXTAUTH_|AUTH_SECRET|AUTH_URL/.test(source) || /\[\.\.\.nextauth\]/.test(path) || /(^|\/)(middleware|proxy)\.[cm]?[jt]sx?$/.test(path),
  run(ctx) {
    reportRoute(ctx, /\[\.\.\.nextauth\]/, 'this Auth.js route is no longer used (Atlas hosts sign-in, sign-out and callbacks): delete it');
    applyReexportRules(ctx, RULES, (path, local, exported, source) => {
      if (source === 'next-auth/middleware' && local === 'default' && exported === 'default') {
        middlewareExport(ctx, path, 'default');
        return true;
      }
      return false;
    });
    // v5: `export { auth as middleware } from '@/auth'` in middleware.ts.
    if (ctx.facts.isMiddleware) {
      applyReexportRules(
        ctx,
        [{ match: (s) => /(^|\/)auth$/.test(s) && !s.startsWith('next-auth'), keepOthers: true }],
        (path, local, exported) => {
          if (local === 'auth' && (exported === 'middleware' || exported === 'default' || exported === 'proxy')) {
            middlewareExport(ctx, path, exported === 'default' ? 'default' : exported);
            return true;
          }
          return false;
        },
      );
      // v5: `import { auth } from '@/auth'; export default auth` in middleware.ts.
      applyImportRules(ctx, [
        {
          match: (s) => /(^|\/)auth$/.test(s) && !s.startsWith('next-auth'),
          named: {
            auth: { module: ATLAS.nextCompat, name: 'createAtlasMiddleware', accept: withAuthAccept, after: withAuthAfter },
          },
          keepOthers: true,
        },
      ]);
    }
    applyImportRules(ctx, RULES);
    rewriteAuthPaths(ctx, {
      signIn: /^\/api\/auth\/signin(\/[a-z0-9-]+)?$/,
      signOut: /^\/api\/auth\/signout$/,
      returnParams: ['callbackUrl'],
    });
    renameEnv(ctx, (key) => {
      if (ENV_NOTE[key]) return { report: ENV_NOTE[key]! };
      if (/^AUTH_[A-Z0-9]+_(ID|SECRET|ISSUER)$/.test(key)) {
        return { report: `${key}: provider credentials now live in the Atlas dashboard (Social connections)` };
      }
      return null;
    });
  },
});
