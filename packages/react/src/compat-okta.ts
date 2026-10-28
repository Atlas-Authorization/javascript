'use client';

/**
 * Drop-in compatibility helpers for React apps moving to Atlas from Okta
 * (`@okta/okta-react` + `@okta/okta-auth-js`): what `atlas migrate code --from okta`
 * rewrites `useOktaAuth()`, `new OktaAuth(config)` and `toRelativeUrl` onto.
 *
 * `useOktaAuthCompat()` keeps okta-react's `{ oktaAuth, authState }` shape, and
 * `OktaAuthCompat` the okta-auth-js methods apps call most (`signInWithRedirect`,
 * `signOut`, `isAuthenticated`, `getUser`, `getAccessToken`, `getIdToken`,
 * `token.getUserInfo`), on top of the mounted `<AtlasProvider>`:
 *
 *  - sign-in opens your Atlas sign-in page and comes back to `originalUri`, so
 *    okta-react's `restoreOriginalUri` and `<LoginCallback>` are no longer needed;
 *  - the "access token" and the "ID token" are both the Atlas session token:
 *    verify it on your server with `AtlasBackend` from `@atlasauth/backend`. Its
 *    `sub` is the Atlas user id (an Okta access token carried the login there,
 *    and the user id in `uid`);
 *  - `getAccessToken()` / `getIdToken()` stay synchronous, as in okta-auth-js:
 *    they return the freshest unexpired token on hand and refresh it in the
 *    background (`await getFreshAccessToken()` when you can wait).
 *
 * Calling a method with no provider mounted throws a clear error, except the
 * synchronous token getters, which return `undefined` like a signed-out Okta app.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtlas } from './AtlasProvider';
import { navigateTo, withRedirect } from './components-shared';
import type { AtlasUser, SessionClaims } from './types';
import { getActiveAtlas, onActiveAtlasChange, requireActive, type ActiveAtlas } from './active-atlas';

/** The OIDC user claims okta-auth-js's `getUser()` / `token.getUserInfo()` resolve to. */
export interface OktaCompatUserClaims {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
  [claim: string]: unknown;
}

/** okta-auth-js's `AuthState`: `null` while loading, then signed in or not. */
export interface OktaCompatAuthState {
  isAuthenticated: boolean;
  /** The Atlas session token, with the user's profile claims merged into its claims. */
  idToken?: { idToken: string; claims: OktaCompatUserClaims & SessionClaims };
  /** The Atlas session token and its claims. */
  accessToken?: { accessToken: string; claims: SessionClaims };
}

export interface OktaAuthCompatOptions {
  /** Where your Atlas sign-in page lives (default `/sign-in`). */
  signInUrl?: string;
  /** Where `signOut()` goes when the call does not say (okta-auth-js's option of the same name). Default `/`. */
  postLogoutRedirectUri?: string;
  /** okta-auth-js options (`issuer`, `clientId`, `redirectUri`, `scopes`, `pkce`, …) are accepted and ignored. */
  [option: string]: unknown;
}

export interface OktaCompatSignInOptions {
  /** Where to land after sign-in (sent to the sign-in page as `redirect_url`). */
  originalUri?: string;
  [option: string]: unknown;
}

export interface OktaCompatSignOutOptions {
  postLogoutRedirectUri?: string;
  [option: string]: unknown;
}

/** okta-auth-js's `AuthSdkError`, thrown when a call needs a signed-in user. */
export class OktaCompatAuthSdkError extends Error {
  readonly errorCode = 'INTERNAL';
  readonly errorSummary: string;
  constructor(message: string) {
    super(message);
    this.name = 'AuthSdkError';
    this.errorSummary = message;
  }
}

/** Project an Atlas user onto the OIDC user claims Okta returns. */
export function oktaUserFrom(user: AtlasUser | null): OktaCompatUserClaims | null {
  if (!user) return null;
  const list = user.email_addresses ?? [];
  const email = list.find((e) => e.primary) ?? list.find((e) => e.verified) ?? list[0];
  const out: OktaCompatUserClaims = { sub: user.id };
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (name) out.name = name;
  if (user.first_name) out.given_name = user.first_name;
  if (user.last_name) out.family_name = user.last_name;
  // Okta's preferred_username is the login: the username here, else the email.
  const login = user.username ?? email?.email_address;
  if (login) out.preferred_username = login;
  if (email) {
    out.email = email.email_address;
    out.email_verified = email.verified;
  }
  if (user.image_url) out.picture = user.image_url;
  return out;
}

/**
 * Pure projection of the provider state onto okta-auth-js's `AuthState`.
 * `token` is the session token: `undefined` while it is being read (the state
 * is then `null`, as Okta's is before its first evaluation), `null` when there
 * is none.
 */
export function oktaAuthStateFrom(
  state: Pick<ActiveAtlas, 'status' | 'user' | 'claims'>,
  token: string | null | undefined,
): OktaCompatAuthState | null {
  if (state.status === 'loading') return null;
  if (state.status !== 'signed_in') return { isAuthenticated: false };
  if (token === undefined) return null;
  if (token === null || !state.claims) return { isAuthenticated: true };
  const profile = oktaUserFrom(state.user);
  return {
    isAuthenticated: true,
    idToken: { idToken: token, claims: { ...state.claims, ...profile, sub: state.claims.sub } },
    accessToken: { accessToken: token, claims: state.claims },
  };
}

/** okta-auth-js's `toRelativeUrl(path, baseUrl)`: an absolute URL loses its `baseUrl` prefix. */
export function toRelativeUrlCompat(path = '', baseUrl = ''): string {
  let out = path;
  if (/^[a-z][a-z0-9+.-]*:/i.test(out)) out = out.substring(baseUrl.length);
  return out.charAt(0) === '/' ? out : `/${out}`;
}

/** When a JWT expires (ms since epoch); unknown expiry counts as not expiring. */
function expiresAt(token: string): number {
  try {
    const part = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const exp = (JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Like okta-auth-js's `expireEarlySeconds`: a token this close to expiry is not handed out. */
const EXPIRE_EARLY_MS = 10_000;

/**
 * `new OktaAuth(config)` from `@okta/okta-auth-js`, on Atlas, for a React app
 * that renders `<AtlasProvider>`. The config is accepted and ignored apart from
 * `signInUrl` and `postLogoutRedirectUri`: sign-in runs on your Atlas pages and
 * the provider holds the session.
 */
export class OktaAuthCompat {
  readonly options: OktaAuthCompatOptions;
  /** okta-auth-js's `oktaAuth.token` namespace (`getUserInfo` only). */
  readonly token: { getUserInfo(): Promise<OktaCompatUserClaims> };
  private readonly atlas: () => ActiveAtlas;
  private cached: { token: string; sub: string; expiresAt: number } | null = null;
  private pending: Promise<string | undefined> | null = null;

  /**
   * @param atlas Where the provider state comes from. Internal: the hook passes
   * its own; by default the `<AtlasProvider>` mounted on the page.
   */
  constructor(options: OktaAuthCompatOptions = {}, atlas?: () => ActiveAtlas) {
    this.options = options;
    this.token = { getUserInfo: () => this.getUser() };
    if (atlas) {
      this.atlas = atlas;
      return;
    }
    this.atlas = () => requireActive('OktaAuthCompat');
    // Keep a token on hand for the synchronous getters, as Okta's token manager does.
    const prefetch = (state: ActiveAtlas | null) => {
      if (state?.status === 'signed_in') void this.getFreshAccessToken().catch(() => undefined);
    };
    onActiveAtlasChange(prefetch);
    prefetch(getActiveAtlas());
  }

  /** Open your Atlas sign-in page, coming back to `originalUri` afterwards. */
  async signInWithRedirect(options: OktaCompatSignInOptions = {}): Promise<void> {
    navigateTo(withRedirect(this.options.signInUrl ?? '/sign-in', options.originalUri));
  }

  /** Sign out, then go to `postLogoutRedirectUri` (default `/`). */
  async signOut(options: OktaCompatSignOutOptions = {}): Promise<void> {
    await this.atlas().signOut();
    this.cached = null;
    navigateTo(options.postLogoutRedirectUri ?? this.options.postLogoutRedirectUri ?? '/');
  }

  async isAuthenticated(): Promise<boolean> {
    return this.atlas().status === 'signed_in';
  }

  /** The signed-in user's claims; throws `AuthSdkError` when nobody is signed in, like Okta. */
  async getUser(): Promise<OktaCompatUserClaims> {
    const atlas = this.atlas();
    const user = atlas.status === 'signed_in' ? oktaUserFrom(atlas.user) : null;
    if (!user) throw new OktaCompatAuthSdkError('getUser: no user is signed in');
    return user;
  }

  /** The session token on hand (synchronous, like okta-auth-js), refreshed in the background. */
  getAccessToken(): string | undefined {
    void this.getFreshAccessToken().catch(() => undefined);
    return this.current();
  }

  /** Atlas has one session token: the same value as `getAccessToken()`. */
  getIdToken(): string | undefined {
    return this.getAccessToken();
  }

  /** Read a fresh session token now (the async form of `getAccessToken()`). */
  getFreshAccessToken(): Promise<string | undefined> {
    if (!this.pending) {
      this.pending = (async () => {
        const atlas = this.atlas();
        const sub = atlas.claims?.sub;
        if (atlas.status !== 'signed_in' || !sub) {
          this.cached = null;
          return undefined;
        }
        const token = await atlas.getToken();
        this.cached = token ? { token, sub, expiresAt: expiresAt(token) } : null;
        return token ?? undefined;
      })().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private current(): string | undefined {
    let atlas: ActiveAtlas;
    try {
      atlas = this.atlas();
    } catch {
      return undefined;
    }
    const c = this.cached;
    // Never hand one user's token to another, nor a token about to expire.
    if (atlas.status !== 'signed_in' || !c || c.sub !== atlas.claims?.sub) return undefined;
    return c.expiresAt - EXPIRE_EARLY_MS > Date.now() ? c.token : undefined;
  }
}

/** `useOktaAuth()` from `@okta/okta-react`, on Atlas: `{ oktaAuth, authState }`. */
export function useOktaAuthCompat(): { oktaAuth: OktaAuthCompat; authState: OktaCompatAuthState | null } {
  const atlas = useAtlas();
  const latest = useRef<ActiveAtlas>(atlas);
  latest.current = atlas;
  // One stable object, like okta-react's: effects that depend on it do not re-run.
  const oktaAuth = useMemo(() => new OktaAuthCompat({}, () => latest.current), []);
  const sub = atlas.status === 'signed_in' ? (atlas.claims?.sub ?? null) : null;
  const [token, setToken] = useState<{ sub: string; value: string | null } | null>(null);
  useEffect(() => {
    if (!sub) return;
    let live = true;
    oktaAuth.getFreshAccessToken().then(
      (value) => {
        if (live) setToken({ sub, value: value ?? null });
      },
      () => {
        if (live) setToken({ sub, value: null });
      },
    );
    return () => {
      live = false;
    };
    // New claims mean a refreshed session token: read it again.
  }, [oktaAuth, sub, atlas.claims]);
  return { oktaAuth, authState: oktaAuthStateFrom(atlas, token && token.sub === sub ? token.value : undefined) };
}
