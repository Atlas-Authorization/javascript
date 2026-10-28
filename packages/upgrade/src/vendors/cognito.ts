import type { ASTPath } from 'jscodeshift';
import {
  applyImportRules,
  applyReexportRules,
  callOf,
  vendorTransform,
  type ModuleRule,
  type Target,
  type VendorContext,
} from './engine';
import { ATLAS } from './shared';

/**
 * Amazon Cognito (AWS Amplify) → Atlas:
 *
 *  - `aws-amplify/auth` v6: `getCurrentUser`, `fetchAuthSession`,
 *    `fetchUserAttributes`, `signOut`, `signInWithRedirect` → the
 *    `@atlasauth/react/compat` helpers (same shapes);
 *  - `Hub.listen('auth', cb)` → `amplifyHubListenCompat('auth', cb)`;
 *  - v5 `Auth.currentAuthenticatedUser()` / `currentSession()` / `signOut()` … →
 *    `amplifyAuthV5Compat`;
 *  - `@aws-amplify/ui-react` `withAuthenticator` / `useAuthenticator` → compat;
 *    `<Authenticator>` is reported (its render-prop children need a human);
 *  - credential flows, MFA, `amazon-cognito-identity-js`, `aws-jwt-verify`,
 *    the Amplify server adapter and the Cognito admin SDK are reported with
 *    their Atlas counterpart.
 *
 * Amplify itself stays when the app uses its other categories (API, Storage).
 */

const SIGN_IN_PAGE = 'credentials are collected on the Atlas sign-in page now: render <SignIn /> (or send users to /sign-in)';
const SIGN_UP_PAGE = 'sign-up runs on the Atlas sign-up page: render <SignUp /> (or send users to /sign-up)';
const PROFILE = 'profile and password changes: use <UserProfile /> or user.update() from @atlasauth/react';
const MFA = 'MFA (TOTP, SMS, email codes, passkeys) runs inside the Atlas sign-in flow and <UserProfile />';
const SERVER = 'server-side: read the session with auth() / currentUser() from @atlasauth/nextjs/server (or AtlasBackend from @atlasauth/backend)';

const manual = (message: string): Target => ({ manual: message });

const V6_AUTH: Record<string, Target> = {
  getCurrentUser: { module: ATLAS.reactCompat, name: 'amplifyGetCurrentUserCompat' },
  fetchAuthSession: { module: ATLAS.reactCompat, name: 'amplifyFetchAuthSessionCompat' },
  fetchUserAttributes: { module: ATLAS.reactCompat, name: 'amplifyFetchUserAttributesCompat' },
  signOut: { module: ATLAS.reactCompat, name: 'amplifySignOutCompat' },
  signInWithRedirect: { module: ATLAS.reactCompat, name: 'amplifySignInWithRedirectCompat' },
  AuthUser: { module: ATLAS.reactCompat, name: 'AmplifyCompatCurrentUser', typeOnly: true },
  JWT: { module: ATLAS.reactCompat, name: 'AmplifyCompatJwt', typeOnly: true },
  signIn: manual(`signIn(): ${SIGN_IN_PAGE}`),
  confirmSignIn: manual(`confirmSignIn(): challenges (MFA, new password) run inside the Atlas sign-in flow`),
  autoSignIn: manual('autoSignIn(): Atlas signs the user in at the end of sign-up; remove this call'),
  signUp: manual(`signUp(): ${SIGN_UP_PAGE}`),
  confirmSignUp: manual('confirmSignUp(): email/phone verification happens inside the Atlas sign-up flow'),
  resendSignUpCode: manual('resendSignUpCode(): resending codes happens inside the Atlas flow'),
  resetPassword: manual('resetPassword(): password reset is built into the Atlas sign-in page ("Forgot password")'),
  confirmResetPassword: manual('confirmResetPassword(): password reset is built into the Atlas sign-in page'),
  updatePassword: manual(`updatePassword(): ${PROFILE}`),
  updateUserAttributes: manual(`updateUserAttributes(): ${PROFILE}; custom attributes are user metadata`),
  updateUserAttribute: manual(`updateUserAttribute(): ${PROFILE}; custom attributes are user metadata`),
  confirmUserAttribute: manual('confirmUserAttribute(): Atlas verifies changed emails/phones in <UserProfile />'),
  sendUserAttributeVerificationCode: manual('sendUserAttributeVerificationCode(): Atlas verifies changed emails/phones in <UserProfile />'),
  deleteUserAttributes: manual(`deleteUserAttributes(): ${PROFILE}`),
  deleteUser: manual('deleteUser(): users delete their account from <UserProfile /> (or users.delete from @atlasauth/backend)'),
  setUpTOTP: manual(`setUpTOTP(): ${MFA}`),
  verifyTOTPSetup: manual(`verifyTOTPSetup(): ${MFA}`),
  updateMFAPreference: manual(`updateMFAPreference(): ${MFA}`),
  fetchMFAPreference: manual(`fetchMFAPreference(): read user.mfa_enabled from useUser() (@atlasauth/react)`),
  associateWebAuthnCredential: manual(`associateWebAuthnCredential(): ${MFA}`),
  listWebAuthnCredentials: manual(`listWebAuthnCredentials(): ${MFA}`),
  deleteWebAuthnCredential: manual(`deleteWebAuthnCredential(): ${MFA}`),
  rememberDevice: manual('rememberDevice(): Atlas sessions are per device; manage them in <UserProfile />'),
  forgetDevice: manual('forgetDevice(): Atlas sessions are per device; manage them in <UserProfile />'),
  fetchDevices: manual('fetchDevices(): list sessions with useSessionList() from @atlasauth/react'),
  decodeJWT: manual('decodeJWT(): read verified claims with useAuth() (browser) or auth() from @atlasauth/nextjs/server'),
};

/** v5 `Auth` methods amplifyAuthV5Compat implements. */
const V5_SUPPORTED = new Set(['currentAuthenticatedUser', 'currentUserInfo', 'currentSession', 'signOut', 'federatedSignIn']);
const V5_MANUAL: Record<string, string> = {
  signIn: SIGN_IN_PAGE,
  signUp: SIGN_UP_PAGE,
  confirmSignUp: 'email/phone verification happens inside the Atlas sign-up flow',
  forgotPassword: 'password reset is built into the Atlas sign-in page',
  forgotPasswordSubmit: 'password reset is built into the Atlas sign-in page',
  changePassword: PROFILE,
  updateUserAttributes: PROFILE,
  confirmSignIn: 'challenges run inside the Atlas sign-in flow',
  completeNewPassword: 'challenges run inside the Atlas sign-in flow',
  setupTOTP: MFA,
  verifyTotpToken: MFA,
  setPreferredMFA: MFA,
  configure: 'remove the Auth section of the Amplify config',
};

const v5Auth: Target = {
  module: ATLAS.reactCompat,
  name: 'amplifyAuthV5Compat',
  accept: (ref) => {
    const parent = ref.parent?.node as { type?: string; object?: unknown; property?: { type?: string; name?: string }; computed?: boolean } | undefined;
    if (parent?.type === 'MemberExpression' && parent.object === ref.node && !parent.computed && parent.property?.type === 'Identifier') {
      const method = parent.property.name ?? '';
      if (V5_SUPPORTED.has(method)) return true;
      return `Auth.${method}(): ${V5_MANUAL[method] ?? 'no Atlas counterpart — migrate it manually'}`;
    }
    return 'the Amplify v5 Auth object is passed around here: call the amplifyAuthV5Compat methods (or the Atlas hooks) where it is used';
  },
};

/**
 * `Hub.listen('auth', cb)` → `amplifyHubListenCompat('auth', cb)`. Other channels
 * (and other Hub methods) stay on Amplify's Hub.
 */
const hub: Target = {
  module: ATLAS.reactCompat,
  name: 'amplifyHubListenCompat',
  accept: (ref) => {
    const parent = ref.parent as ASTPath | null;
    const member = parent?.node as { type?: string; object?: unknown; property?: { type?: string; name?: string }; computed?: boolean } | undefined;
    if (member?.type !== 'MemberExpression' || member.object !== ref.node || member.computed || member.property?.name !== 'listen') {
      return 'Hub: only Hub.listen("auth", …) has an Atlas counterpart; keep Amplify Hub for other channels';
    }
    const call = parent ? callOf(parent) : null;
    const channel = call?.args[0] as { type?: string; value?: unknown } | undefined;
    if (!channel || (channel.type !== 'StringLiteral' && channel.type !== 'Literal') || channel.value !== 'auth') {
      return 'Hub.listen() on a non-auth channel: it stays on Amplify';
    }
    return true;
  },
  // `amplifyHubListenCompat.listen(…)` → `amplifyHubListenCompat(…)`
  after: (ref, ctx) => {
    const parent = ref.parent as ASTPath | null;
    if (parent) parent.replace(ctx.j.identifier((ref.node as { name: string }).name));
  },
};

const RULES: readonly ModuleRule[] = [
  { match: 'aws-amplify/auth', named: V6_AUTH, otherNamed: 'no Atlas counterpart — migrate it manually' },
  { match: '@aws-amplify/auth', named: { ...V6_AUTH, Auth: v5Auth }, otherNamed: 'no Atlas counterpart — migrate it manually' },
  {
    match: (s) => s === 'aws-amplify/auth/server' || s === 'aws-amplify/adapter-core' || s === '@aws-amplify/adapter-nextjs' || s.startsWith('@aws-amplify/adapter-nextjs/'),
    otherNamed: `Amplify server context: ${SERVER}`,
  },
  {
    match: (s) => s === 'aws-amplify/utils' || s === '@aws-amplify/core',
    named: { Hub: hub },
    keepOthers: true,
  },
  {
    match: 'aws-amplify',
    named: { Auth: v5Auth, Hub: hub, Amplify: { keep: true } },
    keepOthers: true,
  },
  {
    match: '@aws-amplify/ui-react',
    named: {
      withAuthenticator: { module: ATLAS.reactCompat, name: 'withAmplifyAuthenticatorCompat' },
      useAuthenticator: { module: ATLAS.reactCompat, name: 'useAmplifyAuthenticatorCompat' },
      Authenticator: manual(
        '<Authenticator>: render <SignIn /> for signed-out users and wrap the signed-in UI in <SignedIn> (both from @atlasauth/react); its render-prop { user, signOut } is useAmplifyAuthenticatorCompat()',
      ),
      AccountSettings: manual('AccountSettings: use <UserProfile /> from @atlasauth/react'),
    },
    keepOthers: true,
  },
  {
    match: (s) => s === '@aws-amplify/ui-react-native' || s === '@aws-amplify/ui-vue' || s === '@aws-amplify/ui-angular',
    otherNamed: 'Amplify Authenticator UI: use the Atlas sign-in components for this framework',
  },
  {
    match: 'amazon-cognito-identity-js',
    otherNamed: `amazon-cognito-identity-js: ${SIGN_IN_PAGE}; read the session with useAuth() / useUser() from @atlasauth/react`,
  },
  {
    match: 'aws-jwt-verify',
    otherNamed:
      'CognitoJwtVerifier: verify Atlas session tokens with new AtlasBackend({ ... }).verify(token) from @atlasauth/backend; keep accepting Cognito tokens during the cutover with legacyIssuers',
  },
  {
    match: '@aws-sdk/client-cognito-identity-provider',
    otherNamed: 'Cognito admin API: use the Atlas Backend API (@atlasauth/backend users.*, organizations.*)',
  },
];

/** `Amplify.configure(config)`: only its Auth section is obsolete. */
function reportConfigure(ctx: VendorContext): void {
  const { j, root } = ctx;
  const amplifyImported = root
    .find(j.ImportDeclaration)
    .nodes()
    .some((n) => String(n.source.value) === 'aws-amplify' && (n.specifiers ?? []).some((s) => s.type === 'ImportSpecifier' && s.imported.name === 'Amplify'));
  if (!amplifyImported) return;
  root
    .find(j.CallExpression, { callee: { type: 'MemberExpression', object: { type: 'Identifier', name: 'Amplify' }, property: { name: 'configure' } } })
    .forEach((path) => {
      ctx.manual(path, 'Amplify.configure(): remove the Auth (Cognito) section; Atlas is configured by <AtlasProvider> and the Atlas dashboard. Delete the call if Amplify has nothing else to do');
    });
}

export default vendorTransform({
  mightApply: (source) => /amplify|cognito|aws-jwt-verify/i.test(source),
  run(ctx) {
    applyReexportRules(ctx, RULES);
    applyImportRules(ctx, RULES);
    reportConfigure(ctx);
  },
});
