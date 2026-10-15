import { onCleanup, onMount, type JSX } from 'solid-js';
import { createStore } from 'solid-js/store';
import { isServer } from 'solid-js/web';
import { h } from './h';
import {
  FapiClient,
  SignOutGuard,
  TokenCache,
  closeOAuthPopupAfterSignIn,
  completeOAuthPopupLanding,
  getProviderToken as fetchProviderToken,
  mapOAuthPopupPayload,
  msUntilRefresh,
  readExpiry,
  readRedirectResult,
  resolveFrontendApi,
  stripRedirectParams,
  type ProviderToken,
  type RedirectResult,
  type SignOutOptions,
  type SignOutResult,
} from '@atlasauth/js';
import { AtlasContext } from './context';
import { mountSignInWidget, mountSignUpWidget, mountUserButtonWidget } from './widgets';
import type {
  AtlasOrganizationMembership,
  AtlasSession,
  AtlasUser,
  SessionClaims,
} from './types';

/**
 * The Solid peer of React's `<AtlasProvider>` and Vue's `createAtlas()` plugin.
 *
 * It holds exactly one thing that matters in memory: the token. Not
 * localStorage, not a cookie this code writes — the refresh token is HttpOnly so
 * browser script never touches it, and the short-lived JWT lives only as long as
 * the tab. A client that persisted either would outlive the tab and become the
 * first thing an XSS reads.
 */

export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

/**
 * The reactive auth state. A Solid store, so a component that reads
 * `client.state.user` re-runs ONLY when the user changes — the fine-grained
 * peer of Vue's refs, not React's whole-component re-render.
 */
export interface AtlasState {
  status: AuthStatus;
  user: AtlasUser | null;
  session: AtlasSession | null;
  claims: SessionClaims | null;
  memberships: AtlasOrganizationMembership[];
}

/**
 * The client provided to the whole app. Every field React's `AtlasContextValue`
 * exposes, but reactivity is a Solid store (`state`) plus the mount seams the
 * widgets drive, so the public surface stays recognisable across SDKs.
 */
export interface AtlasClient {
  publishableKey: string;
  /** The instance's FAPI origin. */
  frontendApi: string;
  /** The reactive auth state; read fields off it inside a tracking scope. */
  state: AtlasState;
  /**
   * A sign-in attempt handed back by an OAuth redirect that still owes a second
   * factor (no session was issued). Null in the ordinary case. `<SignIn>` seeds
   * its flow from this so the user resumes at the 2FA step instead of starting
   * over. Captured synchronously at construction — before any component reads
   * it — because such a redirect carries a status but no ticket.
   */
  pendingAttempt: { id: string; status: string } | null;
  /** Always fresh: refreshes first if the cached token is close to expiry. */
  getToken(): Promise<string | null>;
  /**
   * The signed-in user's OWN live token at a connected provider (Google,
   * GitHub, …), so the app can call that provider's API. Null when there is no
   * usable token. The server refreshes a stale one on read; the refresh token
   * is never exposed.
   */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  /**
   * Sign out of the current session. Resolves `{ revoked, activeSessionId? }`:
   * `revoked: false` means the server never confirmed the revoke (this browser
   * is signed out regardless, and never re-adopts the session); with
   * `{ strict: true }` that case rejects with a `SignOutError` instead, after
   * the local sign-out. `activeSessionId` is a parked session the server
   * promoted, which is adopted.
   */
  signOut(options?: SignOutOptions): Promise<SignOutResult>;
  setActiveOrganization(organizationId: string | null): Promise<void>;
  reload(): Promise<void>;
  /**
   * Mount the server-driven sign-in / sign-up flow, or the user button, into a
   * host element and return a disposer. These are the seams `<SignIn>`,
   * `<SignUp>` and `<UserButton>` call in `onMount`, and tear down in
   * `onCleanup`. The widgets live on the client (not in `@atlasauth/js`, which
   * ships no DOM widgets) so a mounted flow can reach this same client — its
   * `reload()` after completion, its `signOut()` — without re-threading context.
   */
  mountSignIn(el: HTMLElement): () => void;
  mountSignUp(el: HTMLElement): () => void;
  mountUserButton(el: HTMLElement): () => void;
}

export interface AtlasProviderProps {
  publishableKey: string;
  /**
   * The instance's Frontend API: an absolute URL such as
   * `"https://auth.example.com"`, or `"same-origin"` / a path such as `"/atlas"`
   * behind a reverse proxy on the app's own origin. Required at runtime — a
   * missing or malformed value throws an `AtlasConfigError`
   * (`FRONTEND_API_REQUIRED` / `FRONTEND_API_INVALID`). Optional in the type
   * only so existing call sites keep compiling.
   */
  frontendApi?: string;
  /** Injected in tests to drive the client through a mocked network. */
  fetchImpl?: typeof fetch;
  children?: JSX.Element;
}

/**
 * Build the reactive client. Separated from the component so a test can
 * construct it directly and so the mount seams close over one consistent
 * client.
 */
export function createAtlasClient(options: {
  publishableKey: string;
  frontendApi?: string;
  fetchImpl?: typeof fetch;
}): { client: AtlasClient; boot: () => Promise<void>; dispose: () => void } {
  const publishableKey = options.publishableKey;
  // Throws on a missing/invalid value rather than quietly sending every request
  // to a relative path on the app's origin.
  const baseUrl = resolveFrontendApi(options.frontendApi, { component: '<AtlasProvider>' });
  const doFetch = options.fetchImpl ?? fetch;

  const [state, setState] = createStore<AtlasState>({
    status: 'loading',
    user: null,
    session: null,
    claims: null,
    memberships: [],
  });

  const cache = new TokenCache();
  let timer: ReturnType<typeof setTimeout> | null = null;

  // A `needs_second_factor` redirect carries a status but no ticket; that is
  // what the 2FA resume seeds from. Read once, synchronously, at construction.
  const pendingAttempt: { id: string; status: string } | null = (() => {
    if (isServer || typeof window === 'undefined') return null;
    const result = readRedirectResult(window.location.search);
    return result?.status && !result.ticket
      ? { id: result.attemptId, status: result.status }
      : null;
  })();

  const call = (path: string, init?: RequestInit) =>
    doFetch(`${baseUrl}${path}`, {
      ...init,
      // Cookies carry the session; a fetch without this is indistinguishable
      // from being signed out.
      credentials: 'include',
      headers: {
        'x-publishable-key': publishableKey,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });

  // Sessions this browser signed out of (shared by every tab, per Frontend
  // API): never re-adopted from a still-valid refresh cookie, even when the
  // revoke did not reach the server — not by a reload or refresh, nor by a tab
  // opened later. The guard also re-tries such a revoke in the background.
  const guard = new SignOutGuard({ request: call, frontendApi: baseUrl });

  const applyToken = (jwt: string, sessionId: string) => {
    // A refresh that was in flight when the user signed out must not put the
    // signed-out session's token back.
    if (guard.isSignedOut(sessionId)) return;
    const expiresAt = readExpiry(jwt);
    if (!expiresAt) return;
    cache.set({ jwt, expiresAt, sessionId });
    setState('claims', decodeClaims(jwt));
  };

  // Keep the proactive refresh timer in step with the live token. Called after
  // every status/token change rather than from a reactive effect, so the client
  // behaves identically whether or not it was built inside a Solid root.
  const scheduleRefresh = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (state.status !== 'signed_in') return;
    const token = cache.peek();
    if (!token) return;
    const delay = msUntilRefresh({ token, now: Date.now() });
    timer = setTimeout(() => void refresh(), delay);
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

      // A session this browser signed out of (the revoke never landed, so the
      // refresh cookie still works): stay signed out; the guard re-tries the
      // revoke in the background and drops the tombstone once it lands.
      const refused = !!body.session && guard.refuse(body.session.id);
      if (!body.session || !body.user || refused) {
        cache.clear();
        setState({ status: 'signed_out', user: null, session: null, claims: null, memberships: [] });
        scheduleRefresh();
        return;
      }

      setState({
        status: 'signed_in',
        user: body.user,
        session: body.session,
        memberships: body.organization_memberships ?? [],
      });
      if (body.jwt) applyToken(body.jwt, body.session.id);
      scheduleRefresh();
    } catch {
      // A failed boot is NOT signed-out. Rendering a sign-in form because the
      // network hiccuped throws away a perfectly good session and forces a
      // needless re-auth.
      if (state.status === 'loading') setState('status', 'signed_out');
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
      scheduleRefresh();
    } catch {
      // The session may genuinely be gone. Re-boot rather than guess.
      await reload();
    }
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
  // and fetch so `@atlasauth/js` stays the single implementation.
  const fapiClient = new FapiClient({ publishableKey, baseUrl, fetchImpl: doFetch });
  const getProviderToken = (provider: string) => fetchProviderToken(fapiClient, provider);

  const signOut = async (options?: SignOutOptions): Promise<SignOutResult> => {
    // Tombstone → revoke (retried once) → front-channel logout. With no cached
    // token (a boot that carried no JWT) the store's session, or failing that
    // `GET /v1/client`, names the session — the revoke works from the cookies.
    const attempt = await guard.revoke(cache.peek()?.sessionId ?? state.session?.id ?? null, options);
    cache.clear();
    setState({ status: 'signed_out', user: null, session: null, claims: null, memberships: [] });
    scheduleRefresh();
    // The server promoted a parked session on revoke: adopt it.
    if (guard.promoted(attempt)) await reload();
    return guard.settle(attempt, options);
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

  /**
   * Complete a redirect-based sign-in. An OAuth or hosted-page flow lands back
   * with a one-time ticket in the URL; exchange it for cookies, scrub the URL so
   * a reload can't replay it, THEN boot. A redirect carrying only a status (a
   * second factor still owed) has no ticket, so nothing is exchanged and the app
   * boots signed-out — exactly as intended.
   */
  const boot = async () => {
    const browser = !isServer && typeof window !== 'undefined';
    const fromUrl = browser ? readRedirectResult(window.location.search) : null;

    let result: RedirectResult | null = fromUrl;
    // This page may be the landing of a sign-in popup whose opener a
    // Cross-Origin-Opener-Policy severed (`#atlas_popup_result=…`): relay the
    // result to the opener and close. When no opener takes it (its tab is
    // gone), finish the sign-in here like a redirect.
    const landing = browser ? await completeOAuthPopupLanding().catch(() => null) : null;
    if (landing && !landing.delivered) {
      const outcome = mapOAuthPopupPayload(landing.payload);
      if (outcome?.ticket && outcome.attemptId) {
        result = { attemptId: outcome.attemptId, ticket: outcome.ticket };
      } else if (outcome?.continuationUrl) {
        // A second factor / connect / provider error: the redirect flow's page.
        window.location.replace(outcome.continuationUrl);
        return;
      }
    }

    let exchanged = false;
    if (result?.ticket) {
      const response = await call('/v1/client/tickets/exchange', {
        method: 'POST',
        body: JSON.stringify({ attempt_id: result.attemptId, ticket: result.ticket }),
      }).catch(() => undefined);
      exchanged = !!response?.ok;
    }
    if (fromUrl && browser) {
      window.history.replaceState({}, document.title, stripRedirectParams(window.location.href));
    }
    await reload();
    // Signed in inside the Atlas popup: hand back to the waiting opener and
    // close (a no-op in an ordinary tab).
    if (exchanged) void closeOAuthPopupAfterSignIn();
  };

  // `client` is referenced inside the mount seams; the arrows only run once the
  // `const` is initialised, so the self-reference is sound.
  const client: AtlasClient = {
    publishableKey,
    frontendApi: baseUrl,
    state,
    pendingAttempt,
    getToken,
    getProviderToken,
    signOut,
    setActiveOrganization,
    reload,
    mountSignIn: (el) => mountSignInWidget(client, el),
    mountSignUp: (el) => mountSignUpWidget(client, el),
    mountUserButton: (el) => mountUserButtonWidget(client, el),
  };

  // Another tab signed out of THIS session (its tombstone reached the shared
  // store): drop the token and re-check, which refuses the session.
  const stopWatching = guard.watch(
    () => state.session?.id ?? cache.peek()?.sessionId,
    () => {
      cache.clear();
      void reload();
    },
  );

  // Clear the refresh timer, the sibling-tab watch and any scheduled background
  // revoke re-try WITHOUT revoking the session — the provider calls this on
  // unmount. `signOut()` would log the user out server-side, which is
  // emphatically not what unmounting a React/Vue/Solid tree should do.
  const dispose = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    stopWatching();
    guard.dispose();
  };

  return { client, boot, dispose };
}

/**
 * The provider component. Builds the client, provides it, and boots the session
 * on mount — guarded to the browser: on the server there is no redirect to
 * complete and no cookie jar to read, so the app renders `loading` and hydrates
 * into the real status on the client. The refresh timer is cleared on unmount.
 */
export function AtlasProvider(props: AtlasProviderProps): JSX.Element {
  const { client, boot, dispose } = createAtlasClient({
    publishableKey: props.publishableKey,
    frontendApi: props.frontendApi,
    fetchImpl: props.fetchImpl,
  });

  if (!isServer) {
    onMount(() => {
      void boot();
    });
    // The client's refresh timer, sibling-tab watch and background revoke
    // re-tries outlive a render; drop them (stop + dispose the sign-out guard)
    // when the provider unmounts so a torn-down app does not keep polling.
    onCleanup(dispose);
  }

  return h(AtlasContext.Provider, { value: client }, () => props.children);
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
