import type { ASTPath, CallExpression } from 'jscodeshift';
import {
  applyImportRules,
  applyReexportRules,
  fixProviderProps,
  renameEnv,
  vendorTransform,
  type ModuleRule,
  type Target,
  type VendorContext,
} from './engine';
import { ATLAS } from './shared';

/**
 * Nhost (Hasura Auth) → Atlas. The Nhost client keeps serving GraphQL,
 * Storage and Functions; auth moves:
 *
 *  - `<NhostProvider nhost>` → `<AtlasProvider>`;
 *  - the session hooks (`useAuthenticationStatus`, `useAuthenticated`,
 *    `useUserData`, `useUserId`, `useUserEmail`, `useUserDisplayName`,
 *    `useUserAvatarUrl`, `useSignOut`) → `@atlasauth/react/compat`;
 *  - `nhost.auth.getUser()` / `isAuthenticated()` / `isAuthenticatedAsync()` /
 *    `getAccessToken()` / `getSession()` / `signOut()` / `onAuthStateChanged()` /
 *    `onTokenChanged()` → `nhostAuthCompat`;
 *  - credential hooks and calls are marked (they run on Atlas's pages), and
 *    Hasura claims are reported: an Atlas JWT template emits
 *    `https://hasura.io/jwt/claims`, and Hasura reads the Atlas JWKS.
 */

const manual = (message: string): Target => ({ manual: message });
const SIGN_IN_PAGE = 'credentials are collected on the Atlas sign-in page now: render <SignIn /> (or send users to /sign-in)';
const SIGN_UP_PAGE = 'sign-up runs on the Atlas sign-up page: render <SignUp /> (or send users to /sign-up)';
const PROFILE = 'use <UserProfile /> or user.update() from @atlasauth/react';
const HASURA =
  'Hasura claims: create an Atlas JWT template that emits "https://hasura.io/jwt/claims" (x-hasura-user-id, x-hasura-default-role, x-hasura-allowed-roles) and point HASURA_GRAPHQL_JWT_SECRET at the Atlas JWKS ({"jwk_url": "<frontend API>/.well-known/jwks.json"})';

const HOOKS: Record<string, Target> = {
  NhostProvider: { module: ATLAS.react, name: 'AtlasProvider', after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: ['nhost', 'initial'] }) },
  NhostReactProvider: { module: ATLAS.react, name: 'AtlasProvider', after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: ['nhost', 'initial'] }) },
  NhostNextProvider: { module: ATLAS.react, name: 'AtlasProvider', after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: ['nhost', 'initial'] }) },
  useAuthenticationStatus: { module: ATLAS.reactCompat, name: 'useNhostAuthenticationStatusCompat' },
  useAuthenticated: { module: ATLAS.reactCompat, name: 'useNhostAuthenticatedCompat' },
  useUserData: { module: ATLAS.reactCompat, name: 'useNhostUserDataCompat' },
  useUserId: { module: ATLAS.reactCompat, name: 'useNhostUserIdCompat' },
  useUserEmail: { module: ATLAS.reactCompat, name: 'useNhostUserEmailCompat' },
  useUserDisplayName: { module: ATLAS.reactCompat, name: 'useNhostUserDisplayNameCompat' },
  useUserAvatarUrl: { module: ATLAS.reactCompat, name: 'useNhostUserAvatarUrlCompat' },
  useSignOut: { module: ATLAS.reactCompat, name: 'useNhostSignOutCompat' },
  useAccessToken: manual('useAccessToken(): get the Atlas session JWT with useAuth().getToken() from @atlasauth/react'),
  useDecodedAccessToken: manual('useDecodedAccessToken(): read verified claims with useAuth() from @atlasauth/react'),
  useHasuraClaims: manual(`useHasuraClaims(): ${HASURA}`),
  useHasuraClaim: manual(`useHasuraClaim(): ${HASURA}`),
  useUserDefaultRole: manual('useUserDefaultRole(): Nhost roles are imported as user metadata (nhost_default_role); read it from useUser() or a JWT template'),
  useUserRoles: manual('useUserRoles(): Nhost roles are imported as user metadata (nhost_roles); read them from useUser() or a JWT template'),
  useUserIsAnonymous: manual('useUserIsAnonymous(): enable anonymous users in the Atlas dashboard'),
  useUserLocale: manual('useUserLocale(): the locale is imported as user metadata'),
  useSignInEmailPassword: manual(`useSignInEmailPassword(): ${SIGN_IN_PAGE}`),
  useSignInEmailPasswordless: manual('useSignInEmailPasswordless(): enable magic links in the Atlas dashboard; the sign-in page sends them'),
  useSignInEmailOTP: manual('useSignInEmailOTP(): enable email codes in the Atlas dashboard'),
  useSignInSmsPasswordless: manual('useSignInSmsPasswordless(): enable SMS codes in the Atlas dashboard'),
  useSignInSecurityKey: manual('useSignInSecurityKey(): passkeys are on the Atlas sign-in page'),
  useSignInAnonymous: manual('useSignInAnonymous(): enable anonymous users in the Atlas dashboard'),
  useSignInIdToken: manual('useSignInIdToken(): native ID-token sign-in uses the Atlas native SDKs'),
  useSignInPAT: manual('useSignInPAT(): personal access tokens become Atlas API keys (machine auth)'),
  useProviderLink: manual('useProviderLink(): social providers are enabled in the Atlas dashboard; link to /sign-in'),
  useSignUpEmailPassword: manual(`useSignUpEmailPassword(): ${SIGN_UP_PAGE}`),
  useSignUpEmailSecurityKey: manual(`useSignUpEmailSecurityKey(): ${SIGN_UP_PAGE}`),
  useResetPassword: manual('useResetPassword(): password reset is built into the Atlas sign-in page'),
  useChangePassword: manual(`useChangePassword(): ${PROFILE}`),
  useChangeEmail: manual(`useChangeEmail(): ${PROFILE}`),
  useSendVerificationEmail: manual('useSendVerificationEmail(): Atlas verifies email addresses during sign-up and in <UserProfile />'),
  useConfigMfa: manual('useConfigMfa(): MFA enrolment runs in <UserProfile />'),
  useAddSecurityKey: manual('useAddSecurityKey(): passkeys are added from <UserProfile />'),
  useElevateSecurityKeyEmail: manual('useElevateSecurityKeyEmail(): step-up verification is useReverification() from @atlasauth/react'),
  useDeanonymize: manual('useDeanonymize(): anonymous users finish sign-up on the Atlas sign-up page'),
  useLinkIdToken: manual('useLinkIdToken(): users connect accounts from <UserProfile />'),
  getNhostSession: manual('getNhostSession(): read the session with auth() / currentUser() from @atlasauth/nextjs/server'),
};

const RULES: readonly ModuleRule[] = [
  { match: (s) => s === '@nhost/react' || s === '@nhost/nextjs' || s === '@nhost/vue' || s === '@nhost/react-auth', named: HOOKS, keepOthers: true },
  {
    match: (s) => s === '@nhost/react-apollo' || s === '@nhost/react-urql',
    keepOthers: true,
  },
];

/** `nhost.auth.<method>` → nhostAuthCompat.<method> when it has a compat peer. */
const COMPAT_METHODS = new Set(['getUser', 'isAuthenticated', 'isAuthenticatedAsync', 'getAccessToken', 'getSession', 'signOut', 'onAuthStateChanged', 'onTokenChanged']);

const MANUAL_METHODS: Record<string, string> = {
  signIn: SIGN_IN_PAGE,
  signInEmailPassword: SIGN_IN_PAGE,
  signInPasswordlessEmail: 'enable magic links in the Atlas dashboard',
  signUp: SIGN_UP_PAGE,
  signUpEmailPassword: SIGN_UP_PAGE,
  resetPassword: 'password reset is built into the Atlas sign-in page',
  changePassword: PROFILE,
  changeEmail: PROFILE,
  sendVerificationEmail: 'Atlas verifies email addresses during sign-up and in <UserProfile />',
  deanonymize: 'anonymous users finish sign-up on the Atlas sign-up page',
  addSecurityKey: 'passkeys are added from <UserProfile />',
  elevateEmailSecurityKey: 'step-up verification is useReverification() from @atlasauth/react',
  refreshSession: 'Atlas refreshes sessions on its own; remove this call',
  getDecodedAccessToken: 'read verified claims with useAuth() (browser) or auth() from @atlasauth/nextjs/server',
  getHasuraClaims: HASURA,
  getHasuraClaim: HASURA,
  getAuthenticationStatus: 'use nhostAuthCompat.isAuthenticated() or useAuth() from @atlasauth/react',
  connectProvider: 'users connect accounts from <UserProfile />',
  signInIdToken: 'native ID-token sign-in uses the Atlas native SDKs',
  signInPAT: 'personal access tokens become Atlas API keys (machine auth)',
};

function usesNhost(ctx: VendorContext): boolean {
  const { j, root } = ctx;
  return root
    .find(j.ImportDeclaration)
    .nodes()
    .some((n) => /nhost/i.test(String(n.source.value)));
}

function rewriteAuthCalls(ctx: VendorContext): void {
  const { j, root } = ctx;
  if (!usesNhost(ctx)) return;
  root.find(j.CallExpression).forEach((path: ASTPath<CallExpression>) => {
    const callee = path.node.callee as {
      type?: string;
      computed?: boolean;
      property?: { type?: string; name?: string };
      object?: { type?: string; computed?: boolean; property?: { type?: string; name?: string } };
    };
    if (callee.type !== 'MemberExpression' || callee.computed || callee.property?.type !== 'Identifier') return;
    const obj = callee.object;
    if (obj?.type !== 'MemberExpression' || obj.computed || obj.property?.type !== 'Identifier' || obj.property.name !== 'auth') return;
    const method = callee.property.name ?? '';
    if (COMPAT_METHODS.has(method)) {
      const local = ctx.ensureImport(ATLAS.reactCompat, 'nhostAuthCompat');
      path.node.callee = j.memberExpression(j.identifier(local), j.identifier(method));
      ctx.rewrote();
      return;
    }
    const note = MANUAL_METHODS[method];
    if (note) ctx.manual(path, `nhost.auth.${method}(): ${note}`);
  });
}

export default vendorTransform({
  mightApply: (source) => /nhost|HASURA_GRAPHQL_JWT_SECRET/i.test(source),
  run(ctx) {
    applyReexportRules(ctx, RULES);
    applyImportRules(ctx, RULES);
    rewriteAuthCalls(ctx);
    renameEnv(ctx, (key) => (key === 'HASURA_GRAPHQL_JWT_SECRET' ? { report: `HASURA_GRAPHQL_JWT_SECRET: ${HASURA}` } : null));
  },
});
