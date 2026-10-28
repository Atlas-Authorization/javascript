import { applyImportRules, fixProviderProps, publicEnvKey, renameEnv, vendorTransform, type EnvStyle, type ModuleRule, type Target, type VendorContext } from './engine';
import { ATLAS } from './shared';

/**
 * Keycloak → Atlas, across its JavaScript clients:
 *
 *  - `@react-keycloak/web` / `@react-keycloak/ssr`: `<ReactKeycloakProvider>`
 *    → `<AtlasProvider>` (the provider's Keycloak client and init options are
 *    dropped: the Atlas frontend API and publishable key come from the Atlas
 *    env vars); `useKeycloak()` is reported with the Atlas hook that replaces it.
 *  - `keycloak-js`: the client class is reported, and so is each call on a
 *    variable named for Keycloak that has an Atlas counterpart (`login()`,
 *    `logout()`, `updateToken()`, `loadUserProfile()`, `hasRealmRole()` …).
 *  - `keycloak-connect`, `@keycloak/keycloak-admin-client`, `keycloak-angular`,
 *    the Auth.js / NextAuth Keycloak provider: no drop-in; each import is marked
 *    with the Atlas call that replaces it.
 *  - `KEYCLOAK_*` / `AUTH_KEYCLOAK_*` env vars.
 *
 * Verifying a Keycloak access token on a server with `jose` and the realm's
 * `/protocol/openid-connect/certs` is the `--from jose` codemod.
 */

const manual = (message: string): Target => ({ manual: message });

const CLIENT = 'the Keycloak client: read the session with useAuth() / useUser() from @atlasauth/react; sign in with <SignInButton /> and out with <SignOutButton /> or useAuth().signOut(); send useAuth().getToken() to your API';

const PROVIDER_DROP = ['authClient', 'initOptions', 'LoadingComponent', 'isLoadingCheck', 'autoRefreshToken', 'onEvent', 'onTokens', 'onInitError', 'keycloak', 'persistor'];

const HOOK = manual(`useKeycloak(): ${CLIENT}; keycloak.token → await useAuth().getToken(), keycloak.tokenParsed → useAuth().claims, hasRealmRole() → the roles on useUser()`);

const RULES: readonly ModuleRule[] = [
  {
    match: (s) => s === '@react-keycloak/web' || s === '@react-keycloak/ssr',
    named: {
      ReactKeycloakProvider: { module: ATLAS.react, name: 'AtlasProvider', after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: PROVIDER_DROP }) },
      SSRKeycloakProvider: { module: ATLAS.react, name: 'AtlasProvider', after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: [...PROVIDER_DROP, 'keycloakConfig', 'persistor'] }) },
      useKeycloak: HOOK,
      SSRCookies: manual('SSRCookies: Atlas keeps the session in its own cookies; delete the cookie persistor'),
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: 'keycloak-js',
    default: manual(`new Keycloak(config): ${CLIENT}`),
    named: { Keycloak: manual(`new Keycloak(config): ${CLIENT}`) },
    otherNamed: 'Keycloak types are not needed with Atlas; failed calls throw typed errors you can branch on (see the SDK reference)',
    whole: `namespace import of 'keycloak-js' — ${CLIENT}`,
  },
  {
    match: 'keycloak-connect',
    default: manual('Keycloak (keycloak-connect): replace keycloak.middleware() / protect() with atlasMiddleware() and requireAuth() from @atlasauth/express; read the user with getAuth(req); delete the session store'),
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: '@keycloak/keycloak-admin-client',
    default: manual('KcAdminClient: manage users, roles and organizations with AtlasBackend from @atlasauth/backend (the Atlas Backend API)'),
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: (s) => s === 'next-auth/providers/keycloak' || s === '@auth/core/providers/keycloak' || s === '@auth/sveltekit/providers/keycloak',
    default: manual('Keycloak provider (Auth.js): run `atlas migrate code --from authjs` for the Auth.js setup, then delete this provider; Atlas hosts sign-in'),
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: (s) => s === 'keycloak-angular' || s === 'keycloak-ionic' || s === '@dsb-norge/vue-keycloak-js',
    default: manual(CLIENT),
    otherNamed: `no Atlas counterpart — ${CLIENT}`,
    whole: `namespace import of a Keycloak SDK — ${CLIENT}`,
  },
];

/** keycloak-js members that have an Atlas counterpart. */
const CLIENT_CALLS: Record<string, string> = {
  login: 'keycloak.login(): <SignInButton /> from @atlasauth/react, or link to /sign-in',
  register: 'keycloak.register(): link to /sign-up',
  logout: 'keycloak.logout(): useAuth().signOut() or <SignOutButton /> from @atlasauth/react',
  updateToken: 'keycloak.updateToken(): not needed; await useAuth().getToken() returns a fresh Atlas session token',
  loadUserProfile: 'keycloak.loadUserProfile(): useUser() from @atlasauth/react (currentUser() on the server)',
  loadUserInfo: 'keycloak.loadUserInfo(): useUser() from @atlasauth/react (currentUser() on the server)',
  hasRealmRole: 'keycloak.hasRealmRole(): the roles on useUser() / the session claims (roles carry over by name)',
  hasResourceRole: 'keycloak.hasResourceRole(): the roles on useUser() / the session claims (client roles carry over as <client>:<role>)',
  accountManagement: 'keycloak.accountManagement(): <UserProfile /> from @atlasauth/react',
  createLoginUrl: 'keycloak.createLoginUrl(): link to /sign-in',
  createLogoutUrl: 'keycloak.createLogoutUrl(): useAuth().signOut()',
};

const importsKeycloak = (ctx: VendorContext): boolean => {
  const { j, root } = ctx;
  return root.find(j.ImportDeclaration).nodes().some((n) => /keycloak/i.test(String(n.source.value)));
};

/** Calls on a variable named for Keycloak, in a file that imports a Keycloak package. */
function clientCalls(ctx: VendorContext): void {
  if (!importsKeycloak(ctx)) return;
  const { j, root } = ctx;
  root.find(j.CallExpression).forEach((path) => {
    const callee = path.node.callee as { type: string; computed?: boolean; object?: { type: string; name?: string }; property?: { type: string; name?: string } };
    if ((callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') || callee.computed || callee.property?.type !== 'Identifier') return;
    if (callee.object?.type !== 'Identifier' || !/^(keycloak|kc)$/i.test(callee.object.name ?? '')) return;
    const note = CLIENT_CALLS[callee.property.name!];
    if (note) ctx.manual(path, note);
  });
}

const SECRET = /^(CLIENT_SECRET|ADMIN_PASSWORD|ADMIN_CLIENT_SECRET|SECRET)$/;

/** `.env` slots: where the value now comes from. */
function envRename(style: EnvStyle) {
  return (key: string): { to: string } | { report: string } | null => {
    const auth = /^AUTH_KEYCLOAK_(ID|SECRET|ISSUER)$/.exec(key);
    if (auth) return { report: `${key}: the Auth.js Keycloak provider setting; delete it with the provider (Atlas hosts sign-in)` };
    const m = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?KEYCLOAK_(.+)$/.exec(key);
    if (!m) return null;
    const prefix = m[1] ?? '';
    const rest = m[2]!;
    if (/^(URL|BASE_URL|AUTH_SERVER_URL|SERVER_URL)$/.test(rest)) {
      return prefix ? { to: `${prefix}ATLAS_FRONTEND_API` } : { report: `${key}: the Keycloak server URL; the browser uses ${publicEnvKey(style, 'FRONTEND_API')}, servers verify tokens with ATLAS_JWKS_URL` };
    }
    if (rest === 'CLIENT_ID') return prefix ? { to: `${prefix}ATLAS_PUBLISHABLE_KEY` } : { report: `${key}: server code identifies the instance with ATLAS_SECRET_KEY; the browser uses ${publicEnvKey(style, 'PUBLISHABLE_KEY')}` };
    if (rest === 'ISSUER' && !prefix) return { to: 'ATLAS_ISSUER' };
    if (rest === 'REALM') return { report: `${key}: not needed; Atlas has no realms (one instance per realm)` };
    if (SECRET.test(rest)) return { report: `${key}: server code uses ATLAS_SECRET_KEY (from the Atlas dashboard)` };
    return null;
  };
}

export default vendorTransform({
  mightApply: (source) => /keycloak/i.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
    clientCalls(ctx);
    renameEnv(ctx, envRename(ctx.facts.envStyle));
  },
});

export const keycloakPackages = (name: string): boolean => /^(keycloak-js|keycloak-connect|keycloak-angular|keycloak-ionic|@react-keycloak\/|@keycloak\/|@dsb-norge\/vue-keycloak-js)/.test(name);

export const keycloakEnv = (key: string, style: EnvStyle): string | null => {
  if (/^AUTH_KEYCLOAK_/.test(key)) return 'remove (Auth.js Keycloak provider)';
  const m = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)?KEYCLOAK_(.+)$/.exec(key);
  if (!m) return null;
  const prefix = m[1] ?? '';
  const rest = m[2]!;
  if (/^(URL|BASE_URL|AUTH_SERVER_URL|SERVER_URL)$/.test(rest)) return prefix ? `replace with ${publicEnvKey(style, 'FRONTEND_API')}` : 'remove (servers verify tokens with ATLAS_JWKS_URL)';
  if (rest === 'CLIENT_ID') return prefix ? `replace with ${publicEnvKey(style, 'PUBLISHABLE_KEY')}` : 'remove; set ATLAS_SECRET_KEY';
  if (rest === 'ISSUER' && !prefix) return 'replace with ATLAS_ISSUER';
  if (SECRET.test(rest)) return 'remove; set ATLAS_SECRET_KEY';
  return 'remove (not needed with Atlas)';
};
