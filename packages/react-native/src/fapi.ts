import { FapiClient, resolveFrontendApi, type AttestationProvider, type ProviderToken } from '@atlasauth/js';
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
  /** Sent as `Accept-Language`, so the server's error messages come back in that language. */
  locale?: string;
  /** App Attest / Play Integrity provider; sign-up, sign-in and SMS-send calls then carry the `Atlas-Attestation` proof. */
  attestation?: AttestationProvider;
  /** The registered native app id (`napp_…`), sent as `X-Atlas-App-Id`. */
  appId?: string;
}): FapiClient {
  return new FapiClient({
    publishableKey: opts.publishableKey,
    // Exported, so validated here too: a native app has no origin to resolve a
    // relative URL against.
    baseUrl: resolveFrontendApi(opts.frontendApi, {
      component: 'createNativeClient()',
      allowSameOrigin: false,
    }),
    fetchImpl: bearerFetch(opts.fetchImpl, opts.getToken),
    locale: opts.locale,
    attestation: opts.attestation,
    appId: opts.appId,
  });
}

/**
 * Start an OAuth sign-in by hand. Returns the provider's authorization URL for
 * the app to open; opening it and catching the deep-link callback is the app's
 * job, and `completeOAuthRedirect` finishes it.
 *
 * @deprecated Prefer `signInWithOAuth`: it adds PKCE (the callback carries a code
 * only this device can redeem, not a ticket), opens the system browser and stores
 * the session. This path sends no code challenge, which a native redirect refuses
 * (`PKCE_REQUIRED`); it still serves web-style https redirects.
 *
 * `redirectUrl` must be an https URL on the instance's allowed origins. An app
 * scheme like `exampleapp://` is not an allowed origin: register the app
 * (`POST /v1/native_apps`) and add the scheme to its `callback_urls` instead.
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
