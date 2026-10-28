import type { ASTNode, ASTPath } from 'jscodeshift';
import {
  applyImportRules,
  dropJsxAttrs,
  fixProviderProps,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type FileFacts,
  type ModuleRule,
  type Target,
  type VendorContext,
} from './engine';
import { memberChain } from './member-chain';
import { ATLAS } from './shared';

/**
 * Corbado → Atlas, across `@corbado/react`, `@corbado/web-js` and the
 * `@corbado/node-sdk` / `@corbado/node` backend SDKs:
 *
 *  - `<CorbadoProvider projectId>` → `<AtlasProvider>` (`projectId` →
 *    `publishableKey`, `frontendApiUrl` and styling props dropped);
 *    `<CorbadoAuth />` → `<SignIn />`; `<PasskeyList />` → `<ManagePasskeys />`;
 *    other components, `useCorbado()` and the other hooks are reported.
 *  - `@corbado/web-js` (`corbado.load`, `mountAuthUI`, `logout`, `user`,
 *    `sessionService`) and the node SDK (`sessions().getCurrentUser` /
 *    `validateToken`, `users()`, `identifiers()`) are marked at each call with
 *    the Atlas replacement.
 *  - the project id / API secret env vars are renamed or reported.
 */

const PROVIDER_DROP = [
  'frontendApiUrl',
  'darkMode',
  'theme',
  'isDevMode',
  'customDomain',
  'languageCode',
  'setShortSessionCookie',
  'shortSessionCookieDomain',
  'isPreviewMode',
  'spaceId',
  'enableDevMode',
  'onError',
];

const provider: Target = {
  module: ATLAS.react,
  name: 'AtlasProvider',
  after: (ref, ctx) => fixProviderProps(ctx, ref, { map: { publishableKey: 'projectId' }, drop: PROVIDER_DROP }),
};

/** A Corbado component that becomes a prop-less Atlas one: its props are removed and reported. */
function component(corbado: string, atlas: string, extra: string): Target {
  return {
    module: ATLAS.react,
    name: atlas,
    after: (ref, ctx) => {
      const opening = ref.parent?.node as { type?: string; attributes?: ASTNode[] } | undefined;
      if (opening?.type !== 'JSXOpeningElement') return;
      const names = (opening.attributes ?? [])
        .map((a) => a as { type: string; name?: { name?: unknown } })
        .filter((a) => a.type === 'JSXAttribute' && typeof a.name?.name === 'string')
        .map((a) => a.name!.name as string);
      const dropped = dropJsxAttrs(opening, names);
      if (dropped.length > 0) ctx.report(ref, `<${corbado}> is now Atlas's <${atlas} />; removed props with no Atlas counterpart: ${dropped.join(', ')} (${extra})`);
    },
  };
}

const SESSION =
  'verify the Atlas session token with AtlasBackend from @atlasauth/backend (verify(token) resolves { ok, claims }), and read users with the Atlas Backend API (createAtlasClient(), ATLAS_SECRET_KEY); add the corbado bridge preset while Corbado short sessions are still sent';
const NODE_OTHER = `Corbado's backend SDK has no Atlas counterpart: ${SESSION}`;
const WEB_OTHER = "Corbado's web SDK has no Atlas counterpart: render <SignIn /> / <ManagePasskeys /> from @atlasauth/react and read the session with useAuth() / useUser()";

const RULES: readonly ModuleRule[] = [
  {
    match: '@corbado/react',
    named: {
      CorbadoProvider: provider,
      CorbadoAuth: component('CorbadoAuth', 'SignIn', 'sign-in methods, passkey-first behaviour and redirects are configured in the Atlas dashboard; pass afterUrl to <SignIn /> for where to go next'),
      PasskeyList: component('PasskeyList', 'ManagePasskeys', 'passkeys are managed per signed-in user'),
      useCorbado: { manual: 'useCorbado(): use useAuth() (isSignedIn, getToken, signOut) and useUser() from @atlasauth/react' },
    },
    otherNamed: 'no Atlas counterpart: build this screen from <SignIn />, <SignUp />, <UserProfile /> or the hooks of @atlasauth/react',
    whole: WEB_OTHER,
  },
  { match: (s) => s.startsWith('@corbado/') && s !== '@corbado/react' && !/node/.test(s), default: { manual: WEB_OTHER }, otherNamed: WEB_OTHER, whole: WEB_OTHER },
  { match: (s) => /^@corbado\/node/.test(s), default: { manual: NODE_OTHER }, otherNamed: NODE_OTHER, whole: NODE_OTHER },
];

const NODE_CALLS: Record<string, string> = {
  getCurrentUser: SESSION,
  validateToken: SESSION,
  getAndValidateShortSessionValue: SESSION,
  users: 'manage users with the Atlas Backend API (createAtlasClient() from @atlasauth/backend, ATLAS_SECRET_KEY)',
  identifiers: 'manage users with the Atlas Backend API (createAtlasClient() from @atlasauth/backend, ATLAS_SECRET_KEY)',
};
const WEB_CALLS: Record<string, string> = {
  load: 'render <AtlasProvider> from @atlasauth/react (publishableKey) instead of loading the SDK',
  mountAuthUI: 'render <SignIn /> from @atlasauth/react',
  mountPasskeyListUI: 'render <ManagePasskeys /> from @atlasauth/react',
  logout: 'use useAuth().signOut() or <SignOutButton /> from @atlasauth/react',
  user: 'use useUser() from @atlasauth/react',
  shortSession: 'use useAuth().getToken() from @atlasauth/react',
  sessionService: 'use useAuth().getToken() from @atlasauth/react',
};

function reportCalls(ctx: VendorContext): void {
  const { j, root } = ctx;
  const imports = root.find(j.ImportDeclaration).nodes().map((n) => String(n.source.value));
  const node = imports.some((s) => /^@corbado\/node/.test(s));
  const web = imports.some((s) => s === '@corbado/web-js');
  if (!node && !web) return;
  root.find(j.CallExpression).forEach((path: ASTPath) => {
    const callee = (path.node as { callee: unknown }).callee as { type?: string; computed?: boolean; property?: { type?: string; name?: string }; object?: unknown };
    if ((callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') || callee.computed || callee.property?.type !== 'Identifier') return;
    const method = callee.property.name!;
    const chain = memberChain(callee);
    const table = node ? NODE_CALLS : WEB_CALLS;
    // Web SDK: `corbado.mountAuthUI(...)`, `corbado.user`-style members: only on a receiver named like the SDK.
    if (!node && !(chain && /corbado/i.test(chain[0]!))) return;
    if (Object.hasOwn(table, method)) ctx.manual(path, `${method}(): ${table[method]}`);
  });
}

/** `.env` keys that belong to Corbado, with what replaces each. */
export function env(key: string, style: FileFacts['envStyle']): string | null {
  if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)?CORBADO_PROJECT_ID$/.test(key)) return `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')} (keep the Corbado project id only as the project_id of the corbado bridge preset)`;
  if (key === 'CORBADO_API_SECRET' || key === 'CORBADO_API_KEY') return 'replace with ATLAS_SECRET_KEY';
  if (/CORBADO_(FRONTEND_API|BACKEND_API|CNAME|ISSUER)/.test(key)) return 'remove (not needed with Atlas)';
  return /(^|_)CORBADO_/.test(key) ? 'remove (no Atlas counterpart)' : null;
}

function envRename(style: FileFacts['envStyle']) {
  return (key: string): { to: string } | { report: string } | null => {
    const pub = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)CORBADO_PROJECT_ID$/.exec(key);
    if (pub) return { to: `${pub[1]}ATLAS_PUBLISHABLE_KEY` };
    const note = env(key, style);
    return note ? { report: `${key}: ${note}` } : null;
  };
}

export default vendorTransform({
  mightApply: (source) => /@corbado\/|CORBADO_/.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    reportCalls(ctx);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});
