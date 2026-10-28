import {
  applyImportRules,
  fixProviderProps,
  publicEnvKey,
  renameEnv,
  vendorTransform,
  type EnvStyle,
  type FileFacts,
  type ModuleRule,
  type Target,
} from './engine';
import { ATLAS } from './shared';

/**
 * Stytch → Atlas, across its JavaScript SDKs (`@stytch/nextjs`, `@stytch/react`,
 * `@stytch/vanilla-js` and their `/b2b` variants, and the `stytch` Node SDK):
 *
 *  - `<StytchProvider stytch={client}>` and `<StytchB2BProvider>` → `<AtlasProvider>`
 *    (the `stytch` client prop is removed and reported).
 *  - Everything else is reported with the Atlas call to use: `<StytchLogin />` →
 *    `<SignIn />`, `useStytchUser()` / `useStytchMember()` → `useUser()`,
 *    `useStytchSession()` → `useAuth()` / `useSession()`, the headless client and
 *    the server helpers → `auth()` / the Atlas Backend API, `stytch` (node) → the
 *    Atlas Backend API.
 *  - `STYTCH_*` env vars are renamed or reported.
 */

const provider: Target = {
  module: ATLAS.react,
  name: 'AtlasProvider',
  after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: ['stytch'] }),
};

const MANAGEMENT =
  'manage users, organizations, roles and SSO with the Atlas Backend API (createAtlasClient() from @atlasauth/backend, or atlasClient() from @atlasauth/nextjs/server) and ATLAS_SECRET_KEY';
const NOT_MIGRATED = 'no Atlas counterpart — migrate it manually';
const SIGN_IN = 'render <SignIn /> from @atlasauth/react (Atlas hosts the email, OAuth, passkey and SSO sign-in screens)';
const CLIENT_NOTE = 'the Stytch client has no drop-in: sign in with <SignIn /> or useSignIn() from @atlasauth/react, read the session with useAuth() / useUser(); the zero-logout bridge accepts current Stytch sessions until users sign in again';

const CLIENT: Record<string, Target> = {
  StytchProvider: provider,
  StytchB2BProvider: provider,
  StytchLogin: { manual: `StytchLogin: ${SIGN_IN}` },
  StytchB2B: { manual: `StytchB2B: ${SIGN_IN}` },
  IdentityProvider: { manual: 'IdentityProvider: use Atlas as the OAuth/OIDC provider (Atlas OAuth clients) instead' },
  useStytchUser: { manual: 'useStytchUser(): use useUser() from @atlasauth/react (user → useUser().user, isInitialized → isLoaded)' },
  useStytchMember: { manual: 'useStytchMember(): use useUser() and useOrganization() from @atlasauth/react' },
  useStytchSession: { manual: 'useStytchSession(): use useAuth() / useSession() from @atlasauth/react' },
  useStytchMemberSession: { manual: 'useStytchMemberSession(): use useAuth() (orgId, orgRole) from @atlasauth/react' },
  useStytchOrganization: { manual: 'useStytchOrganization(): use useOrganization() from @atlasauth/react' },
  useStytch: { manual: `useStytch(): ${CLIENT_NOTE}` },
  useStytchIsAuthorized: { manual: 'useStytchIsAuthorized(): use useAuth().has({ permission }) from @atlasauth/react' },
  withStytch: { manual: `withStytch(): ${CLIENT_NOTE}` },
  withStytchUser: { manual: 'withStytchUser(): use useUser() from @atlasauth/react' },
  withStytchSession: { manual: 'withStytchSession(): use useAuth() from @atlasauth/react' },
  createStytchUIClient: { manual: `createStytchUIClient(): ${CLIENT_NOTE}` },
  createStytchHeadlessClient: { manual: `createStytchHeadlessClient(): ${CLIENT_NOTE}` },
  createStytchB2BUIClient: { manual: `createStytchB2BUIClient(): ${CLIENT_NOTE}` },
  createStytchB2BHeadlessClient: { manual: `createStytchB2BHeadlessClient(): ${CLIENT_NOTE}` },
  StytchUIClient: { manual: `StytchUIClient: ${CLIENT_NOTE}` },
  StytchHeadlessClient: { manual: `StytchHeadlessClient: ${CLIENT_NOTE}` },
  StytchB2BUIClient: { manual: `StytchB2BUIClient: ${CLIENT_NOTE}` },
  StytchB2BHeadlessClient: { manual: `StytchB2BHeadlessClient: ${CLIENT_NOTE}` },
};

const SERVER_NOTE = 'read the session on the server with auth() or currentUser() from @atlasauth/nextjs/server (userId, orgId, orgRole); redirect to /sign-in when userId is null';

const RULES: readonly ModuleRule[] = [
  {
    match: (s) => /^@stytch\/nextjs\/(b2b\/)?server$/.test(s),
    default: { manual: `Stytch server helper: ${SERVER_NOTE}` },
    otherNamed: SERVER_NOTE,
    whole: `Stytch server helpers: ${SERVER_NOTE}`,
  },
  {
    match: (s) => /^@stytch\/(nextjs|react|react-native|vanilla-js)(\/.*)?$/.test(s),
    named: CLIENT,
    otherNamed: NOT_MIGRATED,
    whole: `Stytch SDK: ${CLIENT_NOTE}`,
  },
  {
    match: 'stytch',
    default: { manual: `Stytch client: ${MANAGEMENT}; each call is marked where it is used` },
    named: {
      Client: { manual: `Stytch client: ${MANAGEMENT}; each call is marked where it is used` },
      B2BClient: { manual: `Stytch B2B client: ${MANAGEMENT}; each call is marked where it is used` },
    },
    otherNamed: `no Atlas counterpart; ${MANAGEMENT}`,
    whole: `Stytch Node SDK: ${MANAGEMENT}`,
  },
  {
    match: (s) => s.startsWith('@stytch/'),
    default: { manual: NOT_MIGRATED },
    otherNamed: NOT_MIGRATED,
    whole: NOT_MIGRATED,
  },
];

/** What replaces each Stytch `.env` key (also used for `process.env.X` in code). */
export function env(key: string, style: EnvStyle): string | null {
  const m = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?STYTCH_(.+)$/.exec(key);
  if (!m) return null;
  const name = m[2]!;
  if (name === 'PUBLIC_TOKEN') return `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}`;
  if (name === 'SECRET') return 'replace with ATLAS_SECRET_KEY (keep the Stytch secret until your export and the lazy-migration step are done)';
  if (name === 'PROJECT_ID') return 'keep only as the project_id of the stytch bridge and lazy-migration presets until they are retired';
  if (name === 'WEBHOOK_SECRET') return 'replace with the signing secret of an Atlas webhook endpoint';
  return 'remove (not needed with Atlas)';
}

function envRename(style: FileFacts['envStyle']) {
  return (key: string): { to: string } | { report: string } | null => {
    const note = env(key, style);
    if (note === null) return null;
    if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)STYTCH_PUBLIC_TOKEN$/.test(key)) return { to: publicEnvKey(style, 'PUBLISHABLE_KEY') };
    return { report: `${key}: ${note}` };
  };
}

export default vendorTransform({
  mightApply: (source) => /@stytch\/|['"]stytch['"]|STYTCH_/.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});
