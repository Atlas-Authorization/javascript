import { applyImportRules, publicEnvKey, renameEnv, vendorTransform, type EnvStyle, type ModuleRule, type VendorContext } from './engine';
import { ATLAS } from './shared';

/**
 * Hanko → Atlas, across its two web packages:
 *
 *  - `@teamhanko/hanko-elements`: the `<hanko-auth>` and `<hanko-profile>`
 *    custom elements become `<SignIn />` and `<UserProfile />` from
 *    `@atlasauth/react` (their attributes configured Hanko's flow and are
 *    dropped); `register()` and the `Hanko` class are reported, `<hanko-events>`
 *    too.
 *  - `@teamhanko/hanko-frontend-sdk`: `new Hanko(api)` is reported, and so is
 *    each call that has an Atlas counterpart (`hanko.user.getCurrent()` →
 *    `useUser()`, `hanko.session.isValid()` → `useAuth().isSignedIn`,
 *    `hanko.logout()` → `useAuth().signOut()`, the session events).
 *  - `HANKO_API_URL` and friends.
 *
 * Verifying a Hanko session JWT on a server with `jose` and the API's
 * `/.well-known/jwks.json` is the `--from jose` codemod.
 */

const REGISTER = 'register(api): delete it; the Hanko web components are replaced by <SignIn /> and <UserProfile /> from @atlasauth/react';
const CLIENT = 'the Hanko client: read the session with useAuth() / useUser() from @atlasauth/react and sign out with useAuth().signOut()';

const RULES: readonly ModuleRule[] = [
  {
    match: '@teamhanko/hanko-elements',
    named: {
      register: { manual: REGISTER },
      Hanko: { manual: `Hanko(api): ${CLIENT}` },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
    whole: `namespace import of '@teamhanko/hanko-elements' — replace the web components with <SignIn /> and <UserProfile /> from @atlasauth/react`,
  },
  {
    match: (s) => s.startsWith('@teamhanko/hanko-elements/'),
    named: {},
    otherNamed: 'no Atlas counterpart — migrate it manually',
    whole: 'Hanko web component import: delete it; <SignIn /> and <UserProfile /> from @atlasauth/react replace <hanko-auth> and <hanko-profile>',
  },
  {
    match: '@teamhanko/hanko-frontend-sdk',
    named: {
      Hanko: { manual: `new Hanko(api): ${CLIENT}` },
    },
    otherNamed: 'Hanko error classes and types are not needed with Atlas; failed calls throw typed errors you can branch on (see the SDK reference)',
    whole: `namespace import of '@teamhanko/hanko-frontend-sdk' — ${CLIENT}`,
  },
];

/** Hanko frontend-sdk methods that have an Atlas counterpart. */
const SDK_CALLS: Record<string, string> = {
  getCurrent: 'hanko.user.getCurrent(): useUser() from @atlasauth/react (currentUser() on the server)',
  isValid: 'hanko.session.isValid(): useAuth().isSignedIn from @atlasauth/react',
  getAuthToken: 'hanko session token: await useAuth().getToken() sends the Atlas session token to your API',
  logout: 'hanko.logout(): useAuth().signOut() or <SignOutButton /> from @atlasauth/react',
  onSessionCreated: 'onSessionCreated(): react to useAuth().isSignedIn changing (an effect)',
  onSessionExpired: 'onSessionExpired(): onAtlasSignOut(handler) from @atlasauth/react reports sign-outs and expiry',
  onUserLoggedOut: 'onUserLoggedOut(): onAtlasSignOut(handler) from @atlasauth/react',
  onAuthFlowCompleted: 'onAuthFlowCompleted(): <SignIn /> continues to your app by itself when the flow completes (set the redirect in the Atlas dashboard)',
  onUserDeleted: 'onUserDeleted(): onAtlasSignOut(handler) from @atlasauth/react (a deleted user is signed out)',
};

const ELEMENTS: Record<string, { component: string; note: string }> = {
  'hanko-auth': { component: 'SignIn', note: '<hanko-auth> is now <SignIn />' },
  'hanko-profile': { component: 'UserProfile', note: '<hanko-profile> is now <UserProfile />' },
};

function importsHanko(ctx: VendorContext): boolean {
  const { j, root } = ctx;
  return root.find(j.ImportDeclaration).nodes().some((n) => String(n.source.value).startsWith('@teamhanko/'));
}

/** `<hanko-auth />` → `<SignIn />`, `<hanko-profile />` → `<UserProfile />`; `<hanko-events>` reported. */
function elements(ctx: VendorContext): void {
  const { j, root } = ctx;
  root.find(j.JSXElement).forEach((path) => {
    const opening = path.node.openingElement;
    if (opening.name.type !== 'JSXIdentifier') return;
    const tag = opening.name.name;
    if (tag === 'hanko-events') {
      ctx.report(path, '<hanko-events>: its session and flow events are useAuth() state and onAtlasSignOut() from @atlasauth/react');
      return;
    }
    const target = ELEMENTS[tag];
    if (!target) return;
    const local = ctx.ensureImport(ATLAS.react, target.component);
    const names = (opening.attributes ?? []).map((a) => (a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' ? a.name.name : '…'));
    opening.name = j.jsxIdentifier(local);
    if (path.node.closingElement) path.node.closingElement.name = j.jsxIdentifier(local);
    opening.attributes = [];
    ctx.rewrote();
    ctx.report(path, `${target.note}${names.length ? `; its attributes (${names.join(', ')}) configured Hanko's flow: set sign-in methods in the Atlas dashboard` : ''}`);
  });
}

/** Calls on a Hanko client, in a file that imports Hanko. */
function sdkCalls(ctx: VendorContext): void {
  if (!importsHanko(ctx)) return;
  const { j, root } = ctx;
  root.find(j.CallExpression).forEach((path) => {
    const callee = path.node.callee as { type: string; computed?: boolean; property?: { type: string; name?: string } };
    if ((callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') || callee.computed || callee.property?.type !== 'Identifier') return;
    const note = SDK_CALLS[callee.property.name!];
    if (note) ctx.manual(path, note);
  });
}

/** `.env` slots: where the value now comes from. */
function envRename(style: EnvStyle) {
  return (key: string): { to: string } | { report: string } | null => {
    const m = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?HANKO_(.+)$/.exec(key);
    if (!m) return null;
    const prefix = m[1] ?? '';
    const rest = m[2]!;
    if (/^(API_URL|API|URL|BASE_URL)$/.test(rest)) {
      return prefix ? { to: `${prefix}ATLAS_FRONTEND_API` } : { report: `${key}: the Hanko API URL; the browser uses ${publicEnvKey(style, 'FRONTEND_API')}, servers verify tokens with ATLAS_JWKS_URL` };
    }
    if (rest === 'JWKS_URL') return { to: 'ATLAS_JWKS_URL' };
    if (/^(API_KEY|SECRET|SECRET_KEY|ADMIN_API_KEY)$/.test(rest)) return { report: `${key}: server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)` };
    return null;
  };
}

export default vendorTransform({
  mightApply: (source) => /@teamhanko\/|hanko-(auth|profile|events)|HANKO_/.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    elements(ctx);
    sdkCalls(ctx);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});

export const hankoPackages = (name: string): boolean => name.startsWith('@teamhanko/hanko-');

export const hankoEnv = (key: string, style: EnvStyle): string | null => {
  const m = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?HANKO_(.+)$/.exec(key);
  if (!m) return null;
  const prefix = m[1] ?? '';
  const rest = m[2]!;
  if (/^(API_URL|API|URL|BASE_URL)$/.test(rest)) return prefix ? `replace with ${publicEnvKey(style, 'FRONTEND_API')}` : 'remove (servers verify tokens with ATLAS_JWKS_URL)';
  if (rest === 'JWKS_URL') return 'replace with ATLAS_JWKS_URL';
  if (/^(API_KEY|SECRET|SECRET_KEY|ADMIN_API_KEY)$/.test(rest)) return 'remove; set ATLAS_SECRET_KEY';
  return 'remove (not needed with Atlas)';
};
