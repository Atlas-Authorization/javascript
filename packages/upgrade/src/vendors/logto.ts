import {
  applyImportRules,
  fixProviderProps,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type EnvStyle,
  type ModuleRule,
  type Target,
} from './engine';
import { ATLAS, reportRoute, rewriteAuthPaths } from './shared';

/**
 * Logto → Atlas, across its SDKs:
 *
 *  - `@logto/react`: `<LogtoProvider config>` → `<AtlasProvider>` (the Logto
 *    endpoint and app id become the Atlas frontend API and publishable key,
 *    read from the Atlas env vars); `useLogto()` and the sign-in callback hook
 *    are reported with the Atlas hook that replaces them.
 *  - `@logto/next` (client, server actions, edge), `@logto/node`,
 *    `@logto/express`, `@logto/browser`, `@logto/client`, `@logto/vue`: no
 *    drop-in exists, so each import is marked with `TODO(atlas-migrate)` naming
 *    the Atlas call (`auth()` / `currentUser()` from `@atlasauth/nextjs/server`,
 *    `atlasMiddleware` / `requireAuth` from `@atlasauth/express`, the
 *    `<SignInButton />` / `<SignOutButton />` components).
 *  - `/api/logto/sign-in` style links → `/sign-in`; env vars → Atlas ones.
 */

const manual = (message: string): Target => ({ manual: message });

const PROVIDER_DROP = ['config', 'unstable_enableCache'];

const SESSION_HELP = 'read the session with useAuth() / useUser() from @atlasauth/react (client) or auth() / currentUser() from @atlasauth/nextjs/server (server)';

const RULES: readonly ModuleRule[] = [
  {
    match: '@logto/react',
    named: {
      LogtoProvider: {
        module: ATLAS.react,
        name: 'AtlasProvider',
        after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: PROVIDER_DROP }),
      },
      useLogto: manual(
        `useLogto(): ${SESSION_HELP}; signIn() → <SignInButton />, signOut() → <SignOutButton /> or useAuth().signOut(), getAccessToken() → useAuth().getToken(), getIdTokenClaims() → useAuth().claims, fetchUserInfo() → useUser()`,
      ),
      useHandleSignInCallback: manual('useHandleSignInCallback(): Atlas completes callbacks itself; delete the callback page and its route'),
      LogtoConfig: manual('LogtoConfig: Atlas is configured by the AtlasProvider props (publishableKey, frontendApi) and the Atlas dashboard; delete the config object'),
    },
    otherNamed: 'no Atlas counterpart — migrate it manually (scopes, resources and organizations are configured in the Atlas dashboard)',
  },
  {
    match: (s) => s === '@logto/next/server-actions' || s === '@logto/next/edge' || s === '@logto/next/server',
    named: {
      getLogtoContext: manual('getLogtoContext(): read the session with auth() / currentUser() from @atlasauth/nextjs/server'),
      signIn: manual('signIn(): sign-in is the Atlas /sign-in page; link to it or render <SignInButton />'),
      signOut: manual('signOut(): sign out with <SignOutButton /> or useAuth().signOut() from @atlasauth/react'),
      handleSignIn: manual('handleSignIn(): Atlas completes sign-in callbacks itself; delete this handler and its route'),
      getAccessToken: manual('getAccessToken(): send the Atlas session token (getToken() in the browser) to your API and verify it there with @atlasauth/backend'),
      getOrganizationToken: manual('getOrganizationToken(): organization tokens are Atlas session tokens with the active organization claims; verify them with @atlasauth/backend'),
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: '@logto/next',
    default: manual(
      'LogtoClient (@logto/next): replace handleAuthRoutes / withLogtoApiRoute / withLogtoSsr with the Atlas middleware (createAtlasMiddleware from @atlasauth/nextjs) and auth() / currentUser() from @atlasauth/nextjs/server; delete the /api/logto route',
    ),
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: '@logto/express',
    named: {
      handleAuthRoutes: manual('handleAuthRoutes(): Atlas hosts sign-in, sign-out and callbacks; delete these routes and add atlasMiddleware() from @atlasauth/express'),
      withLogto: manual('withLogto(): use atlasMiddleware() (reads the session) and requireAuth() (rejects signed-out requests) from @atlasauth/express; read the user with getAuth(req)'),
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: '@logto/node',
    default: manual('LogtoClient (@logto/node): verify Atlas session tokens with AtlasBackend from @atlasauth/backend, or use atlasMiddleware() from @atlasauth/express'),
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: (s) => s === '@logto/browser' || s === '@logto/client' || s === '@logto/vue' || s === '@logto/js',
    default: manual('LogtoClient: use the Atlas JS client from @atlasauth/js (sign-in redirects to /sign-in; getToken() returns the session token)'),
    otherNamed: 'no Atlas counterpart — migrate it manually (scopes, resources and organizations are configured in the Atlas dashboard)',
    whole: 'namespace import of a Logto SDK — migrate its members manually',
  },
];

/** Public env var slots that map onto Atlas's (values must come from the Atlas dashboard). */
function envRename(style: EnvStyle) {
  return (key: string): { to: string } | { report: string } | null => {
    const pub = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?LOGTO_(ENDPOINT|APP_ID)$/.exec(key);
    if (pub) {
      const prefix = pub[1] ?? '';
      const suffix = pub[2] === 'ENDPOINT' ? 'FRONTEND_API' : 'PUBLISHABLE_KEY';
      if (prefix) return { to: `${prefix}ATLAS_${suffix}` };
      return pub[2] === 'ENDPOINT'
        ? { to: 'ATLAS_ISSUER' }
        : { report: `LOGTO_APP_ID: server code identifies the instance with ATLAS_SECRET_KEY; the browser uses ${publicEnvKey(style, 'PUBLISHABLE_KEY')}` };
    }
    const notes: Record<string, string> = {
      LOGTO_APP_SECRET: 'LOGTO_APP_SECRET: server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)',
      LOGTO_COOKIE_SECRET: 'LOGTO_COOKIE_SECRET: Atlas manages its own session cookies; server code uses ATLAS_SECRET_KEY',
      LOGTO_BASE_URL: 'LOGTO_BASE_URL: not needed; add your app origin to the instance allowed origins in the Atlas dashboard',
      LOGTO_RESOURCES: 'LOGTO_RESOURCES: register each API as a resource server in the Atlas dashboard',
      LOGTO_SCOPES: 'LOGTO_SCOPES: not needed with Atlas sessions',
    };
    for (const [k, note] of Object.entries(notes)) {
      if (key === k || key.endsWith(`_${k}`)) return { report: note };
    }
    return null;
  };
}

export default vendorTransform({
  mightApply: (source, path) => /@logto\/|LOGTO_|\/api\/logto\b|\/logto\/sign-/.test(source) || /\/api\/logto\b/.test(path),
  run(ctx) {
    reportRoute(ctx, /\/api\/logto\b/, 'this Logto route is no longer used (Atlas hosts sign-in, sign-out and callbacks): delete it');
    applyImportRules(ctx, RULES);
    rewriteAuthPaths(ctx, {
      signIn: /^\/(api\/)?logto\/sign-in$/,
      signOut: /^\/(api\/)?logto\/sign-out$/,
      returnParams: [],
    });
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});

export function logtoPackages(name: string): boolean {
  return name.startsWith('@logto/');
}

/** `.env` keys that belong to Logto, with what replaces them. */
export function logtoEnv(key: string, style: EnvStyle): string | null {
  if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)LOGTO_ENDPOINT$/.test(key)) return `replace with ${publicEnvKey(style, 'FRONTEND_API')}`;
  if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)LOGTO_APP_ID$/.test(key)) return `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`;
  if (key === 'LOGTO_ENDPOINT') return 'replace with ATLAS_ISSUER';
  if (key === 'LOGTO_APP_SECRET' || key === 'LOGTO_COOKIE_SECRET') return 'remove; set ATLAS_SECRET_KEY';
  if (/(^|_)LOGTO_/.test(key)) return 'remove (not needed with Atlas)';
  return null;
}
