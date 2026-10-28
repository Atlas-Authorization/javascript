import {
  applyImportRules,
  fixProviderProps,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type EnvStyle,
  type FileFacts,
  type ModuleRule,
  type Target,
} from './engine';
import { ATLAS } from './shared';

/**
 * Frontegg → Atlas, across its JavaScript SDKs (`@frontegg/react`,
 * `@frontegg/react-hooks`, `@frontegg/nextjs`, `@frontegg/js`,
 * `@frontegg/client`, `@frontegg/rest-api`):
 *
 *  - `FronteggProvider` / `FronteggAppProvider` → `<AtlasProvider>` (Frontegg-only
 *    props removed and reported).
 *  - Everything else is reported with the Atlas call to use: `useAuth()` /
 *    `useAuthUser()` → `useAuth()` / `useUser()` from `@atlasauth/react`,
 *    `useLoginWithRedirect()` → the `/sign-in` page, `useLogout()` →
 *    `<SignOutButton />`, `AdminPortal` → `<UserProfile />` /
 *    `<OrganizationProfile />`, `getSession()` / `withSSRSession()` /
 *    `FronteggMiddleware` → `auth()` and `createAtlasMiddleware()`,
 *    `@frontegg/client` / `@frontegg/rest-api` → the Atlas Backend API.
 *  - `FRONTEGG_*` env vars are renamed or reported.
 */

const PROVIDER_DROP = [
  'contextOptions',
  'authOptions',
  'hostedLoginBox',
  'themeOptions',
  'customLoginOptions',
  'entitlementsOptions',
  'headerImage',
  'backgroundImage',
  'plugins',
  'basename',
  'shadowDom',
  'options',
  'app',
  'alwaysVisibleAuthRoutes',
];

const provider: Target = {
  module: ATLAS.react,
  name: 'AtlasProvider',
  after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: PROVIDER_DROP }),
};

const MANAGEMENT =
  'manage users, tenants, roles and SSO with the Atlas Backend API (createAtlasClient() from @atlasauth/backend, or atlasClient() from @atlasauth/nextjs/server) and ATLAS_SECRET_KEY';
const NOT_MIGRATED = 'no Atlas counterpart — migrate it manually';

const HOOK = 'use useAuth() / useUser() from @atlasauth/react (user → useUser().user, isAuthenticated → useAuth().isSignedIn, tenantId → useAuth().orgId, roles → useAuth().orgRole)';
const SIGN_IN = "link to the Atlas '/sign-in' page (add ?redirect_url= to come back), or render <SignIn /> from @atlasauth/react";
const SIGN_OUT = 'use <SignOutButton /> or useAuth().signOut() from @atlasauth/react';
const PROFILE = 'render <UserProfile /> and <OrganizationProfile /> from @atlasauth/react (Atlas has no hosted admin portal)';
const SESSION = 'read the session with auth() or currentUser() from @atlasauth/nextjs/server (userId, orgId, orgRole; redirect(\'/sign-in\') when userId is null)';
const MIDDLEWARE = 'compose createAtlasMiddleware() from @atlasauth/nextjs/compat (pass { publicRoutes, protectedRoutes }); Frontegg\'s middleware also served its own /api/frontegg routes, which Atlas does not need';

const HOOKS: Record<string, Target> = {
  useAuth: { manual: `useAuth() from Frontegg: ${HOOK}` },
  useAuthUser: { manual: `useAuthUser(): ${HOOK}` },
  useAuthUserOrNull: { manual: `useAuthUserOrNull(): ${HOOK}` },
  useIsAuthenticated: { manual: 'useIsAuthenticated(): use useAuth().isSignedIn from @atlasauth/react' },
  useLoginWithRedirect: { manual: `useLoginWithRedirect(): ${SIGN_IN}` },
  useLogout: { manual: `useLogout(): ${SIGN_OUT}` },
  useAuthActions: { manual: 'useAuthActions(): use useAuth() / useSignIn() / useSignUp() from @atlasauth/react' },
  useLoginActions: { manual: 'useLoginActions(): use useSignIn() from @atlasauth/react' },
  useAuthRoutes: { manual: 'useAuthRoutes(): Atlas hosts /sign-in and /sign-up; link to them' },
  useOnRedirectTo: { manual: 'useOnRedirectTo(): pass redirect_url to the Atlas sign-in page instead' },
  useTenantsState: { manual: 'useTenantsState(): use useOrganization() / useOrganizationList() from @atlasauth/react' },
  useTenants: { manual: 'useTenants(): use useOrganizationList() from @atlasauth/react' },
  useEntitlements: { manual: 'useEntitlements(): Atlas has no plan entitlements; check organization roles and permissions with useAuth().has({ permission })' },
  useFeatureEntitlements: { manual: 'useFeatureEntitlements(): Atlas has no plan entitlements; check organization roles and permissions with useAuth().has({ permission })' },
  usePermissionEntitlements: { manual: 'usePermissionEntitlements(): check permissions with useAuth().has({ permission }) from @atlasauth/react' },
  AdminPortal: { manual: `AdminPortal: ${PROFILE}` },
  ProtectedRoute: { manual: 'ProtectedRoute: wrap the page in <SignedIn> / <SignedOut> from @atlasauth/react, or protect the route in createAtlasMiddleware()' },
  FronteggProvider: provider,
  FronteggAppProvider: provider,
};

const SERVER: Record<string, Target> = {
  getSession: { manual: `getSession(): ${SESSION}` },
  getServerSession: { manual: `getServerSession(): ${SESSION}` },
  withSSRSession: { manual: `withSSRSession(): ${SESSION}` },
  withFronteggApp: { manual: 'withFronteggApp(): wrap pages/_app with <AtlasProvider> from @atlasauth/react' },
  FronteggRouter: { manual: 'FronteggRouter: delete the catch-all route (Atlas hosts sign-in and the callback)' },
  FronteggMiddleware: { manual: `FronteggMiddleware: ${MIDDLEWARE}` },
  FronteggAppMiddleware: { manual: `FronteggAppMiddleware: ${MIDDLEWARE}` },
  fronteggMiddleware: { manual: `fronteggMiddleware: ${MIDDLEWARE}` },
  handleSessionOnEdge: { manual: `handleSessionOnEdge(): ${SESSION}` },
  getAppUserSession: { manual: `getAppUserSession(): ${SESSION}` },
  getTokensFromCookie: { manual: 'getTokensFromCookie(): Atlas manages its own session cookie; read the verified claims with auth().claims' },
};

const RULES: readonly ModuleRule[] = [
  {
    match: (s) => s === '@frontegg/react' || s === '@frontegg/react-hooks' || s === '@frontegg/nextjs' || s.startsWith('@frontegg/nextjs/') || s === '@frontegg/react-native',
    named: { ...HOOKS, ...SERVER },
    otherNamed: NOT_MIGRATED,
  },
  {
    match: (s) => s === '@frontegg/js' || s === '@frontegg/types',
    default: { manual: `Frontegg JS SDK: render <SignIn /> from @atlasauth/react or use @atlasauth/js; ${NOT_MIGRATED}` },
    otherNamed: `Frontegg JS SDK: use @atlasauth/js (createAtlas) or @atlasauth/react; ${NOT_MIGRATED}`,
    whole: 'Frontegg JS SDK: use @atlasauth/js (createAtlas) or @atlasauth/react',
  },
  {
    match: (s) => s === '@frontegg/client' || s === '@frontegg/rest-api' || s === '@frontegg/node',
    default: { manual: `Frontegg server client: ${MANAGEMENT}; each call is marked where it is used` },
    named: {
      FronteggContext: { manual: `FronteggContext: ${MANAGEMENT}` },
      FronteggClient: { manual: `FronteggClient: verify Atlas session tokens with AtlasBackend from @atlasauth/backend; ${MANAGEMENT}` },
      withAuthentication: { manual: 'withAuthentication(): verify the request with the Atlas middleware for your framework (requireAuth from @atlasauth/express or AtlasBackend.verify from @atlasauth/backend)' },
    },
    otherNamed: `no Atlas counterpart; ${MANAGEMENT}`,
    whole: `Frontegg server SDK: ${MANAGEMENT}`,
  },
  {
    match: (s) => s.startsWith('@frontegg/'),
    default: { manual: NOT_MIGRATED },
    otherNamed: NOT_MIGRATED,
    whole: NOT_MIGRATED,
  },
];

/** What replaces each Frontegg `.env` key (also used for `process.env.X` in code). */
export function env(key: string, style: EnvStyle): string | null {
  const m = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?FRONTEGG_(.+)$/.exec(key);
  if (!m) return null;
  const name = m[2]!;
  if (name === 'CLIENT_ID') {
    return m[1]
      ? `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`
      : 'remove once the zero-logout bridge and lazy migration are retired (the lazy preset needs it until then); the browser uses the Atlas publishable key';
  }
  if (name === 'CLIENT_SECRET' || name === 'API_KEY') return 'replace with ATLAS_SECRET_KEY (keep the Frontegg key until your export and the lazy-migration step are done)';
  if (name === 'BASE_URL') return 'keep only as the base_url of the frontegg bridge preset, then remove';
  if (name === 'ENCRYPTION_PASSWORD') return 'remove once the zero-logout bridge is retired (the Frontegg session cookie is read with it until then)';
  if (name === 'APP_URL') return 'remove; Atlas hosts sign-in and the callback, add your app origin to the allowed origins in the Atlas dashboard';
  return 'remove (not needed with Atlas)';
}

function envRename(style: FileFacts['envStyle']) {
  return (key: string): { to: string } | { report: string } | null => {
    const note = env(key, style);
    if (note === null) return null;
    if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)FRONTEGG_CLIENT_ID$/.test(key)) return { to: publicEnvKey(style, 'PUBLISHABLE_KEY') };
    return { report: `${key}: ${note}` };
  };
}

export default vendorTransform({
  mightApply: (source) => /@frontegg\/|FRONTEGG_/.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});
