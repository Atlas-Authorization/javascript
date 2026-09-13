import { getContext, setContext } from 'svelte';
import { derived, get, writable, type Readable } from 'svelte/store';
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
import { EN_US, withFallback, type Catalog } from './i18n';
import type { Appearance } from './appearance';
import type {
  AtlasOrganizationMembership,
  AtlasSession,
  AtlasUser,
  SessionClaims,
} from './types';

/**
 * §10.1 the Svelte peer of React's `<AtlasProvider>`.
 *
 * React installs the auth engine through a context provider component and hands
 * state out via hooks. The Svelte idiom is the same shape turned inside out: the
 * engine is a plain controller whose reactive state is exposed as Svelte
 * **stores**, installed into component context by {@link initAtlas} so the
 * accessors ({@link useAtlas}, {@link getUser}, …) can `getContext` it back.
 *
 * It holds exactly one thing that matters: the token, in memory. Not
 * localStorage, not a cookie this code writes — the refresh token is HttpOnly so
 * browser script never touches it, and the short-lived JWT lives only as long as
 * the tab. Persisting either would survive the tab and become the thing an XSS
 * reads first.
 */

export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

/** The context key. A `Symbol` so it cannot collide with an app's own context. */
export const ATLAS_KEY = Symbol('atlas');

export interface AtlasInitOptions {
  publishableKey: string;
  /** The instance's FAPI origin. Empty for same-origin. */
  frontendApi?: string;
  appearance?: Appearance;
  localization?: Catalog;
  fetchImpl?: typeof fetch;
  /**
   * Skip the automatic browser boot (redirect handling + `/v1/client` load).
   * Useful in tests, or when the caller wants to drive `boot()` by hand.
   */
  manualBoot?: boolean;
}

/**
 * The reactive surface. Every field is a Svelte store, so `$user`, `$session`,
 * `$isSignedIn` work in a `.svelte` template and `get(user)` works in plain TS.
 */
export interface AtlasStores {
  /** `'loading' | 'signed_in' | 'signed_out'`. */
  status: Readable<AuthStatus>;
  user: Readable<AtlasUser | null>;
  session: Readable<AtlasSession | null>;
  claims: Readable<SessionClaims | null>;
  memberships: Readable<AtlasOrganizationMembership[]>;
  /** `status === 'signed_in'`. */
  isSignedIn: Readable<boolean>;
  /** `status !== 'loading'` — the guard against a flash of signed-out content. */
  isLoaded: Readable<boolean>;
}

export interface AtlasClient extends AtlasStores {
  publishableKey: string;
  frontendApi: string;
  appearance?: Appearance;
  catalog: Catalog;
  /**
   * §5.3: a sign-in attempt handed back by an OAuth redirect that still needs a
   * second factor (no session was issued). Null in the ordinary case. `<SignIn>`
   * seeds itself from this so the user resumes at the 2FA step.
   */
  pendingAttempt: { id: string; status: string } | null;
  getToken(): Promise<string | null>;
  /**
   * §6.6 the signed-in user's OWN live token at a connected provider (Google,
   * GitHub, …). Null when there is no usable token. The refresh token is never
   * exposed; the server refreshes a stale token on read.
   */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  signOut(): Promise<void>;
  setActiveOrganization(organizationId: string | null): Promise<void>;
  reload(): Promise<void>;
  /**
   * Redirect handling + the first `/v1/client` load. Runs once, in the browser
   * only. {@link initAtlas} calls it automatically unless `manualBoot` is set;
   * `<AtlasProvider>` also calls it in `onMount`, and a second call is a no-op.
   */
  boot(): Promise<void>;
  /** Cancel the scheduled refresh — call from a component's `onDestroy`. */
  destroy(): void;
}

interface ClientBody {
  session: AtlasSession | null;
  user: AtlasUser | null;
  jwt?: string;
  organization_memberships?: AtlasOrganizationMembership[];
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

/**
 * Build the auth controller. Framework-agnostic aside from the Svelte stores it
 * exposes; {@link initAtlas} is the thin wrapper that also `setContext`s it.
 */
export function createAtlasClient(options: AtlasInitOptions): AtlasClient {
  const { publishableKey } = options;
  const baseUrl = options.frontendApi ?? '';
  const doFetch = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const catalog = options.localization ? withFallback(options.localization) : EN_US;

  const status = writable<AuthStatus>('loading');
  const user = writable<AtlasUser | null>(null);
  const session = writable<AtlasSession | null>(null);
  const claims = writable<SessionClaims | null>(null);
  const memberships = writable<AtlasOrganizationMembership[]>([]);

  const cache = new TokenCache();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let booted = false;

  /**
   * Captured synchronously at construction (not after boot) so it is in context
   * before `<SignIn>` reads it — a needs_second_factor redirect carries a status
   * but no ticket, and that is what the 2FA resume seeds from.
   */
  const pendingAttempt: { id: string; status: string } | null = (() => {
    if (typeof window === 'undefined') return null;
    const result = readRedirectResult(window.location.search);
    return result?.status && !result.ticket
      ? { id: result.attemptId, status: result.status }
      : null;
  })();

  async function call(path: string, init?: RequestInit): Promise<Response> {
    if (!doFetch) throw new Error('No fetch implementation available.');
    return doFetch(`${baseUrl}${path}`, {
      ...init,
      // Cookies carry the session; a fetch without this looks identical to being
      // signed out.
      credentials: 'include',
      headers: {
        'x-publishable-key': publishableKey,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  }

  function applyToken(jwt: string, sessionId: string): void {
    const expiresAt = readExpiry(jwt);
    if (!expiresAt) return;
    cache.set({ jwt, expiresAt, sessionId });
    claims.set(decodeClaims(jwt));
  }

  function clearSession(): void {
    cache.clear();
    status.set('signed_out');
    user.set(null);
    session.set(null);
    claims.set(null);
    memberships.set([]);
  }

  function scheduleRefresh(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (get(status) !== 'signed_in') return;
    const token = cache.peek();
    if (!token) return;
    // §7.4: proactive, jittered refresh scheduled from the token's own expiry.
    const delay = msUntilRefresh({ token, now: Date.now() });
    timer = setTimeout(() => void refresh(), delay);
  }

  async function reload(): Promise<void> {
    try {
      const response = await call('/v1/client');
      if (!response.ok) throw new Error('boot failed');

      const body = (await response.json()) as ClientBody;
      if (!body.session || !body.user) {
        clearSession();
        return;
      }

      user.set(body.user);
      session.set(body.session);
      memberships.set(body.organization_memberships ?? []);
      if (body.jwt) applyToken(body.jwt, body.session.id);
      status.set('signed_in');
      scheduleRefresh();
    } catch {
      /**
       * A failed boot is NOT signed-out. Rendering a sign-in form because the
       * network hiccuped throws away a perfectly good session and makes the user
       * re-authenticate for no reason.
       */
      status.update((current) => (current === 'loading' ? 'signed_out' : current));
    }
  }

  async function refresh(): Promise<void> {
    const current = cache.peek();
    if (!current) return;
    try {
      const response = await call(`/v1/client/sessions/${current.sessionId}/tokens`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('refresh failed');
      const body = (await response.json()) as { jwt: string; session_id: string };
      applyToken(body.jwt, body.session_id);
      scheduleRefresh();
    } catch {
      // The session may genuinely be gone. Re-boot rather than guess.
      await reload();
    }
  }

  async function getToken(): Promise<string | null> {
    // A 5s skew so a token that would die inside the caller's request is
    // refreshed first rather than handed over.
    const usable = cache.get(5_000);
    if (usable) return usable.jwt;
    await refresh();
    return cache.get(5_000)?.jwt ?? null;
  }

  const fapiClient = new FapiClient({ publishableKey, baseUrl, fetchImpl: doFetch });

  function getProviderToken(provider: string): Promise<ProviderToken | null> {
    return fetchProviderToken(fapiClient, provider);
  }

  async function signOut(): Promise<void> {
    const current = cache.peek();
    if (current) {
      await call(`/v1/client/sessions/${current.sessionId}/revoke`, { method: 'POST' }).catch(
        () => undefined,
      );
    }
    if (timer) clearTimeout(timer);
    timer = null;
    clearSession();
  }

  async function setActiveOrganization(organizationId: string | null): Promise<void> {
    const current = cache.peek();
    if (!current) return;

    const response = await call(`/v1/client/sessions/${current.sessionId}/touch`, {
      method: 'POST',
      body: JSON.stringify({ active_organization_id: organizationId }),
    });
    if (!response.ok) return;

    const body = (await response.json()) as { jwt: string };
    // The new token carries the new org claims; re-boot would work too but costs
    // a round trip for information already in hand.
    applyToken(body.jwt, current.sessionId);
    await reload();
  }

  async function boot(): Promise<void> {
    if (booted) return;
    booted = true;

    /**
     * §6.3 step 3: complete a redirect-based sign-in. An OAuth or hosted-page
     * flow lands back here with a one-time ticket in the URL; exchange it for
     * cookies, scrub the URL so a reload can't replay it, THEN boot. A redirect
     * that only carries a `__atlas_status` (a second factor is still owed) has no
     * ticket, so nothing is exchanged and the app boots signed-out.
     */
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
  }

  function destroy(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  const isSignedIn = derived(status, ($status) => $status === 'signed_in');
  const isLoaded = derived(status, ($status) => $status !== 'loading');

  const client: AtlasClient = {
    publishableKey,
    frontendApi: baseUrl,
    appearance: options.appearance,
    catalog,
    pendingAttempt,
    status: { subscribe: status.subscribe },
    user: { subscribe: user.subscribe },
    session: { subscribe: session.subscribe },
    claims: { subscribe: claims.subscribe },
    memberships: { subscribe: memberships.subscribe },
    isSignedIn,
    isLoaded,
    getToken,
    getProviderToken,
    signOut,
    setActiveOrganization,
    reload,
    boot,
    destroy,
  };

  // Kick off the browser boot immediately unless the caller opts out. Guarded to
  // the browser so SvelteKit SSR never touches window / a credentialed fetch.
  if (!options.manualBoot && typeof window !== 'undefined') {
    void boot();
  }

  return client;
}

/**
 * Install the Atlas client into Svelte component context and return it.
 *
 * Call from the `<script>` of a top-level component (or `<AtlasProvider>`), the
 * peer of mounting React's `<AtlasProvider>`. Everything below in the tree can
 * then reach the stores and actions through {@link useAtlas} and friends.
 */
export function initAtlas(options: AtlasInitOptions): AtlasClient {
  const client = createAtlasClient(options);
  setContext(ATLAS_KEY, client);
  return client;
}

/**
 * The installed client, from any descendant of a component that called
 * {@link initAtlas}. Throws rather than returning a null-ish default: a store of
 * `null` outside the provider is indistinguishable from a signed-out user, and
 * the developer spends an afternoon on it.
 */
export function useAtlas(): AtlasClient {
  const client = getContext<AtlasClient | undefined>(ATLAS_KEY);
  if (!client) {
    throw new Error('Atlas accessors must be used under a component that called initAtlas().');
  }
  return client;
}
