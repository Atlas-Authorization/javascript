import type { ASTNode, ASTPath } from 'jscodeshift';
import {
  applyImportRules,
  applyReexportRules,
  callOf,
  dropJsxAttrs,
  fixProviderProps,
  getJsxAttr,
  isManual,
  publicEnvKey,
  referencesOf,
  renameEnv,
  vendorTransform,
  type FileFacts,
  type ModuleRule,
  type Target,
  type VendorContext,
} from './engine';
import { ATLAS } from './shared';

/**
 * Descope → Atlas, across its three web SDKs:
 *
 *  - `@descope/react-sdk` and `@descope/nextjs-sdk` (root and `/client`):
 *    `AuthProvider` → `<AtlasProvider>` (`projectId` → `publishableKey`,
 *    `baseUrl` → `frontendApi`); the `<Descope flowId>` component and the
 *    `SignInFlow` / `SignUpFlow` / `SignUpOrInFlow` shortcuts → `<SignIn />` or
 *    `<SignUp />` (stock flows only; a custom flow is reported); the
 *    `UserProfile` widget → `<UserProfile />`; `useSession`, `useUser`,
 *    `useDescope` (its `logout` / `refresh`) and awaited `getSessionToken()` →
 *    the `@atlasauth/react/compat` helpers, which keep Descope's result shapes.
 *  - `@descope/nextjs-sdk/server`: `authMiddleware({...})` →
 *    `createAtlasMiddleware({...})` (`publicRoutes` kept, `privateRoutes` →
 *    `protectedRoutes`, `redirectUrl` → `signInUrl`, `*` → `(.*)`); `session()`
 *    → `descopeSessionCompat()` from `@atlasauth/nextjs/compat`.
 *  - `@descope/node-sdk` and `createSdk()`: reported where they are created and
 *    where they are called (`validateSession` → `AtlasBackend.verify`,
 *    `management.*` → the Atlas Backend API); there is no drop-in client.
 *
 * Tenant and role widgets, custom flows and the management SDK are reported.
 */

const PROVIDER_DROP = [
  'baseStaticUrl',
  'baseCdnUrl',
  'persistTokens',
  'autoRefresh',
  'sessionTokenViaCookie',
  'refreshTokenViaCookie',
  'refreshCookieName',
  'storeLastAuthenticatedUser',
  'keepLastAuthenticatedUserAfterLogout',
  'storagePrefix',
  'customStorage',
  'oidcConfig',
  'nonce',
  'hooks',
];

const provider: Target = {
  module: ATLAS.react,
  name: 'AtlasProvider',
  after: (ref, ctx) =>
    fixProviderProps(ctx, ref, { map: { publishableKey: 'projectId', frontendApi: 'baseUrl' }, drop: PROVIDER_DROP }),
};

// ---- JSX helpers -------------------------------------------------------------------

interface Opening {
  type: string;
  name: unknown;
  attributes?: ASTNode[];
}

/** The opening tag `ref` names (`<Descope …>`), else null. */
function openingOf(ref: ASTPath): Opening | null {
  const parent = ref.parent?.node as Opening | undefined;
  return parent?.type === 'JSXOpeningElement' && parent.name === ref.node ? parent : null;
}

function isClosingName(ref: ASTPath): boolean {
  const parent = ref.parent?.node as { type?: string; name?: unknown } | undefined;
  return parent?.type === 'JSXClosingElement' && parent.name === ref.node;
}

function hasSpread(opening: Opening): boolean {
  return (opening.attributes ?? []).some((a) => a.type === 'JSXSpreadAttribute');
}

function attrNames(opening: Opening): string[] {
  return (opening.attributes ?? [])
    .map((a) => a as { type: string; name?: { name?: unknown } })
    .filter((a) => a.type === 'JSXAttribute' && typeof a.name?.name === 'string')
    .map((a) => a.name!.name as string);
}

/** A JSX attribute's plain string value (`flowId="x"`, `flowId={'x'}`), else undefined. */
function stringAttr(opening: Opening, name: string): string | undefined {
  type Lit = { type?: string; value?: unknown; expressions?: unknown[]; quasis?: Array<{ value: { cooked?: string | null } }> };
  const value = getJsxAttr(opening, name)?.value as (Lit & { expression?: Lit }) | undefined;
  const lit = value?.type === 'JSXExpressionContainer' ? value.expression : value;
  if ((lit?.type === 'StringLiteral' || lit?.type === 'Literal') && typeof lit.value === 'string') return lit.value;
  if (lit?.type === 'TemplateLiteral' && lit.expressions?.length === 0) return lit.quasis?.[0]?.value.cooked ?? undefined;
  return undefined;
}

// ---- flows: <Descope flowId> and the SignInFlow / SignUpFlow shortcuts ----------------

/** Descope flow components → the Atlas component (null: decided by `flowId`). */
const FLOWS: Record<string, 'SignIn' | 'SignUp' | null> = {
  Descope: null,
  SignInFlow: 'SignIn',
  SignUpOrInFlow: 'SignIn',
  SignUpFlow: 'SignUp',
};

/** Descope's stock flow ids. Any other flow was built in the Descope console and is reported. */
const STOCK_FLOWS: Record<string, 'SignIn' | 'SignUp'> = {
  'sign-in': 'SignIn',
  'sign-up-or-in': 'SignIn',
  'sign-up': 'SignUp',
};

const UI_MODULES = ['@descope/react-sdk', '@descope/nextjs-sdk', '@descope/nextjs-sdk/client'];

/** Rewrite one rendered flow; a string is the reason it was left alone. */
function rewriteFlow(ctx: VendorContext, ref: ASTPath, component: string, fixed: 'SignIn' | 'SignUp' | null): true | string {
  const opening = openingOf(ref);
  if (!opening) return `'${component}' is used outside a JSX tag: render <SignIn /> or <SignUp /> from @atlasauth/react instead`;
  if (hasSpread(opening)) {
    return `<${component} {...props}>: render <SignIn /> or <SignUp /> from @atlasauth/react and pass only the props it takes (afterUrl, signUpUrl)`;
  }
  let page = fixed;
  if (!page) {
    const flowId = stringAttr(opening, 'flowId');
    if (flowId === undefined) {
      return `<${component}> with a flowId that is not a plain string: render <SignIn /> (sign-in) or <SignUp /> (sign-up) from @atlasauth/react`;
    }
    page = Object.hasOwn(STOCK_FLOWS, flowId) ? STOCK_FLOWS[flowId]! : null;
    if (!page) {
      return `<${component} flowId="${flowId}">: custom Descope flows have no Atlas counterpart; build this screen from the Atlas components (<SignIn />, <SignUp />, <UserProfile />) or hooks (useSignIn, useSignUp, useReverification)`;
    }
  }
  const element = ref.parent?.parent?.node as
    | { children?: Array<{ type: string; value?: string }>; closingElement?: { name?: { type?: string; name?: string } } | null }
    | undefined;
  if ((element?.children ?? []).some((c) => c.type !== 'JSXText' || (c.value ?? '').trim() !== '')) {
    return `<${component}> with children: render <${page} /> from @atlasauth/react and move the children next to it`;
  }
  const local = ctx.ensureImport(ATLAS.react, page);
  (ref.node as { name: string }).name = local;
  if (element?.closingElement?.name?.type === 'JSXIdentifier') element.closingElement.name.name = local;
  const dropped = dropJsxAttrs(opening, attrNames(opening));
  ctx.rewrote();
  if (dropped.length > 0) {
    ctx.report(
      ref,
      `<${component}> is now Atlas's <${page} />; removed props with no Atlas counterpart: ${dropped.join(', ')} (the screens, theme and redirects are configured in the Atlas dashboard; pass afterUrl for where to go after sign-in)`,
    );
  }
  return true;
}

/**
 * Flow components are rewritten per rendered tag (the Atlas component depends
 * on each tag's `flowId`), so they are handled here rather than by an import
 * rule; a flow that cannot be rewritten keeps its Descope import and is marked.
 */
function rewriteFlows(ctx: VendorContext): void {
  const { j, root } = ctx;
  root.find(j.ImportDeclaration).forEach((decl) => {
    if (!UI_MODULES.includes(String(decl.node.source.value)) || decl.node.importKind === 'type') return;
    const specifiers = decl.node.specifiers ?? [];
    const kept = specifiers.filter((spec) => {
      if (spec.type !== 'ImportSpecifier' || !Object.hasOwn(FLOWS, spec.imported.name)) return true;
      const component = spec.imported.name;
      let remaining = 0;
      for (const ref of referencesOf(ctx, spec.local?.name ?? component)) {
        if (isClosingName(ref)) continue;
        const verdict = rewriteFlow(ctx, ref, component, FLOWS[component] ?? null);
        if (verdict !== true) {
          remaining++;
          ctx.manual(ref, verdict);
        }
      }
      return remaining > 0;
    });
    if (kept.length === specifiers.length) return;
    ctx.changed = true;
    if (kept.length === 0) j(decl).remove();
    else decl.node.specifiers = kept;
  });
}

const userProfile: Target = {
  module: ATLAS.react,
  name: 'UserProfile',
  accept: (ref) => {
    if (isClosingName(ref)) return true;
    const opening = openingOf(ref);
    if (!opening) return "'UserProfile' is used outside a JSX tag: render <UserProfile /> from @atlasauth/react instead";
    if (hasSpread(opening)) return '<UserProfile {...props}>: render <UserProfile /> from @atlasauth/react (its sections are configured in the Atlas dashboard)';
    return true;
  },
  after: (ref, ctx) => {
    const opening = openingOf(ref);
    if (!opening) return;
    const dropped = dropJsxAttrs(opening, attrNames(opening));
    if (dropped.length > 0) {
      ctx.report(
        ref,
        `<UserProfile> is now Atlas's <UserProfile />; removed props with no Atlas counterpart: ${dropped.join(', ')} (its sections and look are configured in the Atlas dashboard)`,
      );
    }
  },
};

// ---- hooks ---------------------------------------------------------------------------

/** The `useDescope()` members `useDescopeCompat()` has. */
const SDK_MEMBERS = new Set(['logout', 'refresh']);
const DEPS_HOOK = /^use(Callback|Effect|LayoutEffect|InsertionEffect|Memo)$/;

function memberName(node: unknown): string | undefined {
  const m = node as { type?: string; computed?: boolean; property?: { type?: string; name?: string } };
  if ((m.type !== 'MemberExpression' && m.type !== 'OptionalMemberExpression') || m.computed) return undefined;
  return m.property?.type === 'Identifier' ? m.property.name : undefined;
}

/** How a `const sdk = useDescope()` binding is used: true when the compat hook covers it. */
function sdkUse(use: ASTPath): true | string {
  const parent = use.parent?.node as { type?: string; object?: unknown } | undefined;
  if (parent && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === use.node) {
    const name = memberName(parent);
    return name && SDK_MEMBERS.has(name) ? true : `.${name ?? '[…]'}`;
  }
  // A dependency list: useCallback(fn, [sdk]).
  if (parent?.type === 'ArrayExpression') {
    const call = use.parent?.parent?.node as { type?: string; callee?: { type?: string; name?: string }; arguments?: unknown[] } | undefined;
    const hook = call?.callee?.type === 'Identifier' ? call.callee.name : memberName(call?.callee);
    if (call?.type === 'CallExpression' && hook && DEPS_HOOK.test(hook) && call.arguments?.[1] === parent) return true;
  }
  return 'the SDK object itself';
}

function acceptUseDescope(ref: ASTPath, ctx: VendorContext): true | string {
  const unsupported = (what: string) =>
    `useDescope(): ${what}; only logout() and refresh() have an Atlas counterpart here (useDescopeCompat from @atlasauth/react/compat). Use useAuth() / useUser() from @atlasauth/react for the rest; users sign out other devices from <UserProfile />`;
  const call = callOf(ref);
  if (!call) return unsupported('the hook is passed around rather than called');
  const parent = call.path.parent?.node as { type?: string; object?: unknown; init?: unknown; id?: { type?: string; name?: string; properties?: unknown[] } } | undefined;
  if (parent && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === call.path.node) {
    const name = memberName(parent);
    return name && SDK_MEMBERS.has(name) ? true : unsupported(`.${name ?? '[…]'} is used`);
  }
  if (parent?.type === 'VariableDeclarator' && parent.init === call.path.node && parent.id) {
    let bad: string[] = [];
    if (parent.id.type === 'ObjectPattern') {
      bad = (parent.id.properties ?? []).map((p) => propName(p as Prop) ?? '...rest').filter((k) => !SDK_MEMBERS.has(k));
    } else if (parent.id.type === 'Identifier' && parent.id.name) {
      bad = [...new Set(referencesOf(ctx, parent.id.name).map(sdkUse).filter((u): u is string => u !== true))];
    } else {
      bad = ['a destructuring pattern'];
    }
    return bad.length === 0 ? true : unsupported(`${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} used`);
  }
  return unsupported('its result is used in a way the codemod cannot check');
}

const getSessionToken: Target = {
  module: ATLAS.reactCompat,
  name: 'getDescopeSessionTokenCompat',
  accept: (ref) => {
    const call = callOf(ref);
    const parent = call?.path.parent?.node as { type?: string; argument?: unknown } | undefined;
    if (call && parent?.type === 'AwaitExpression' && parent.argument === call.path.node) return true;
    return 'getSessionToken() is synchronous in Descope, but Atlas fetches session tokens asynchronously: use `await getDescopeSessionTokenCompat()` from @atlasauth/react/compat, or `await getToken()` from useAuth()';
  },
};

const ROLES_IN_BROWSER =
  'read roles from useDescopeSessionCompat().claims (roles, permissions, tenants), or check them with useAuth().has({ role }) / <Protect role> from @atlasauth/react';

/** The client exports shared by `@descope/react-sdk`, `@descope/nextjs-sdk` and its `/client`. */
const UI_NAMED: NonNullable<ModuleRule['named']> = {
  AuthProvider: provider,
  UserProfile: userProfile,
  useSession: { module: ATLAS.reactCompat, name: 'useDescopeSessionCompat' },
  useUser: { module: ATLAS.reactCompat, name: 'useDescopeUserCompat' },
  useDescope: { module: ATLAS.reactCompat, name: 'useDescopeCompat', accept: acceptUseDescope },
  getSessionToken,
  // Rewritten (or marked where they are rendered) by rewriteFlows().
  Descope: { keep: true },
  SignInFlow: { keep: true },
  SignUpFlow: { keep: true },
  SignUpOrInFlow: { keep: true },
  UserManagement: { manual: 'UserManagement widget: members and their roles are managed in <OrganizationProfile /> from @atlasauth/react' },
  RoleManagement: { manual: 'RoleManagement widget: define roles in the Atlas dashboard; members get them in <OrganizationProfile /> from @atlasauth/react' },
  AccessKeyManagement: { manual: 'AccessKeyManagement widget: use <ApiKeys /> from @atlasauth/react (Atlas API keys)' },
  AuditManagement: { manual: 'AuditManagement widget: use <OrganizationAuditLog /> from @atlasauth/react' },
  TenantProfile: { manual: 'TenantProfile widget: use <OrganizationProfile /> from @atlasauth/react' },
  ApplicationsPortal: { manual: 'ApplicationsPortal widget: no Atlas counterpart; link to your apps from a page of your own' },
  getRefreshToken: {
    manual: 'getRefreshToken(): Atlas keeps the refresh credential in an HttpOnly cookie; send the session token (await getDescopeSessionTokenCompat()) instead',
  },
  refresh: { manual: 'refresh(): Atlas refreshes sessions on its own; remove this call' },
  isSessionTokenExpired: { manual: 'isSessionTokenExpired(): Atlas refreshes sessions on its own; check useAuth().isSignedIn instead' },
  isRefreshTokenExpired: { manual: 'isRefreshTokenExpired(): Atlas refreshes sessions on its own; check useAuth().isSignedIn instead' },
  getJwtRoles: { manual: `getJwtRoles(): ${ROLES_IN_BROWSER}` },
  getJwtPermissions: { manual: `getJwtPermissions(): ${ROLES_IN_BROWSER}` },
};

// ---- Next.js middleware: authMiddleware({...}) → createAtlasMiddleware({...}) ------------

type Prop = {
  type: string;
  key?: { type?: string; name?: string; value?: unknown };
  computed?: boolean;
  shorthand?: boolean;
  value?: ASTNode;
};

function propName(prop: Prop): string | undefined {
  if ((prop.type !== 'ObjectProperty' && prop.type !== 'Property') || prop.computed) return undefined;
  if (prop.key?.type === 'Identifier') return prop.key.name;
  if ((prop.key?.type === 'StringLiteral' || prop.key?.type === 'Literal') && typeof prop.key.value === 'string') return prop.key.value;
  return undefined;
}

function renameProp(ctx: VendorContext, prop: Prop, to: string): void {
  if (prop.key?.type === 'Identifier' && !prop.shorthand) {
    prop.key.name = to;
    return;
  }
  prop.key = ctx.j.identifier(to) as never;
  prop.shorthand = false;
}

const MIDDLEWARE_DROP = ['projectId', 'baseUrl', 'logLevel'];
const MIDDLEWARE_OPTIONS = new Set([...MIDDLEWARE_DROP, 'redirectUrl', 'publicRoutes', 'privateRoutes']);
const MIDDLEWARE_BY_HAND =
  'pass { publicRoutes, protectedRoutes, signInUrl } to createAtlasMiddleware() from @atlasauth/nextjs/compat (patterns are exact paths, or end in (.*))';

/**
 * A Descope route (an exact path, or one ending in `*`) as an Atlas pattern;
 * null when the two matchers would disagree on it.
 */
function atlasRoute(route: string): string | null {
  if (/[()[\]{}?+^$|\\]/.test(route) || route.includes('/:')) return null;
  const star = route.indexOf('*');
  if (star === -1) return route;
  return star === route.length - 1 ? `${route.slice(0, -1)}(.*)` : null;
}

type Elements = Array<{ type?: string; value?: unknown } | null>;

/** The route list of `publicRoutes` / `privateRoutes`, when every entry converts. */
function routeElements(value: ASTNode | undefined): Elements | null {
  const array = value as { type?: string; elements?: Elements } | undefined;
  if (array?.type !== 'ArrayExpression' || !array.elements) return null;
  const ok = array.elements.every(
    (el) => el && (el.type === 'StringLiteral' || el.type === 'Literal') && typeof el.value === 'string' && atlasRoute(el.value) !== null,
  );
  return ok ? array.elements : null;
}

function acceptMiddleware(ref: ASTPath): true | string {
  const call = callOf(ref);
  if (!call) return 'authMiddleware is not called here: export default createAtlasMiddleware() from @atlasauth/nextjs/compat instead';
  if (call.args.length === 0) return true;
  const options = call.args[0] as { type?: string; properties?: Prop[] };
  if (call.args.length > 1 || options.type !== 'ObjectExpression') return `authMiddleware(options) with options built elsewhere: ${MIDDLEWARE_BY_HAND}`;
  for (const prop of options.properties ?? []) {
    const name = propName(prop);
    if (!name) return `authMiddleware({ ... }) with spread or computed options: ${MIDDLEWARE_BY_HAND}`;
    if (!MIDDLEWARE_OPTIONS.has(name)) return `authMiddleware option '${name}' has no Atlas counterpart: ${MIDDLEWARE_BY_HAND}`;
    if ((name === 'publicRoutes' || name === 'privateRoutes') && !routeElements(prop.value)) {
      return `authMiddleware ${name}: only a list of plain paths (optionally ending in *) converts; ${MIDDLEWARE_BY_HAND}`;
    }
  }
  return true;
}

function convertMiddlewareOptions(ref: ASTPath, ctx: VendorContext): void {
  const { j } = ctx;
  const options = callOf(ref)?.args[0] as { type?: string; properties?: Prop[] } | undefined;
  const props = options?.type === 'ObjectExpression' ? (options.properties ?? []) : [];
  const names = props.map(propName);
  const hasPublic = names.includes('publicRoutes');
  const hasPrivate = names.includes('privateRoutes');
  const dropped: string[] = [];
  const kept = props.filter((prop) => {
    const name = propName(prop)!;
    if (MIDDLEWARE_DROP.includes(name) || (name === 'privateRoutes' && hasPublic)) {
      dropped.push(name);
      return false;
    }
    if (name === 'redirectUrl') renameProp(ctx, prop, 'signInUrl');
    if (name === 'publicRoutes' || name === 'privateRoutes') {
      const elements = routeElements(prop.value) ?? [];
      elements.forEach((el, i) => {
        const to = atlasRoute(String(el!.value))!;
        if (to !== el!.value) elements[i] = j.stringLiteral(to) as never;
      });
    }
    if (name === 'privateRoutes') renameProp(ctx, prop, 'protectedRoutes');
    return true;
  });
  if (options && kept.length !== props.length) options.properties = kept;
  const privateOnly = hasPrivate && !hasPublic;
  if (options && privateOnly) {
    // With privateRoutes, Descope left every other route public.
    const open = j.objectProperty(j.identifier('publicRoutes'), j.arrayExpression([j.stringLiteral('/(.*)')]));
    options.properties = [open as never, ...(options.properties ?? [])];
  }
  if (dropped.length > 0) {
    ctx.report(
      ref,
      `removed authMiddleware options with no Atlas counterpart: ${dropped.join(', ')} (the Atlas middleware reads ATLAS_ISSUER, ATLAS_JWKS_URL and ATLAS_PUBLISHABLE_KEY from the environment${hasPrivate && hasPublic ? '; privateRoutes was already ignored next to publicRoutes' : ''})`,
    );
  }
  ctx.report(
    ref,
    privateOnly
      ? 'middleware now runs Atlas: only your protectedRoutes (the old privateRoutes) need a signed-in user; every other route stays public, as before'
      : 'middleware now runs Atlas: every route your config.matcher selects needs a signed-in user, except /sign-in, /sign-up and your publicRoutes',
  );
}

// ---- rules -----------------------------------------------------------------------------

const MANAGEMENT =
  'manage users, tenants and roles with the Atlas Backend API (createAtlasClient() from @atlasauth/backend, or atlasClient() from @atlasauth/nextjs/server) and ATLAS_SECRET_KEY';

const RULES: readonly ModuleRule[] = [
  {
    match: (s) => UI_MODULES.includes(s),
    named: UI_NAMED,
    otherNamed: 'no Atlas counterpart — migrate it manually',
    whole:
      'namespace import of the Descope SDK: import the Atlas pieces by name (AtlasProvider, SignIn, SignUp, UserProfile from @atlasauth/react; the use…Compat hooks from @atlasauth/react/compat)',
  },
  {
    match: '@descope/nextjs-sdk/server',
    named: {
      authMiddleware: {
        module: ATLAS.nextCompat,
        name: 'createAtlasMiddleware',
        accept: acceptMiddleware,
        after: convertMiddlewareOptions,
      },
      session: { module: ATLAS.nextCompat, name: 'descopeSessionCompat' },
      getSession: {
        manual:
          'getSession(req) (Pages router): verify the Atlas session token from the request with AtlasBackend from @atlasauth/backend, or use descopeSessionCompat() from @atlasauth/nextjs/compat in the App Router',
      },
      createSdk: { manual: `createSdk(): the Descope management SDK; ${MANAGEMENT}` },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: '@descope/node-sdk',
    default: {
      manual:
        'DescopeClient(): verify session tokens with AtlasBackend from @atlasauth/backend and manage users with the Atlas Backend API (createAtlasClient(), ATLAS_SECRET_KEY); each call on the client is marked where it is used',
    },
    otherNamed: 'no Atlas counterpart; session checks move to AtlasBackend from @atlasauth/backend',
  },
  {
    match: (s) => s.startsWith('@descope/'),
    otherNamed: 'no Atlas counterpart — migrate it manually',
    whole: 'the Descope SDK has no Atlas counterpart here — migrate its uses manually',
  },
];

/** Re-exports (`export { useSession } from '@descope/react-sdk'`) keep only the renames that need no call-site check. */
const REEXPORT_SAFE = new Set(['useSession', 'useUser', 'session']);
const REEXPORT_RULES: readonly ModuleRule[] = RULES.map((rule) => ({
  ...rule,
  named: Object.fromEntries(
    Object.entries(rule.named ?? {}).map(([name, target]) => [
      name,
      REEXPORT_SAFE.has(name) || (typeof target !== 'function' && isManual(target))
        ? target
        : { manual: `re-export of '${name}': import it from the Descope SDK where it is used, so the codemod can migrate each use` },
    ]),
  ),
}));

// ---- node-sdk / createSdk calls ------------------------------------------------------

const VERIFY =
  'verify the Atlas session token with AtlasBackend from @atlasauth/backend: verify(token) resolves { ok, claims } instead of throwing, and claims.sub is the user id (add descopeLegacyIssuer({ projectId }) to legacyIssuers so Descope tokens issued before the switch keep verifying)';
const ROLES_ON_SERVER =
  'check roles on the verified claims: has({ role }) / has({ permission }) for organization (tenant) roles, has({ appRole }) for project-wide ones (auth() in Next.js, or the claims from AtlasBackend.verify)';

/** Client methods with a plain-words pointer; the first group only on a known client. */
const SDK_CALLS: Record<string, string> = {
  logout: 'sign the user out in the browser (useAuth().signOut()), or revoke the session with the Atlas Backend API (sessions.revoke)',
  logoutAll: 'revoke every session of the user with the Atlas Backend API (sessions.revoke), or let them sign out other devices from <UserProfile />',
  me: 'read the user with currentUser() from @atlasauth/nextjs/server, or with the Atlas Backend API (users.get)',
};
const SDK_CALLS_ANY_RECEIVER: Record<string, string> = {
  validateSession: VERIFY,
  validateJwt: VERIFY,
  validateAndRefreshSession: `Atlas refreshes sessions in the browser, so the server only verifies: ${VERIFY}`,
  refreshSession: 'Atlas refreshes sessions in the browser; remove this call',
  validateRoles: ROLES_ON_SERVER,
  validatePermissions: ROLES_ON_SERVER,
  validateTenantRoles: ROLES_ON_SERVER,
  validateTenantPermissions: ROLES_ON_SERVER,
  getMatchedRoles: ROLES_ON_SERVER,
  getMatchedPermissions: ROLES_ON_SERVER,
  getMatchedTenantRoles: ROLES_ON_SERVER,
  getMatchedTenantPermissions: ROLES_ON_SERVER,
};
const SIGN_IN_GROUPS = new Set(['otp', 'magicLink', 'enchantedLink', 'oauth', 'saml', 'sso', 'totp', 'webauthn', 'password', 'notp', 'flow', 'accessKey']);

/** `a.b.c` → ['a', 'b', 'c'] for a plain member chain on an identifier, else null. */
function memberChain(node: unknown): string[] | null {
  const names: string[] = [];
  let cur = node as { type?: string; computed?: boolean; object?: unknown; property?: { type?: string; name?: string }; name?: string };
  while (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') {
    if (cur.computed || cur.property?.type !== 'Identifier' || !cur.property.name) return null;
    names.unshift(cur.property.name);
    cur = cur.object as typeof cur;
  }
  return cur.type === 'Identifier' && cur.name ? [cur.name, ...names] : null;
}

/** Variables holding a Descope client made in this file (`DescopeClient(...)`, `createSdk(...)`). */
function descopeClients(ctx: VendorContext): Set<string> {
  const { j, root } = ctx;
  const factories = new Set<string>();
  root.find(j.ImportDeclaration).forEach((decl) => {
    const source = String(decl.node.source.value);
    for (const spec of decl.node.specifiers ?? []) {
      if (source === '@descope/node-sdk' && spec.type === 'ImportDefaultSpecifier' && spec.local) factories.add(spec.local.name);
      if (source === '@descope/nextjs-sdk/server' && spec.type === 'ImportSpecifier' && spec.imported.name === 'createSdk') {
        factories.add(spec.local?.name ?? 'createSdk');
      }
    }
  });
  const clients = new Set<string>();
  if (factories.size === 0) return clients;
  root.find(j.VariableDeclarator).forEach((p) => {
    const id = p.node.id as { type?: string; name?: string };
    const init = p.node.init as { type?: string; callee?: { type?: string; name?: string } } | null | undefined;
    if (
      id.type === 'Identifier' &&
      id.name &&
      (init?.type === 'CallExpression' || init?.type === 'NewExpression') &&
      init.callee?.type === 'Identifier' &&
      factories.has(init.callee.name ?? '')
    ) {
      clients.add(id.name);
    }
  });
  return clients;
}

/**
 * Calls on a Descope backend client: on one created in this file, or on any
 * receiver named like one (`descopeClient.validateSession(...)` in a file that
 * imports the client from your own module).
 */
function reportSdkCalls(ctx: VendorContext): void {
  const { j, root } = ctx;
  const clients = descopeClients(ctx);
  root.find(j.CallExpression).forEach((path) => {
    const chain = memberChain(path.node.callee);
    if (!chain || chain.length < 2) return;
    const [receiver, ...members] = chain as [string, ...string[]];
    const known = clients.has(receiver);
    if (!known && !/descope/i.test(receiver)) return;
    const method = members[members.length - 1]!;
    let note: string | undefined;
    if (members[0] === 'management') note = MANAGEMENT;
    else if (members.length === 1 && Object.hasOwn(SDK_CALLS_ANY_RECEIVER, method)) note = SDK_CALLS_ANY_RECEIVER[method];
    else if (known && members.length === 1 && Object.hasOwn(SDK_CALLS, method)) note = SDK_CALLS[method];
    else if (known && SIGN_IN_GROUPS.has(members[0]!)) {
      note = 'credentials are collected on the Atlas sign-in page (<SignIn />); remove server-side sign-in calls';
    }
    if (note) ctx.manual(path, `${members.join('.')}(): ${note}`);
  });
}

// ---- env -----------------------------------------------------------------------------

/** Public env slots that map onto Atlas's (values must come from the Atlas dashboard). */
function envRename(style: FileFacts['envStyle']) {
  return (key: string): { to: string } | { report: string } | null => {
    const slot = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?DESCOPE_(PROJECT_ID|BASE_URL)$/.exec(key);
    if (slot) {
      const suffix = slot[2] === 'PROJECT_ID' ? 'PUBLISHABLE_KEY' : 'FRONTEND_API';
      if (slot[1]) return { to: `${slot[1]}ATLAS_${suffix}` };
      return slot[2] === 'PROJECT_ID'
        ? {
            report: `DESCOPE_PROJECT_ID: the browser identifies the Atlas instance with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}, server code with ATLAS_SECRET_KEY and ATLAS_ISSUER; keep the Descope project id only for descopeLegacyIssuer() while old Descope tokens are still accepted`,
          }
        : { report: `DESCOPE_BASE_URL: the browser uses ${publicEnvKey(style, 'FRONTEND_API')}; server code reads ATLAS_ISSUER and ATLAS_JWKS_URL` };
    }
    if (key === 'DESCOPE_MANAGEMENT_KEY') {
      return { report: 'DESCOPE_MANAGEMENT_KEY: the Atlas Backend API uses ATLAS_SECRET_KEY (from the Atlas dashboard)' };
    }
    return null;
  };
}

export default vendorTransform({
  mightApply: (source) =>
    /@descope\/|DESCOPE_/.test(source) || /descope\w*\.(?:management\.|validate|refreshSession|getMatched)/i.test(source),
  run(ctx) {
    applyReexportRules(ctx, REEXPORT_RULES);
    rewriteFlows(ctx);
    applyImportRules(ctx, RULES);
    reportSdkCalls(ctx);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});
