import {
  applyImportRules,
  fixProviderProps,
  renameEnv,
  vendorTransform,
  type ModuleRule,
  type Target,
} from './engine';
import { ATLAS, rewriteAuthPaths } from './shared';

/**
 * SuperTokens → Atlas, across its SDKs:
 *
 *  - `supertokens-auth-react`: `<SuperTokensWrapper>` → `<AtlasProvider>`; the
 *    pre-built UI, `SessionAuth`, `useSessionContext`, `Session.signOut()` and
 *    the recipe components are marked with the Atlas component or hook that
 *    replaces them (`<SignedIn>`, `<RedirectToSignIn />`, `useAuth()`,
 *    `<SignOutButton />`); Atlas hosts sign-in and sign-up.
 *  - `supertokens-node`: `supertokens.init`, the framework `middleware` /
 *    `errorHandler`, `verifySession` and the recipe modules are marked with the
 *    Atlas backend call (`atlasMiddleware()` / `requireAuth()` from
 *    `@atlasauth/express`, `auth()` in Next.js, `AtlasBackend` from
 *    `@atlasauth/backend`).
 *  - `supertokens-web-js`, `supertokens-website`, `supertokens-react-native`:
 *    marked with the Atlas client that replaces them.
 *  - `SUPERTOKENS_*` env vars are reported; `/auth/signin` links → `/sign-in`.
 */

const manual = (message: string): Target => ({ manual: message });

const OTHER = 'no Atlas counterpart — migrate it manually';

const NODE_INIT =
  'supertokens.init(): delete the SuperTokens setup (Atlas hosts sign-in, sessions and users); protect routes with atlasMiddleware() / requireAuth() from @atlasauth/express, auth() from @atlasauth/nextjs/server, or verify session tokens with AtlasBackend from @atlasauth/backend';
const NODE_SESSION =
  'Session (supertokens-node): Atlas creates sessions at sign-in; read the signed-in user with getAuth(req) (@atlasauth/express) or auth() (@atlasauth/nextjs/server), and manage sessions with AtlasBackend from @atlasauth/backend';
const NODE_RECIPE = (recipe: string) =>
  `${recipe} (supertokens-node): sign-up, sign-in and account APIs are hosted by Atlas; manage users, roles, metadata and tenants with AtlasBackend from @atlasauth/backend`;

const REACT_INIT =
  'SuperTokens.init() (supertokens-auth-react): delete it; the AtlasProvider props (publishableKey, frontendApi) are the whole client setup, and sign-in is the Atlas /sign-in page';
const REACT_SESSION =
  'Session (supertokens-auth-react): read the session with useAuth() / useUser() from @atlasauth/react; doesSessionExist() → useAuth().status, getAccessToken() → useAuth().getToken(), signOut() → <SignOutButton /> or useAuth().signOut()';

const RULES: readonly ModuleRule[] = [
  {
    match: 'supertokens-auth-react',
    named: {
      SuperTokensWrapper: { module: ATLAS.react, name: 'AtlasProvider', after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: [] }) },
      getRoutingComponent: manual('getRoutingComponent(): Atlas hosts the sign-in and sign-up pages; delete the /auth route and link to /sign-in'),
      canHandleRoute: manual('canHandleRoute(): Atlas hosts the sign-in and sign-up pages; delete the /auth route and link to /sign-in'),
      redirectToAuth: manual('redirectToAuth(): render <RedirectToSignIn /> from @atlasauth/react'),
      SessionAuth: manual('SessionAuth: render signed-in-only UI inside <SignedIn> and send everyone else with <RedirectToSignIn /> (both from @atlasauth/react)'),
      useSessionContext: manual('useSessionContext(): use useAuth() / useUser() from @atlasauth/react'),
    },
    default: manual(REACT_INIT),
    otherNamed: OTHER,
  },
  {
    match: (s) => s === 'supertokens-auth-react/recipe/session' || s.startsWith('supertokens-auth-react/recipe/session/'),
    named: {
      SessionAuth: manual('SessionAuth: render signed-in-only UI inside <SignedIn> and send everyone else with <RedirectToSignIn /> (both from @atlasauth/react)'),
      useSessionContext: manual('useSessionContext(): use useAuth() / useUser() from @atlasauth/react'),
      signOut: manual('signOut(): use <SignOutButton /> or useAuth().signOut() from @atlasauth/react'),
      doesSessionExist: manual('doesSessionExist(): use useAuth().status from @atlasauth/react'),
      getAccessToken: manual('getAccessToken(): use useAuth().getToken() from @atlasauth/react'),
      getUserId: manual('getUserId(): use useUser() from @atlasauth/react'),
    },
    default: manual(REACT_SESSION),
    otherNamed: OTHER,
  },
  {
    match: (s) => s.startsWith('supertokens-auth-react/'),
    default: manual('SuperTokens recipe UI (supertokens-auth-react): Atlas hosts sign-in and sign-up (<SignIn />, <SignUp />, <UserProfile />); delete the recipe and its routes'),
    otherNamed: 'Atlas hosts the pre-built sign-in UI: delete it and use the Atlas /sign-in page',
    whole: 'namespace import of a SuperTokens recipe — Atlas hosts sign-in and sign-up; delete it',
  },
  {
    match: (s) => s === 'supertokens-web-js' || s.startsWith('supertokens-web-js/') || s === 'supertokens-website' || s.startsWith('supertokens-website/'),
    default: manual('SuperTokens web client: use the Atlas JS client from @atlasauth/js (sign-in redirects to /sign-in; getToken() returns the session token)'),
    otherNamed: 'no Atlas counterpart — use the Atlas JS client from @atlasauth/js',
    whole: 'namespace import of a SuperTokens web SDK — migrate its members to @atlasauth/js manually',
  },
  {
    match: (s) => s === 'supertokens-react-native' || s.startsWith('supertokens-react-native/'),
    default: manual('SuperTokens (React Native): use the Atlas React Native / Expo SDK (@atlasauth/expo); sessions are Atlas session tokens'),
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: (s) => s === 'supertokens-node/framework/express' || s === 'supertokens-node/framework/fastify' || s === 'supertokens-node/framework/hono' || s === 'supertokens-node/framework/koa',
    named: {
      middleware: manual('middleware(): Atlas hosts sign-in and session endpoints; delete the SuperTokens middleware and add atlasMiddleware() from @atlasauth/express (or the Fastify / Hono adapter)'),
      errorHandler: manual('errorHandler(): delete it together with the SuperTokens middleware'),
      plugin: manual('plugin: delete the SuperTokens plugin and register the Atlas Fastify plugin from @atlasauth/fastify'),
    },
    otherNamed: OTHER,
  },
  {
    match: (s) => /^supertokens-node\/recipe\/session\/framework\//.test(s),
    named: {
      verifySession: manual('verifySession(): use requireAuth() from @atlasauth/express (or the Fastify / Hono adapter); read the user with getAuth(req) instead of req.session.getUserId()'),
    },
    otherNamed: OTHER,
  },
  {
    match: 'supertokens-node/recipe/session',
    default: manual(NODE_SESSION),
    named: {
      getSession: manual('getSession(): read the signed-in user with getAuth(req) (@atlasauth/express) or auth() (@atlasauth/nextjs/server)'),
      createNewSession: manual('createNewSession(): not needed; Atlas creates the session at sign-in (to sign someone in from your backend, use a sign-in token from @atlasauth/backend)'),
      revokeSession: manual('revokeSession(): revoke sessions with AtlasBackend from @atlasauth/backend'),
    },
    otherNamed: OTHER,
  },
  {
    match: (s) => /^supertokens-node\/recipe\/[a-z]+$/.test(s),
    default: manual(NODE_RECIPE('Recipe')),
    otherNamed: 'sign-up, sign-in and account APIs are hosted by Atlas; manage users with AtlasBackend from @atlasauth/backend',
    whole: 'namespace import of a SuperTokens recipe — migrate its calls to AtlasBackend from @atlasauth/backend',
  },
  {
    match: 'supertokens-node',
    default: manual(NODE_INIT),
    otherNamed: 'manage users, roles and metadata with AtlasBackend from @atlasauth/backend',
    whole: 'namespace import of supertokens-node — migrate its calls to AtlasBackend from @atlasauth/backend',
  },
];

const ENV_NOTES: Record<string, string> = {
  SUPERTOKENS_CONNECTION_URI: 'SUPERTOKENS_CONNECTION_URI: the SuperTokens core is only needed for lazy migration during the cutover window; remove it afterwards',
  SUPERTOKENS_API_KEY: 'SUPERTOKENS_API_KEY: server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)',
  API_DOMAIN: 'API_DOMAIN (SuperTokens apiDomain): not needed; the browser SDK uses the Atlas frontend API',
  WEBSITE_DOMAIN: 'WEBSITE_DOMAIN (SuperTokens websiteDomain): not needed; add your app origin to the instance allowed origins in the Atlas dashboard',
  API_BASE_PATH: 'API_BASE_PATH (SuperTokens apiBasePath): not needed with Atlas',
  WEBSITE_BASE_PATH: 'WEBSITE_BASE_PATH (SuperTokens websiteBasePath): not needed; sign-in is the Atlas /sign-in page',
};

function envRename(key: string): { report: string } | null {
  if (!/SUPERTOKENS_/.test(key)) return null;
  for (const [suffix, note] of Object.entries(ENV_NOTES)) {
    if (key === suffix || key.endsWith(`_${suffix}`)) return { report: note };
  }
  return { report: `${key}: not needed with Atlas` };
}

export default vendorTransform({
  mightApply: (source) => /supertokens|SUPERTOKENS_/.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    rewriteAuthPaths(ctx, {
      signIn: /^\/auth\/sign-?in$/,
      signUp: /^\/auth\/sign-?up$/,
      signOut: /^\/auth\/sign-?out$/,
      returnParams: ['redirectToPath'],
    });
    renameEnv(ctx, envRename);
  },
});

export function supertokensPackages(name: string): boolean {
  return name === 'supertokens-node' || name === 'supertokens-web-js' || name === 'supertokens-website' || name === 'supertokens-react-native' || name === 'supertokens-auth-react' || name.startsWith('@supertokens-plugins/');
}

/** `.env` keys that belong to SuperTokens, with what replaces them. */
export function supertokensEnv(key: string): string | null {
  if (key === 'SUPERTOKENS_API_KEY') return 'remove; set ATLAS_SECRET_KEY';
  if (key === 'SUPERTOKENS_CONNECTION_URI') return 'remove after the lazy-migration window (the core is not needed once users have moved)';
  if (/SUPERTOKENS_/.test(key)) return 'remove (not needed with Atlas)';
  return null;
}
