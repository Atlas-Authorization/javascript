import {
  effectScope,
  shallowRef,
  watch,
  type App,
  type Plugin,
  type ShallowRef,
} from 'vue';
import {
  FapiClient,
  TokenCache,
  getProviderToken as fetchProviderToken,
  msUntilRefresh,
  readExpiry,
  readRedirectResult,
  stripRedirectParams,
  type ProviderToken,
} from '@atlasauth/js';
import { cssVariables, resolveTokens, type Appearance } from './appearance';
import { EN_US, withFallback, type Catalog } from './i18n';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

/**
 * §10.1 `app.use(createAtlas({ publishableKey }))`.
 *
 * The Vue peer of React's `<AtlasProvider>`. Holds exactly one thing that
 * matters: the token, in memory. Not localStorage, not a cookie this code
 * writes — the refresh token is HttpOnly so browser script never touches it,
 * and the short-lived JWT lives only as long as the tab. A client that
 * persisted either would survive the tab and become the thing an XSS reads
 * first.
 */

export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

/**
 * The reactive auth state + actions provided to the whole app. Every field the
 * React `AtlasContextValue` exposes, but the mutable ones are Vue refs so a
 * composable can hand back a live `computed` rather than a snapshot.
 */
export interface AtlasClient {
  publishableKey: string;
  /** The instance's FAPI origin. */
  frontendApi: string;
  appearance?: Appearance;
  catalog: Catalog;
  status: ShallowRef<AuthStatus>;
  user: ShallowRef<AtlasUser | null>;
  session: ShallowRef<AtlasSession | null>;
  claims: ShallowRef<SessionClaims | null>;
  memberships: ShallowRef<AtlasOrganizationMembership[]>;
  /**
   * §5.3: a sign-in attempt handed back by an OAuth redirect that still needs a
   * second factor (no session was issued). Null in the ordinary case. The
   * <SignIn> flow seeds itself from this so the user resumes at the 2FA step
   * instead of starting over. Captured synchronously at install time — before
   * any component reads it — because a `needs_second_factor` redirect carries a
   * status but no ticket, and that is what the 2FA resume seeds from.
   */
  pendingAttempt: { id: string; status: string } | null;
  /** Always fresh: refreshes first if the cached token is close to expiry. */
  getToken(): Promise<string | null>;
  /**
   * §6.6 the signed-in user's OWN live token at a connected provider (Google,
   * GitHub, …), so the app can call that provider's API. Null when there is no
   * usable token — no linked account, or the provider granted / kept none. The
   * server refreshes a stale token on read; the refresh token is never exposed.
   */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  signOut(): Promise<void>;
  setActiveOrganization(organizationId: string | null): Promise<void>;
  reload(): Promise<void>;
}

export interface CreateAtlasOptions {
  publishableKey: string;
  /** The instance's FAPI origin. */
  frontendApi?: string;
  appearance?: Appearance;
  localization?: Catalog;
  fetchImpl?: typeof fetch;
}

/**
 * Build the Vue plugin. `app.use(createAtlas({ publishableKey }))` installs the
 * client, provides it for `inject`, paints the appearance tokens onto the host
 * DOM as CSS variables (no iframe — components render in the host DOM so
 * Tailwind/CSS just works), and boots the session.
 */
export function createAtlas(options: CreateAtlasOptions): Plugin {
  const { client, boot } = createAtlasClient(options);

  return {
    install(app: App) {
      app.provide(ATLAS_INJECTION_KEY, client);

      // Tokens land as CSS variables on the host document root — the Vue peer of
      // React's `<div class="atlas-root" style={cssVars}>`. There is no single
      // element wrapping the whole app in a plugin, so the document root inherits
      // them for every component that renders.
      if (typeof document !== 'undefined') {
        const vars = cssVariables(resolveTokens(options.appearance));
        for (const [name, value] of Object.entries(vars)) {
          document.documentElement.style.setProperty(name, value);
        }
        document.documentElement.classList.add('atlas-root');
      }

      // Boot once per install. Guarded to the browser: on the server there is no
      // redirect to complete and no cookie jar to read, so the app renders
      // `loading` and hydrates into the real status on the client.
      if (typeof window !== 'undefined') {
        void boot();
      }
    },
  };
}

/**
 * The reactive client. Separated from the plugin wrapper so a test can build it
 * directly, and so a single `createAtlas(...)` result installs one consistent
 * client no matter how many times the returned plugin is `use`d.
 */
function createAtlasClient(options: CreateAtlasOptions): {
  client: AtlasClient;
  boot: () => Promise<void>;
} {
  const publishableKey = options.publishableKey;
  const baseUrl = options.frontendApi ?? '';
  const doFetch = options.fetchImpl ?? fetch;

  const status = shallowRef<AuthStatus>('loading');
  const user = shallowRef<AtlasUser | null>(null);
  const session = shallowRef<AtlasSession | null>(null);
  const claims = shallowRef<SessionClaims | null>(null);
  const memberships = shallowRef<AtlasOrganizationMembership[]>([]);

  const cache = new TokenCache();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pendingAttempt: { id: string; status: string } | null = (() => {
    if (typeof window === 'undefined') return null;
    const result = readRedirectResult(window.location.search);
    return result?.status && !result.ticket
      ? { id: result.attemptId, status: result.status }
      : null;
  })();

  const call = (path: string, init?: RequestInit) =>
    doFetch(`${baseUrl}${path}`, {
      ...init,
      // Cookies carry the session; a fetch without this looks identical to
      // being signed out.
      credentials: 'include',
      headers: {
        'x-publishable-key': publishableKey,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });

  const applyToken = (jwt: string, sessionId: string) => {
    const expiresAt = readExpiry(jwt);
    if (!expiresAt) return;
    cache.set({ jwt, expiresAt, sessionId });
    claims.value = decodeClaims(jwt);
  };

  const reload = async () => {
    try {
      const response = await call('/v1/client');
      if (!response.ok) throw new Error('boot failed');

      const body = (await response.json()) as {
        session: AtlasSession | null;
        user: AtlasUser | null;
        jwt?: string;
        organization_memberships?: AtlasOrganizationMembership[];
      };

      if (!body.session || !body.user) {
        cache.clear();
        status.value = 'signed_out';
        user.value = null;
        session.value = null;
        claims.value = null;
        memberships.value = [];
        return;
      }

      user.value = body.user;
      session.value = body.session;
      memberships.value = body.organization_memberships ?? [];
      if (body.jwt) applyToken(body.jwt, body.session.id);
      status.value = 'signed_in';
    } catch {
      // A failed boot is NOT signed-out. Rendering a sign-in form because the
      // network hiccuped throws away a perfectly good session and makes the
      // user re-authenticate for no reason.
      if (status.value === 'loading') status.value = 'signed_out';
    }
  };

  const refresh = async () => {
    const current = cache.peek();
    if (!current) return;

    try {
      const response = await call(`/v1/client/sessions/${current.sessionId}/tokens`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('refresh failed');

      const body = (await response.json()) as { jwt: string; session_id: string };
      applyToken(body.jwt, body.session_id);
    } catch {
      // The session may genuinely be gone. Re-boot rather than guess.
      await reload();
    }
  };

  /** §7.4: proactive, jittered refresh scheduled from the token's own expiry. */
  const scheduleRefresh = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (status.value !== 'signed_in') return;
    const token = cache.peek();
    if (!token) return;
    const delay = msUntilRefresh({ token, now: Date.now() });
    timer = setTimeout(() => void refresh(), delay);
  };

  const getToken = async () => {
    // A 5s skew so a token that would die inside the caller's request is
    // refreshed first rather than handed over.
    const usable = cache.get(5_000);
    if (usable) return usable.jwt;
    await refresh();
    return cache.get(5_000)?.jwt ?? null;
  };

  // The FAPI client for the token-vault read. Reuses the same publishable key
  // and fetch so the framework-agnostic `@atlasauth/js` helper is the single
  // implementation the Vue SDK surfaces.
  const fapiClient = new FapiClient({ publishableKey, baseUrl, fetchImpl: doFetch });
  const getProviderToken = (provider: string) => fetchProviderToken(fapiClient, provider);

  const signOut = async () => {
    const current = cache.peek();
    if (current) {
      await call(`/v1/client/sessions/${current.sessionId}/revoke`, { method: 'POST' }).catch(
        () => undefined,
      );
    }
    cache.clear();
    status.value = 'signed_out';
    user.value = null;
    session.value = null;
    claims.value = null;
    memberships.value = [];
  };

  const setActiveOrganization = async (organizationId: string | null) => {
    const current = cache.peek();
    if (!current) return;

    const response = await call(`/v1/client/sessions/${current.sessionId}/touch`, {
      method: 'POST',
      body: JSON.stringify({ active_organization_id: organizationId }),
    });
    if (!response.ok) return;

    const body = (await response.json()) as { jwt: string };
    // The new token carries the new org claims; re-boot would work too but
    // costs a round trip for information already in hand.
    applyToken(body.jwt, current.sessionId);
    await reload();
  };

  const catalog = options.localization ? withFallback(options.localization) : EN_US;

  // §7.4 the refresh timer is driven off the reactive state. Any change to
  // status or claims (a new token has new claims and a new expiry) reschedules
  // the proactive refresh — the Vue peer of React's expiry effect. A detached
  // scope so the watcher lives for the app's lifetime and never attaches to a
  // component that happens to install the plugin.
  const scope = effectScope(true);
  scope.run(() => {
    watch([status, claims], () => scheduleRefresh(), { flush: 'post' });
  });

  /**
   * §6.3 step 3: complete a redirect-based sign-in. An OAuth or hosted-page flow
   * lands back here with a one-time ticket in the URL; exchange it for cookies,
   * scrub the URL so a reload can't replay it, THEN boot. A redirect that only
   * carries a `__atlas_status` (a second factor is still owed) has no ticket, so
   * nothing is exchanged and the app boots signed-out — exactly as intended.
   */
  const boot = async () => {
    const result =
      typeof window !== 'undefined' ? readRedirectResult(window.location.search) : null;

    if (result?.ticket) {
      await call('/v1/client/tickets/exchange', {
        method: 'POST',
        body: JSON.stringify({ attempt_id: result.attemptId, ticket: result.ticket }),
      }).catch(() => undefined);
    }
    if (result && typeof window !== 'undefined') {
      window.history.replaceState({}, document.title, stripRedirectParams(window.location.href));
    }
    await reload();
  };

  // `boot` is returned separately, not on the client — it is an install-time
  // concern the plugin drives exactly once, so the public `AtlasClient` surface
  // stays identical to React's context value.
  return {
    client: {
      publishableKey,
      frontendApi: baseUrl,
      appearance: options.appearance,
      catalog,
      status,
      user,
      session,
      claims,
      memberships,
      pendingAttempt,
      getToken,
      getProviderToken,
      signOut,
      setActiveOrganization,
      reload,
    },
    boot,
  };
}

function decodeClaims(jwt: string): SessionClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as SessionClaims;
  } catch {
    return null;
  }
}
