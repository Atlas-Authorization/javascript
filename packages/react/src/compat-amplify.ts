'use client';

/**
 * AWS Amplify Auth (Amazon Cognito) compatibility helpers, for
 * `atlas migrate code --from cognito`. They keep the call shapes of
 * `aws-amplify/auth` v6 (`getCurrentUser`, `fetchAuthSession`,
 * `fetchUserAttributes`, `signOut`, `signInWithRedirect`), `Hub.listen('auth')`,
 * the v5 `Auth` object's session readers, and `@aws-amplify/ui-react`'s
 * `useAuthenticator` / `withAuthenticator`, over the `<AtlasProvider>` session.
 *
 * Tokens: `fetchAuthSession().tokens.idToken` and `.accessToken` are both the
 * Atlas session JWT (`{ payload, toString() }`, like Amplify's `JWT`). AWS
 * credentials from an identity pool are not produced; `credentials` is undefined.
 */
import { createElement, useEffect, type ComponentType } from 'react';
import { useAtlas } from './AtlasProvider';
import { navigateTo, withRedirect } from './components-shared';
import { displayName, primaryEmail } from './compat';
import type { AtlasUser } from './types';
import { getActiveAtlas, onActiveAtlasChange, requireActive, type ActiveAtlas } from './active-atlas';

/** Thrown like Amplify's `UserUnAuthenticatedException` when no one is signed in. */
export class AmplifyCompatUnauthenticatedError extends Error {
  constructor() {
    super('User needs to be authenticated to call this API.');
    this.name = 'UserUnAuthenticatedException';
  }
}

export interface AmplifyCompatJwt {
  payload: Record<string, unknown>;
  toString(): string;
}

export interface AmplifyCompatCurrentUser {
  username: string;
  userId: string;
  signInDetails?: { loginId?: string; authFlowType?: string };
}

function signedIn(helper: string): ActiveAtlas & { user: AtlasUser } {
  const atlas = requireActive(helper);
  if (atlas.status !== 'signed_in' || !atlas.user) throw new AmplifyCompatUnauthenticatedError();
  return atlas as ActiveAtlas & { user: AtlasUser };
}

function decodePayload(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1] ?? '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function jwt(token: string): AmplifyCompatJwt {
  return { payload: decodePayload(token), toString: () => token };
}

function currentUserOf(user: AtlasUser): AmplifyCompatCurrentUser {
  const email = primaryEmail(user)?.address;
  return { username: user.username ?? email ?? user.id, userId: user.id, signInDetails: email ? { loginId: email } : undefined };
}

/** Cognito-style attributes (all strings, as Amplify returns them). */
export function amplifyAttributesFrom(user: AtlasUser): Record<string, string> {
  const email = primaryEmail(user);
  const phone = (user.phone_numbers ?? []).find((p) => p.primary) ?? user.phone_numbers?.[0];
  const out: Record<string, string> = { sub: user.id };
  if (email) {
    out.email = email.address;
    out.email_verified = String(email.verified);
  }
  if (phone) {
    out.phone_number = phone.phone_number;
    out.phone_number_verified = String(phone.verified);
  }
  if (user.first_name) out.given_name = user.first_name;
  if (user.last_name) out.family_name = user.last_name;
  const name = displayName(user);
  if (name) out.name = name;
  if (user.username) out.preferred_username = user.username;
  if (user.image_url) out.picture = user.image_url;
  for (const [k, v] of Object.entries(user.public_metadata ?? {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[`custom:${k}`] = String(v);
  }
  return out;
}

/** `getCurrentUser()`: `{ username, userId }`; throws when signed out. */
export async function amplifyGetCurrentUserCompat(): Promise<AmplifyCompatCurrentUser> {
  return currentUserOf(signedIn('amplifyGetCurrentUserCompat').user);
}

/** `fetchAuthSession()`: `{ tokens: { idToken, accessToken }, userSub }`, or `{}` when signed out. */
export async function amplifyFetchAuthSessionCompat(_options?: { forceRefresh?: boolean }): Promise<{
  tokens?: { idToken?: AmplifyCompatJwt; accessToken: AmplifyCompatJwt };
  userSub?: string;
  credentials?: undefined;
  identityId?: undefined;
}> {
  const atlas = requireActive('amplifyFetchAuthSessionCompat');
  if (atlas.status !== 'signed_in' || !atlas.user) return {};
  const token = await atlas.getToken();
  if (!token) return {};
  return { tokens: { idToken: jwt(token), accessToken: jwt(token) }, userSub: atlas.user.id };
}

/** `fetchUserAttributes()`. */
export async function amplifyFetchUserAttributesCompat(): Promise<Record<string, string>> {
  return amplifyAttributesFrom(signedIn('amplifyFetchUserAttributesCompat').user);
}

/** `signOut({ global })`. */
export async function amplifySignOutCompat(_input?: { global?: boolean }): Promise<void> {
  await requireActive('amplifySignOutCompat').signOut();
}

/** `signInWithRedirect({ provider })`: opens your Atlas sign-in page. */
export async function amplifySignInWithRedirectCompat(input: { provider?: unknown; customState?: string; signInUrl?: string } = {}): Promise<void> {
  const back = typeof window !== 'undefined' ? window.location.href : undefined;
  navigateTo(withRedirect(input.signInUrl ?? '/sign-in', back));
}

type HubCallback = (capsule: { channel: string; payload: { event: string; data?: unknown } }) => void;

/**
 * `Hub.listen('auth', cb)`: `signedIn`, `signedOut` and `tokenRefresh` events
 * as the Atlas session changes. Other channels never fire. Returns the
 * unsubscribe, like Amplify v6.
 */
export function amplifyHubListenCompat(channel: string, callback: HubCallback): () => void {
  if (channel !== 'auth') return () => undefined;
  let last: { status: string | null; id: string | null; exp: unknown } = { status: null, id: null, exp: null };
  const listener = (atlas: ActiveAtlas | null) => {
    if (!atlas || atlas.status === 'loading') return;
    const id = atlas.status === 'signed_in' ? (atlas.user?.id ?? null) : null;
    const exp = atlas.claims?.exp ?? null;
    let event: string | null = null;
    if (last.status !== null) {
      if (id && id !== last.id) event = 'signedIn';
      else if (!id && last.id) event = 'signedOut';
      else if (id && exp !== last.exp) event = 'tokenRefresh';
    }
    last = { status: atlas.status, id, exp };
    if (event) callback({ channel: 'auth', payload: { event, data: event === 'signedIn' && atlas.user ? currentUserOf(atlas.user) : undefined } });
  };
  const unsubscribe = onActiveAtlasChange(listener);
  const current = getActiveAtlas();
  if (current) listener(current);
  return unsubscribe;
}

/** The v5 `Auth` object's session readers (`Auth.currentAuthenticatedUser()` …). */
export const amplifyAuthV5Compat = {
  async currentAuthenticatedUser(_params?: unknown) {
    const atlas = signedIn('Auth.currentAuthenticatedUser');
    return { username: currentUserOf(atlas.user).username, attributes: amplifyAttributesFrom(atlas.user) };
  },
  async currentUserInfo() {
    const atlas = getActiveAtlas();
    if (!atlas || atlas.status !== 'signed_in' || !atlas.user) return null;
    return { id: atlas.user.id, username: currentUserOf(atlas.user).username, attributes: amplifyAttributesFrom(atlas.user) };
  },
  async currentSession() {
    const session = await amplifyFetchAuthSessionCompat();
    if (!session.tokens) throw new AmplifyCompatUnauthenticatedError();
    const token = session.tokens.accessToken.toString();
    const wrap = () => ({ getJwtToken: () => token, payload: session.tokens!.accessToken.payload });
    return { getIdToken: wrap, getAccessToken: wrap, isValid: () => true };
  },
  async signOut(_opts?: unknown) {
    await amplifySignOutCompat();
  },
  async federatedSignIn(_opts?: unknown) {
    await amplifySignInWithRedirectCompat();
  },
};

export type AmplifyAuthStatus = 'configuring' | 'authenticated' | 'unauthenticated';

/** `useAuthenticator()` from @aws-amplify/ui-react: `{ user, authStatus, route, signOut }`. */
export function useAmplifyAuthenticatorCompat(_selector?: unknown): {
  user: (AmplifyCompatCurrentUser & { attributes: Record<string, string> }) | undefined;
  authStatus: AmplifyAuthStatus;
  route: 'idle' | 'authenticated' | 'signIn';
  signOut: () => void;
} {
  const atlas = useAtlas();
  const authStatus: AmplifyAuthStatus = atlas.status === 'loading' ? 'configuring' : atlas.status === 'signed_in' ? 'authenticated' : 'unauthenticated';
  const user = atlas.status === 'signed_in' && atlas.user ? { ...currentUserOf(atlas.user), attributes: amplifyAttributesFrom(atlas.user) } : undefined;
  return {
    user,
    authStatus,
    route: authStatus === 'configuring' ? 'idle' : authStatus === 'authenticated' ? 'authenticated' : 'signIn',
    signOut: () => void amplifySignOutCompat(),
  };
}

/**
 * `withAuthenticator(Component)`: renders the component for signed-in users
 * (with `user` and `signOut` props, as Amplify passes them) and sends everyone
 * else to your sign-in page.
 */
export function withAmplifyAuthenticatorCompat<P extends object>(
  Component: ComponentType<P & { user?: unknown; signOut?: () => void }>,
  _options?: unknown,
): ComponentType<P> {
  function Wrapped(props: P) {
    const auth = useAmplifyAuthenticatorCompat();
    useEffect(() => {
      if (auth.authStatus === 'unauthenticated') {
        navigateTo(withRedirect('/sign-in', typeof window !== 'undefined' ? window.location.href : undefined));
      }
    }, [auth.authStatus]);
    if (auth.authStatus !== 'authenticated') return null;
    return createElement(Component, { ...props, user: auth.user, signOut: auth.signOut });
  }
  Wrapped.displayName = `withAmplifyAuthenticatorCompat(${Component.displayName ?? Component.name ?? 'Component'})`;
  return Wrapped;
}
