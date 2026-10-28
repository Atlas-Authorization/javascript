import {
  applyImportRules,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type FileFacts,
  type ModuleRule,
} from './engine';

/**
 * Userfront → Atlas. Userfront's SDKs (`@userfront/react`, `@userfront/toolkit`,
 * `@userfront/core`, `@userfront/next`, the older `userfront-core` / `userfront-react`)
 * are form components plus a token-reading singleton with no drop-in Atlas
 * counterpart, so nothing is rewritten blind: every import is marked with the
 * Atlas replacement, and the `USERFRONT_*` env vars are reported.
 */

const CLIENT =
  'Userfront client SDK: wrap the app in <AtlasProvider> and render <SignIn /> / <SignUp /> from @atlasauth/react in place of the Userfront forms; read the session with useAuth() / useUser() and sign out with <SignOutButton />';
const SERVER =
  'Userfront server SDK: read the session with auth() / currentUser() from @atlasauth/nextjs/server, or verify tokens with AtlasBackend from @atlasauth/backend; manage users with the Atlas Backend API (createAtlasClient(), ATLAS_SECRET_KEY)';

const RULES: readonly ModuleRule[] = [
  {
    match: (s) => s === '@userfront/next/server',
    default: { manual: SERVER },
    otherNamed: SERVER,
    whole: SERVER,
  },
  {
    match: (s) => s.startsWith('@userfront/') || s === 'userfront-core' || s === 'userfront-react' || s === 'userfront-js',
    default: { manual: CLIENT },
    otherNamed: CLIENT,
    whole: CLIENT,
  },
];

/** What replaces each Userfront `.env` key (also used for `process.env.X` in code). */
export function env(key: string, style: FileFacts['envStyle']): string | null {
  if (/(^|_)USERFRONT_(WORKSPACE_ID|TENANT_ID)$/.test(key)) {
    return `remove; the browser uses ${publicEnvKey(style, 'PUBLISHABLE_KEY')} (keep the tenant id only as the tenant_id of the userfront lazy-migration preset)`;
  }
  if (/(^|_)USERFRONT_API_KEY$/.test(key)) return 'replace with ATLAS_SECRET_KEY (keep the Userfront key until your export is done)';
  if (/(^|_)USERFRONT_JWT_PUBLIC_KEY$/.test(key)) return 'remove (Atlas tokens are verified against the Atlas JWKS)';
  return /(^|_)USERFRONT_/.test(key) ? 'remove (not needed with Atlas)' : null;
}

function envRename(style: FileFacts['envStyle']) {
  return (key: string): { report: string } | null => {
    const note = env(key, style);
    return note === null ? null : { report: `${key}: ${note}` };
  };
}

export default vendorTransform({
  mightApply: (source) => /@userfront\/|userfront-(core|react|js)|USERFRONT_/.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});
