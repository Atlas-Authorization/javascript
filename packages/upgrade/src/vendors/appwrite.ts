import type { ASTPath, CallExpression } from 'jscodeshift';
import { applyImportRules, applyReexportRules, vendorTransform, type ModuleRule, type Target, type VendorContext } from './engine';
import { ATLAS } from './shared';

/**
 * Appwrite → Atlas. Appwrite keeps serving data (Databases, Storage,
 * Functions); its Account API moves:
 *
 *  - `new Account(client)` → `new AppwriteAccountCompat(client)` from
 *    `@atlasauth/react/compat`: `get()`, `getPrefs()`, `deleteSession('current')`,
 *    `deleteSessions()`, `createJWT()`, `createOAuth2Session()` keep working;
 *  - credential calls on it (`createEmailPasswordSession`, `create`,
 *    `createRecovery`, `updatePassword`, …) are marked: they run on Atlas's pages;
 *  - `node-appwrite` `Users` (admin) is reported: use `@atlasauth/backend`;
 *  - `Teams` is reported: organizations replace teams.
 *
 * Appwrite permissions that use `Role.user(...)`/`Role.users()` no longer see a
 * signed-in user from the browser; that data access moves behind your server
 * (API key) or an Appwrite Function that verifies the Atlas session JWT.
 */

const manual = (message: string): Target => ({ manual: message });
const DATA_AUTH =
  'Appwrite permissions (Role.user / Role.users / Role.team) no longer see the signed-in user once Appwrite sessions are gone: read that data through your server (API key) after verifying the Atlas session, or in a Function that verifies the Atlas JWT';

const RULES: readonly ModuleRule[] = [
  {
    match: 'appwrite',
    named: {
      Account: {
        module: ATLAS.reactCompat,
        name: 'AppwriteAccountCompat',
        after: (ref, ctx) => {
          if ((ref.parent?.node as { type?: string } | undefined)?.type === 'NewExpression') ctx.report(ref, DATA_AUTH);
        },
      },
      Teams: manual('Teams: Atlas organizations replace Appwrite teams (useOrganization() from @atlasauth/react, organizations.* from @atlasauth/backend)'),
      OAuthProvider: { keep: true },
      AuthenticationFactor: manual('AuthenticationFactor (MFA): MFA runs inside the Atlas sign-in flow and <UserProfile />'),
      AuthenticatorType: manual('AuthenticatorType (MFA): MFA runs inside the Atlas sign-in flow and <UserProfile />'),
    },
    keepOthers: true,
  },
  {
    match: 'node-appwrite',
    named: {
      Users: manual('node-appwrite Users: use the Atlas Backend API (@atlasauth/backend users.*); move existing users with `atlas migrate export appwrite`'),
      Account: manual(
        'node-appwrite Account with setSession (SSR): read the session with auth() / currentUser() from @atlasauth/nextjs/server; Atlas sets its own cookie',
      ),
      Teams: manual('node-appwrite Teams: Atlas organizations replace teams (organizations.* from @atlasauth/backend)'),
    },
    keepOthers: true,
  },
];

/** Account methods with no compat behaviour: each call site gets a marker. */
const CREDENTIAL_CALLS: Record<string, string> = {
  create: 'sign-up runs on the Atlas sign-up page: render <SignUp /> (or send users to /sign-up)',
  createEmailPasswordSession: 'credentials are collected on the Atlas sign-in page now: render <SignIn /> (or send users to /sign-in)',
  createEmailSession: 'credentials are collected on the Atlas sign-in page now: render <SignIn /> (or send users to /sign-in)',
  createSession: 'token sign-in: the Atlas sign-in page completes magic links and codes itself',
  createMagicURLToken: 'enable magic links in the Atlas dashboard; the sign-in page sends them',
  createMagicURLSession: 'enable magic links in the Atlas dashboard; the sign-in page sends them',
  updateMagicURLSession: 'Atlas completes magic links itself; delete this callback',
  createEmailToken: 'enable email codes in the Atlas dashboard; the sign-in page sends them',
  createPhoneToken: 'enable SMS codes in the Atlas dashboard; the sign-in page sends them',
  createPhoneSession: 'enable SMS codes in the Atlas dashboard; the sign-in page sends them',
  createAnonymousSession: 'enable anonymous users in the Atlas dashboard',
  updatePassword: 'password changes: <UserProfile /> or user.update() from @atlasauth/react',
  updateEmail: 'email changes: <UserProfile /> or user.update() from @atlasauth/react',
  updateName: 'name changes: <UserProfile /> or user.update() from @atlasauth/react',
  updatePhone: 'phone changes: <UserProfile />',
  updatePrefs: 'preferences: store them in unsafe_metadata (user.update() from @atlasauth/react)',
  createRecovery: 'password reset is built into the Atlas sign-in page ("Forgot password")',
  updateRecovery: 'password reset is built into the Atlas sign-in page',
  createVerification: 'Atlas verifies email addresses during sign-up and in <UserProfile />',
  updateVerification: 'Atlas verifies email addresses during sign-up and in <UserProfile />',
  createMfaAuthenticator: 'MFA enrolment runs in <UserProfile />',
  updateMfaAuthenticator: 'MFA enrolment runs in <UserProfile />',
  createMfaChallenge: 'MFA challenges run inside the Atlas sign-in flow',
  updateMfaChallenge: 'MFA challenges run inside the Atlas sign-in flow',
  listSessions: 'sessions: useSessionList() from @atlasauth/react',
  listIdentities: 'linked accounts: user.externalAccounts (connect/disconnect them in <UserProfile />)',
};

/** Local names holding `new AppwriteAccountCompat(...)` (after the import pass). */
function compatAccounts(ctx: VendorContext): Set<string> {
  const { j, root } = ctx;
  const names = new Set<string>();
  root.find(j.VariableDeclarator).forEach((path) => {
    const init = path.node.init as { type?: string; callee?: { type?: string; name?: string } } | null | undefined;
    if (init?.type === 'NewExpression' && init.callee?.type === 'Identifier' && init.callee.name === 'AppwriteAccountCompat' && path.node.id.type === 'Identifier') {
      names.add(path.node.id.name);
    }
  });
  return names;
}

function markCredentialCalls(ctx: VendorContext): void {
  const { j, root } = ctx;
  const accounts = compatAccounts(ctx);
  if (accounts.size === 0) return;
  root.find(j.CallExpression).forEach((path: ASTPath<CallExpression>) => {
    const callee = path.node.callee as { type?: string; computed?: boolean; object?: { type?: string; name?: string }; property?: { type?: string; name?: string } };
    if (callee.type !== 'MemberExpression' || callee.computed || callee.property?.type !== 'Identifier') return;
    if (callee.object?.type !== 'Identifier' || !accounts.has(callee.object.name ?? '')) return;
    const note = CREDENTIAL_CALLS[callee.property.name ?? ''];
    if (note) ctx.manual(path, `account.${callee.property.name}(): ${note}`);
  });
}

export default vendorTransform({
  mightApply: (source) => /appwrite/i.test(source),
  run(ctx) {
    applyReexportRules(ctx, RULES);
    applyImportRules(ctx, RULES);
    markCredentialCalls(ctx);
  },
});
