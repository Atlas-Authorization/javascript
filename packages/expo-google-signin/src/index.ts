/**
 * @atlasauth/expo-google-signin — native Google sign-in for Expo & React Native.
 *
 * The device-native Google button (`@react-native-google-signin/google-signin`,
 * an optional peer) yields a Google `id_token`; this helper trades it for an
 * Atlas session via the native id_token sign-in endpoint. The flow mirrors the
 * web's One-Tap path (see `@atlasauth/js`'s `nativeSignIn`):
 *
 *   1. mint a replay-binding nonce (optional but recommended),
 *   2. run the native Google sign-in with that nonce → `id_token`,
 *   3. POST the `id_token` to `/v1/client/sign_ins/id_token`,
 *   4. on completion, exchange the one-time ticket for a session JWT.
 */

import { mintNativeNonce, nativeSignIn, type FieldError } from '@atlasauth/js';
import { createFapiClient, type AtlasFapiConfig } from './client';
import { extractIdToken, type GoogleSignin } from './google-native';

export * from './client';
export * from './google-native';

export interface GoogleSignInResult {
  status: 'complete' | 'needs_more' | 'error' | 'cancelled';
  /** The session JWT, when `complete`. Hand it to `@atlasauth/expo`'s token cache. */
  jwt?: string;
  /** The one-time ticket, when `complete` (if you prefer to exchange it yourself). */
  ticket?: string;
  attemptId?: string;
  attemptStatus?: string;
  errors: FieldError[];
}

export interface SignInWithGoogleOptions {
  config: AtlasFapiConfig;
  /** The `GoogleSignin` object from `@react-native-google-signin/google-signin`. */
  googleSignin: GoogleSignin;
  /**
   * Bind the sign-in to a server-minted nonce (recommended). On by default; set
   * false only if your Google configuration cannot forward a nonce.
   *
   * @default true
   */
  useNonce?: boolean;
  /** Check Play Services first (Android). On by default; a no-op on iOS. */
  checkPlayServices?: boolean;
}

/**
 * Run the native Google sign-in and exchange the result for an Atlas session.
 *
 * Resolves (never throws) with an outcome: `complete` + `jwt` on success,
 * `cancelled` when the user dismissed the Google sheet, `needs_more` when a
 * second factor is owed, `error` otherwise.
 */
export async function signInWithGoogle(
  options: SignInWithGoogleOptions,
): Promise<GoogleSignInResult> {
  const { config, googleSignin, useNonce = true, checkPlayServices = true } = options;
  const client = createFapiClient(config);

  if (checkPlayServices) {
    try {
      await googleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    } catch {
      return {
        status: 'error',
        errors: [{ code: 'PLAY_SERVICES', message: 'Google Play Services are unavailable.' }],
      };
    }
  }

  // §6 a single-use nonce binds the id_token to this attempt; mint it FIRST so
  // the native sheet can embed it.
  let nonce: string | undefined;
  if (useNonce) {
    nonce = (await mintNativeNonce(client, 'google')) ?? undefined;
    if (!nonce) {
      return {
        status: 'error',
        errors: [{ code: 'NONCE', message: 'Could not start Google sign-in.' }],
      };
    }
  }

  let idToken: string | null;
  try {
    const response = await googleSignin.signIn(nonce ? { nonce } : undefined);
    idToken = extractIdToken(response);
  } catch {
    // The library throws on user cancel (and on config errors); treat an absent
    // token below as cancellation, and a throw here as a cancel too.
    return { status: 'cancelled', errors: [] };
  }
  if (!idToken) return { status: 'cancelled', errors: [] };

  const flow = await nativeSignIn(client, { provider: 'google', idToken, nonce });
  if (flow.errors.length) return { status: 'error', errors: flow.errors };

  const attempt = flow.attempt as { id?: string; status?: string } | null;

  if (flow.ticket) {
    const exchange = await client.post<{ jwt?: string }>('/v1/client/tickets/exchange', {
      attempt_id: attempt?.id ?? '',
      ticket: flow.ticket,
    });
    if (!exchange.ok || !exchange.data?.jwt) {
      return {
        status: 'error',
        errors: exchange.errors.length
          ? exchange.errors
          : [{ code: 'EXCHANGE_FAILED', message: 'Could not complete sign-in.' }],
      };
    }
    return {
      status: 'complete',
      jwt: exchange.data.jwt,
      ticket: flow.ticket,
      ...(attempt?.id ? { attemptId: attempt.id } : {}),
      errors: [],
    };
  }

  return {
    status: 'needs_more',
    ...(attempt?.id ? { attemptId: attempt.id } : {}),
    ...(attempt?.status ? { attemptStatus: attempt.status } : {}),
    errors: [],
  };
}
