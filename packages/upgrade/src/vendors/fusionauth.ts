import { applyImportRules, fixProviderProps, publicEnvKey, renameEnv, vendorTransform, type EnvStyle, type ModuleRule, type Target } from './engine';
import { ATLAS } from './shared';

/**
 * FusionAuth → Atlas, across its JavaScript SDKs:
 *
 *  - `@fusionauth/react-sdk`: `<FusionAuthProvider config>` → `<AtlasProvider>`
 *    (the server URL, client id and redirect settings are dropped: the Atlas
 *    frontend API and publishable key come from the Atlas env vars);
 *    `useFusionAuth()`, the login / logout / register buttons and `RequireAuth`
 *    are reported with the Atlas call that replaces each.
 *  - `@fusionauth/typescript-client` / `@fusionauth/node-client`: the API client
 *    is reported (users are managed with `@atlasauth/backend`).
 *  - `@fusionauth/vue-sdk`, `@fusionauth/angular-sdk`, `@fusionauth/js-sdk`
 *    and `@fusionauth/sdk-core`-style clients: reported.
 *  - `FUSIONAUTH_*` env vars.
 *
 * Verifying a FusionAuth access token on a server with `jose` and the tenant's
 * `/.well-known/jwks.json` is the `--from jose` codemod.
 */

const manual = (message: string): Target => ({ manual: message });

const SESSION = 'read the session with useAuth() / useUser() from @atlasauth/react (client) or auth() / currentUser() from @atlasauth/nextjs/server (server)';

const PROVIDER_DROP = [
  'config',
  'clientId',
  'serverUrl',
  'redirectUri',
  'postLogoutRedirectUri',
  'tenantId',
  'scope',
  'mode',
  'shouldAutoRefresh',
  'shouldAutoFetchUserInfo',
  'accessTokenExpireCookieName',
  'onRedirectSuccess',
  'onRedirectFail',
  'onLogout',
  'loginPath',
  'logoutPath',
  'registerPath',
  'tokenRefreshPath',
  'meRoutePath',
];

const RULES: readonly ModuleRule[] = [
  {
    match: '@fusionauth/react-sdk',
    named: {
      FusionAuthProvider: { module: ATLAS.react, name: 'AtlasProvider', after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: PROVIDER_DROP }) },
      useFusionAuth: manual(`useFusionAuth(): ${SESSION}; login() → <SignInButton />, logout() → <SignOutButton /> or useAuth().signOut(), register() → link to /sign-up, isAuthenticated → useAuth().isSignedIn, user → useUser()`),
      FusionAuthLoginButton: manual('FusionAuthLoginButton: <SignInButton /> from @atlasauth/react'),
      FusionAuthLogoutButton: manual('FusionAuthLogoutButton: <SignOutButton /> from @atlasauth/react'),
      FusionAuthRegisterButton: manual('FusionAuthRegisterButton: link to /sign-up (Atlas hosts registration)'),
      RequireAuth: manual('RequireAuth: render the protected UI when useAuth().isSignedIn is true, and send signed-out visitors to /sign-in'),
    },
    otherNamed: 'no Atlas counterpart — migrate it manually (sign-in methods, registration and roles are configured in the Atlas dashboard)',
  },
  {
    match: (s) => s === '@fusionauth/typescript-client' || s === '@fusionauth/node-client',
    default: manual('FusionAuthClient: manage users, roles and groups with AtlasBackend from @atlasauth/backend; verify sessions with it, or with atlasMiddleware() from @atlasauth/express'),
    named: { FusionAuthClient: manual('FusionAuthClient: manage users, roles and groups with AtlasBackend from @atlasauth/backend; verify sessions with it, or with atlasMiddleware() from @atlasauth/express') },
    otherNamed: 'FusionAuth request and response types are not needed with Atlas — migrate the calls manually',
    whole: "namespace import of '@fusionauth/typescript-client' — use AtlasBackend from @atlasauth/backend",
  },
  {
    match: (s) => s.startsWith('@fusionauth/') && !s.startsWith('@fusionauth/react-sdk'),
    default: manual(`FusionAuth SDK: use the Atlas JS client from @atlasauth/js (sign-in redirects to /sign-in; getToken() returns the session token); ${SESSION}`),
    otherNamed: 'no Atlas counterpart — migrate it manually',
    whole: 'namespace import of a FusionAuth SDK — migrate its members manually',
  },
];

/** `.env` slots: where the value now comes from. */
function envRename(style: EnvStyle) {
  return (key: string): { to: string } | { report: string } | null => {
    const m = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?FUSIONAUTH_(.+)$/.exec(key);
    if (!m) return null;
    const prefix = m[1] ?? '';
    const rest = m[2]!;
    if (/^(URL|BASE_URL|HOST|SERVER_URL|API_URL)$/.test(rest)) {
      return prefix ? { to: `${prefix}ATLAS_FRONTEND_API` } : { report: `${key}: the FusionAuth server URL; the browser uses ${publicEnvKey(style, 'FRONTEND_API')}, servers verify tokens with ATLAS_JWKS_URL` };
    }
    if (rest === 'CLIENT_ID') return prefix ? { to: `${prefix}ATLAS_PUBLISHABLE_KEY` } : { report: `${key}: server code identifies the instance with ATLAS_SECRET_KEY; the browser uses ${publicEnvKey(style, 'PUBLISHABLE_KEY')}` };
    if (rest === 'ISSUER' && !prefix) return { to: 'ATLAS_ISSUER' };
    if (/^(API_KEY|CLIENT_SECRET|SECRET)$/.test(rest)) return { report: `${key}: server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)` };
    if (/^(TENANT_ID|APPLICATION_ID|APP_ID)$/.test(rest)) return { report: `${key}: not needed; one Atlas instance per tenant (applications are configured in the Atlas dashboard)` };
    return null;
  };
}

export default vendorTransform({
  mightApply: (source) => /@fusionauth\/|FUSIONAUTH_/.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});

export const fusionauthPackages = (name: string): boolean => name.startsWith('@fusionauth/');

export const fusionauthEnv = (key: string, style: EnvStyle): string | null => {
  const m = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?FUSIONAUTH_(.+)$/.exec(key);
  if (!m) return null;
  const prefix = m[1] ?? '';
  const rest = m[2]!;
  if (/^(URL|BASE_URL|HOST|SERVER_URL|API_URL)$/.test(rest)) return prefix ? `replace with ${publicEnvKey(style, 'FRONTEND_API')}` : 'remove (servers verify tokens with ATLAS_JWKS_URL)';
  if (rest === 'CLIENT_ID') return prefix ? `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}` : 'remove; set ATLAS_SECRET_KEY';
  if (rest === 'ISSUER' && !prefix) return 'replace with ATLAS_ISSUER';
  if (/^(API_KEY|CLIENT_SECRET|SECRET)$/.test(rest)) return 'remove; set ATLAS_SECRET_KEY';
  return 'remove (not needed with Atlas)';
};
