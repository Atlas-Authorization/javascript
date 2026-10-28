import {
  applyImportRules,
  applyReexportRules,
  callOf,
  renameEnv,
  vendorTransform,
  type ImportTarget,
  type ModuleRule,
} from './engine';
import { ATLAS, reportRoute } from './shared';

/**
 * Better Auth → Atlas.
 *
 *  - `createAuthClient()` (`better-auth/react`) → `createBetterAuthCompatClient()`:
 *    the same `useSession` / `getSession` / `signIn.*` / `signUp.email` / `signOut`
 *    members, so `authClient.useSession()` call sites keep working;
 *  - `betterAuth({...})` → `createBetterAuthServerCompat()`: `auth.api.getSession()`
 *    and `auth.api.signOut()` keep working;
 *  - `toNextJsHandler(auth)` → a 404 route (delete it), `getSessionCookie(request)`
 *    → the Atlas signed-in hint for middleware;
 *  - plugins, adapters and the server config are reported.
 */

const ignoredConfig: Pick<ImportTarget, 'after'> = {
  after: (ref, ctx) => {
    if ((callOf(ref)?.args.length ?? 0) > 0) {
      ctx.report(
        ref,
        'the Better Auth config passed here is now ignored: enable its sign-in methods and plugins (organizations, 2FA, passkeys, magic links) in the Atlas dashboard, then delete it; move users with `atlas import --from better-auth`',
      );
    }
  },
};

const RULES: readonly ModuleRule[] = [
  {
    match: (s) => s === 'better-auth/react' || s === 'better-auth/client',
    named: {
      createAuthClient: { module: ATLAS.reactCompat, name: 'createBetterAuthCompatClient', ...ignoredConfig },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: 'better-auth/client/plugins',
    otherNamed:
      'Better Auth client plugin: the matching feature is built into Atlas (organizations → useOrganization(), 2FA/passkeys/magic links → the sign-in page); remove the plugin and its authClient.<plugin> calls',
  },
  {
    match: 'better-auth',
    named: {
      betterAuth: { module: ATLAS.nextCompat, name: 'createBetterAuthServerCompat', ...ignoredConfig },
      Session: { module: ATLAS.nextCompat, name: 'BetterAuthServerSession', typeOnly: true },
      User: { manual: "Better Auth's User type: use BetterAuthServerSession['user'] from @atlasauth/nextjs/compat" },
      BetterAuthOptions: { manual: 'Better Auth config type: delete it with the config' },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: 'better-auth/next-js',
    named: {
      toNextJsHandler: {
        module: ATLAS.nextCompat,
        name: 'toNextJsHandlerCompat',
        after: (ref, ctx) => ctx.report(ref, 'this Better Auth route is no longer used (Atlas hosts sign-in, sign-out and callbacks): delete it'),
      },
      nextCookies: { manual: 'nextCookies(): Atlas sets its own cookies; remove the plugin' },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: 'better-auth/cookies',
    named: {
      getSessionCookie: { module: ATLAS.nextCompat, name: 'getSessionCookieCompat' },
      getCookieCache: { manual: 'getCookieCache(): verify the session in the page with auth() from @atlasauth/nextjs/server' },
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: (s) => s.startsWith('better-auth/adapters') || s === 'better-auth/plugins' || s.startsWith('better-auth/plugins/') || s === 'better-auth/api' || s === 'better-auth/crypto',
    otherNamed:
      'Better Auth server config (adapter/plugin): Atlas stores users and runs these features itself; remove it with the config',
  },
  {
    match: (s) => s.startsWith('better-auth/') || s.startsWith('@better-auth/'),
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
];

export default vendorTransform({
  mightApply: (source, path) => /better-auth|BETTER_AUTH_/.test(source) || /api\/auth\/\[\.\.\.all\]/.test(path),
  run(ctx) {
    reportRoute(ctx, /api\/auth\/\[\.\.\.all\]/, 'this Better Auth route is no longer used (Atlas hosts sign-in, sign-out and callbacks): delete it');
    applyReexportRules(ctx, RULES);
    applyImportRules(ctx, RULES);
    renameEnv(ctx, (key) => {
      if (/^(NEXT_PUBLIC_|VITE_|PUBLIC_)?BETTER_AUTH_URL$/.test(key)) {
        return { report: `${key}: not needed (the compat client ignores baseURL); set the Atlas publishable key and frontend API env vars instead` };
      }
      if (key === 'BETTER_AUTH_SECRET') return { report: 'BETTER_AUTH_SECRET: Atlas signs sessions itself; server code uses ATLAS_SECRET_KEY' };
      return null;
    });
  },
});
