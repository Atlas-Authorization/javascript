import type { ASTPath } from 'jscodeshift';
import {
  applyImportRules,
  applyReexportRules,
  callOf,
  fixProviderProps,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type FileFacts,
  type ModuleRule,
  type Target,
  type VendorContext,
} from './engine';
import { ATLAS, middlewareExport, reportRoute, rewriteAuthPaths } from './shared';

/**
 * Auth0 → Atlas, across its three web SDKs:
 *
 *  - `@auth0/auth0-react`: `Auth0Provider` → `<AtlasProvider>` (`domain` →
 *    `frontendApi`, `clientId` → `publishableKey`); `useAuth0` and
 *    `withAuthenticationRequired` → the `@atlasauth/react` compat helpers.
 *  - `@auth0/nextjs-auth0` (v3 and v4): `UserProvider`/`Auth0Provider`,
 *    `useUser`, `getSession`, `withApiAuthRequired`, `withPageAuthRequired`,
 *    `handleAuth`, `withMiddlewareAuthRequired` and v4's `Auth0Client` → compat
 *    helpers in `@atlasauth/react` / `@atlasauth/nextjs/compat`; `/api/auth/login`
 *    links → `/sign-in`.
 *  - `@auth0/auth0-spa-js`: `createAuth0Client` / `new Auth0Client` →
 *    `createAuth0CompatClient` / `Auth0CompatClient` from `@atlasauth/js/compat`
 *    (same methods and result shapes; `domain` → `frontendApi`, `clientId` →
 *    `publishableKey`); the few spa-js features with no Atlas counterpart
 *    (custom token exchange, DPoP helpers, API `audience`) are reported.
 *  - Server SDKs: `express-oauth2-jwt-bearer`'s `auth()` → `requireAccessToken()`
 *    from `@atlasauth/express` (`issuerBaseURL` → `issuer` reading
 *    ATLAS_ISSUER, `jwksUri` → `jwksUrl`; scope and claim helpers reported);
 *    `express-openid-connect`'s `requiresAuth()` → `requireAuth()` (its
 *    `auth()` router and `req.oidc` are reported: Atlas hosts sign-in); the
 *    `auth0` Node SDK's clients → reported for `createAtlasClient()`.
 */

const EXPRESS = '@atlasauth/express';

const PROVIDER_DROP = [
  'authorizationParams',
  'cacheLocation',
  'useRefreshTokens',
  'useRefreshTokensFallback',
  'onRedirectCallback',
  'redirectUri',
  'audience',
  'scope',
  'skipRedirectCallback',
  'issuer',
  'context',
  'user',
  'profileUrl',
  'loginUrl',
  'fetcher',
];

const provider: Target = {
  module: ATLAS.react,
  name: 'AtlasProvider',
  after: (ref, ctx) =>
    fixProviderProps(ctx, ref, { map: { frontendApi: 'domain', publishableKey: 'clientId' }, drop: PROVIDER_DROP }),
};

const pagesRouterSession = (ref: ASTPath, ctx: VendorContext): true | string => {
  const call = callOf(ref);
  if (ctx.facts.kind === 'client') {
    return 'getSession() in browser code: use useAuth0UserCompat() (or useUser()) from @atlasauth/react';
  }
  if (call && call.args.length >= 2) {
    return 'Pages-router getSession(req, res): call getAuth0SessionCompat() from an App Router server component or route handler, or verify the session token with AtlasBackend from @atlasauth/backend';
  }
  return true;
};

const getSession: Target = { module: ATLAS.nextCompat, name: 'getAuth0SessionCompat', accept: pagesRouterSession };

/** v3's withPageAuthRequired is a server helper in app/, a client HOC in a client component. */
const withPageAuthRequired = (facts: FileFacts): Target =>
  facts.kind === 'client'
    ? { module: ATLAS.reactCompat, name: 'withAuthenticationRequiredCompat' }
    : {
        module: ATLAS.nextCompat,
        name: 'withPageAuthRequiredCompat',
        accept: (ref) => {
          const first = callOf(ref)?.args[0] as { type?: string } | undefined;
          if (first && first.type === 'ObjectExpression') {
            return 'withPageAuthRequired({ getServerSideProps }) (Pages router): protect the page in middleware, or move it to the App Router and use withPageAuthRequiredCompat(Page)';
          }
          return true;
        },
      };

const userType: Target = { module: ATLAS.reactCompat, name: 'Auth0CompatUser', typeOnly: true };

const RULES: readonly ModuleRule[] = [
  {
    match: '@auth0/auth0-react',
    named: {
      Auth0Provider: provider,
      useAuth0: { module: ATLAS.reactCompat, name: 'useAuth0Compat' },
      withAuthenticationRequired: { module: ATLAS.reactCompat, name: 'withAuthenticationRequiredCompat' },
      User: userType,
      withAuth0: { manual: 'withAuth0(Class): read auth in a function component with useAuth0Compat() and pass it down as props' },
      Auth0Context: { manual: 'Auth0Context: use useAuth0Compat() (or useAuth()) from @atlasauth/react' },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: (s) => s === '@auth0/nextjs-auth0/client',
    named: {
      UserProvider: provider,
      Auth0Provider: provider,
      useUser: { module: ATLAS.reactCompat, name: 'useAuth0UserCompat' },
      withPageAuthRequired: { module: ATLAS.reactCompat, name: 'withAuthenticationRequiredCompat' },
      UserProfile: userType,
      UserContext: userType,
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: '@auth0/nextjs-auth0/edge',
    named: {
      withMiddlewareAuthRequired: {
        module: ATLAS.nextCompat,
        name: 'withMiddlewareAuthRequiredCompat',
        accept: (ref) =>
          (callOf(ref)?.args.length ?? 0) > 0
            ? 'withMiddlewareAuthRequired(fn/options): Atlas middleware protects every matched route; move custom checks into the page (auth().has(…))'
            : true,
      },
      getSession: {
        manual: 'getSession(req, res) in edge middleware: the Atlas middleware already verifies the session; read it in the page with auth()',
      },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: '@auth0/nextjs-auth0/server',
    named: {
      Auth0Client: { module: ATLAS.nextCompat, name: 'Auth0ClientCompat' },
      SessionData: { module: ATLAS.nextCompat, name: 'Auth0ServerSession', typeOnly: true },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: '@auth0/nextjs-auth0',
    named: {
      // v3 (server) …
      getSession,
      withApiAuthRequired: { module: ATLAS.nextCompat, name: 'withApiAuthRequiredCompat' },
      withPageAuthRequired,
      handleAuth: { module: ATLAS.nextCompat, name: 'handleAuthCompat', after: (ref, ctx) => ctx.report(ref, 'this Auth0 route is no longer used (Atlas hosts sign-in, sign-out and callbacks): delete it') },
      Session: { module: ATLAS.nextCompat, name: 'Auth0ServerSession', typeOnly: true },
      Claims: userType,
      UserProfile: userType,
      // … and v4 (client) exports from the package root.
      Auth0Provider: provider,
      UserProvider: provider,
      useUser: { module: ATLAS.reactCompat, name: 'useAuth0UserCompat' },
      getAccessToken: {
        manual: 'getAccessToken(): send the Atlas session token (getToken() in the browser) to your API and verify it there with @atlasauth/backend',
      },
      handleLogin: { manual: 'handleLogin(): sign-in is the Atlas /sign-in page; delete this handler' },
      handleLogout: { manual: 'handleLogout(): sign out with <SignOutButton /> or useAuth().signOut(); delete this handler' },
      handleCallback: { manual: 'handleCallback(): Atlas completes callbacks itself; delete this handler' },
      handleProfile: { manual: 'handleProfile(): read the user with currentUser() from @atlasauth/nextjs/server' },
      updateSession: { manual: 'updateSession(): store app data on the user (publicMetadata) via @atlasauth/backend instead' },
      initAuth0: { manual: 'initAuth0(config): delete it; the Atlas helpers read ATLAS_* from the environment' },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: '@auth0/auth0-spa-js',
    named: {
      createAuth0Client: { module: ATLAS.jsCompat, name: 'createAuth0CompatClient', after: renameClientOptions },
      Auth0Client: { module: ATLAS.jsCompat, name: 'Auth0CompatClient', after: renameClientOptions },
      User: { module: ATLAS.jsCompat, name: 'Auth0CompatUser', typeOnly: true },
      IdToken: { module: ATLAS.jsCompat, name: 'Auth0CompatUser', typeOnly: true },
      Auth0ClientOptions: { module: ATLAS.jsCompat, name: 'Auth0CompatClientOptions', typeOnly: true },
      RedirectLoginOptions: { module: ATLAS.jsCompat, name: 'Auth0CompatRedirectOptions', typeOnly: true },
      PopupLoginOptions: { module: ATLAS.jsCompat, name: 'Auth0CompatRedirectOptions', typeOnly: true },
      LogoutOptions: { module: ATLAS.jsCompat, name: 'Auth0CompatLogoutOptions', typeOnly: true },
      GetTokenSilentlyOptions: { module: ATLAS.jsCompat, name: 'Auth0CompatTokenOptions', typeOnly: true },
      GenericError: { module: ATLAS.jsCompat, name: 'Auth0CompatError' },
    },
    otherNamed:
      'no Atlas counterpart in @atlasauth/js/compat — catch Auth0CompatError and branch on its `error` code (login_required, popup_closed, popup_blocked, timeout)',
  },
  {
    match: 'express-oauth2-jwt-bearer',
    named: {
      auth: { module: EXPRESS, name: 'requireAccessToken', after: jwtBearerOptions },
      requiredScopes: {
        manual: 'requiredScopes(…): pass requiredScopes: […] to requireAccessToken() (every listed scope is required); the granted scopes are on req.atlasToken.scopes',
      },
      scopeIncludesAny: { manual: 'scopeIncludesAny(…): after requireAccessToken(), check req.atlasToken.scopes in the route' },
      claimCheck: { manual: 'claimCheck(…): after requireAccessToken(), check req.atlasToken.claims in the route' },
      claimEquals: { manual: 'claimEquals(…): after requireAccessToken(), check req.atlasToken.claims in the route' },
      claimIncludes: { manual: 'claimIncludes(…): after requireAccessToken(), check req.atlasToken.claims in the route' },
      InsufficientScopeError: { manual: 'InsufficientScopeError: requireAccessToken() answers 403 with the WWW-Authenticate challenge itself' },
      InvalidTokenError: { manual: 'InvalidTokenError: requireAccessToken() answers 401 with the WWW-Authenticate challenge itself' },
      UnauthorizedError: { manual: 'UnauthorizedError: requireAccessToken() answers 401 with the WWW-Authenticate challenge itself' },
    },
    otherNamed: 'no Atlas counterpart — verify Atlas access tokens with requireAccessToken() from @atlasauth/express',
  },
  {
    match: 'express-openid-connect',
    named: {
      auth: {
        manual:
          'auth(config) from express-openid-connect: Atlas hosts sign-in, so this app no longer runs its own login, callback and session. Verify the Atlas session with app.use(atlasMiddleware({ jwksUrl: process.env.ATLAS_JWKS_URL, issuer: process.env.ATLAS_ISSUER })) from @atlasauth/express; req.oidc.user becomes getAuth(req) (and createAtlasClient().users.get(userId) for the profile)',
      },
      requiresAuth: {
        module: EXPRESS,
        name: 'requireAuth',
        after: (ref, ctx) =>
          ctx.report(ref, 'requireAuth() answers 401 instead of redirecting to the login page; for pages, redirect to /sign-in yourself when getAuth(req).userId is null'),
      },
      claimCheck: { manual: 'claimCheck(…): after requireAuth(), check getAuth(req).claims (or has({ role, permission })) in the route' },
      claimEquals: { manual: 'claimEquals(…): after requireAuth(), check getAuth(req).claims in the route' },
      claimIncludes: { manual: 'claimIncludes(…): after requireAuth(), check getAuth(req).claims in the route' },
    },
    otherNamed: 'no Atlas counterpart — read the session with getAuth(req) from @atlasauth/express',
  },
  {
    match: 'auth0',
    named: {
      ManagementClient: {
        manual: 'new ManagementClient(…): manage users, organizations and roles with createAtlasClient({ secretKey: process.env.ATLAS_SECRET_KEY }) from @atlasauth/backend',
      },
      AuthenticationClient: {
        manual: 'AuthenticationClient: Atlas hosts sign-in (password, passwordless, social); server-side, mint sign-in tokens or sessions with createAtlasClient() from @atlasauth/backend',
      },
      UserInfoClient: { manual: 'UserInfoClient: read the user with createAtlasClient().users.get(userId) from @atlasauth/backend' },
    },
    otherNamed: 'no Atlas counterpart — use createAtlasClient() from @atlasauth/backend',
  },
];

/**
 * express-oauth2-jwt-bearer `auth({ … })` options → `requireAccessToken`'s:
 * `issuerBaseURL` → `issuer` (now the Atlas issuer), `jwksUri` → `jwksUrl`;
 * options with no counterpart are reported for removal.
 */
function jwtBearerOptions(ref: ASTPath, ctx: VendorContext): void {
  const call = callOf(ref);
  if (!call) return;
  const first = call.args[0] as { type?: string; properties?: Array<{ type?: string; key?: { type?: string; name?: string }; computed?: boolean; shorthand?: boolean; value?: unknown }> } | undefined;
  if (!first || first.type !== 'ObjectExpression') {
    ctx.manual(ref, 'requireAccessToken() needs { issuer: process.env.ATLAS_ISSUER, audience: <your API identifier, registered as a resource server in Atlas> } (auth() read ISSUER_BASE_URL and AUDIENCE from the environment)');
    return;
  }
  const dropped: string[] = [];
  for (const prop of first.properties ?? []) {
    if ((prop.type !== 'ObjectProperty' && prop.type !== 'Property') || prop.computed || prop.shorthand || prop.key?.type !== 'Identifier') continue;
    const name = prop.key.name ?? '';
    if (name === 'issuerBaseURL') {
      prop.key.name = 'issuer';
      prop.value = ctx.expr(ctx.facts.isTypeScript ? 'process.env.ATLAS_ISSUER!' : 'process.env.ATLAS_ISSUER');
    } else if (name === 'jwksUri') {
      prop.key.name = 'jwksUrl';
    } else if (name !== 'audience') {
      dropped.push(name);
    }
  }
  if (dropped.length) ctx.manual(ref, `requireAccessToken(): remove ${dropped.join(', ')} (Atlas access tokens are RS256, checked against the instance JWKS)`);
  ctx.report(ref, 'requireAccessToken(): register this API as a resource server in Atlas with the same audience; the verified token is on req.atlasToken (was req.auth)');
}

/** auth0-spa-js option names → the compat client's (`domain` → `frontendApi`, `clientId` → `publishableKey`). */
function renameClientOptions(ref: ASTPath, ctx: VendorContext): void {
  const call = callOf(ref);
  const first = call?.args[0] as { type?: string; properties?: Array<{ type?: string; key?: { type?: string; name?: string }; computed?: boolean; shorthand?: boolean }> } | undefined;
  if (!first || first.type !== 'ObjectExpression') return;
  const names: Record<string, string> = { domain: 'frontendApi', clientId: 'publishableKey' };
  for (const prop of first.properties ?? []) {
    if ((prop.type !== 'ObjectProperty' && prop.type !== 'Property') || prop.computed || prop.shorthand) continue;
    const to = prop.key?.type === 'Identifier' && prop.key.name ? names[prop.key.name] : undefined;
    if (to) {
      prop.key!.name = to;
      const holder = prop as unknown as { value?: { type?: string } };
      // A hard-coded Auth0 domain / client id is not an Atlas value: read the Atlas env var instead.
      if (holder.value && (holder.value.type === 'StringLiteral' || holder.value.type === 'Literal')) {
        const suffix = to === 'frontendApi' ? 'FRONTEND_API' : 'PUBLISHABLE_KEY';
        holder.value = ctx.publicEnv(suffix) as never;
        ctx.report(ref, `${to} now reads ${publicEnvKey(ctx.facts.envStyle, suffix)} (the old literal was an Auth0 value)`);
      }
    }
    if (prop.key?.type === 'Identifier' && prop.key.name === 'authorizationParams') {
      const value = (prop as unknown as { value?: { type?: string; properties?: Array<{ key?: { name?: string } }> } }).value;
      if (value?.type === 'ObjectExpression' && value.properties?.some((p) => p.key?.name === 'audience' || p.key?.name === 'scope')) {
        ctx.report(ref, 'authorizationParams.audience/scope: Atlas session tokens are verified with the instance JWKS; for tokens scoped to an API, register a resource server in Atlas');
      }
    }
  }
}

/** Client methods auth0-spa-js has and the Atlas compat client does not. */
const SPA_UNSUPPORTED: Record<string, string> = {
  exchangeToken: 'custom token exchange: use Atlas sign-in tokens (@atlasauth/backend signInTokens) or an Actions-based flow',
  loginWithCustomTokenExchange: 'custom token exchange: use Atlas sign-in tokens (@atlasauth/backend signInTokens) or an Actions-based flow',
  getDpopNonce: 'DPoP helpers: Atlas session tokens are bearer tokens verified with the instance JWKS',
  setDpopNonce: 'DPoP helpers: Atlas session tokens are bearer tokens verified with the instance JWKS',
  generateDpopProof: 'DPoP helpers: Atlas session tokens are bearer tokens verified with the instance JWKS',
  createFetcher: 'createFetcher(): call fetch with `Authorization: Bearer ${await client.getTokenSilently()}`',
  connectAccountWithRedirect: 'connected accounts: users link accounts from <UserProfile /> or the hosted account page',
  buildAuthorizeUrl: 'buildAuthorizeUrl(): call loginWithRedirect({ openUrl }) to receive the URL instead',
  buildLogoutUrl: 'buildLogoutUrl(): call logout({ openUrl }) to receive the URL instead',
};

/** In a file that uses auth0-spa-js, report method calls the compat client cannot serve. */
function reportSpaUnsupported(ctx: VendorContext): void {
  const { j, root } = ctx;
  const usesSpa = root
    .find(j.ImportDeclaration)
    .nodes()
    .some((n) => n.source.value === '@auth0/auth0-spa-js' || n.source.value === ATLAS.jsCompat);
  if (!usesSpa) return;
  root.find(j.CallExpression).forEach((path) => {
    const callee = path.node.callee as { type?: string; computed?: boolean; property?: { type?: string; name?: string } };
    if ((callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') || callee.computed) return;
    const name = callee.property?.type === 'Identifier' ? callee.property.name : undefined;
    // The callback check from Auth0's quickstart, `location.search.includes('code=')`:
    // Atlas returns `__atlas_attempt` (and a ticket) instead of `code` / `state`.
    const arg = path.node.arguments[0] as { type?: string; value?: unknown } | undefined;
    if (name === 'includes' && arg && (arg.type === 'StringLiteral' || arg.type === 'Literal') && (arg.value === 'code=' || arg.value === 'state=')) {
      arg.value = '__atlas_attempt=';
      ctx.rewrote();
      return;
    }
    const note = name ? SPA_UNSUPPORTED[name] : undefined;
    if (note) ctx.manual(path, `${name}(): ${note}`);
  });
}

/** `export default withMiddlewareAuthRequired()` with a re-export source, and v4 `auth0.middleware`. */
function middleware(ctx: VendorContext): void {
  applyReexportRules(ctx, RULES, (path, local, exported, source) => {
    if (source === '@auth0/nextjs-auth0/edge' && local === 'withMiddlewareAuthRequired' && (exported === 'default' || exported === 'middleware')) {
      middlewareExport(ctx, path, exported);
      return true;
    }
    return false;
  });
}

/** Public env var slots that map onto Atlas's (values must come from the Atlas dashboard). */
function envRename(style: FileFacts['envStyle']) {
  return (key: string): { to: string } | { report: string } | null => {
    const pub = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?AUTH0_(DOMAIN|CLIENT_ID)$/.exec(key);
    if (pub) {
      const prefix = pub[1] ?? '';
      const suffix = pub[2] === 'DOMAIN' ? 'FRONTEND_API' : 'PUBLISHABLE_KEY';
      if (prefix) return { to: `${prefix}ATLAS_${suffix}` };
      // Server-side AUTH0_DOMAIN / AUTH0_CLIENT_ID (nextjs-auth0 v4).
      return pub[2] === 'DOMAIN' ? { to: 'ATLAS_ISSUER' } : { report: `AUTH0_CLIENT_ID: server code identifies the instance with ATLAS_SECRET_KEY; the browser uses ${publicEnvKey(style, 'PUBLISHABLE_KEY')}` };
    }
    if (key === 'AUTH0_ISSUER_BASE_URL') return { to: 'ATLAS_ISSUER' };
    const notes: Record<string, string> = {
      AUTH0_SECRET: 'AUTH0_SECRET (cookie encryption): Atlas manages its own session cookies; server code uses ATLAS_SECRET_KEY',
      AUTH0_CLIENT_SECRET: 'AUTH0_CLIENT_SECRET: server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)',
      AUTH0_BASE_URL: 'AUTH0_BASE_URL: not needed; add your app origin to the instance allowed origins in the Atlas dashboard',
      APP_BASE_URL: 'APP_BASE_URL: not needed; add your app origin to the instance allowed origins in the Atlas dashboard',
      AUTH0_AUDIENCE: 'AUTH0_AUDIENCE: Atlas session tokens are verified with the instance JWKS; for API tokens register a resource server in Atlas',
      AUTH0_SCOPE: 'AUTH0_SCOPE: not needed with Atlas sessions',
    };
    for (const [k, note] of Object.entries(notes)) {
      if (key === k || key.endsWith(`_${k}`)) return { report: note };
    }
    return null;
  };
}

export default vendorTransform({
  mightApply: (source, path) => /@auth0\/|AUTH0_|APP_BASE_URL|\/api\/auth\/|\/auth\/login|express-openid-connect|express-oauth2-jwt-bearer|from ['"]auth0['"]/.test(source) || /\[auth0\]/.test(path),
  run(ctx) {
    reportRoute(ctx, /\[auth0\]/, 'this Auth0 route is no longer used (Atlas hosts sign-in, sign-out and callbacks): delete it');
    middleware(ctx);
    applyImportRules(ctx, RULES);
    reportSpaUnsupported(ctx);
    rewriteAuthPaths(ctx, {
      signIn: /^\/(api\/)?auth\/login$/,
      signUp: /^\/(api\/)?auth\/signup$/,
      signOut: /^\/(api\/)?auth\/logout$/,
      returnParams: ['returnTo'],
    });
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});
