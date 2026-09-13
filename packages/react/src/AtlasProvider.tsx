import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

/**
 * §10.1 `<AtlasProvider publishableKey>`.
 *
 * Holds exactly one thing that matters: the token, in memory. Not
 * localStorage, not a cookie this code writes — the refresh token is HttpOnly
 * so browser script never touches it, and the short-lived JWT lives only as
 * long as the tab. A provider that persisted either would survive the tab and
 * become the thing an XSS reads first.
 */

export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

interface AtlasContextValue {
  publishableKey: string;
  frontendApi: string;
  status: AuthStatus;
  user: AtlasUser | null;
  session: AtlasSession | null;
  claims: SessionClaims | null;
  memberships: AtlasOrganizationMembership[];
  appearance?: Appearance;
  catalog: Catalog;
  /**
   * §5.3: a sign-in attempt handed back by an OAuth redirect that still needs a
   * second factor (no session was issued). Null in the ordinary case. The
   * <SignIn> flow seeds itself from this so the user resumes at the 2FA step
   * instead of starting over.
   */
  pendingAttempt: { id: string; status: string } | null;
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

const AtlasContext = createContext<AtlasContextValue | null>(null);

export interface AtlasProviderProps {
  publishableKey: string;
  /** The instance's FAPI origin. */
  frontendApi?: string;
  appearance?: Appearance;
  localization?: Catalog;
  children: ReactNode;
  fetchImpl?: typeof fetch;
}

export function AtlasProvider(props: AtlasProviderProps) {
  const { publishableKey, children, appearance, localization } = props;
  const baseUrl = props.frontendApi ?? '';
  const doFetch = props.fetchImpl ?? fetch;

  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AtlasUser | null>(null);
  const [session, setSession] = useState<AtlasSession | null>(null);
  const [claims, setClaims] = useState<SessionClaims | null>(null);
  const [memberships, setMemberships] = useState<AtlasOrganizationMembership[]>([]);

  const cache = useRef(new TokenCache());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Captured synchronously during the first render (not in an effect) so it is
   * already in context before <SignIn> reads it — a needs_second_factor redirect
   * carries a status but no ticket, and that is what the 2FA resume seeds from.
   */
  const [pendingAttempt] = useState<{ id: string; status: string } | null>(() => {
    if (typeof window === 'undefined') return null;
    const result = readRedirectResult(window.location.search);
    return result?.status && !result.ticket
      ? { id: result.attemptId, status: result.status }
      : null;
  });

  const call = useCallback(
    async (path: string, init?: RequestInit) => {
      return doFetch(`${baseUrl}${path}`, {
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
    },
    [baseUrl, doFetch, publishableKey],
  );

  const applyToken = useCallback((jwt: string, sessionId: string) => {
    const expiresAt = readExpiry(jwt);
    if (!expiresAt) return;

    cache.current.set({ jwt, expiresAt, sessionId });
    setClaims(decodeClaims(jwt));
  }, []);

  const reload = useCallback(async () => {
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
        cache.current.clear();
        setStatus('signed_out');
        setUser(null);
        setSession(null);
        setClaims(null);
        setMemberships([]);
        return;
      }

      setUser(body.user);
      setSession(body.session);
      setMemberships(body.organization_memberships ?? []);
      if (body.jwt) applyToken(body.jwt, body.session.id);
      setStatus('signed_in');
    } catch {
      /**
       * A failed boot is NOT signed-out. Rendering a sign-in form because the
       * network hiccuped throws away a perfectly good session and makes the
       * user re-authenticate for no reason.
       */
      setStatus((current) => (current === 'loading' ? 'signed_out' : current));
    }
  }, [applyToken, call]);

  const refresh = useCallback(async () => {
    const current = cache.current.peek();
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
  }, [applyToken, call, reload]);

  /** §7.4: proactive, jittered refresh scheduled from the token's own expiry. */
  useEffect(() => {
    if (status !== 'signed_in') return;
    const token = cache.current.peek();
    if (!token) return;

    const delay = msUntilRefresh({ token, now: Date.now() });
    timer.current = setTimeout(() => void refresh(), delay);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [status, claims, refresh]);

  /**
   * §6.3 step 3: complete a redirect-based sign-in. An OAuth or hosted-page flow
   * lands back here with a one-time ticket in the URL; exchange it for cookies,
   * scrub the URL so a reload can't replay it, THEN boot. A redirect that only
   * carries a `__atlas_status` (a second factor is still owed) has no ticket, so
   * nothing is exchanged and the app boots signed-out — exactly as intended.
   */
  useEffect(() => {
    const result =
      typeof window !== 'undefined' ? readRedirectResult(window.location.search) : null;

    void (async () => {
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
    })();
    // Runs once on mount (empty deps): the redirect is handled exactly once, and
    // re-running would only re-read an already-scrubbed URL. `reload`/`call` are
    // stable across renders.
  }, []);

  const getToken = useCallback(async () => {
    // A 5s skew so a token that would die inside the caller's request is
    // refreshed first rather than handed over.
    const usable = cache.current.get(5_000);
    if (usable) return usable.jwt;

    await refresh();
    return cache.current.get(5_000)?.jwt ?? null;
  }, [refresh]);

  /**
   * The FAPI client for the token-vault read. Reuses the exact same
   * credentials-and-publishable-key request `call` makes, so the browser sends
   * one consistent shape and the framework-agnostic `@atlasauth/js` helper is the
   * single implementation the React SDK surfaces.
   */
  const fapiClient = useMemo(
    () => new FapiClient({ publishableKey, baseUrl, fetchImpl: doFetch }),
    [publishableKey, baseUrl, doFetch],
  );

  const getProviderToken = useCallback(
    (provider: string) => fetchProviderToken(fapiClient, provider),
    [fapiClient],
  );

  const signOut = useCallback(async () => {
    const current = cache.current.peek();
    if (current) {
      await call(`/v1/client/sessions/${current.sessionId}/revoke`, { method: 'POST' }).catch(
        () => undefined,
      );
    }
    cache.current.clear();
    setStatus('signed_out');
    setUser(null);
    setSession(null);
    setClaims(null);
    setMemberships([]);
  }, [call]);

  const setActiveOrganization = useCallback(
    async (organizationId: string | null) => {
      const current = cache.current.peek();
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
    },
    [applyToken, call, reload],
  );

  const catalog = useMemo(
    () => (localization ? withFallback(localization) : EN_US),
    [localization],
  );

  const value = useMemo<AtlasContextValue>(
    () => ({
      publishableKey,
      frontendApi: baseUrl,
      status,
      user,
      session,
      claims,
      memberships,
      appearance,
      catalog,
      pendingAttempt,
      getToken,
      getProviderToken,
      signOut,
      setActiveOrganization,
      reload,
    }),
    [
      appearance,
      baseUrl,
      publishableKey,
      catalog,
      claims,
      getToken,
      getProviderToken,
      memberships,
      pendingAttempt,
      reload,
      session,
      setActiveOrganization,
      signOut,
      status,
      user,
    ],
  );

  const style = useMemo(
    () => cssVariables(resolveTokens(appearance)) as React.CSSProperties,
    [appearance],
  );

  return (
    <AtlasContext.Provider value={value}>
      {/* Tokens land as CSS variables on a host-DOM element — no iframe. */}
      <div className="atlas-root" style={style}>
        {children}
      </div>
    </AtlasContext.Provider>
  );
}

export function useAtlas(): AtlasContextValue {
  const value = useContext(AtlasContext);
  if (!value) {
    /**
     * A thrown error rather than a null-ish default. A hook returning
     * `{ user: null }` outside the provider is indistinguishable from a
     * signed-out user, and the developer spends an afternoon on it.
     */
    throw new Error('Atlas hooks must be used inside <AtlasProvider>.');
  }
  return value;
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
