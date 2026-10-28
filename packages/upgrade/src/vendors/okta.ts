import type { ASTNode, ASTPath } from 'jscodeshift';
import {
  applyImportRules,
  applyReexportRules,
  callOf,
  fixProviderProps,
  getJsxAttr,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type FileFacts,
  type ModuleRule,
  type Target,
  type VendorContext,
} from './engine';
import { ATLAS, reportRoute } from './shared';

/**
 * Okta → Atlas, across its JavaScript SDKs:
 *
 *  - `@okta/okta-react`: `<Security>` → `<AtlasProvider>` (`oktaAuth`,
 *    `restoreOriginalUri` and `onAuthRequired` are dropped and reported);
 *    `useOktaAuth()` → `useOktaAuthCompat()` from `@atlasauth/react/compat`
 *    (same `{ oktaAuth, authState }` shape). `<LoginCallback>`, `withOktaAuth`
 *    and `SecureRoute` are reported: Atlas completes the callback itself.
 *  - `@okta/okta-auth-js` in a React file: `new OktaAuth(config)` →
 *    `new OktaAuthCompat(config)` and `toRelativeUrl` → `toRelativeUrlCompat`
 *    from `@atlasauth/react/compat`. Outside React (plain browser code, Vue,
 *    Angular) it is reported: there is no drop-in client there.
 *  - `@okta/okta-vue`, `@okta/okta-angular`, `@okta/okta-signin-widget`:
 *    reported, pointing at `@atlasauth/vue`, `@atlasauth/angular` and `<SignIn />`.
 *  - Server SDKs, marked and reported (their shapes differ too much to rewrite
 *    safely): `@okta/oidc-middleware` (`new ExpressOIDC`, `oidc.router`,
 *    `oidc.ensureAuthenticated()`, `req.userContext`) → `@atlasauth/express`;
 *    `@okta/jwt-verifier` (`verifyAccessToken`) → `AtlasBackend#verify()`, which
 *    returns `{ ok }` instead of throwing; `@okta/okta-sdk-nodejs` →
 *    `createAtlasClient()`. The file gets the Atlas import (ES modules only), so
 *    the replacement is one edit away and `add` lists the package.
 *  - Public env keys (`VITE_OKTA_CLIENT_ID`, `NEXT_PUBLIC_OKTA_ISSUER`, …) →
 *    the Atlas publishable key / frontend API, once nothing in the file still
 *    hands them to Okta; server keys are reported. A file that is the
 *    `/login/callback` route is reported for deletion.
 */

const EXPRESS = '@atlasauth/express';

const CALLBACK_ROUTE = /(^|\/)(login|implicit|authorization-code)[/.]callback(\/(page|route|index))?\.[cm]?[jt]sx?$/;

const CALLBACK_ROUTE_MESSAGE =
  'this is the Okta sign-in callback route: Atlas completes sign-in callbacks itself; delete it (and the redirectUri that points at it)';

const NOT_REACT =
  'in a Vue app use the createAtlas plugin from @atlasauth/vue, in Angular provideAtlas from @atlasauth/angular, otherwise the Atlas JS SDK (@atlasauth/js); sign-in then runs on your Atlas /sign-in page';

const CONFIG_IGNORED =
  'OktaAuthCompat acts on the <AtlasProvider> on the page: its issuer, clientId, redirectUri and scopes options are ignored (sign-in runs on your Atlas /sign-in page; set publishableKey and frontendApi on <AtlasProvider>)';

const RESTORE =
  'restoreOriginalUri: after sign-in Atlas returns to the page the user started from (redirect_url), so this callback is no longer called; delete it';

const ON_AUTH_REQUIRED =
  'onAuthRequired: protect pages with withAuthenticationRequiredCompat (@atlasauth/react/compat) or <RedirectToSignIn /> (@atlasauth/react), which send signed-out visitors to your Atlas /sign-in page';

const LOGIN_CALLBACK =
  'LoginCallback: Atlas completes the sign-in callback itself; delete the /login/callback route (and the redirectUri that points at it)';

const VUE =
  'move to the Atlas Vue plugin: app.use(createAtlas({ publishableKey, frontendApi })) from @atlasauth/vue, then read auth with useAuth() / useUser(); Atlas completes sign-in itself, so the /login/callback route can go';

const ANGULAR =
  'move to the Atlas Angular SDK: provideAtlas({ publishableKey, frontendApi }) from @atlasauth/angular, AtlasService for the auth state and AtlasSignedInDirective / AtlasSignedOutDirective in templates; Atlas completes sign-in itself, so the callback route can go';

const WIDGET =
  'the Okta Sign-In Widget: render <SignIn /> from @atlasauth/react (or send users to your Atlas /sign-in page); style it with the appearance prop or the dashboard designer';

/** Files that render React: an `<AtlasProvider>` can hold the session there. */
const reactFiles = new WeakSet<VendorContext>();

const REACT_SOURCES = /^(react|react-dom(\/.*)?|react-router(-dom)?|@okta\/okta-react|@atlasauth\/react(\/compat)?)$/;

function importSources(ctx: VendorContext): string[] {
  return ctx.root.find(ctx.j.ImportDeclaration).nodes().map((n) => String(n.source.value));
}

const inReact =
  (what: string) =>
  (_ref: ASTPath, ctx: VendorContext): true | string =>
    reactFiles.has(ctx) ? true : `${what} outside a React app has no drop-in Atlas counterpart: ${NOT_REACT}`;

const provider: Target = {
  module: ATLAS.react,
  name: 'AtlasProvider',
  after: (ref, ctx) => {
    const opening = ref.parent?.node as { type?: string; attributes?: ASTNode[] } | undefined;
    if (opening?.type === 'JSXOpeningElement') {
      if (getJsxAttr(opening, 'restoreOriginalUri')) ctx.report(ref, RESTORE);
      if (getJsxAttr(opening, 'onAuthRequired')) ctx.report(ref, ON_AUTH_REQUIRED);
    }
    fixProviderProps(ctx, ref, { drop: ['oktaAuth', 'restoreOriginalUri', 'onAuthRequired'] });
  },
};

const oktaAuthClient: Target = {
  module: ATLAS.reactCompat,
  name: 'OktaAuthCompat',
  accept: inReact('new OktaAuth(config)'),
  after: (ref, ctx) => {
    const call = callOf(ref);
    if (call?.path.node.type === 'NewExpression' && call.args.length > 0) ctx.report(ref, CONFIG_IGNORED);
  },
};

const RULES: readonly ModuleRule[] = [
  {
    match: '@okta/okta-react',
    named: {
      Security: provider,
      useOktaAuth: { module: ATLAS.reactCompat, name: 'useOktaAuthCompat' },
      LoginCallback: { manual: LOGIN_CALLBACK },
      withOktaAuth: {
        manual: 'withOktaAuth(Component): read { oktaAuth, authState } with useOktaAuthCompat() from @atlasauth/react/compat in a function component and pass them down as props',
      },
      SecureRoute: {
        manual: "SecureRoute (react-router v5): wrap the route's component with withAuthenticationRequiredCompat from @atlasauth/react/compat, or render it inside <SignedIn> with <RedirectToSignIn /> in <SignedOut> (@atlasauth/react)",
      },
      OktaContext: { manual: 'OktaContext: use useOktaAuthCompat() from @atlasauth/react/compat (or useAuth() from @atlasauth/react)' },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: '@okta/okta-auth-js',
    named: {
      OktaAuth: oktaAuthClient,
      toRelativeUrl: {
        module: ATLAS.reactCompat,
        name: 'toRelativeUrlCompat',
        accept: (_ref, ctx) =>
          reactFiles.has(ctx)
            ? true
            : 'toRelativeUrl(): after sign-in Atlas returns to the page the user started from, so restoring the original URL by hand is usually not needed (otherwise use new URL(uri).pathname)',
      },
      AuthState: { module: ATLAS.reactCompat, name: 'OktaCompatAuthState', typeOnly: true, accept: inReact('the AuthState type') },
      UserClaims: { module: ATLAS.reactCompat, name: 'OktaCompatUserClaims', typeOnly: true, accept: inReact('the UserClaims type') },
      OktaAuthOptions: { module: ATLAS.reactCompat, name: 'OktaAuthCompatOptions', typeOnly: true, accept: inReact('the OktaAuthOptions type') },
    },
    otherNamed: 'no Atlas counterpart — use the Atlas JS SDK (@atlasauth/js), or in a React app the hooks in @atlasauth/react',
  },
  {
    match: '@okta/okta-vue',
    default: { manual: `@okta/okta-vue: ${VUE}` },
    otherNamed: VUE,
    whole: `@okta/okta-vue: ${VUE}`,
  },
  {
    match: '@okta/okta-angular',
    otherNamed: ANGULAR,
    whole: `@okta/okta-angular: ${ANGULAR}`,
  },
  {
    match: (s) => s === '@okta/okta-signin-widget' || s.startsWith('@okta/okta-signin-widget/'),
    default: { manual: WIDGET },
    otherNamed: WIDGET,
    whole: WIDGET,
  },
];

// ---- server SDKs: found by what the code constructs, marked, never rewritten ----------

/** How a module is bound in this file: `import x` / `import * as x` / `const x = require()`, and named imports. */
interface Bindings {
  esm: boolean;
  /** Locals holding the whole module (default, namespace or `require()` result). */
  whole: Set<string>;
  /** Named imports and `const { a } = require()`: local → exported name. */
  named: Map<string, string>;
}

function isRequireOf(node: unknown, source: string): boolean {
  const call = node as { type?: string; callee?: { type?: string; name?: string }; arguments?: Array<{ type?: string; value?: unknown }> } | null;
  if (call?.type !== 'CallExpression' || call.callee?.type !== 'Identifier' || call.callee.name !== 'require') return false;
  const arg = call.arguments?.[0];
  return Boolean(arg && (arg.type === 'StringLiteral' || arg.type === 'Literal') && arg.value === source);
}

function bindingsOf(ctx: VendorContext, source: string): Bindings {
  const { j, root } = ctx;
  const out: Bindings = { esm: false, whole: new Set(), named: new Map() };
  root.find(j.ImportDeclaration, { source: { value: source } }).forEach((p) => {
    out.esm = true;
    for (const s of p.node.specifiers ?? []) {
      const local = s.local?.name;
      if (!local) continue;
      if (s.type === 'ImportSpecifier') out.named.set(local, s.imported.name);
      else out.whole.add(local);
    }
  });
  root.find(j.VariableDeclarator).forEach((p) => {
    if (!isRequireOf(p.node.init, source)) return;
    const id = p.node.id as {
      type: string;
      name?: string;
      properties?: Array<{ type: string; computed?: boolean; key?: { type?: string; name?: string }; value?: { type?: string; name?: string } }>;
    };
    if (id.type === 'Identifier' && id.name) out.whole.add(id.name);
    if (id.type !== 'ObjectPattern') return;
    for (const prop of id.properties ?? []) {
      if ((prop.type !== 'ObjectProperty' && prop.type !== 'Property') || prop.computed) continue;
      if (prop.key?.type === 'Identifier' && prop.key.name && prop.value?.type === 'Identifier' && prop.value.name) {
        out.named.set(prop.value.name, prop.key.name);
      }
    }
  });
  return out;
}

/**
 * Is this `new X(…)` the module's class? With `exported`, a named class
 * (`new ExpressOIDC()` / `new mod.ExpressOIDC()`); without, the module itself
 * (`new OktaJwtVerifier()` from a default import or `require()`).
 */
function constructs(node: ASTNode, b: Bindings, exported?: string): boolean {
  const callee = (node as { callee?: { type?: string; name?: string; computed?: boolean; object?: { type?: string; name?: string }; property?: { type?: string; name?: string } } }).callee;
  if (callee?.type === 'Identifier' && callee.name) {
    return exported ? b.named.get(callee.name) === exported : b.whole.has(callee.name);
  }
  if (exported && callee?.type === 'MemberExpression' && !callee.computed) {
    return callee.object?.type === 'Identifier' && b.whole.has(callee.object.name ?? '') && callee.property?.type === 'Identifier' && callee.property.name === exported;
  }
  return false;
}

/** Mark every `new …` of the class; returns how many, and the variables holding an instance. */
function markConstructions(
  ctx: VendorContext,
  b: Bindings,
  exported: string | undefined,
  message: string,
): { count: number; instances: Set<string> } {
  const { j, root } = ctx;
  const instances = new Set<string>();
  let count = 0;
  root.find(j.NewExpression).forEach((path) => {
    if (!constructs(path.node, b, exported)) return;
    count++;
    ctx.manual(path, message);
    const parent = path.parent?.node as { type?: string; id?: { type?: string; name?: string } } | undefined;
    if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier' && parent.id.name) instances.add(parent.id.name);
  });
  return { count, instances };
}

/** A note from a table, ignoring inherited keys (`oidc.toString`). */
function noteFor(table: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** `<instance>.<member>` with a plain identifier on both sides. */
function memberOf(node: ASTNode): { object: string; property: string } | null {
  const m = node as { type?: string; computed?: boolean; object?: { type?: string; name?: string }; property?: { type?: string; name?: string } };
  if ((m.type !== 'MemberExpression' && m.type !== 'OptionalMemberExpression') || m.computed) return null;
  if (m.object?.type !== 'Identifier' || !m.object.name || m.property?.type !== 'Identifier' || !m.property.name) return null;
  return { object: m.object.name, property: m.property.name };
}

const NEW_VERIFIER =
  'new OktaJwtVerifier({ issuer }): verify Atlas session tokens with new AtlasBackend({ issuer: process.env.ATLAS_ISSUER!, jwksUrl: process.env.ATLAS_JWKS_URL }) from @atlasauth/backend; during the cutover add legacyIssuers: oktaLegacyIssuer({ domain, until }) so tokens Okta already issued keep verifying';

const VERIFIER_METHODS: Record<string, string> = {
  verifyAccessToken:
    'use `const result = await backend.verify(token)`. It does not throw: reject the request when result.ok is false, and read result.claims. Atlas session tokens have no API audience by default, so the audience argument has no counterpart (pass `audience` to AtlasBackend for an aud check). Okta access tokens put the login in sub and the user id in uid; Atlas puts the Atlas user id in sub',
  verifyIdToken:
    'Atlas sign-in runs on Atlas pages, so your server no longer receives Okta ID tokens: verify the Atlas session token with `await backend.verify(token)` (it does not throw: check result.ok)',
};

/** `@okta/jwt-verifier`: the verifier and its verify calls. */
function jwtVerifierPass(ctx: VendorContext): void {
  const b = bindingsOf(ctx, '@okta/jwt-verifier');
  if (b.whole.size === 0) return;
  const { count, instances } = markConstructions(ctx, b, undefined, NEW_VERIFIER);
  let found = count > 0;
  ctx.root.find(ctx.j.CallExpression).forEach((path) => {
    const m = memberOf(path.node.callee);
    const note = m && instances.has(m.object) ? noteFor(VERIFIER_METHODS, m.property) : undefined;
    if (!m || !note) return;
    ctx.manual(path, `${m.property}(): ${note}`);
    found = true;
  });
  if (found && b.esm) ctx.ensureImport(ATLAS.backend, 'AtlasBackend');
}

const NEW_OIDC =
  'new ExpressOIDC(config): Atlas hosts sign-in, so this app no longer runs its own OIDC login, callback and session. Verify the Atlas session instead with atlasMiddleware({ jwksUrl: process.env.ATLAS_JWKS_URL!, issuer: process.env.ATLAS_ISSUER! }) from @atlasauth/express, and drop express-session if nothing else uses it';

const OIDC_MEMBERS: Record<string, string> = {
  router:
    'replace with app.use(atlasMiddleware({ jwksUrl, issuer })); the /login, /authorization-code/callback and /logout routes it served are gone: send users to your Atlas /sign-in page and sign out in the browser',
  ensureAuthenticated:
    'use requireAuth() from @atlasauth/express (it answers 401 instead of redirecting to sign-in; for pages, redirect to /sign-in yourself when getAuth(req).userId is null)',
  on: 'Atlas needs no startup step (there is no OIDC discovery to wait for): start the server directly',
  forceLogoutAndRevoke:
    "sign-out happens in the browser (<SignOutButton /> or useAuth().signOut()); to end a user's sessions from the server use the Atlas Backend API (@atlasauth/backend)",
};

const USER_CONTEXT =
  'req.userContext: use getAuth(req) from @atlasauth/express (userId, sessionId, claims); load the full profile with createAtlasClient({ secretKey }).users.get(userId) from @atlasauth/backend';

/** `@okta/oidc-middleware` (Express): the OIDC instance, its router and guards, and `req.userContext`. */
function expressOidcPass(ctx: VendorContext): void {
  const b = bindingsOf(ctx, '@okta/oidc-middleware');
  if (b.whole.size === 0 && b.named.size === 0) return;
  const { j, root } = ctx;
  const { count, instances } = markConstructions(ctx, b, 'ExpressOIDC', NEW_OIDC);
  const need = { atlasMiddleware: count > 0, requireAuth: false, getAuth: false };
  root.find(j.MemberExpression).forEach((path) => {
    const m = memberOf(path.node);
    const note = m && instances.has(m.object) ? noteFor(OIDC_MEMBERS, m.property) : undefined;
    if (!m || !note) return;
    if (m.property === 'router') need.atlasMiddleware = true;
    if (m.property === 'ensureAuthenticated') need.requireAuth = true;
    ctx.manual(path, `${m.object}.${m.property}${m.property === 'router' ? '' : '()'}: ${note}`);
  });
  root.find(j.MemberExpression).forEach((path) => {
    const node = path.node as { computed?: boolean; property: { type: string; name?: string } };
    if (node.computed || node.property.type !== 'Identifier' || node.property.name !== 'userContext') return;
    need.getAuth = true;
    ctx.manual(path, USER_CONTEXT);
  });
  if (!b.esm) return;
  if (need.atlasMiddleware) ctx.ensureImport(EXPRESS, 'atlasMiddleware');
  if (need.requireAuth) ctx.ensureImport(EXPRESS, 'requireAuth');
  if (need.getAuth) ctx.ensureImport(EXPRESS, 'getAuth');
}

const SDK_CLIENT =
  "new okta.Client({ orgUrl, token }): use createAtlasClient({ secretKey: process.env.ATLAS_SECRET_KEY! }) from @atlasauth/backend. Its users, organizations and invitations resources replace Okta's users, groups and group memberships; method names differ, so move each call over";

/** `@okta/okta-sdk-nodejs`: the management client. */
function managementSdkPass(ctx: VendorContext): void {
  const b = bindingsOf(ctx, '@okta/okta-sdk-nodejs');
  if (b.whole.size === 0 && b.named.size === 0) return;
  const { count } = markConstructions(ctx, b, 'Client', SDK_CLIENT);
  if (count > 0 && b.esm) ctx.ensureImport(ATLAS.backend, 'createAtlasClient');
}

// ---- env -------------------------------------------------------------------------------

/** Okta modules that read the issuer / client id themselves (all but okta-react). */
function oktaStillConfigured(ctx: VendorContext): boolean {
  const { j, root } = ctx;
  const configModule = (s: unknown) => typeof s === 'string' && s.startsWith('@okta/') && s !== '@okta/okta-react';
  if (importSources(ctx).some(configModule)) return true;
  return (
    root.find(j.CallExpression, { callee: { type: 'Identifier', name: 'require' } }).filter((p) => {
      const arg = p.node.arguments[0] as { value?: unknown } | undefined;
      return configModule(arg?.value);
    }).length > 0
  );
}

/** Public slots that map onto Atlas's (the values must come from the Atlas dashboard). */
const PUBLIC_ENV = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)OKTA_(CLIENT_ID|ISSUER|DOMAIN|ORG_URL|BASE_URL)$/;

const ORG = 'the Okta org is not used after the move: server code reads ATLAS_ISSUER and ATLAS_SECRET_KEY';
const API_TOKEN = 'the Okta API token is replaced by ATLAS_SECRET_KEY (createAtlasClient from @atlasauth/backend)';

const ENV_NOTES: Record<string, string> = {
  CLIENT_SECRET: 'server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)',
  ISSUER: 'Atlas tokens are verified against ATLAS_ISSUER and ATLAS_JWKS_URL; keep the Okta issuer only for oktaLegacyIssuer() during the cutover',
  DOMAIN: ORG,
  ORG_URL: ORG,
  CLIENT_ORGURL: ORG,
  API_TOKEN,
  CLIENT_TOKEN: API_TOKEN,
  TOKEN: API_TOKEN,
  REDIRECT_URI: 'not needed: Atlas completes the sign-in callback itself',
  AUDIENCE: 'Atlas session tokens have no API audience by default; pass `audience` to AtlasBackend (your instance id) for an aud check',
  SCOPES: 'not needed with Atlas sessions',
  SCOPE: 'not needed with Atlas sessions',
  TESTING_DISABLEHTTPSCHECK: 'not needed with Atlas; remove it',
};

function envRename(style: FileFacts['envStyle']) {
  return (key: string): { to: string } | { report: string } | null => {
    const pub = PUBLIC_ENV.exec(key);
    if (pub) return { to: `${pub[1]}ATLAS_${pub[2] === 'CLIENT_ID' ? 'PUBLISHABLE_KEY' : 'FRONTEND_API'}` };
    const okta = /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_)?OKTA_([A-Z0-9_]+)$/.exec(key);
    if (!okta) return null;
    if (okta[1] === 'CLIENT_ID') {
      return { report: `${key}: server code identifies the instance with ATLAS_SECRET_KEY; the browser uses ${publicEnvKey(style, 'PUBLISHABLE_KEY')}` };
    }
    const note = noteFor(ENV_NOTES, okta[1]!);
    return note ? { report: `${key}: ${note}` } : null;
  };
}

export default vendorTransform({
  mightApply: (source, path) => /@okta\/|OKTA_/.test(source) || CALLBACK_ROUTE.test(path),
  run(ctx) {
    reportRoute(ctx, CALLBACK_ROUTE, CALLBACK_ROUTE_MESSAGE);
    if (importSources(ctx).some((s) => REACT_SOURCES.test(s))) reactFiles.add(ctx);
    applyReexportRules(ctx, RULES);
    applyImportRules(ctx, RULES);
    jwtVerifierPass(ctx);
    expressOidcPass(ctx);
    managementSdkPass(ctx);
    // Env keys Okta code in this file still reads stay as they are until it is
    // migrated (the .env scan reports them either way).
    if (!oktaStillConfigured(ctx)) renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});
