import type { ASTNode } from 'jscodeshift';
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
import { ATLAS } from './shared';

/**
 * authentik → Atlas. authentik is an OpenID Connect provider, so an app talks
 * to it through an OIDC client library (not an authentik SDK). This codemod
 * covers the ones authentik's own integration guides use:
 *
 *  - `react-oidc-context`: `<AuthProvider authority client_id …>` →
 *    `<AtlasProvider>` (`authority` → `frontendApi`, `client_id` →
 *    `publishableKey`; spread config and OIDC-only props are removed); its hooks
 *    and helpers are reported with what replaces them.
 *  - `oidc-client-ts`: `UserManager` and friends are reported (Atlas hosts the
 *    redirect and the callback).
 *  - the Auth.js authentik provider (`next-auth/providers/authentik`, or the
 *    same path under `@auth/core`) is reported (run `--from authjs` for the rest
 *    of the NextAuth setup).
 *  - `@goauthentik/api` (the admin API client) is reported: `@atlasauth/backend`
 *    covers users, roles, organizations and API keys.
 *  - `AUTHENTIK_*` / `AUTH_AUTHENTIK_*` variables.
 *
 * Libraries that are not authentik specific (`openid-client`, `jose`) have
 * their own codemods: `--from openid-client`, `--from jose`.
 */

const PROVIDER_DROP = [
  'authority',
  'client_id',
  'client_secret',
  'redirect_uri',
  'post_logout_redirect_uri',
  'silent_redirect_uri',
  'scope',
  'response_type',
  'automaticSilentRenew',
  'monitorSession',
  'loadUserInfo',
  'userStore',
  'stateStore',
  'extraQueryParams',
  'onSigninCallback',
  'onRemoveUser',
  'skipSigninCallback',
  'matchSignoutCallback',
  'autoSignIn',
];

const provider: Target = {
  module: ATLAS.react,
  name: 'AtlasProvider',
  after: (ref, ctx) => {
    fixProviderProps(ctx, ref, { map: { frontendApi: 'authority', publishableKey: 'client_id' }, drop: PROVIDER_DROP });
    // `<AuthProvider {...oidcConfig}>`: the spread carries OIDC settings Atlas does not read.
    const opening = ref.parent?.node as { type?: string; attributes?: ASTNode[] } | undefined;
    if (opening?.type !== 'JSXOpeningElement') return;
    const before = opening.attributes?.length ?? 0;
    opening.attributes = (opening.attributes ?? []).filter((a) => (a as { type: string }).type !== 'JSXSpreadAttribute');
    if ((opening.attributes?.length ?? 0) !== before) ctx.report(ref, 'removed the spread OIDC settings (authority, client_id, redirect_uri …): the Atlas provider reads the instance from its two props');
  },
};

const HOOKS =
  'the authentik session moves to Atlas: read it with useAuth() / useUser() from @atlasauth/react (isSignedIn, user, signOut()), and call APIs with the Atlas session token (getToken())';

const RULES: readonly ModuleRule[] = [
  {
    match: 'react-oidc-context',
    named: {
      AuthProvider: provider,
      useAuth: { manual: `useAuth(): ${HOOKS}` },
      withAuth: { manual: 'withAuth(Component): wrap the page in <SignedIn> / <RedirectToSignIn /> from @atlasauth/react' },
      hasAuthParams: { manual: 'hasAuthParams(): Atlas completes its own callback; delete the check' },
      AuthContext: { manual: `AuthContext: ${HOOKS}` },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: 'oidc-client-ts',
    named: {
      UserManager: { manual: 'UserManager: Atlas hosts the redirect, callback and silent renew; use useAuth() (signIn / signOut / getToken) from @atlasauth/react' },
      WebStorageStateStore: { manual: 'WebStorageStateStore: delete it; Atlas keeps the session in its own cookies' },
      User: { manual: 'User: the signed-in user is useUser() from @atlasauth/react (id, primaryEmailAddress, fullName)' },
      UserManagerSettings: { manual: 'UserManagerSettings: delete them; Atlas reads its instance from the publishable key' },
      Log: { manual: 'Log: not needed with Atlas' },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: (s) => /(^|\/)providers\/authentik$/.test(s),
    default: { manual: 'authentik provider: Atlas hosts sign-in (enable the same OIDC application as an Atlas OAuth provider); remove it from the Auth.js config (run --from authjs for the rest)' },
    otherNamed: 'authentik profile types are not needed with Atlas',
  },
  {
    match: '@goauthentik/api',
    named: {
      Configuration: { manual: 'authentik admin API client: use AtlasBackend from @atlasauth/backend (users, roles, organizations, API keys)' },
      CoreApi: { manual: 'CoreApi: users, groups and tokens are AtlasBackend users / roles / apiKeys from @atlasauth/backend' },
    },
    otherNamed: 'authentik admin API: use AtlasBackend from @atlasauth/backend',
  },
];

/** `.env` slots: where the value now comes from. */
function envRename(style: EnvStyle) {
  return (key: string): { to: string } | { report: string } | null => {
    const m = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?(?:AUTH_)?AUTHENTIK_(.+)$/.exec(key);
    if (!m) return null;
    const prefix = m[1] ?? '';
    const rest = m[2]!;
    if (/^(ISSUER|ISSUER_URL|OIDC_ISSUER|AUTHORITY)$/.test(rest)) {
      return prefix ? { to: `${prefix}ATLAS_FRONTEND_API` } : { to: 'ATLAS_ISSUER' };
    }
    if (/^(URL|BASE_URL|HOST)$/.test(rest)) return { report: `${key}: the authentik host; point these calls at your Atlas instance (the Backend API with ATLAS_SECRET_KEY)` };
    if (/^(CLIENT_ID|ID)$/.test(rest)) {
      return prefix ? { to: `${prefix}ATLAS_PUBLISHABLE_KEY` } : { report: `${key}: server code identifies the instance with ATLAS_SECRET_KEY; the browser uses ${publicEnvKey(style, 'PUBLISHABLE_KEY')}` };
    }
    if (/^(CLIENT_SECRET|SECRET)$/.test(rest)) return { report: `${key}: server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)` };
    if (rest === 'TOKEN' || rest === 'API_TOKEN') return { report: `${key}: authentik admin API token; Backend API calls use ATLAS_SECRET_KEY` };
    return null;
  };
}

export default vendorTransform({
  mightApply: (source) => /authentik|react-oidc-context|oidc-client-ts/i.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});

export const authentikPackages = (name: string): boolean => name.startsWith('@goauthentik/') || name === 'react-oidc-context' || name === 'oidc-client-ts';

export const authentikEnv = (key: string, style: EnvStyle): string | null => {
  const m = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?(?:AUTH_)?AUTHENTIK_(.+)$/.exec(key);
  if (!m) return null;
  const prefix = m[1] ?? '';
  const rest = m[2]!;
  if (/^(ISSUER|ISSUER_URL|OIDC_ISSUER|AUTHORITY)$/.test(rest)) return prefix ? `replace with ${publicEnvKey(style, 'FRONTEND_API')}` : 'replace with ATLAS_ISSUER';
  if (/^(URL|BASE_URL|HOST)$/.test(rest)) return 'remove (the authentik host; use your Atlas instance)';
  if (/^(CLIENT_ID|ID)$/.test(rest)) return prefix ? `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}` : 'remove (server code identifies the instance with ATLAS_SECRET_KEY)';
  if (/^(CLIENT_SECRET|SECRET|TOKEN|API_TOKEN)$/.test(rest)) return 'remove; set ATLAS_SECRET_KEY';
  return 'remove (not needed with Atlas)';
};
