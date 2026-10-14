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
 * Package specifier renames: Clerk npm package -> Atlas npm package.
 *
 * Atlas publishes its React/Next/etc. adapters under the `@atlasauth/*` scope,
 * mirroring Clerk's `@clerk/*` scope one-for-one. The names on the right are the
 * real published Atlas package names (see `packages/<x>/package.json` "name"
 * fields and the ecosystem waves `@atlasauth/{themes,localizations,elements,
 * agent-toolkit}`). Only mappings whose Atlas target actually exists belong
 * here — an unmapped `@clerk/*` import is flagged with a TODO instead.
 */
export const PACKAGE_MAP: Readonly<Record<string, string>> = {
  '@clerk/clerk-react': '@atlasauth/react',
  '@clerk/nextjs': '@atlasauth/nextjs',
  '@clerk/backend': '@atlasauth/backend',
  '@clerk/clerk-js': '@atlasauth/js',
  '@clerk/express': '@atlasauth/express',
  '@clerk/fastify': '@atlasauth/fastify',
  '@clerk/astro': '@atlasauth/astro',
  '@clerk/nuxt': '@atlasauth/nuxt',
  '@clerk/vue': '@atlasauth/vue',
  '@clerk/themes': '@atlasauth/themes',
  '@clerk/localizations': '@atlasauth/localizations',
  '@clerk/elements': '@atlasauth/elements',
  '@clerk/testing': '@atlasauth/testing',
  '@clerk/agent-toolkit': '@atlasauth/agent-toolkit',
  '@clerk/chrome-extension': '@atlasauth/chrome-extension',
  '@clerk/expo': '@atlasauth/expo',
  '@clerk/tanstack-react-start': '@atlasauth/tanstack-react-start',
  // gatsby's convention is an unscoped `gatsby-plugin-<name>` package.
  'gatsby-plugin-clerk': 'gatsby-plugin-atlasauth',
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
 *   - `clerkMiddleware`-> `atlasMiddleware` (packages/nextjs/src/middleware.ts)
 *
 * The large shared surface — `SignedIn`, `SignedOut`, `Protect`, `useUser`,
 * `useAuth`, `useSession`, `useOrganization`, `UserButton`, ... — is *identical*
 * on both sides, so it is deliberately absent: those symbols need no rewrite and
 * must flow through untouched. Any Clerk-specific symbol NOT listed here and NOT
 * in that shared set gets a TODO rather than a guessed rename.
 */
export const IDENTIFIER_MAP: Readonly<Record<string, string>> = {
  ClerkProvider: 'AtlasProvider',
  useClerk: 'useAtlas',
  ClerkLoaded: 'AtlasLoaded',
  ClerkLoading: 'AtlasLoading',
  clerkMiddleware: 'atlasMiddleware',
};

/**
 * Clerk exports that are known to have the SAME name on Atlas. Listing them lets
 * the codemod stay quiet (no TODO) on symbols that are correct as-is, so the
 * TODO noise is reserved for genuinely Clerk-only symbols. This is verified
 * against the Atlas React/Next exports.
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
 * Environment-variable key rename. Clerk prefixes its public/secret keys with
 * `CLERK_` (and `NEXT_PUBLIC_CLERK_` for browser-exposed vars in Next.js); Atlas
 * uses `ATLAS_` / `NEXT_PUBLIC_ATLAS_` (confirmed against the vars read in
 * packages/nextjs/src and packages/backend/src). Returns the rewritten key, or
 * `null` when the key is not a Clerk env var and must be left alone.
 */
export function renameEnvKey(key: string): string | null {
  if (key.startsWith('NEXT_PUBLIC_CLERK_')) {
    return 'NEXT_PUBLIC_ATLAS_' + key.slice('NEXT_PUBLIC_CLERK_'.length);
  }
  if (key.startsWith('CLERK_')) {
    return 'ATLAS_' + key.slice('CLERK_'.length);
  }
  return null;
}

/** True for a package specifier that is part of the Clerk ecosystem. */
export function isClerkPackage(specifier: string): boolean {
  return specifier.startsWith('@clerk/') || specifier === 'gatsby-plugin-clerk';
}
