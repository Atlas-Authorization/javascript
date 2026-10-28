import {
  applyImportRules,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type FileFacts,
  type ModuleRule,
  type VendorContext,
} from './engine';
import { memberChain } from './member-chain';

/**
 * Magic (magic.link) → Atlas. Magic has no drop-in Atlas counterpart (its
 * client is a method-call API that shows its own login UI), so nothing is
 * rewritten blind: every import of `magic-sdk`, `@magic-sdk/*` and
 * `@magic-ext/*` and every call on a Magic client (`magic.auth.loginWith…`,
 * `magic.user.*`, `magic.oauth.*`, `magic.users.getMetadataBy…`,
 * `Magic.token.validate`) is marked with the Atlas replacement, and the public
 * publishable-key env var is renamed to Atlas's.
 */

const CLIENT =
  "the Magic client has no drop-in: render <SignIn /> from @atlasauth/react in place of magic.auth.loginWith…, read the session with useAuth() / useUser(), and on the server verify tokens with AtlasBackend from @atlasauth/backend (the migration bridge accepts users' current DID tokens until they sign in again)";
const OTHER = 'Magic extensions and wallet SDKs have no Atlas counterpart: social login is configured as Atlas oauth_providers and shown by <SignIn />; wallet sign-in is Atlas "Sign in with Ethereum"';

const RULES: readonly ModuleRule[] = [
  {
    match: (s) => s === 'magic-sdk' || s.startsWith('@magic-sdk/') || s.startsWith('@magic-ext/'),
    named: { Magic: { manual: CLIENT } },
    default: { manual: CLIENT },
    otherNamed: OTHER,
    whole: CLIENT,
  },
];

const SIGN_IN = 'collect the credential on the Atlas sign-in page: render <SignIn /> from @atlasauth/react (or useSignIn() for a custom form)';
const USER_CALLS: Record<string, string> = {
  isLoggedIn: 'use useAuth().isSignedIn (or <SignedIn> / <SignedOut>)',
  getInfo: 'use useUser() from @atlasauth/react (server: the Atlas Backend API)',
  getMetadata: 'use useUser() from @atlasauth/react (server: the Atlas Backend API)',
  getIdToken: 'use useAuth().getToken() from @atlasauth/react; Atlas session tokens are verified with AtlasBackend, not as DID tokens',
  generateIdToken: 'use useAuth().getToken() from @atlasauth/react; Atlas session tokens are verified with AtlasBackend, not as DID tokens',
  logout: 'use useAuth().signOut() or <SignOutButton /> from @atlasauth/react',
  updateEmail: 'render <UserProfile /> from @atlasauth/react',
  showSettings: 'render <UserProfile /> from @atlasauth/react',
  recoverAccount: 'recovery is handled by Atlas sign-in (email code)',
};
const BACKEND = 'use the Atlas Backend API (createAtlasClient() from @atlasauth/backend, ATLAS_SECRET_KEY); look users up by id or email';
const VERIFY = 'verify the Atlas session token with AtlasBackend.verify from @atlasauth/backend (add the magic bridge preset while DID tokens are still sent)';

function note(members: string[]): string | undefined {
  const [group, method = ''] = members;
  switch (group) {
    case 'auth':
      return SIGN_IN;
    case 'oauth':
    case 'oauth2':
      return 'social login is configured as Atlas oauth_providers and shown by <SignIn />';
    case 'user':
      return USER_CALLS[method];
    case 'users':
      return BACKEND;
    case 'token':
      return VERIFY;
    case 'wallet':
    case 'rpcProvider':
      return 'wallet operations have no Atlas counterpart (keep Magic for the wallet, or use Atlas "Sign in with Ethereum" for sign-in only)';
    default:
      return undefined;
  }
}

function reportCalls(ctx: VendorContext): void {
  const { j, root } = ctx;
  root.find(j.CallExpression).forEach((path) => {
    const chain = memberChain(path.node.callee);
    if (!chain || chain.length < 3) return;
    const [receiver, ...members] = chain as [string, ...string[]];
    if (!/magic/i.test(receiver)) return;
    const message = note(members);
    if (message) ctx.manual(path, `${members.join('.')}(): ${message}`);
  });
}

/** `.env` keys that belong to Magic, with what replaces each. */
export function env(key: string, style: FileFacts['envStyle']): string | null {
  if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)MAGIC_(PUBLISHABLE_KEY|API_KEY)$/.test(key)) return `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`;
  if (key === 'MAGIC_PUBLISHABLE_KEY' || key === 'MAGIC_API_KEY') return `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`;
  if (key === 'MAGIC_SECRET_KEY') return 'replace with ATLAS_SECRET_KEY';
  if (/MAGIC_CLIENT_ID$/.test(key)) return 'keep only as the client_id of the magic bridge preset';
  return /(^|_)MAGIC_/.test(key) ? 'remove (no Atlas counterpart)' : null;
}

function envRename(style: FileFacts['envStyle']) {
  return (key: string): { to: string } | { report: string } | null => {
    const pub = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)MAGIC_(PUBLISHABLE_KEY|API_KEY)$/.exec(key);
    if (pub) return { to: `${pub[1]}ATLAS_PUBLISHABLE_KEY` };
    const note = env(key, style);
    return note && /^(replace|keep)/.test(note) ? { report: `${key}: ${note}` } : null;
  };
}

export default vendorTransform({
  mightApply: (source) => /magic-sdk|@magic-ext\/|MAGIC_(PUBLISHABLE|API|SECRET|CLIENT)/.test(source) || /\bmagic\w*\.(auth|user|users|oauth|oauth2|token|wallet)\./i.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    reportCalls(ctx);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});
