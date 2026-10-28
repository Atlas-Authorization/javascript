import type { ASTNode, ASTPath } from 'jscodeshift';
import {
  applyImportRules,
  callOf,
  dropJsxAttrs,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type EnvStyle,
  type ImportTarget,
  type ModuleRule,
  type Target,
  type VendorContext,
} from './engine';
import { ATLAS, rewriteAuthPaths } from './shared';

/**
 * Ory (Kratos, Hydra, Keto, Ory Network) → Atlas.
 *
 * Ory's SDKs are thin clients of flows Ory serves as JSON: your app renders
 * the forms. Atlas hosts sign-in, sign-up, recovery, verification and account
 * settings itself (or as components), so most of that code is deleted rather
 * than translated. What the codemod does:
 *
 *  - `@ory/elements-react` (`<Login>`, `<Registration>`, `<Settings>`) →
 *    `<SignIn />`, `<SignUp />`, `<UserProfile />` from `@atlasauth/react`
 *    (the flow props go away: the components run the flow);
 *  - `@ory/nextjs/middleware` `createOryMiddleware(config)` →
 *    `createAtlasMiddleware()` from `@atlasauth/nextjs/compat`;
 *  - `/self-service/login/browser`, `/self-service/registration/browser` and
 *    Ory Account Experience links → `/sign-in` / `/sign-up` (return_to kept);
 *  - `@ory/nextjs` flow loaders and `getServerSession`, the `@ory/client`
 *    APIs (`FrontendApi`, `IdentityApi`, `OAuth2Api`, Keto's permission APIs)
 *    and Ory Elements v0 are marked with what replaces them (`// TODO(atlas-migrate):`
 *    and the report), because their call shapes have no mechanical Atlas twin;
 *  - `ORY_*` / `KRATOS_*` environment variables are renamed or explained.
 */

/** `<Login flow={flow} config={config} />` → `<SignIn />`: every prop belonged to the Ory flow. */
function dropFlowProps(what: string): NonNullable<ImportTarget['after']> {
  return (ref: ASTPath, ctx: VendorContext) => {
    const parent = ref.parent?.node as { type?: string; attributes?: ASTNode[] } | undefined;
    if (parent?.type !== 'JSXOpeningElement') return;
    const names = (parent.attributes ?? []).map((a) => (a as { name?: { name?: string } }).name?.name).filter((n): n is string => Boolean(n));
    const dropped = dropJsxAttrs(parent, names);
    if (dropped.length > 0) ctx.report(ref, `${what}: the Ory flow props (${dropped.join(', ')}) are gone; the Atlas component runs the flow and is configured in the Atlas dashboard`);
  };
}

/** The flow loaders of `@ory/nextjs`: what hosted Atlas UI replaces each one. */
const flow = (fn: string, instead: string): Target => ({ manual: `${fn}(): ${instead}; delete the flow code` });

const ELEMENTS: ModuleRule = {
  match: (s) => s === '@ory/elements-react' || s === '@ory/elements-react/theme' || s.startsWith('@ory/elements-react/'),
  named: {
    Login: { module: ATLAS.react, name: 'SignIn', after: dropFlowProps('<Login>') },
    Registration: { module: ATLAS.react, name: 'SignUp', after: dropFlowProps('<Registration>') },
    Settings: { module: ATLAS.react, name: 'UserProfile', after: dropFlowProps('<Settings>') },
    Recovery: { manual: '<Recovery>: Atlas password reset starts from <SignIn /> ("Forgot password?"); delete this page' },
    Verification: { manual: '<Verification>: Atlas verifies addresses during sign-up and in <UserProfile />; delete this page' },
    OryProvider: { manual: '<OryProvider>: wrap the app in <AtlasProvider> from @atlasauth/react instead' },
  },
  otherNamed: 'Ory Elements component: use <SignIn />, <SignUp /> and <UserProfile /> from @atlasauth/react',
};

const RULES: readonly ModuleRule[] = [
  ELEMENTS,
  {
    // Ory Elements v0 / markup / themes: server-rendered form markup.
    match: (s) => s === '@ory/elements' || s === '@ory/elements-markup' || s === '@ory/themes' || s.startsWith('@ory/elements/') || s.startsWith('@ory/themes/'),
    otherNamed: 'Ory Elements markup: Atlas renders the forms (<SignIn />, <SignUp />, <UserProfile /> from @atlasauth/react)',
    whole: 'Ory Elements styles: the Atlas components bring their own (appearance prop or the dashboard designer)',
  },
  {
    match: '@ory/nextjs/middleware',
    named: {
      createOryMiddleware: {
        module: ATLAS.nextCompat,
        name: 'createAtlasMiddleware',
        after: (ref, ctx) => {
          const call = callOf(ref);
          if (!call || call.args.length === 0) return;
          (call.path.node as { arguments: ASTNode[] }).arguments = [];
          ctx.manual(ref, 'createOryMiddleware(options) options were removed: Atlas serves sign-in itself. Every matched route needs a signed-in user except /sign-in and /sign-up; pass publicRoutes to createAtlasMiddleware() to open more');
        },
      },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: (s) => s === '@ory/nextjs' || s === '@ory/nextjs/app' || s === '@ory/nextjs/pages' || s.startsWith('@ory/nextjs/'),
    named: {
      getServerSession: {
        manual: 'getServerSession(): read the signed-in user with auth() / currentUser() from @atlasauth/nextjs/server; the Ory session object (identity.traits) has no Atlas counterpart',
      },
      getLoginFlow: flow('getLoginFlow', 'Atlas hosts sign-in: render <SignIn /> from @atlasauth/react, or link to /sign-in'),
      getRegistrationFlow: flow('getRegistrationFlow', 'Atlas hosts sign-up: render <SignUp /> from @atlasauth/react, or link to /sign-up'),
      getRecoveryFlow: flow('getRecoveryFlow', 'Atlas password reset starts from <SignIn />'),
      getVerificationFlow: flow('getVerificationFlow', 'Atlas verifies addresses during sign-up and in <UserProfile />'),
      getSettingsFlow: flow('getSettingsFlow', 'account settings are <UserProfile /> from @atlasauth/react'),
      getLogoutFlow: flow('getLogoutFlow', 'sign out with <SignOutButton /> or useAuth().signOut() from @atlasauth/react'),
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    // Kratos / Hydra / Keto API clients, in every package spelling Ory has shipped.
    match: (s) => /^@ory\/(client|client-fetch|kratos-client|kratos-client-fetch|hydra-client|hydra-client-fetch|keto-client|keto-client-fetch|sdk|integrations)(\/|$)/.test(s),
    named: {
      FrontendApi: { manual: 'FrontendApi (Kratos browser flows): sign-in, sign-up, recovery and settings run on Atlas pages and components; read the session with useAuth() / useUser() in the browser and verify the Atlas session token with @atlasauth/backend on the server' },
      Configuration: { manual: 'Configuration: not needed once the Ory client calls are replaced (Atlas SDKs read ATLAS_* from the environment)' },
      IdentityApi: { manual: 'IdentityApi (Kratos admin): manage users with the Atlas Backend API (@atlasauth/backend)' },
      OAuth2Api: { manual: 'OAuth2Api (Hydra admin): Atlas is the OAuth 2.0 / OIDC provider; register clients in the Atlas dashboard or API and delete your login and consent apps' },
      PermissionApi: { manual: 'PermissionApi (Ory Keto): Atlas has an OpenFGA-compatible authorization API; use @atlasauth/fga-js' },
      RelationshipApi: { manual: 'RelationshipApi (Ory Keto): Atlas has an OpenFGA-compatible authorization API; use @atlasauth/fga-js' },
      Session: { manual: 'type Session: the Atlas user and session claims come from useAuth() / useUser() (browser) and auth() (server)' },
      Identity: { manual: 'type Identity: use the Atlas user (useUser(), currentUser()); Kratos traits become user fields and metadata' },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
];

/** Public env var slots that map onto Atlas's; the rest are explained (values come from the Atlas dashboard). */
function envRename(key: string): { to: string } | { report: string } | null {
  const pub = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?(ORY_SDK_URL|ORY_URL|ORY_KRATOS_PUBLIC_URL|KRATOS_PUBLIC_URL|ORY_KRATOS_URL|KRATOS_BROWSER_URL|ORY_PROJECT_URL)$/.exec(key);
  if (pub) return { to: pub[1] ? `${pub[1]}ATLAS_FRONTEND_API` : 'ATLAS_ISSUER' };
  if (/^(ORY_PROJECT_API_KEY|ORY_API_KEY|ORY_SDK_API_KEY|ORY_ACCESS_TOKEN|ORY_PAT)$/.test(key)) {
    return { report: `${key}: server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)` };
  }
  if (/^(ORY_KRATOS_ADMIN_URL|KRATOS_ADMIN_URL|ORY_HYDRA_ADMIN_URL|HYDRA_ADMIN_URL|ORY_HYDRA_PUBLIC_URL|HYDRA_PUBLIC_URL|ORY_KETO_[A-Z_]+)$/.test(key)) {
    return { report: `${key}: admin and OAuth APIs are Atlas's Backend API (@atlasauth/backend with ATLAS_SECRET_KEY) and its own OIDC endpoints` };
  }
  if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)?(ORY|KRATOS|HYDRA)_/.test(key)) return { report: `${key}: not needed with Atlas` };
  return null;
}

export default vendorTransform({
  mightApply: (source) => /@ory\/|ORY_|KRATOS_|HYDRA_|\/self-service\/|\/ui\/(login|registration)/.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    rewriteAuthPaths(ctx, {
      signIn: /^\/(self-service\/login\/browser|ui\/login)$/,
      signUp: /^\/(self-service\/registration\/browser|ui\/registration)$/,
      signOut: /^\/self-service\/logout(\/browser|\/api)?$/,
      returnParams: ['return_to'],
    });
    renameEnv(ctx, envRename);
  },
});

/** npm packages that belong to Ory (removed once the manual items are done). */
export const oryPackages = (name: string): boolean => name.startsWith('@ory/');

/** `.env` hints: what replaces each Ory variable. */
export const oryEnv = (key: string, style: EnvStyle): string | null => {
  const verdict = envRename(key);
  if (!verdict) return null;
  if ('to' in verdict) return `replace with ${verdict.to.startsWith('ATLAS') ? verdict.to : publicEnvKey(style, 'FRONTEND_API')}`;
  return key.includes('API_KEY') || key.includes('ACCESS_TOKEN') || key === 'ORY_PAT' ? 'remove; set ATLAS_SECRET_KEY' : 'remove (not needed with Atlas)';
};
