import type { ASTNode, ASTPath, CallExpression, MemberExpression } from 'jscodeshift';
import {
  applyImportRules,
  applyReexportRules,
  dropJsxAttrs,
  renameEnv,
  vendorTransform,
  type ModuleRule,
  type Target,
  type VendorContext,
} from './engine';
import { ATLAS } from './shared';

/**
 * Firebase Auth → Atlas. Firebase stays (Firestore, Storage, Functions…); only
 * its AUTH surface moves:
 *
 *  - `firebase/auth`: `onAuthStateChanged`, `onIdTokenChanged`, `signOut`,
 *    `getIdToken`, `signInWithRedirect` and the `User` type → the
 *    `@atlasauth/react/compat` helpers (same arguments; the `auth` instance is
 *    accepted and ignored); `auth.currentUser` → `getFirebaseCurrentUserCompat()`;
 *  - the v8 / compat API (`firebase.auth().onAuthStateChanged(cb)`, …) → the same helpers;
 *  - `react-firebase-hooks/auth` `useAuthState` / `useIdToken` → compat hooks;
 *  - FirebaseUI (`StyledFirebaseAuth`, `FirebaseAuth`) → `<SignIn />`;
 *  - credential flows, providers, MFA and the Admin SDK's auth calls are
 *    reported with their Atlas counterpart: sign-in runs on Atlas's pages, and
 *    server code verifies Atlas session tokens with `@atlasauth/backend`.
 */

const SIGN_IN_PAGE = 'credentials are collected on the Atlas sign-in page now: render <SignIn /> (or send users to /sign-in)';
const PROVIDERS =
  'social and enterprise providers are enabled in the Atlas dashboard and shown on the sign-in page; delete the provider object';
const PROFILE = 'profile, email and password changes: use <UserProfile /> or user.update() from @atlasauth/react';
const MFA = 'MFA enrolment and challenges run inside the Atlas sign-in flow and <UserProfile />';

const manual = (message: string): Target => ({ manual: message });

const AUTH_NAMED: Record<string, Target> = {
  onAuthStateChanged: { module: ATLAS.reactCompat, name: 'onFirebaseAuthStateChangedCompat' },
  onIdTokenChanged: { module: ATLAS.reactCompat, name: 'onFirebaseIdTokenChangedCompat' },
  signOut: { module: ATLAS.reactCompat, name: 'firebaseSignOutCompat' },
  getIdToken: { module: ATLAS.reactCompat, name: 'getFirebaseIdTokenCompat' },
  signInWithRedirect: { module: ATLAS.reactCompat, name: 'firebaseSignInWithRedirectCompat' },
  User: { module: ATLAS.reactCompat, name: 'FirebaseCompatUser', typeOnly: true },
  UserInfo: { module: ATLAS.reactCompat, name: 'FirebaseCompatUser', typeOnly: true },
  IdTokenResult: { module: ATLAS.reactCompat, name: 'FirebaseCompatIdTokenResult', typeOnly: true },
  // The auth instance is still passed to the compat helpers (and ignored there).
  getAuth: { keep: true },
  initializeAuth: { keep: true },
  Auth: { keep: true },
  getRedirectResult: manual('getRedirectResult(): Atlas completes OAuth redirects on its own pages; remove this call'),
  signInWithPopup: manual(`signInWithPopup(): ${SIGN_IN_PAGE}; the social buttons there replace the popup`),
  signInWithEmailAndPassword: manual(`signInWithEmailAndPassword(): ${SIGN_IN_PAGE}`),
  createUserWithEmailAndPassword: manual('createUserWithEmailAndPassword(): sign-up runs on the Atlas sign-up page: render <SignUp /> (or send users to /sign-up)'),
  signInAnonymously: manual('signInAnonymously(): enable anonymous users in the Atlas dashboard'),
  signInWithCustomToken: manual('signInWithCustomToken(): mint an Atlas sign-in token on your server (signInTokens.create from @atlasauth/backend) and redeem it in the browser'),
  signInWithCredential: manual('signInWithCredential(): native Google/Apple ID-token sign-in uses the Atlas native SDKs'),
  signInWithPhoneNumber: manual('signInWithPhoneNumber(): enable SMS codes in the Atlas dashboard; the sign-in page sends and checks them'),
  RecaptchaVerifier: manual('RecaptchaVerifier: Atlas runs its own bot protection on the sign-in page; delete it'),
  sendSignInLinkToEmail: manual('sendSignInLinkToEmail(): enable magic links in the Atlas dashboard; the sign-in page sends them'),
  isSignInWithEmailLink: manual('isSignInWithEmailLink(): Atlas completes magic links itself; remove this check'),
  signInWithEmailLink: manual('signInWithEmailLink(): Atlas completes magic links itself; remove this call'),
  sendPasswordResetEmail: manual('sendPasswordResetEmail(): password reset is built into the Atlas sign-in page ("Forgot password")'),
  confirmPasswordReset: manual('confirmPasswordReset(): password reset is built into the Atlas sign-in page'),
  verifyPasswordResetCode: manual('verifyPasswordResetCode(): password reset is built into the Atlas sign-in page'),
  applyActionCode: manual('applyActionCode(): Atlas handles verification and reset links itself; delete this action handler'),
  checkActionCode: manual('checkActionCode(): Atlas handles verification and reset links itself; delete this action handler'),
  sendEmailVerification: manual('sendEmailVerification(): Atlas verifies email addresses during sign-up and in <UserProfile />'),
  fetchSignInMethodsForEmail: manual('fetchSignInMethodsForEmail(): the Atlas sign-in page decides the method per user'),
  updateProfile: manual(`updateProfile(): ${PROFILE}`),
  updateEmail: manual(`updateEmail(): ${PROFILE}`),
  verifyBeforeUpdateEmail: manual(`verifyBeforeUpdateEmail(): ${PROFILE}`),
  updatePassword: manual(`updatePassword(): ${PROFILE}`),
  updatePhoneNumber: manual(`updatePhoneNumber(): ${PROFILE}`),
  deleteUser: manual('deleteUser(): users delete their account from <UserProfile /> (or call users.delete from @atlasauth/backend on your server)'),
  reauthenticateWithCredential: manual('reauthenticateWithCredential(): step-up verification is useReverification() from @atlasauth/react'),
  reauthenticateWithPopup: manual('reauthenticateWithPopup(): step-up verification is useReverification() from @atlasauth/react'),
  linkWithPopup: manual('linkWithPopup(): users connect accounts from <UserProfile />'),
  linkWithRedirect: manual('linkWithRedirect(): users connect accounts from <UserProfile />'),
  linkWithCredential: manual('linkWithCredential(): users connect accounts from <UserProfile />'),
  unlink: manual('unlink(): users disconnect accounts from <UserProfile />'),
  multiFactor: manual(`multiFactor(): ${MFA}`),
  getMultiFactorResolver: manual(`getMultiFactorResolver(): ${MFA}`),
  TotpMultiFactorGenerator: manual(`TotpMultiFactorGenerator: ${MFA}`),
  PhoneMultiFactorGenerator: manual(`PhoneMultiFactorGenerator: ${MFA}`),
  setPersistence: manual('setPersistence(): Atlas keeps the session in its own cookie; remove this call'),
  browserLocalPersistence: manual('browserLocalPersistence: Atlas keeps the session in its own cookie; remove it'),
  browserSessionPersistence: manual('browserSessionPersistence: Atlas keeps the session in its own cookie; remove it'),
  inMemoryPersistence: manual('inMemoryPersistence: Atlas keeps the session in its own cookie; remove it'),
  indexedDBLocalPersistence: manual('indexedDBLocalPersistence: Atlas keeps the session in its own cookie; remove it'),
  connectAuthEmulator: manual('connectAuthEmulator(): point a development Atlas instance at your app instead of the Auth emulator'),
  GoogleAuthProvider: manual(`GoogleAuthProvider: ${PROVIDERS}`),
  GithubAuthProvider: manual(`GithubAuthProvider: ${PROVIDERS}`),
  FacebookAuthProvider: manual(`FacebookAuthProvider: ${PROVIDERS}`),
  TwitterAuthProvider: manual(`TwitterAuthProvider: ${PROVIDERS}`),
  OAuthProvider: manual(`OAuthProvider: ${PROVIDERS}`),
  SAMLAuthProvider: manual(`SAMLAuthProvider: ${PROVIDERS}`),
  EmailAuthProvider: manual('EmailAuthProvider: password sign-in is on the Atlas sign-in page; delete the credential'),
  PhoneAuthProvider: manual('PhoneAuthProvider: SMS codes are on the Atlas sign-in page; delete the provider'),
};

const RULES: readonly ModuleRule[] = [
  {
    match: (s) => s === 'firebase/auth' || s === '@firebase/auth' || s === 'firebase/auth/web-extension' || s === 'firebase/auth/cordova',
    named: AUTH_NAMED,
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: 'react-firebase-hooks/auth',
    named: {
      useAuthState: { module: ATLAS.reactCompat, name: 'useFirebaseAuthStateCompat' },
      useIdToken: { module: ATLAS.reactCompat, name: 'useFirebaseIdTokenCompat' },
      useSignOut: manual('useSignOut(): use useAuth().signOut from @atlasauth/react (or <SignOutButton />)'),
    },
    otherNamed: `react-firebase-hooks credential hook: ${SIGN_IN_PAGE}`,
  },
  {
    match: (s) => s === 'react-firebaseui' || s.startsWith('react-firebaseui/'),
    default: {
      module: ATLAS.react,
      name: 'SignIn',
      after: (ref, ctx) => {
        const parent = ref.parent?.node as { type?: string; attributes?: ASTNode[] } | undefined;
        if (parent?.type !== 'JSXOpeningElement') return;
        const names = (parent.attributes ?? [])
          .map((a) => (a as { name?: { name?: string } }).name?.name)
          .filter((n): n is string => Boolean(n));
        const dropped = dropJsxAttrs(parent, names);
        if (dropped.length > 0) {
          ctx.report(ref, `FirebaseUI is now Atlas's <SignIn />; its props (${dropped.join(', ')}) are configured in the Atlas dashboard instead`);
        }
      },
    },
    otherNamed: 'FirebaseUI: use <SignIn /> and <SignUp /> from @atlasauth/react',
  },
  {
    match: (s) => s === 'firebaseui' || s.startsWith('firebaseui/'),
    whole: 'FirebaseUI: render <SignIn /> from @atlasauth/react instead, and delete the FirebaseUI setup',
    otherNamed: 'FirebaseUI: render <SignIn /> from @atlasauth/react instead',
    default: manual('FirebaseUI: render <SignIn /> from @atlasauth/react instead, and delete the FirebaseUI setup'),
  },
  {
    match: 'reactfire',
    named: {
      useSigninCheck: manual('useSigninCheck(): use useAuth() from @atlasauth/react ({ isLoaded, isSignedIn }); role checks use has()'),
      useUser: manual('reactfire useUser(): use useUser() from @atlasauth/react, or useFirebaseAuthStateCompat() for a Firebase-shaped user'),
      useAuth: { keep: true },
      AuthProvider: manual('reactfire <AuthProvider>: wrap the app in <AtlasProvider> from @atlasauth/react'),
      useIdTokenResult: manual('useIdTokenResult(): read session claims with useAuth() from @atlasauth/react'),
    },
    keepOthers: true,
  },
];

/** Admin SDK auth methods → what replaces them. */
const ADMIN: Record<string, string> = {
  verifyIdToken: 'verify the Atlas session token instead: new AtlasBackend({ ... }).verify(token) from @atlasauth/backend (keep accepting Firebase ID tokens during the cutover with legacyIssuers)',
  verifySessionCookie: 'Atlas sets and verifies its own session cookie: auth() from @atlasauth/nextjs/server, or AtlasBackend.authenticateRequest()',
  createSessionCookie: 'Atlas sets its own session cookie at sign-in; delete this session-login route',
  revokeRefreshTokens: 'revoke sessions with sessions.revoke / users.revokeSessions from @atlasauth/backend',
  createCustomToken: 'custom tokens: mint an Atlas sign-in token (signInTokens.create) or a JWT template token instead',
  setCustomUserClaims: 'custom claims: set users.update({ public_metadata }) from @atlasauth/backend; a JWT template copies them into the session token',
  getUser: 'read users with users.get(id) from @atlasauth/backend (Atlas ids; the Firebase uid is the external id)',
  getUserByEmail: 'read users with users.list({ email_address }) from @atlasauth/backend',
  getUserByPhoneNumber: 'read users with users.list({ phone_number }) from @atlasauth/backend',
  getUsers: 'read users with users.list() from @atlasauth/backend',
  listUsers: 'list users with users.list() from @atlasauth/backend',
  createUser: 'create users with users.create() from @atlasauth/backend',
  updateUser: 'update users with users.update() from @atlasauth/backend',
  deleteUser: 'delete users with users.delete() from @atlasauth/backend',
  deleteUsers: 'delete users with users.delete() from @atlasauth/backend',
  importUsers: 'move users with `atlas migrate export firebase` and the Atlas import, not importUsers()',
  generatePasswordResetLink: 'password reset is built into the Atlas sign-in page',
  generateEmailVerificationLink: 'Atlas verifies email addresses during sign-up and in <UserProfile />',
  generateSignInWithEmailLink: 'mint an Atlas sign-in token (signInTokens.create from @atlasauth/backend)',
  tenantManager: 'Identity Platform tenants: one Atlas instance (or organization) per tenant',
  projectConfigManager: 'auth settings live in the Atlas dashboard; `atlas migrate config firebase` translates them',
};

/** True when a file uses the Firebase SDK (any Firebase module, or a local firebase helper). */
function usesFirebase(ctx: VendorContext): boolean {
  const { j, root } = ctx;
  return root
    .find(j.ImportDeclaration)
    .nodes()
    .some((n) => /firebase/i.test(String(n.source.value)));
}

function importsAdmin(ctx: VendorContext): boolean {
  const { j, root } = ctx;
  const imports = root.find(j.ImportDeclaration).nodes().some((n) => String(n.source.value).startsWith('firebase-admin'));
  if (imports) return true;
  // CommonJS: require('firebase-admin') / require('firebase-admin/auth')
  return root
    .find(j.CallExpression, { callee: { type: 'Identifier', name: 'require' } })
    .nodes()
    .some((n) => {
      const arg = n.arguments[0] as { value?: unknown } | undefined;
      return typeof arg?.value === 'string' && arg.value.startsWith('firebase-admin');
    });
}

/** `<x>.auth()` — the v8 / compat / Admin SDK auth accessor. */
function isAuthAccessorCall(node: ASTNode | undefined): boolean {
  const n = node as { type?: string; arguments?: unknown[]; callee?: { type?: string; property?: { type?: string; name?: string }; computed?: boolean } } | undefined;
  return (
    n?.type === 'CallExpression' &&
    (n.arguments?.length ?? 0) === 0 &&
    (n.callee?.type === 'MemberExpression' || n.callee?.type === 'OptionalMemberExpression') &&
    !n.callee.computed &&
    n.callee.property?.type === 'Identifier' &&
    n.callee.property.name === 'auth'
  );
}

/** An identifier that conventionally holds the Firebase auth instance. */
const AUTH_NAME = /^(auth|firebaseAuth|fbAuth|clientAuth)$/;

/** v8/compat: `firebase.auth().onAuthStateChanged(cb)` → `onFirebaseAuthStateChangedCompat(null, cb)`. */
const V8_METHODS: Record<string, string> = {
  onAuthStateChanged: 'onFirebaseAuthStateChangedCompat',
  onIdTokenChanged: 'onFirebaseIdTokenChangedCompat',
  signOut: 'firebaseSignOutCompat',
  signInWithRedirect: 'firebaseSignInWithRedirectCompat',
};

const V8_MANUAL: Record<string, string> = {
  signInWithEmailAndPassword: SIGN_IN_PAGE,
  createUserWithEmailAndPassword: 'sign-up runs on the Atlas sign-up page: render <SignUp /> (or send users to /sign-up)',
  signInWithPopup: `${SIGN_IN_PAGE}; the social buttons there replace the popup`,
  sendPasswordResetEmail: 'password reset is built into the Atlas sign-in page ("Forgot password")',
  signInAnonymously: 'enable anonymous users in the Atlas dashboard',
  signInWithCustomToken: 'mint an Atlas sign-in token on your server (signInTokens.create from @atlasauth/backend)',
  setPersistence: 'Atlas keeps the session in its own cookie; remove this call',
  getRedirectResult: 'Atlas completes OAuth redirects on its own pages; remove this call',
  useEmulator: 'point a development Atlas instance at your app instead of the Auth emulator',
};

function rewriteAuthMembers(ctx: VendorContext): void {
  const { j, root } = ctx;
  const browser = ctx.facts.kind !== 'server';
  const admin = importsAdmin(ctx);
  // `auth.currentUser` and `x.auth().signOut()` mean Firebase only in a file that uses it.
  if (!admin && !usesFirebase(ctx)) return;

  root.find(j.CallExpression).forEach((path: ASTPath<CallExpression>) => {
    const callee = path.node.callee as MemberExpression | { type: string };
    if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return;
    const member = callee as MemberExpression;
    if (member.computed || member.property.type !== 'Identifier') return;
    const method = member.property.name;
    const onAccessor = isAuthAccessorCall(member.object as ASTNode);
    const onAuthName = member.object.type === 'Identifier' && AUTH_NAME.test(member.object.name);

    // Admin SDK: getAuth().verifyIdToken(t), admin.auth().getUser(uid), auth.setCustomUserClaims(…)
    if (admin && ADMIN[method]) {
      const obj = member.object as { type?: string; callee?: { type?: string; name?: string } };
      const onGetAuth = obj.type === 'CallExpression' && obj.callee?.type === 'Identifier' && obj.callee.name === 'getAuth';
      if (onAccessor || onAuthName || onGetAuth) {
        ctx.manual(path, `Firebase Admin ${method}(): ${ADMIN[method]}`);
        return;
      }
    }
    if (admin || !onAccessor) return;

    // v8 / compat client API on firebase.auth()
    const peer = V8_METHODS[method];
    if (peer && browser) {
      const local = ctx.ensureImport(ATLAS.reactCompat, peer);
      path.node.callee = j.identifier(local);
      path.node.arguments = [j.literal(null) as never, ...path.node.arguments];
      ctx.rewrote();
      return;
    }
    const note = V8_MANUAL[method];
    if (note) ctx.manual(path, `firebase.auth().${method}(): ${note}`);
    else if (peer) ctx.manual(path, `firebase.auth().${method}() on the server: sessions are read with auth() from @atlasauth/nextjs/server`);
  });

  // `auth.currentUser` / `firebase.auth().currentUser` (read, browser side) → getFirebaseCurrentUserCompat()
  if (!browser || admin) return;
  root.find(j.MemberExpression).forEach((path: ASTPath<MemberExpression>) => {
    const node = path.node;
    if (node.computed || node.property.type !== 'Identifier' || node.property.name !== 'currentUser') return;
    const onAuth = (node.object.type === 'Identifier' && AUTH_NAME.test(node.object.name)) || isAuthAccessorCall(node.object as ASTNode);
    if (!onAuth) return;
    const parent = path.parent?.node as { type?: string; left?: unknown } | undefined;
    if (parent?.type === 'AssignmentExpression' && parent.left === node) return;
    const local = ctx.ensureImport(ATLAS.reactCompat, 'getFirebaseCurrentUserCompat');
    path.replace(j.callExpression(j.identifier(local), []));
    ctx.rewrote();
  });
}

export default vendorTransform({
  mightApply: (source) => /firebase|FIREBASE_/i.test(source),
  run(ctx) {
    applyReexportRules(ctx, RULES);
    applyImportRules(ctx, RULES);
    rewriteAuthMembers(ctx);
    renameEnv(ctx, (key) => {
      if (key === 'FIREBASE_AUTH_EMULATOR_HOST') return { report: 'FIREBASE_AUTH_EMULATOR_HOST: use a development Atlas instance instead of the Auth emulator' };
      if (/^(GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_SERVICE_ACCOUNT\w*)$/.test(key) && importsAdmin(ctx)) {
        return { report: `${key}: still needed for Firestore/Storage, but auth calls now use ATLAS_SECRET_KEY with @atlasauth/backend` };
      }
      return null;
    });
  },
});
