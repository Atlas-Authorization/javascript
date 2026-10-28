import type { ASTNode, ASTPath } from 'jscodeshift';
import {
  applyImportRules,
  applyReexportRules,
  callOf,
  fixProviderProps,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type EnvStyle,
  type FileFacts,
  type ModuleRule,
  type Target,
  type VendorContext,
} from './engine';
import { ATLAS, middlewareExport } from './shared';

/**
 * WorkOS (AuthKit) → Atlas, across its JavaScript SDKs:
 *
 *  - `@workos-inc/authkit-nextjs` and `@workos-inc/authkit-react`:
 *    `AuthKitProvider` → `<AtlasProvider>` (WorkOS-only props removed and reported);
 *    `authkitMiddleware()` / `authkitProxy()` → `createAtlasMiddleware()` from
 *    `@atlasauth/nextjs/compat`: `middlewareAuth.enabled` + `unauthenticatedPaths`
 *    become `publicRoutes` (AuthKit's middleware does not protect pages unless
 *    `middlewareAuth.enabled` is true, so without it every route stays public, as before).
 *  - Everything else is reported with the Atlas call to use: `withAuth()` →
 *    `auth()` / `currentUser()` from `@atlasauth/nextjs/server`, `useAuth()` →
 *    `useAuth()` / `useUser()` from `@atlasauth/react`, `getSignInUrl()` → the
 *    `/sign-in` page, `signOut()` → `<SignOutButton />`, `handleAuth()` → delete the
 *    callback route (Atlas hosts the callback), `@workos-inc/node` → the Atlas Backend API.
 *  - `WORKOS_*` env vars are renamed or reported.
 */

const PROVIDER_DROP = [
  'clientId',
  'apiHostname',
  'redirectUri',
  'devMode',
  'https',
  'port',
  'onRedirectCallback',
  'onRefresh',
  'onRefreshFailure',
  'refreshBufferInterval',
  'initialAuth',
  'onSessionExpired',
];

const provider: Target = {
  module: ATLAS.react,
  name: 'AtlasProvider',
  after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: PROVIDER_DROP }),
};

// ---- middleware: authkitMiddleware({...}) → createAtlasMiddleware({...}) ------------

type Prop = {
  type: string;
  key?: { type?: string; name?: string; value?: unknown };
  computed?: boolean;
  value?: ASTNode;
};

function propName(prop: Prop): string | undefined {
  if ((prop.type !== 'ObjectProperty' && prop.type !== 'Property') || prop.computed) return undefined;
  if (prop.key?.type === 'Identifier') return prop.key.name;
  if ((prop.key?.type === 'StringLiteral' || prop.key?.type === 'Literal') && typeof prop.key.value === 'string') return prop.key.value;
  return undefined;
}

const MIDDLEWARE_IGNORED = ['redirectUri', 'signUpPaths', 'debug', 'eagerAuth'];
const MIDDLEWARE_BY_HAND =
  'pass { publicRoutes, protectedRoutes, signInUrl } to createAtlasMiddleware() from @atlasauth/nextjs/compat (patterns are exact paths, or end in (.*))';

/** An AuthKit path (exact, or ending in `/*`) as an Atlas pattern; null when the matchers could disagree. */
function atlasRoute(route: string): string | null {
  if (/[()[\]{}?+^$|\\:]/.test(route)) return null;
  const star = route.indexOf('*');
  if (star === -1) return route;
  return star === route.length - 1 ? `${route.slice(0, -1)}(.*)` : null;
}

interface ParsedAuth {
  enabled: boolean;
  paths: string[];
  /** Options with no Atlas counterpart that were removed. */
  ignored: string[];
}

/** `middlewareAuth: { enabled, unauthenticatedPaths }` when it is plain literals, else a reason it is not. */
function parseMiddlewareAuth(value: ASTNode | undefined): ParsedAuth | string {
  const obj = value as { type?: string; properties?: Prop[] } | undefined;
  if (obj?.type !== 'ObjectExpression') return `authkitMiddleware middlewareAuth built elsewhere: ${MIDDLEWARE_BY_HAND}`;
  let enabled = false;
  const paths: string[] = [];
  for (const prop of obj.properties ?? []) {
    const name = propName(prop);
    const v = prop.value as { type?: string; value?: unknown; elements?: Array<{ type?: string; value?: unknown } | null> } | undefined;
    if (name === 'enabled') {
      if ((v?.type !== 'BooleanLiteral' && v?.type !== 'Literal') || typeof v.value !== 'boolean') {
        return `authkitMiddleware middlewareAuth.enabled is not a plain true/false: ${MIDDLEWARE_BY_HAND}`;
      }
      enabled = v.value;
    } else if (name === 'unauthenticatedPaths') {
      if (v?.type !== 'ArrayExpression' || !v.elements) return `authkitMiddleware unauthenticatedPaths is not a plain list: ${MIDDLEWARE_BY_HAND}`;
      for (const el of v.elements) {
        const to = el && (el.type === 'StringLiteral' || el.type === 'Literal') && typeof el.value === 'string' ? atlasRoute(el.value) : null;
        if (to === null) return `authkitMiddleware unauthenticatedPaths: only plain paths (optionally ending in /*) convert; ${MIDDLEWARE_BY_HAND}`;
        paths.push(to);
      }
    } else {
      return `authkitMiddleware middlewareAuth option '${name ?? '…'}' has no Atlas counterpart: ${MIDDLEWARE_BY_HAND}`;
    }
  }
  return { enabled, paths, ignored: [] };
}

function parseMiddleware(ref: ASTPath): ParsedAuth | string {
  const call = callOf(ref);
  if (!call) return 'authkitMiddleware is not called here: export default createAtlasMiddleware() from @atlasauth/nextjs/compat instead';
  if (call.args.length === 0) return { enabled: false, paths: [], ignored: [] };
  const options = call.args[0] as { type?: string; properties?: Prop[] };
  if (call.args.length > 1 || options.type !== 'ObjectExpression') return `authkitMiddleware(options) with options built elsewhere: ${MIDDLEWARE_BY_HAND}`;
  let auth: ParsedAuth = { enabled: false, paths: [], ignored: [] };
  const ignored: string[] = [];
  for (const prop of options.properties ?? []) {
    const name = propName(prop);
    if (!name) return `authkitMiddleware({ ... }) with spread or computed options: ${MIDDLEWARE_BY_HAND}`;
    if (name === 'middlewareAuth') {
      const parsed = parseMiddlewareAuth(prop.value);
      if (typeof parsed === 'string') return parsed;
      auth = parsed;
    } else if (MIDDLEWARE_IGNORED.includes(name)) {
      ignored.push(name);
    } else {
      return `authkitMiddleware option '${name}' has no Atlas counterpart: ${MIDDLEWARE_BY_HAND}`;
    }
  }
  return { ...auth, ignored };
}

const middlewareTarget: Target = {
  module: ATLAS.nextCompat,
  name: 'createAtlasMiddleware',
  accept: (ref) => {
    const parsed = parseMiddleware(ref);
    return typeof parsed === 'string' ? parsed : true;
  },
  after: (ref, ctx) => {
    const call = callOf(ref);
    const parsed = parseMiddleware(ref);
    if (!call || typeof parsed === 'string') return;
    const node = call.path.node as { arguments: ASTNode[] };
    // Without middlewareAuth.enabled AuthKit protected nothing: keep every route public.
    const routes = parsed.enabled ? parsed.paths : ['/(.*)'];
    node.arguments = routes.length > 0 ? [ctx.expr(`{ publicRoutes: [${routes.map((r) => `'${r}'`).join(', ')}] }`)] : [];
    if (parsed.ignored.length > 0) {
      ctx.report(ref, `removed authkitMiddleware options with no Atlas counterpart: ${parsed.ignored.join(', ')} (the Atlas middleware reads ATLAS_ISSUER, ATLAS_JWKS_URL and ATLAS_PUBLISHABLE_KEY from the environment)`);
    }
    ctx.report(
      ref,
      parsed.enabled
        ? 'middleware now runs Atlas: every route your config.matcher selects needs a signed-in user, except /sign-in, /sign-up and your publicRoutes'
        : 'authkitMiddleware did not protect pages (middlewareAuth was not enabled): every route stays public through publicRoutes: [\'/(.*)\']; list protectedRoutes instead to require sign-in',
    );
  },
};

// ---- rules ----------------------------------------------------------------------------

const MANAGEMENT =
  'manage users, organizations, roles and SSO with the Atlas Backend API (createAtlasClient() from @atlasauth/backend, or atlasClient() from @atlasauth/nextjs/server) and ATLAS_SECRET_KEY';
const NOT_MIGRATED = 'no Atlas counterpart — migrate it manually';

const ROUTE_MESSAGE = 'handleAuth(): this callback route is no longer used (Atlas hosts sign-in and the callback): delete it';

const SERVER: Record<string, Target> = {
  withAuth: {
    manual:
      "withAuth(): read the session with auth() or currentUser() from @atlasauth/nextjs/server (userId, orgId, orgRole; ensureSignedIn becomes a redirect('/sign-in') when userId is null)",
  },
  getSignInUrl: { manual: "getSignInUrl(): link to the Atlas '/sign-in' page (add ?redirect_url= to come back)" },
  getSignUpUrl: { manual: "getSignUpUrl(): link to the Atlas '/sign-up' page (add ?redirect_url= to come back)" },
  signOut: { manual: 'signOut(): use <SignOutButton /> or useAuth().signOut() from @atlasauth/react' },
  handleAuth: { manual: ROUTE_MESSAGE },
  refreshSession: { manual: 'refreshSession(): Atlas refreshes the session itself; use useAuth().getToken() for a fresh token' },
  saveSession: { manual: 'saveSession(): Atlas manages its own session cookie' },
  switchToOrganization: { manual: 'switchToOrganization(): use useOrganizationList().setActive or <OrganizationSwitcher /> from @atlasauth/react' },
  getWorkOS: { manual: `getWorkOS(): ${MANAGEMENT}` },
  getTokenClaims: { manual: 'getTokenClaims(): the verified claims are on auth().claims from @atlasauth/nextjs/server' },
  validateApiKey: { manual: 'validateApiKey(): issue and verify API keys with the Atlas API keys feature (AtlasBackend.verify with an API key)' },
};

const CLIENT: Record<string, Target> = {
  AuthKitProvider: provider,
  useAuth: {
    manual:
      'useAuth() from AuthKit: use useAuth() / useUser() from @atlasauth/react (user → useUser().user, organizationId → useAuth().orgId, role → useAuth().orgRole, signOut → useAuth().signOut, getAccessToken → useAuth().getToken)',
  },
  useAccessToken: { manual: 'useAccessToken(): use useAuth().getToken() from @atlasauth/react' },
  useTokenClaims: { manual: 'useTokenClaims(): the session claims are on useAuth().claims from @atlasauth/react' },
  Impersonation: { manual: 'Impersonation banner: Atlas shows its own impersonation banner inside <AtlasProvider>' },
  useRecentAuth: { manual: 'useRecentAuth(): use useReverification() from @atlasauth/react' },
};

const RULES: readonly ModuleRule[] = [
  {
    match: '@workos-inc/authkit-nextjs/components',
    named: CLIENT,
    otherNamed: NOT_MIGRATED,
  },
  {
    match: (s) => s === '@workos-inc/authkit-nextjs' || s === '@workos-inc/authkit-react',
    named: {
      authkitMiddleware: middlewareTarget,
      authkitProxy: middlewareTarget,
      authkit: { manual: 'authkit(request): custom middleware around AuthKit; compose createAtlasMiddleware() from @atlasauth/nextjs/compat or read auth() in the route' },
      ...SERVER,
      ...CLIENT,
    },
    otherNamed: NOT_MIGRATED,
  },
  {
    match: (s) => /^@workos-inc\/authkit-(remix|react-router|sveltekit|tanstack-react-start|nuxt)(\/|$)/.test(s),
    default: { manual: 'AuthKit SDK: use the Atlas SDK for your framework (@atlasauth/react, @atlasauth/remix, @atlasauth/sveltekit … see the Atlas docs)' },
    otherNamed: 'AuthKit SDK: use the Atlas SDK for your framework',
    whole: 'AuthKit SDK: use the Atlas SDK for your framework',
  },
  {
    match: '@workos-inc/node',
    default: { manual: `WorkOS client: ${MANAGEMENT}; each call is marked where it is used` },
    named: { WorkOS: { manual: `WorkOS client: ${MANAGEMENT}; each call is marked where it is used` } },
    otherNamed: `no Atlas counterpart; ${MANAGEMENT}`,
    whole: `WorkOS Node SDK: ${MANAGEMENT}`,
  },
  {
    match: (s) => s.startsWith('@workos-inc/'),
    default: { manual: NOT_MIGRATED },
    otherNamed: NOT_MIGRATED,
    whole: NOT_MIGRATED,
  },
];

/** `export { authkitMiddleware as default } from '@workos-inc/authkit-nextjs'`. */
function middleware(ctx: VendorContext): void {
  applyReexportRules(ctx, RULES, (path, local, exported, source) => {
    if (source === '@workos-inc/authkit-nextjs' && (local === 'authkitMiddleware' || local === 'authkitProxy') && (exported === 'default' || exported === 'middleware' || exported === 'proxy')) {
      middlewareExport(ctx, path, exported);
      return true;
    }
    return false;
  });
}

/** What replaces each WorkOS `.env` key (also used for `process.env.X` in code). */
export function env(key: string, style: EnvStyle): string | null {
  const m = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?WORKOS_(.+)$/.exec(key);
  if (!m) return null;
  const name = m[2]!;
  if (name === 'CLIENT_ID') {
    return m[1]
      ? `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`
      : 'remove once the zero-logout bridge is retired (the bridge needs it until then); the browser uses the Atlas publishable key';
  }
  if (name === 'API_KEY') return 'replace with ATLAS_SECRET_KEY (keep the WorkOS key until your export and the lazy-migration step are done)';
  if (name === 'COOKIE_PASSWORD') return 'remove once the zero-logout bridge is retired (workosSessionTokenExtractor reads it until then)';
  if (name === 'REDIRECT_URI') return 'remove; Atlas hosts the callback, add your app origin to the allowed origins in the Atlas dashboard';
  if (name === 'WEBHOOK_SECRET') return 'replace with the signing secret of an Atlas webhook endpoint';
  return 'remove (not needed with Atlas)';
}

function envRename(style: FileFacts['envStyle']) {
  return (key: string): { to: string } | { report: string } | null => {
    const note = env(key, style);
    if (note === null) return null;
    if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)WORKOS_CLIENT_ID$/.test(key)) return { to: publicEnvKey(style, 'PUBLISHABLE_KEY') };
    return { report: `${key}: ${note}` };
  };
}

export default vendorTransform({
  mightApply: (source) => /@workos-inc\/|WORKOS_/.test(source),
  run(ctx) {
    middleware(ctx);
    applyImportRules(ctx, RULES);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});
