import { FapiClient, type ProviderToken } from '@atlasauth/js';
import type { AtlasSession, AtlasUser } from './types';

/**
 * The native FAPI layer. Every network call in this SDK goes through the
 * framework-agnostic `@atlasauth/js` `FapiClient` — the same client the web SDK and
 * the embed widget use — so there is exactly one implementation of "how an Atlas
 * request is shaped". This module only adds the two things native needs that the
 * browser gets for free:
 *
 *   1. Bearer auth. The browser attaches the session via a cookie; RN has no
 *      cookie jar, so the token from the storage adapter rides in an
 *      `Authorization: Bearer` header instead. That is done by wrapping the
 *      fetch the client is built with — the client itself is unchanged.
 *   2. A couple of native-shaped reads (current user, ticket → token exchange)
 *      that are thin `client.get` / `client.post` calls.
 */

/**
 * Wrap a fetch so every request carries the current session token as a bearer.
 * The token is read fresh from the adapter on each call — never captured — so a
 * refresh or a sign-out between requests is always reflected.
 */
export function bearerFetch(
  fetchImpl: typeof fetch,
  getToken: () => string | null | Promise<string | null>,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = await getToken();
    const headers = new Headers(init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers });
  };
}

/** Build the FAPI client the store uses: `@atlasauth/js` + native bearer auth. */
export function createNativeClient(opts: {
  publishableKey: string;
  frontendApi: string;
  fetchImpl: typeof fetch;
  getToken: () => string | null | Promise<string | null>;
}): FapiClient {
  return new FapiClient({
    publishableKey: opts.publishableKey,
    baseUrl: opts.frontendApi,
    fetchImpl: bearerFetch(opts.fetchImpl, opts.getToken),
  });
}

/**
 * Start an OAuth sign-in. Returns the provider's authorization URL for the app
 * to open — with `expo-auth-session`, `expo-web-browser`, or `Linking`. This SDK
 * does NOT hard-depend on any browser library: opening the URL and catching the
 * deep-link callback is the app's job, and `completeOAuthRedirect` finishes it.
 *
 * `redirectUrl` is the app's deep link (e.g. `myapp://oauth-callback`); it must
 * be registered as one of the instance's allowed redirect URLs.
 */
export async function startOAuthSignIn(
  client: FapiClient,
  input: { provider: string; redirectUrl: string },
): Promise<{
  authorizationUrl: string | null;
  errors: Array<{ code: string; message: string; param?: string }>;
}> {
  const response = await client.post<{ authorization_url?: string }>('/v1/client/sign_ins/oauth', {
    provider: input.provider,
    redirect_url: input.redirectUrl,
  });
  return { authorizationUrl: response.data?.authorization_url ?? null, errors: response.errors };
}

/**
 * Exchange a completion ticket for a session token. The browser exchanges its
 * ticket for cookies; the native exchange returns the token in the body so the
 * SDK can hand it to the storage adapter. Returns null when the exchange fails.
 */
export async function exchangeTicketForToken(
  client: FapiClient,
  input: { attemptId: string; ticket: string },
): Promise<string | null> {
  const response = await client.post<{ jwt?: string }>('/v1/client/tickets/exchange', {
    attempt_id: input.attemptId,
    ticket: input.ticket,
  });
  return response.data?.jwt ?? null;
}

/** Load the signed-in user and session. Null user means the token is not valid. */
export async function fetchCurrentUser(client: FapiClient): Promise<{
  user: AtlasUser | null;
  session: AtlasSession | null;
}> {
  const response = await client.get<{
    user: AtlasUser | null;
    session: AtlasSession | null;
  }>('/v1/client');
  return { user: response.data?.user ?? null, session: response.data?.session ?? null };
}

export type { ProviderToken };
