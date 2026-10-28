import {
  applyImportRules,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type EnvStyle,
  type ModuleRule,
} from './engine';
import { rewriteAuthPaths } from './shared';

/**
 * ZITADEL → Atlas. ZITADEL apps talk to it through standard OIDC (a generic
 * OIDC client, or the Auth.js ZITADEL provider) and, for service-side work,
 * its own SDKs. Atlas hosts sign-in, so the codemod:
 *
 *  - marks the Auth.js ZITADEL provider (`next-auth/providers/zitadel`,
 *    `@auth/core/providers/zitadel`) for removal and points at the Auth.js
 *    codemod (`--from authjs`) for the rest of the Auth.js setup;
 *  - marks `@zitadel/react` login-UI components (the social buttons, form
 *    inputs) with what replaces them: `<SignIn />`, `<SignUp />`,
 *    `<UserProfile />` from `@atlasauth/react`;
 *  - marks `@zitadel/node`, `@zitadel/client`, `@zitadel/proto`,
 *    `@zitadel/server` and `@zitadel/next` calls (introspection, management
 *    and auth service clients, service accounts) with their Atlas Backend
 *    counterparts;
 *  - rewrites ZITADEL's hosted login links (`/ui/login`, `/ui/v2/login`,
 *    register, `/oidc/v1/end_session`) to `/sign-in`, `/sign-up` and the
 *    sign-out action;
 *  - renames `ZITADEL_*` environment variables or says what replaces them.
 *
 * Generic OIDC clients (`oidc-client-ts`, `react-oidc-context`, `openid-client`)
 * pointed at ZITADEL are handled by `--from generic-oidc` / `openid-client`.
 */

const RULES: readonly ModuleRule[] = [
  {
    match: (s) => s === 'next-auth/providers/zitadel' || s === '@auth/core/providers/zitadel' || s === '@auth/sveltekit/providers/zitadel',
    default: { manual: 'ZITADEL sign-in is Atlas sign-in: remove the ZITADEL provider here, and migrate the rest of Auth.js with `atlas migrate code --from authjs`' },
    otherNamed: 'ZITADEL sign-in is Atlas sign-in: remove the ZITADEL provider',
  },
  {
    match: (s) => s === '@zitadel/react' || s.startsWith('@zitadel/react/'),
    named: {
      SignInWithGoogle: { manual: 'SignInWithGoogle: Atlas\'s <SignIn /> shows the social providers you enable in the dashboard; delete this button' },
      SignInWithGitHub: { manual: 'SignInWithGitHub: Atlas\'s <SignIn /> shows the social providers you enable in the dashboard; delete this button' },
      SignInWithAzureAD: { manual: 'SignInWithAzureAD: Atlas\'s <SignIn /> shows the social providers you enable in the dashboard; delete this button' },
      SignInWithGitlab: { manual: 'SignInWithGitlab: Atlas\'s <SignIn /> shows the social providers you enable in the dashboard; delete this button' },
      SignInWithGeneric: { manual: 'SignInWithGeneric: Atlas\'s <SignIn /> shows the SSO and social providers you enable in the dashboard; delete this button' },
    },
    otherNamed: 'ZITADEL login UI component: Atlas renders sign-in, sign-up and account pages (<SignIn />, <SignUp />, <UserProfile /> from @atlasauth/react)',
    whole: 'ZITADEL login UI styles: the Atlas components bring their own (appearance prop or the dashboard designer)',
  },
  {
    match: (s) => s === '@zitadel/node' || s.startsWith('@zitadel/node/'),
    named: {
      introspect: { manual: 'introspect(): verify the Atlas session token with AtlasBackend#verify from @atlasauth/backend (checked against the instance JWKS, no call per request)' },
      ServiceAccount: { manual: 'ServiceAccount: service accounts become Atlas API keys or M2M clients; call the Backend API with @atlasauth/backend' },
    },
    otherNamed: 'ZITADEL server SDK: the Atlas Backend API (createAtlasClient from @atlasauth/backend) replaces its management and auth services',
  },
  {
    match: (s) => s === '@zitadel/client' || s.startsWith('@zitadel/client/') || s === '@zitadel/proto' || s.startsWith('@zitadel/proto/') || s === '@zitadel/server' || s.startsWith('@zitadel/server/'),
    otherNamed: 'ZITADEL API client: the Atlas Backend API (createAtlasClient from @atlasauth/backend) replaces its user, session and organization services',
  },
  {
    match: (s) => s === '@zitadel/next' || s.startsWith('@zitadel/next/'),
    otherNamed: 'ZITADEL Next.js helper: use auth() / currentUser() from @atlasauth/nextjs/server and createAtlasMiddleware() from @atlasauth/nextjs/compat',
  },
];

/** Public env var slots that map onto Atlas's; the rest are explained (values come from the Atlas dashboard). */
function envRename(key: string): { to: string } | { report: string } | null {
  const pub = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?ZITADEL_(ISSUER|DOMAIN|API|AUTHORITY|INSTANCE_URL|URL)$/.exec(key);
  if (pub) return { to: pub[1] ? `${pub[1]}ATLAS_FRONTEND_API` : 'ATLAS_ISSUER' };
  const id = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)ZITADEL_CLIENT_ID$/.exec(key);
  if (id) return { to: `${id[1]}ATLAS_PUBLISHABLE_KEY` };
  if (/^ZITADEL_(CLIENT_SECRET|SERVICE_USER_TOKEN|SERVICE_USER_ID|SERVICE_ACCOUNT_KEY|KEY_FILE|PAT|JWT_KEY|API_KEY|MACHINE_KEY)$/.test(key)) {
    return { report: `${key}: server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)` };
  }
  if (key === 'ZITADEL_CLIENT_ID') return { report: 'ZITADEL_CLIENT_ID: server code identifies the instance with ATLAS_SECRET_KEY; the browser uses the Atlas publishable key' };
  if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)?ZITADEL_/.test(key)) return { report: `${key}: not needed with Atlas` };
  return null;
}

export default vendorTransform({
  mightApply: (source) => /@zitadel\/|providers\/zitadel|ZITADEL_|\/ui\/(v2\/)?login|\/oidc\/v1\/end_session/.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    rewriteAuthPaths(ctx, {
      signIn: /^\/ui\/(v2\/)?login$/,
      signUp: /^\/ui\/(v2\/)?login\/register$/,
      signOut: /^\/(ui\/(v2\/)?login\/logout|oidc\/v1\/end_session)$/,
      returnParams: ['returnTo', 'redirect_uri'],
    });
    renameEnv(ctx, envRename);
  },
});

/** npm packages that belong to ZITADEL (removed once the manual items are done). */
export const zitadelPackages = (name: string): boolean => name.startsWith('@zitadel/');

/** `.env` hints: what replaces each ZITADEL variable. */
export const zitadelEnv = (key: string, style: EnvStyle): string | null => {
  const verdict = envRename(key);
  if (!verdict) return null;
  if ('to' in verdict) return `replace with ${verdict.to === 'ATLAS_ISSUER' ? verdict.to : verdict.to.endsWith('PUBLISHABLE_KEY') ? publicEnvKey(style, 'PUBLISHABLE_KEY') : publicEnvKey(style, 'FRONTEND_API')}`;
  return verdict.report.includes('ATLAS_SECRET_KEY') ? 'remove; set ATLAS_SECRET_KEY' : 'remove (not needed with Atlas)';
};
