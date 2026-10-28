import type { ASTNode } from 'jscodeshift';
import {
  applyImportRules,
  applyReexportRules,
  callOf,
  dropJsxAttrs,
  fixProviderProps,
  getJsxAttr,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type FileFacts,
  type ModuleRule,
  type Target,
  type VendorContext,
} from './engine';
import { ATLAS, middlewareExport, reportRoute, rewriteAuthPaths } from './shared';

/**
 * Kinde → Atlas, across its JavaScript SDKs:
 *
 *  - `@kinde-oss/kinde-auth-nextjs`: `getKindeServerSession()`, `withAuth` (and v1's
 *    `authMiddleware`) and `handleAuth()` → the `@atlasauth/nextjs/compat` helpers
 *    (same shapes: `getUser()`, `getPermission()`, `getOrganization()`, …);
 *    `KindeProvider` → `<AtlasProvider>`; `useKindeBrowserClient()` →
 *    `useKindeBrowserClientCompat()` from `@atlasauth/react/compat`; the
 *    `LoginLink` / `RegisterLink` / `LogoutLink` components → `<SignInButton>` /
 *    `<SignUpButton>` / `<SignOutButton>` (`postLoginRedirectURL` /
 *    `postLogoutRedirectURL` → `redirectUrl`); `/api/auth/login` links → `/sign-in`;
 *    the `app/api/auth/[kindeAuth]` route is reported for deletion.
 *  - `@kinde-oss/kinde-auth-react`: `KindeProvider` → `<AtlasProvider>` (`domain` →
 *    `frontendApi`, `clientId` → `publishableKey`); `useKindeAuth()` →
 *    `useKindeAuthCompat()`.
 *  - Kinde feature flags (`getFlag`, `getBooleanFlag`, …) have no Atlas counterpart:
 *    the compat getters return the default value, and every call site is marked.
 *  - `@kinde-oss/kinde-typescript-sdk`, `@kinde-oss/kinde-node-express` and the
 *    other Kinde packages are reported, with the Atlas package to use instead.
 */

const NEXT = '@kinde-oss/kinde-auth-nextjs';

/** Kinde's link components and the Atlas button each one becomes. */
const LINKS = {
  LoginLink: { atlas: 'SignInButton', redirect: 'postLoginRedirectURL' },
  RegisterLink: { atlas: 'SignUpButton', redirect: 'postLoginRedirectURL' },
  LogoutLink: { atlas: 'SignOutButton', redirect: 'postLogoutRedirectURL' },
} as const;

/** Props the Atlas auth buttons accept (besides `redirectUrl`, mapped from Kinde's). */
const BUTTON_PROPS = ['className', 'children', 'key', 'redirectUrl'];

/**
 * `<LoginLink postLoginRedirectURL="/x">` → `<SignInButton redirectUrl="/x">`.
 * Props the button does not take (`orgCode`, `authUrlParams`, anchor props) are
 * removed and reported.
 */
function link(kind: keyof typeof LINKS): Target {
  const { atlas, redirect } = LINKS[kind];
  return {
    module: ATLAS.react,
    name: atlas,
    after: (ref, ctx) => {
      const opening = ref.parent?.node as { type?: string; attributes?: ASTNode[] } | undefined;
      if (opening?.type !== 'JSXOpeningElement') return;
      const old = getJsxAttr(opening, redirect) as unknown as { name?: { name?: string } } | undefined;
      if (old?.name && !getJsxAttr(opening, 'redirectUrl')) old.name.name = 'redirectUrl';
      const others = (opening.attributes ?? [])
        .map((a) => a as unknown as { type?: string; name?: { name?: string } })
        .filter((a) => a.type === 'JSXAttribute' && a.name?.name && !BUTTON_PROPS.includes(a.name.name))
        .map((a) => a.name!.name!);
      const dropped = dropJsxAttrs(opening, others);
      if (dropped.length > 0) {
        ctx.report(
          ref,
          `<${kind}> is now <${atlas}>: removed props it does not accept: ${dropped.join(', ')} (users choose an organization after sign-in with <OrganizationSwitcher />; sign-in options are set in the Atlas dashboard)`,
        );
      }
    },
  };
}

const PROVIDER_DROP = [
  'redirectUri',
  'logoutUri',
  'audience',
  'scope',
  'isDangerouslyUseLocalStorage',
  'onRedirectCallback',
  'callbacks',
  'useInsecureForRefreshToken',
  'sessionManager',
  'store',
  'forceChildrenRender',
  'popupOptions',
  'refreshOnFocus',
  'options',
];

const provider: Target = {
  module: ATLAS.react,
  name: 'AtlasProvider',
  after: (ref, ctx) =>
    fixProviderProps(ctx, ref, { map: { frontendApi: 'domain', publishableKey: 'clientId' }, drop: PROVIDER_DROP }),
};

const getKindeServerSession: Target = {
  module: ATLAS.nextCompat,
  name: 'getKindeServerSessionCompat',
  accept: (ref, ctx) => {
    if (ctx.facts.kind === 'client') {
      return 'getKindeServerSession() in browser code: use useKindeBrowserClientCompat() from @atlasauth/react/compat';
    }
    if ((callOf(ref)?.args.length ?? 0) >= 2) {
      return 'Pages-router getKindeServerSession(req, res): call getKindeServerSessionCompat() from an App Router server component or route handler, or verify the session token with AtlasBackend from @atlasauth/backend';
    }
    return true;
  },
};

/** Property names of an object literal or an object destructuring pattern. */
function objectKeys(node: ASTNode | null | undefined): string[] {
  const obj = node as unknown as { type?: string; properties?: Array<{ key?: { name?: string; value?: unknown } }> } | null | undefined;
  if (obj?.type !== 'ObjectExpression' && obj?.type !== 'ObjectPattern') return [];
  return (obj.properties ?? []).map((p) => String(p.key?.name ?? p.key?.value ?? ''));
}

const withAuth: Target = {
  module: ATLAS.nextCompat,
  name: 'kindeWithAuthCompat',
  after: (ref, ctx) => {
    const options = callOf(ref)?.args.find((a) => a.type === 'ObjectExpression');
    if (objectKeys(options).includes('isAuthorized')) {
      ctx.manual(
        ref,
        'withAuth isAuthorized: it now receives the Atlas session claims (permissions and org_code are filled in from Atlas); check the permission names match your Atlas roles',
      );
    }
    ctx.report(
      ref,
      'withAuth now runs the Atlas middleware: every route your config.matcher selects needs a signed-in user, except /sign-in, /sign-up and your publicPaths',
    );
  },
};

const ROUTE_MESSAGE = 'this Kinde route is no longer used (Atlas hosts sign-in, sign-out and callbacks): delete it';

const handleAuth: Target = {
  module: ATLAS.nextCompat,
  name: 'handleKindeAuthCompat',
  after: (ref, ctx) => ctx.report(ref, ROUTE_MESSAGE),
};

/** Kinde's user / permission / organization types → the compat types on the same side. */
const compatType = (name: string) => (facts: FileFacts): Target => ({
  module: facts.kind === 'client' ? ATLAS.reactCompat : ATLAS.nextCompat,
  name,
  typeOnly: true,
});

const LINK_TARGETS = { LoginLink: link('LoginLink'), RegisterLink: link('RegisterLink'), LogoutLink: link('LogoutLink') };

const NOT_MIGRATED = 'no Atlas counterpart — migrate it manually';

const OTHER_LINKS: Record<string, Target> = {
  CreateOrgLink: { manual: 'CreateOrgLink: let users create organizations with <CreateOrganization /> from @atlasauth/react' },
  PortalLink: { manual: 'PortalLink: the account page is <UserProfile /> from @atlasauth/react' },
};

const SERVER_SDK =
  'on the server verify Atlas session tokens with AtlasBackend from @atlasauth/backend (createAtlasClient for the Backend API); in the browser use @atlasauth/js';
const EXPRESS_SDK = 'use atlasMiddleware(), requireAuth() and getAuth(req) from @atlasauth/express';

const RULES: readonly ModuleRule[] = [
  {
    match: `${NEXT}/server`,
    named: {
      getKindeServerSession,
      handleAuth,
      withAuth,
      authMiddleware: withAuth,
      ...LINK_TARGETS,
      ...OTHER_LINKS,
      createKindeManagementAPIClient: {
        manual: 'createKindeManagementAPIClient(): call the Atlas Backend API with atlasClient() from @atlasauth/nextjs/server (needs ATLAS_SECRET_KEY)',
      },
    },
    otherNamed: NOT_MIGRATED,
  },
  {
    match: `${NEXT}/middleware`,
    named: { withAuth, authMiddleware: withAuth },
    default: withAuth,
    otherNamed: NOT_MIGRATED,
  },
  {
    match: `${NEXT}/components`,
    named: { ...LINK_TARGETS, ...OTHER_LINKS },
    otherNamed: NOT_MIGRATED,
  },
  {
    match: `${NEXT}/types`,
    named: {
      KindeUser: compatType('KindeCompatUser'),
      KindePermission: compatType('KindeCompatPermission'),
      KindePermissions: compatType('KindeCompatPermissions'),
      KindeOrganization: compatType('KindeCompatOrganization'),
    },
    otherNamed: NOT_MIGRATED,
  },
  {
    // The package root is the browser entry (provider, hooks, links).
    match: (s) => s === NEXT || s === `${NEXT}/client`,
    named: {
      KindeProvider: provider,
      useKindeBrowserClient: { module: ATLAS.reactCompat, name: 'useKindeBrowserClientCompat' },
      useKindeAuth: { module: ATLAS.reactCompat, name: 'useKindeBrowserClientCompat' },
      ...LINK_TARGETS,
      ...OTHER_LINKS,
    },
    otherNamed: NOT_MIGRATED,
  },
  {
    match: (s) => s === '@kinde-oss/kinde-auth-react' || s === '@kinde-oss/kinde-auth-react/components',
    named: {
      KindeProvider: provider,
      useKindeAuth: { module: ATLAS.reactCompat, name: 'useKindeAuthCompat' },
      ...LINK_TARGETS,
      ...OTHER_LINKS,
    },
    otherNamed: NOT_MIGRATED,
  },
  {
    match: '@kinde-oss/kinde-node-express',
    default: { manual: `Kinde Express SDK: ${EXPRESS_SDK}` },
    otherNamed: `Kinde Express SDK: ${EXPRESS_SDK}`,
    whole: `Kinde Express SDK: ${EXPRESS_SDK}`,
  },
  {
    match: (s) => s.startsWith('@kinde-oss/'),
    default: { manual: `Kinde SDK: ${SERVER_SDK}` },
    otherNamed: `Kinde SDK: ${SERVER_SDK}`,
    whole: `Kinde SDK: ${SERVER_SDK}`,
  },
];

/** `export { default } from '@kinde-oss/kinde-auth-nextjs/middleware'` and v1's `export { authMiddleware as default } from '…/server'`. */
function middleware(ctx: VendorContext): void {
  applyReexportRules(ctx, RULES, (path, local, exported, source) => {
    const isMiddlewareSource = source === `${NEXT}/middleware` || source === `${NEXT}/server`;
    const isMiddlewareExport = local === 'default' || local === 'withAuth' || local === 'authMiddleware';
    if (isMiddlewareSource && isMiddlewareExport && (exported === 'default' || exported === 'middleware')) {
      middlewareExport(ctx, path, exported);
      return true;
    }
    return false;
  });
}

const FLAG_GETTERS = new Set(['getFlag', 'getBooleanFlag', 'getStringFlag', 'getIntegerFlag']);

/** The session factories whose result carries the flag getters (Kinde's and the compat ones). */
const SESSION_FACTORIES = new Set([
  'getKindeServerSession',
  'useKindeBrowserClient',
  'useKindeAuth',
  'getKindeServerSessionCompat',
  'useKindeBrowserClientCompat',
  'useKindeAuthCompat',
]);

const flagMessage = (names: readonly string[]) =>
  `${names.join(', ')}: Kinde feature flags have no Atlas counterpart, so this now always returns the default value you pass; move the flag to your own flag service (or gate billing features with has({ feature }))`;

/** True for `factory()` / `await factory()` where `factory` is one of the session factories. */
function factoryCall(init: ASTNode | null | undefined): boolean {
  let node = init as unknown as { type?: string; argument?: ASTNode; callee?: { type?: string; name?: string } } | null | undefined;
  if (node?.type === 'AwaitExpression') node = node.argument as unknown as typeof node;
  return node?.type === 'CallExpression' && node.callee?.type === 'Identifier' && SESSION_FACTORIES.has(node.callee.name ?? '');
}

/**
 * Mark Kinde feature-flag reads: destructured from a session
 * (`const { getBooleanFlag } = getKindeServerSession()`) or called on one
 * (`session.getFlag(…)`). Runs before and after the rewrite alike (idempotent).
 */
function markFlags(ctx: VendorContext): void {
  const { j, root } = ctx;
  const usesKinde =
    root.find(j.ImportDeclaration).nodes().some((n) => String(n.source.value).startsWith('@kinde-oss/')) ||
    root.find(j.Identifier).nodes().some((n) => SESSION_FACTORIES.has(n.name));
  if (!usesKinde) return;
  root.find(j.VariableDeclarator).forEach((path) => {
    const node = path.node as unknown as { id?: ASTNode; init?: ASTNode | null };
    if (node.id?.type !== 'ObjectPattern' || !factoryCall(node.init)) return;
    const names = objectKeys(node.id).filter((n) => FLAG_GETTERS.has(n));
    if (names.length > 0) ctx.manual(path, flagMessage(names));
  });
  root.find(j.CallExpression).forEach((path) => {
    const callee = (path.node as unknown as { callee: { type?: string; computed?: boolean; property?: { type?: string; name?: string } } }).callee;
    if ((callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') || callee.computed) return;
    const name = callee.property?.type === 'Identifier' ? callee.property.name : undefined;
    if (name && FLAG_GETTERS.has(name)) ctx.manual(path, flagMessage([name]));
  });
}

/** Env var slots that map onto Atlas's (values must come from the Atlas dashboard). */
function envRename(style: FileFacts['envStyle']) {
  return (key: string): { to: string } | { report: string } | null => {
    const pub = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?KINDE_(DOMAIN|CLIENT_ID)$/.exec(key);
    if (pub) {
      const prefix = pub[1] ?? '';
      const suffix = pub[2] === 'DOMAIN' ? 'FRONTEND_API' : 'PUBLISHABLE_KEY';
      if (prefix) return { to: `${prefix}ATLAS_${suffix}` };
      // Server-side KINDE_DOMAIN / KINDE_CLIENT_ID.
      return pub[2] === 'DOMAIN'
        ? { to: 'ATLAS_ISSUER' }
        : { report: `KINDE_CLIENT_ID: server code identifies the instance with ATLAS_SECRET_KEY; the browser uses ${publicEnvKey(style, 'PUBLISHABLE_KEY')}` };
    }
    if (key === 'KINDE_ISSUER_URL') return { to: 'ATLAS_ISSUER' };
    const origin = 'not needed; add your app origin to the allowed origins in the Atlas dashboard';
    const backend = 'call the Atlas Backend API with ATLAS_SECRET_KEY (@atlasauth/backend) instead of a machine-to-machine app';
    const notes: Record<string, string> = {
      KINDE_CLIENT_SECRET: 'KINDE_CLIENT_SECRET: server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)',
      KINDE_M2M_CLIENT_ID: `KINDE_M2M_CLIENT_ID: ${backend}`,
      KINDE_M2M_CLIENT_SECRET: `KINDE_M2M_CLIENT_SECRET: ${backend}`,
      KINDE_SITE_URL: `KINDE_SITE_URL: ${origin}`,
      KINDE_REDIRECT_URL: `KINDE_REDIRECT_URL: ${origin}`,
      KINDE_LOGOUT_URL: `KINDE_LOGOUT_URL: ${origin}`,
      KINDE_POST_LOGIN_REDIRECT_URL:
        'KINDE_POST_LOGIN_REDIRECT_URL: pass redirectUrl to <SignInButton> (or ?redirect_url= on /sign-in), or set the after-sign-in URL in the Atlas dashboard',
      KINDE_POST_LOGOUT_REDIRECT_URL: 'KINDE_POST_LOGOUT_REDIRECT_URL: pass redirectUrl to <SignOutButton>',
      KINDE_COOKIE_DOMAIN: 'KINDE_COOKIE_DOMAIN: Atlas manages its own session cookies',
      KINDE_AUTH_API_PATH: 'KINDE_AUTH_API_PATH: not needed; Atlas hosts sign-in, sign-out and callbacks',
      KINDE_AUDIENCE:
        'KINDE_AUDIENCE: Atlas session tokens are verified with the instance JWKS; for tokens scoped to an API, register a resource server in Atlas',
      KINDE_SCOPE: 'KINDE_SCOPE: not needed with Atlas sessions',
    };
    for (const [k, note] of Object.entries(notes)) {
      if (key === k || key.endsWith(`_${k}`)) return { report: note };
    }
    return null;
  };
}

export default vendorTransform({
  mightApply: (source, path) => /@kinde-oss\/|KINDE_|\/api\/auth\//.test(source) || /\[kindeAuth\]/.test(path),
  run(ctx) {
    reportRoute(ctx, /\[kindeAuth\]/, ROUTE_MESSAGE);
    middleware(ctx);
    applyImportRules(ctx, RULES);
    markFlags(ctx);
    rewriteAuthPaths(ctx, {
      signIn: /^\/api\/auth\/login$/,
      signUp: /^\/api\/auth\/register$/,
      signOut: /^\/api\/auth\/logout$/,
      returnParams: ['post_login_redirect_url'],
    });
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});
