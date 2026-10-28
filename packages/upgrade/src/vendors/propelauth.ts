import {
  applyImportRules,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type FileFacts,
  type ModuleRule,
} from './engine';

/**
 * PropelAuth → Atlas. PropelAuth's SDKs are hosted-page redirects plus token
 * validators with no drop-in Atlas counterpart, so nothing is rewritten blind:
 * every import of `@propelauth/*` is marked with the Atlas replacement, and the
 * `PROPELAUTH_*` env vars are reported.
 */

const CLIENT =
  'PropelAuth client SDK: wrap the app in <AtlasProvider> and render <SignIn /> / <SignUp /> from @atlasauth/react; read the session with useAuth() / useUser(), org membership with useOrganization()';
const SERVER =
  'PropelAuth server SDK: read the session with auth() / currentUser() from @atlasauth/nextjs/server, or verify tokens with AtlasBackend from @atlasauth/backend (the propelauth bridge preset accepts current PropelAuth access tokens until users sign in again)';
const MANAGEMENT =
  'PropelAuth backend API client: manage users, organizations and roles with the Atlas Backend API (createAtlasClient() from @atlasauth/backend, ATLAS_SECRET_KEY)';

const RULES: readonly ModuleRule[] = [
  {
    match: (s) => s === '@propelauth/react' || s === '@propelauth/javascript' || s === '@propelauth/nextjs/client' || s === '@propelauth/auth-provider',
    default: { manual: CLIENT },
    otherNamed: CLIENT,
    whole: CLIENT,
  },
  {
    match: (s) => s === '@propelauth/node-apis' || s === '@propelauth/js-apis' || s === '@propelauth/node',
    default: { manual: MANAGEMENT },
    otherNamed: `${MANAGEMENT}; token validation: ${SERVER}`,
    whole: MANAGEMENT,
  },
  {
    match: (s) => s.startsWith('@propelauth/'),
    default: { manual: SERVER },
    otherNamed: SERVER,
    whole: SERVER,
  },
];

/** What replaces each PropelAuth `.env` key (also used for `process.env.X` in code). */
export function env(key: string, style: FileFacts['envStyle']): string | null {
  if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)AUTH_URL$/.test(key) || /(^|_)PROPELAUTH_AUTH_URL$/.test(key)) {
    return `remove once the zero-logout bridge is retired (the bridge needs it until then); the browser uses ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`;
  }
  if (/(^|_)PROPELAUTH_API_KEY$/.test(key)) return 'replace with ATLAS_SECRET_KEY (keep the PropelAuth key until your export is done)';
  if (/(^|_)PROPELAUTH_VERIFIER_KEY$/.test(key)) return 'remove once the zero-logout bridge is retired (the propelauth bridge preset needs it until then)';
  return /(^|_)PROPELAUTH_/.test(key) ? 'remove (not needed with Atlas)' : null;
}

function envRename(style: FileFacts['envStyle']) {
  return (key: string): { report: string } | null => {
    const note = env(key, style);
    return note === null ? null : { report: `${key}: ${note}` };
  };
}

export default vendorTransform({
  mightApply: (source) => /@propelauth\/|PROPELAUTH_/.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});
