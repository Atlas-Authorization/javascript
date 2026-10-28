/**
 * The rename tables that drive the `clerk-to-atlas` codemod.
 *
 * These are kept in one module (rather than inlined in the transform) so the
 * correspondence between a Clerk symbol and its Atlas peer is auditable in one
 * place and can be unit-tested directly. Every entry here is a *verified* 1:1
 * correspondence — we would rather leave a symbol untouched with a TODO than
 * rename it to something that does not exist on the Atlas side, because a wrong
 * rename compiles and then fails at runtime, which is far harder for a migrating
 * developer to debug than an obvious "review this" marker.
 */

/** Marker left on anything the codemod cannot safely rewrite. */
export const TODO_PREFIX = 'TODO(atlas-upgrade):';

/**
 * The primary Atlas package for each Clerk package (also used for `require()` /
 * dynamic `import()` specifiers). The transform itself routes imports per
 * export through {@link CLERK_MODULES}, because some Clerk packages are split
 * differently on the Atlas side (the React surface of `@clerk/nextjs` lives in
 * `@atlasauth/react`, for example). The names on the right are the real published
 * Atlas package names (`packages/<x>/package.json` "name" fields).
 */
export const PACKAGE_MAP: Readonly<Record<string, string>> = {
  '@clerk/clerk-react': '@atlasauth/react',
  '@clerk/react': '@atlasauth/react',
  '@clerk/nextjs': '@atlasauth/nextjs',
  '@clerk/backend': '@atlasauth/backend',
  '@clerk/clerk-js': '@atlasauth/js',
  '@clerk/express': '@atlasauth/express',
  '@clerk/clerk-sdk-node': '@atlasauth/express',
  '@clerk/fastify': '@atlasauth/fastify',
  '@hono/clerk-auth': '@atlasauth/hono',
  '@clerk/astro': '@atlasauth/astro',
  '@clerk/nuxt': '@atlasauth/nuxt',
  '@clerk/vue': '@atlasauth/vue',
  '@clerk/types': '@atlasauth/types',
  '@clerk/themes': '@atlasauth/themes',
  '@clerk/localizations': '@atlasauth/localizations',
  '@clerk/elements': '@atlasauth/elements',
  '@clerk/testing': '@atlasauth/testing',
  '@clerk/agent-toolkit': '@atlasauth/agent-toolkit',
  '@clerk/chrome-extension': '@atlasauth/chrome-extension',
  '@clerk/expo': '@atlasauth/expo',
  '@clerk/clerk-expo': '@atlasauth/expo',
  '@clerk/react-router': '@atlasauth/react-router',
  '@clerk/tanstack-react-start': '@atlasauth/tanstack-react-start',
  // gatsby's convention is an unscoped `gatsby-plugin-<name>` package.
  'gatsby-plugin-clerk': 'gatsby-plugin-atlasauth',
};

/**
 * React-surface renames: Clerk export name -> Atlas export name, confirmed to
 * exist in `packages/react/src` (AtlasProvider.tsx, control-components.tsx).
 */
export const REACT_RENAMES: Readonly<Record<string, string>> = {
  ClerkProvider: 'AtlasProvider',
  useClerk: 'useAtlas',
  ClerkLoaded: 'AtlasLoaded',
  ClerkLoading: 'AtlasLoading',
};

/**
 * Imported-identifier renames: Clerk export name -> Atlas export name.
 *
 * IMPORTANT: this table only contains symbols whose *name differs* between the
 * two SDKs AND whose Atlas peer was confirmed to exist by reading the Atlas
 * source (`packages/react/src/*`, `packages/nextjs/src/*`):
 *   - `ClerkProvider`  -> `AtlasProvider`   (packages/react/src/AtlasProvider.tsx)
 *   - `useClerk`       -> `useAtlas`        (packages/react/src/AtlasProvider.tsx)
 *   - `ClerkLoaded`    -> `AtlasLoaded`     (packages/react/src/control-components.tsx)
 *   - `ClerkLoading`   -> `AtlasLoading`    (packages/react/src/control-components.tsx)
 *   - `clerkMiddleware`-> `atlasMiddleware` (express / hono / astro adapters)
 *
 * Per-package exceptions (e.g. Next.js `clerkMiddleware()` becoming
 * `createAtlasMiddleware()`, which reads its config from the environment the way
 * Clerk's does) live in {@link CLERK_MODULES} and take precedence.
 */
export const IDENTIFIER_MAP: Readonly<Record<string, string>> = {
  ...REACT_RENAMES,
  clerkMiddleware: 'atlasMiddleware',
};

/**
 * Clerk exports that are known to have the SAME name on Atlas. Listing them lets
 * the codemod stay quiet (no TODO) on symbols that are correct as-is, so the
 * TODO noise is reserved for genuinely Clerk-only symbols. This is verified
 * against the Atlas React exports (`packages/react/src/components.tsx`, `hooks.ts`).
 */
export const SHARED_IDENTIFIERS: ReadonlySet<string> = new Set([
  'SignedIn',
  'SignedOut',
  'Protect',
  'RedirectToSignIn',
  'RedirectToSignUp',
  'SignIn',
  'SignUp',
  'SignInButton',
  'SignUpButton',
  'SignOutButton',
  'UserButton',
  'UserProfile',
  'OrganizationSwitcher',
  'OrganizationProfile',
  'OrganizationList',
  'CreateOrganization',
  'Waitlist',
  'MultisessionAppSupport',
  'PricingTable',
  'useUser',
  'useAuth',
  'useSession',
  'useSessionList',
  'useSignIn',
  'useSignUp',
  'useOrganization',
  'useOrganizationList',
  'useReverification',
  'authMiddleware', // Atlas exposes this as an alias of atlasMiddleware
]);

/**
 * Call-site fixes the transform applies to a rewritten binding:
 *  - `next-middleware`: `clerkMiddleware()` → `createAtlasMiddleware({ publicRoutes: ['/(.*)'] })`
 *    (Clerk's middleware protects nothing by default; Atlas's protects every
 *    matched route unless it is public). A handler argument is reported.
 *  - `server-options`: a zero-argument call gets `{ jwksUrl, issuer }` from
 *    `ATLAS_JWKS_URL` / `ATLAS_ISSUER` (Clerk read its config from env; these
 *    Atlas adapters take it as options). A call with options is reported.
 *  - `fastify-register`: the same for `fastify.register(atlasPlugin)`.
 *  - `client-call`: `clerkClient.users…` (v5 object) → `atlasClient().users…`.
 *  - `next-auth`: report `auth.protect()`, a non-awaited `auth()` and auth
 *    fields Atlas does not return.
 *  - `current-user`: report Clerk `User` fields the claims-based Atlas
 *    `currentUser()` does not carry.
 */
export type ClerkCallFix =
  | 'next-middleware'
  | 'server-options'
  | 'fastify-register'
  | 'client-call'
  | 'next-auth'
  | 'current-user';

/** A Clerk export rewritten onto an Atlas one (module defaults to the rule's). */
export interface ClerkExportRewrite {
  module?: string;
  name?: string;
  /** Rewritten, but a human should check this (left as a TODO). */
  note?: string;
  fix?: ClerkCallFix;
}

/** A Clerk export with no faithful Atlas counterpart: left on the Clerk import, with this TODO. */
export interface ClerkExportManual {
  manual: string;
}

export type ClerkExportTarget = ClerkExportRewrite | ClerkExportManual;

/** Where `<AtlasProvider>` reads its keys when the Clerk provider was given none. */
export interface ProviderEnv {
  object: 'process.env' | 'import.meta.env';
  prefix: string;
}

export interface ClerkModuleRule {
  /** Atlas module for listed exports without their own module, for shared names and for unknown names. */
  module: string;
  /** The module re-exports the Atlas React surface: accept SHARED_IDENTIFIERS and REACT_RENAMES. */
  react?: boolean;
  /** Other names that exist unchanged on `module`. */
  shared?: ReadonlySet<string>;
  /** Per-export decisions (win over `react` / `shared`). */
  exports?: Readonly<Record<string, ClerkExportTarget>>;
  /** The Clerk default export → this named Atlas export (`import clerk from '@clerk/astro'`). */
  defaultExport?: string;
  /** Always left as a TODO on the import (something every user of this module must check). */
  note?: string;
  /** Keys for an `<AtlasProvider>` that had none (Clerk read them from env). */
  providerEnv?: ProviderEnv;
  /** `req.auth` / `req.auth()` → `getAuth(req)` from this module. */
  reqAuth?: boolean;
}

/** A Clerk module with no Atlas counterpart at all. */
export interface ClerkModuleManual {
  manual: string;
}

export type ClerkModuleEntry = ClerkModuleRule | ClerkModuleManual;

export function isManualEntry(e: ClerkModuleEntry | ClerkExportTarget): e is ClerkModuleManual | ClerkExportManual {
  return typeof (e as { manual?: unknown }).manual === 'string';
}

const NEXT_SERVER = '@atlasauth/nextjs/server';
const NEXT_COMPAT = '@atlasauth/nextjs/compat';
const BACKEND = '@atlasauth/backend';

const CLIENT_METHODS =
  'resource methods differ from Clerk (users.getUser → users.get, users.getUserList → users.list, users.updateUserMetadata → users.update / users.replaceMetadata): check each call';

const CREATE_CLIENT: ClerkExportRewrite = {
  module: BACKEND,
  name: 'createAtlasClient',
  note: `createAtlasClient takes { secretKey } like createClerkClient, but ${CLIENT_METHODS}`,
};

const VERIFY_TOKEN: ClerkExportManual = {
  manual:
    "verifyToken(token, opts): use new AtlasBackend({ jwksUrl: process.env.ATLAS_JWKS_URL, issuer: process.env.ATLAS_ISSUER }).verify(token) from '@atlasauth/backend' (or authenticateRequest(req)); it returns a result object instead of throwing",
};

const VERIFY_WEBHOOK: ClerkExportManual = {
  manual:
    "verifyWebhook(req): use verifyWebhook({ body: await req.text(), headers: req.headers, secret: process.env.ATLAS_WEBHOOK_SIGNING_SECRET }) from '@atlasauth/backend'; it returns { verified, event } instead of throwing, and Atlas signs with atlas-* headers (not svix-*)",
};

const WEBHOOK_EVENT: ClerkExportRewrite = {
  module: '@atlasauth/types',
  name: 'WebhookEvent',
  note: 'WebhookEvent: Atlas event payloads use the Backend API resource shapes (snake_case fields); check the fields your handler reads',
};

const EXPRESS_CLIENT: ClerkExportManual = {
  manual: `clerkClient: create a client with createAtlasClientFromEnv() from '@atlasauth/backend' (reads ATLAS_SECRET_KEY); ${CLIENT_METHODS}`,
};

const SERVER_OPTIONS = 'server-options' as const;

const REQUIRE_AUTH_NOTE =
  'requireAuth(): Atlas answers a signed-out request with 401 JSON instead of redirecting to the sign-in page';

const REMIX: ClerkModuleManual = {
  manual:
    'Atlas has no Remix adapter: upgrade to React Router v7 and use @atlasauth/react-router (rootAuthLoader, getAuth and the React components)',
};

const EXPO_SHARED: ReadonlySet<string> = new Set([
  'useAuth',
  'useUser',
  'useSession',
  'useSessionList',
  'useOrganization',
  'SignedIn',
  'SignedOut',
  'Protect',
]);

const EXPO_EXPORTS: Readonly<Record<string, ClerkExportTarget>> = {
  ClerkProvider: { name: 'AtlasProvider' },
  ClerkLoaded: { name: 'AtlasLoaded' },
  ClerkLoading: { name: 'AtlasLoading' },
  useClerk: { module: '@atlasauth/react', name: 'useAtlas' },
};

const EXPO_TOKEN_CACHE: ClerkModuleRule = {
  module: '@atlasauth/expo',
  exports: {
    tokenCache: {
      manual:
        "tokenCache: pass tokenCache={createSecureStoreTokenCache(SecureStore)} to <AtlasProvider> (createSecureStoreTokenCache from '@atlasauth/expo', SecureStore from 'expo-secure-store')",
    },
  },
};

const RR_SERVER: ClerkModuleRule = {
  module: '@atlasauth/react-router',
  shared: new Set(['rootAuthLoader', 'getAuth']),
  exports: {
    clerkMiddleware: {
      manual:
        'clerkMiddleware(): Atlas verifies per loader; call getAuth(args) in loaders (and rootAuthLoader(args) in the root route) instead of a route middleware',
    },
    createClerkClient: CREATE_CLIENT,
  },
};

const NUXT_SERVER: ClerkModuleRule = {
  module: '@atlasauth/nuxt/server',
  exports: {
    getAuth: {
      manual: 'getAuth(event): use await getAtlasAuth(event) from @atlasauth/nuxt/server (async; also auto-imported in server routes)',
    },
    clerkClient: EXPRESS_CLIENT,
    clerkMiddleware: {
      manual:
        'clerkMiddleware(): the Atlas Nuxt module installs its own server middleware; delete this file and protect routes with getAtlasAuth(event) / auth.protect()',
    },
    createRouteMatcher: {
      manual: 'createRouteMatcher(): check event.path in your server middleware and call (await getAtlasAuth(event)).protect()',
    },
  },
};

/**
 * Every Clerk module the codemod knows, keyed by import specifier. A key ending
 * in `/*` covers every subpath of that package not listed on its own.
 */
export const CLERK_MODULES: Readonly<Record<string, ClerkModuleEntry>> = {
  // ---- React ------------------------------------------------------------------
  '@clerk/clerk-react': { module: '@atlasauth/react', react: true },
  '@clerk/react': { module: '@atlasauth/react', react: true },

  // ---- Next.js ----------------------------------------------------------------
  // The root re-exports the React surface (→ @atlasauth/react); the Next.js
  // helpers it also carried in v4 go to @atlasauth/nextjs/server and /compat.
  '@clerk/nextjs': {
    module: '@atlasauth/react',
    react: true,
    providerEnv: { object: 'process.env', prefix: 'NEXT_PUBLIC_' },
    exports: {
      authMiddleware: {
        module: NEXT_COMPAT,
        name: 'createAtlasMiddleware',
        note: 'authMiddleware(): createAtlasMiddleware() protects every matched route except publicRoutes (plus /sign-in and /sign-up); patterns support a trailing (.*) only, and ignoredRoutes / afterAuth / beforeAuth have no counterpart',
      },
      clerkMiddleware: { module: NEXT_COMPAT, name: 'createAtlasMiddleware', fix: 'next-middleware' },
      createRouteMatcher: { module: '@atlasauth/nextjs' },
      auth: { module: NEXT_SERVER, fix: 'next-auth' },
      currentUser: { module: NEXT_SERVER, fix: 'current-user' },
      clerkClient: { module: NEXT_SERVER, name: 'atlasClient', fix: 'client-call', note: `atlasClient(): ${CLIENT_METHODS}` },
      redirectToSignIn: { manual: "redirectToSignIn(): use redirect('/sign-in') from 'next/navigation'" },
    },
  },
  '@clerk/nextjs/server': {
    module: NEXT_SERVER,
    exports: {
      auth: { fix: 'next-auth' },
      currentUser: { fix: 'current-user' },
      clerkClient: { name: 'atlasClient', fix: 'client-call', note: `atlasClient(): ${CLIENT_METHODS}` },
      clerkMiddleware: { module: NEXT_COMPAT, name: 'createAtlasMiddleware', fix: 'next-middleware' },
      createRouteMatcher: { module: '@atlasauth/nextjs' },
      createClerkClient: CREATE_CLIENT,
      verifyToken: VERIFY_TOKEN,
      WebhookEvent: WEBHOOK_EVENT,
      getAuth: {
        manual:
          "getAuth(req) (Pages router): use auth() from an App Router server component or route handler, or new AtlasBackend({ jwksUrl, issuer }).authenticateRequest(req) from '@atlasauth/backend'",
      },
      buildClerkProps: {
        manual: 'buildClerkProps(): not needed; the Atlas client SDK restores the session in the browser (pass getAtlasInitialState() for a first paint with the sign-in data)',
      },
    },
  },
  '@clerk/nextjs/webhooks': { module: BACKEND, exports: { verifyWebhook: VERIFY_WEBHOOK } },
  '@clerk/nextjs/errors': {
    manual:
      "Clerk error helpers have no Atlas counterpart: on the server catch AtlasApiError from '@atlasauth/backend' and branch on err.code",
  },

  // ---- Server adapters --------------------------------------------------------
  '@clerk/backend': {
    module: BACKEND,
    exports: {
      createClerkClient: CREATE_CLIENT,
      verifyToken: VERIFY_TOKEN,
      verifyWebhook: VERIFY_WEBHOOK,
      WebhookEvent: WEBHOOK_EVENT,
    },
  },
  '@clerk/backend/webhooks': { module: BACKEND, exports: { verifyWebhook: VERIFY_WEBHOOK } },
  '@clerk/express': {
    module: '@atlasauth/express',
    reqAuth: true,
    shared: new Set(['getAuth']),
    exports: {
      clerkMiddleware: { name: 'atlasMiddleware', fix: SERVER_OPTIONS },
      requireAuth: { fix: SERVER_OPTIONS, note: REQUIRE_AUTH_NOTE },
      clerkClient: EXPRESS_CLIENT,
      createClerkClient: CREATE_CLIENT,
      verifyToken: VERIFY_TOKEN,
    },
  },
  // Deprecated predecessor of @clerk/express.
  '@clerk/clerk-sdk-node': {
    module: '@atlasauth/express',
    reqAuth: true,
    exports: {
      ClerkExpressWithAuth: { name: 'atlasMiddleware', fix: SERVER_OPTIONS },
      ClerkExpressRequireAuth: { name: 'requireAuth', fix: SERVER_OPTIONS, note: REQUIRE_AUTH_NOTE },
      clerkClient: EXPRESS_CLIENT,
      createClerkClient: CREATE_CLIENT,
      verifyToken: VERIFY_TOKEN,
    },
  },
  '@clerk/fastify': {
    module: '@atlasauth/fastify',
    shared: new Set(['getAuth']),
    exports: {
      clerkPlugin: { name: 'atlasPlugin', fix: 'fastify-register' },
      clerkClient: EXPRESS_CLIENT,
      createClerkClient: CREATE_CLIENT,
      verifyToken: VERIFY_TOKEN,
    },
  },
  '@hono/clerk-auth': {
    module: '@atlasauth/hono',
    shared: new Set(['getAuth']),
    exports: {
      clerkMiddleware: {
        name: 'atlasMiddleware',
        fix: SERVER_OPTIONS,
        note: 'atlasMiddleware: on Cloudflare Workers (no process.env) pass jwksUrl / issuer from your bindings',
      },
    },
  },

  // ---- Meta-frameworks --------------------------------------------------------
  '@clerk/astro': { module: '@atlasauth/astro', defaultExport: 'atlasAstro' },
  '@clerk/astro/server': {
    module: '@atlasauth/astro/server',
    exports: {
      clerkMiddleware: {
        name: 'atlasMiddleware',
        note: 'atlasMiddleware(): Atlas puts the auth state on context.locals.atlas (Clerk: context.locals.auth()); read it with getAuth(context). A handler argument has no counterpart: protect pages with getAuth(context).protect()',
      },
      createRouteMatcher: { manual: 'createRouteMatcher(): check context.url.pathname in your page or middleware and call getAuth(context).protect()' },
      clerkClient: EXPRESS_CLIENT,
    },
  },
  '@clerk/astro/react': {
    module: '@atlasauth/react',
    react: true,
    note: '@atlasauth/react components need an <AtlasProvider publishableKey frontendApi> around the island (Clerk Astro islands shared a global store)',
  },
  '@clerk/astro/components': {
    manual:
      'Atlas has no Astro components: render the @atlasauth/react components as islands (client:load) inside <AtlasProvider>, or gate pages with getAuth(Astro) from @atlasauth/astro/server',
  },
  '@clerk/nuxt': { module: '@atlasauth/nuxt' },
  '@clerk/nuxt/server': NUXT_SERVER,
  '@clerk/vue': {
    module: '@atlasauth/vue',
    shared: new Set([
      'SignedIn',
      'SignedOut',
      'Protect',
      'SignIn',
      'SignUp',
      'UserButton',
      'UserProfile',
      'OrganizationSwitcher',
      'OrganizationProfile',
      'useUser',
      'useSession',
      'useAuth',
      'useOrganization',
    ]),
    exports: {
      useClerk: { name: 'useAtlas' },
      ClerkLoaded: { name: 'AtlasLoaded' },
      ClerkLoading: { name: 'AtlasLoading' },
      clerkPlugin: {
        manual: "app.use(clerkPlugin, { publishableKey }): use app.use(createAtlas({ publishableKey, frontendApi })) with createAtlas from '@atlasauth/vue'",
      },
    },
  },
  '@clerk/react-router': {
    module: '@atlasauth/react-router',
    react: true,
    providerEnv: { object: 'import.meta.env', prefix: 'VITE_' },
  },
  '@clerk/react-router/ssr.server': RR_SERVER,
  '@clerk/react-router/server': RR_SERVER,
  '@clerk/react-router/api.server': RR_SERVER,
  '@clerk/remix': REMIX,
  '@clerk/remix/*': REMIX,
  '@clerk/tanstack-react-start': {
    module: '@atlasauth/tanstack-react-start',
    react: true,
    providerEnv: { object: 'import.meta.env', prefix: 'VITE_' },
  },
  '@clerk/tanstack-react-start/server': {
    module: '@atlasauth/tanstack-react-start',
    shared: new Set(['getAuth']),
    exports: {
      createClerkHandler: {
        manual:
          'createClerkHandler(): keep the plain TanStack Start handler and register createMiddleware().server(createAtlasHandler()) as global request middleware (auth arrives as context.atlasAuth)',
      },
      clerkMiddleware: {
        manual: 'clerkMiddleware(): register createMiddleware().server(createAtlasHandler()) (createAtlasHandler from @atlasauth/tanstack-react-start) as request middleware',
      },
      clerkClient: EXPRESS_CLIENT,
      createClerkClient: CREATE_CLIENT,
    },
  },

  // ---- Native and extensions --------------------------------------------------
  '@clerk/expo': { module: '@atlasauth/expo', shared: EXPO_SHARED, exports: EXPO_EXPORTS, providerEnv: { object: 'process.env', prefix: 'EXPO_PUBLIC_' } },
  '@clerk/clerk-expo': { module: '@atlasauth/expo', shared: EXPO_SHARED, exports: EXPO_EXPORTS, providerEnv: { object: 'process.env', prefix: 'EXPO_PUBLIC_' } },
  '@clerk/expo/token-cache': EXPO_TOKEN_CACHE,
  '@clerk/clerk-expo/token-cache': EXPO_TOKEN_CACHE,
  // The React surface of the extension SDK is the `/react` entry on the Atlas side.
  '@clerk/chrome-extension': {
    module: '@atlasauth/chrome-extension/react',
    react: true,
    exports: {
      createClerkClient: {
        module: '@atlasauth/chrome-extension',
        name: 'createAtlasClient',
        note: 'createAtlasClient({ publishableKey, frontendApi }): it returns an Atlas client (getToken, signOut), not a Clerk instance; check each call',
      },
    },
  },
  '@clerk/chrome-extension/background': {
    module: '@atlasauth/chrome-extension/background',
    exports: {
      createClerkClient: {
        name: 'createAtlasClient',
        note: 'createAtlasClient({ publishableKey, frontendApi }): it returns an Atlas client (getToken, signOut), not a Clerk instance; check each call',
      },
    },
  },

  // ---- Shared packages --------------------------------------------------------
  '@clerk/types': { module: '@atlasauth/types', shared: new Set(['Appearance', 'LocalizationResource', 'DeepPartial']) },
  '@clerk/clerk-js': {
    module: '@atlasauth/js',
    exports: {
      Clerk: {
        manual: 'Clerk (clerk-js): @atlasauth/js has no drop-in browser singleton; use a framework SDK (@atlasauth/react AtlasProvider + hooks, @atlasauth/vue createAtlas)',
      },
    },
  },
  '@clerk/themes': { module: '@atlasauth/themes' },
  '@clerk/localizations': { module: '@atlasauth/localizations' },
  '@clerk/elements': { module: '@atlasauth/elements' },
  '@clerk/testing': { module: '@atlasauth/testing' },
  '@clerk/agent-toolkit': { module: '@atlasauth/agent-toolkit' },
  'gatsby-plugin-clerk': { module: 'gatsby-plugin-atlasauth' },
};

/** The rule for an import specifier: an exact entry, else the package's `/*` entry. */
export function clerkModuleFor(specifier: string): ClerkModuleEntry | undefined {
  const exact = CLERK_MODULES[specifier];
  if (exact) return exact;
  const parts = specifier.split('/');
  const pkg = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return pkg !== specifier ? CLERK_MODULES[`${pkg}/*`] : undefined;
}

/** Clerk props `<AtlasProvider>` has no counterpart for (configured in the Atlas dashboard instead). */
export const CLERK_ONLY_PROVIDER_PROPS: readonly string[] = [
  'afterSignOutUrl',
  'afterSignInUrl',
  'afterSignUpUrl',
  'signInUrl',
  'signUpUrl',
  'signInFallbackRedirectUrl',
  'signUpFallbackRedirectUrl',
  'signInForceRedirectUrl',
  'signUpForceRedirectUrl',
  'waitlistUrl',
  'allowedRedirectOrigins',
  'allowedRedirectProtocols',
  'routerPush',
  'routerReplace',
  'dynamic',
  'telemetry',
  'proxyUrl',
  'domain',
  'isSatellite',
  'satelliteAutoSync',
  'nonce',
  'clerkJSUrl',
  'clerkJSVariant',
  'clerkJSVersion',
  'sdkMetadata',
  'standardBrowser',
  'supportEmail',
  'touchSession',
  'syncHost',
  'loaderData',
  'Clerk',
];

/** Env-var prefixes public Clerk keys carry in each framework. */
const PUBLIC_ENV_PREFIXES = [
  'NEXT_PUBLIC_',
  'VITE_',
  'REACT_APP_',
  'EXPO_PUBLIC_',
  'NUXT_PUBLIC_',
  'NUXT_',
  'PLASMO_PUBLIC_',
  'GATSBY_',
  'PUBLIC_',
];

/**
 * Environment-variable key rename. Clerk prefixes its public/secret keys with
 * `CLERK_` (and a framework prefix such as `NEXT_PUBLIC_`, `VITE_`,
 * `EXPO_PUBLIC_`, `PUBLIC_` (Astro) or `NUXT_PUBLIC_` for browser-exposed vars);
 * Atlas uses `ATLAS_` behind the same prefix (confirmed against the vars read in
 * packages/nextjs/src, packages/nuxt/src and packages/backend/src). Returns the
 * rewritten key, or `null` when the key is not a Clerk env var and must be left
 * alone.
 */
export function renameEnvKey(key: string): string | null {
  for (const prefix of PUBLIC_ENV_PREFIXES) {
    if (key.startsWith(`${prefix}CLERK_`)) {
      return `${prefix}ATLAS_${key.slice(prefix.length + 'CLERK_'.length)}`;
    }
  }
  if (key.startsWith('CLERK_')) {
    return 'ATLAS_' + key.slice('CLERK_'.length);
  }
  return null;
}

/** True for a package specifier that is part of the Clerk ecosystem. */
export function isClerkPackage(specifier: string): boolean {
  return (
    specifier.startsWith('@clerk/') ||
    specifier === 'gatsby-plugin-clerk' ||
    specifier === '@hono/clerk-auth' ||
    specifier.startsWith('@hono/clerk-auth/')
  );
}
