/**
 * Native Google / Apple sign-in for the provider's client: the system sheet
 * yields a provider ID token, which is sent to Atlas (`POST
 * /v1/client/sign_ins/id_token`) and traded for a session. The provider's token
 * cache stores the returned session JWT.
 */
import { mintNativeNonce, nativeSignIn, type FapiClient, type FieldError } from '@atlasauth/js';

export interface NativeSocialResult {
  status: 'complete' | 'needs_more' | 'error' | 'cancelled';
  jwt?: string;
  attemptId?: string;
  errors: FieldError[];
}

/** Send a provider ID token (with the nonce it was minted with) and finish the sign-in. */
export async function signInWithIdToken(client: FapiClient, input: { provider: string; idToken: string; nonce?: string }): Promise<NativeSocialResult> {
  const flow = await nativeSignIn(client, input);
  if (flow.errors.length) return { status: 'error', errors: flow.errors };
  const attempt = flow.attempt as { id?: string } | null;
  if (!flow.ticket) return { status: 'needs_more', ...(attempt?.id ? { attemptId: attempt.id } : {}), errors: [] };
  const ex = await client.post<{ jwt?: string }>('/v1/client/tickets/exchange', { attempt_id: attempt?.id ?? '', ticket: flow.ticket });
  if (!ex.ok || !ex.data?.jwt) return { status: 'error', errors: ex.errors.length ? ex.errors : [{ code: 'EXCHANGE_FAILED', message: 'Could not complete sign-in.' }] };
  return { status: 'complete', jwt: ex.data.jwt, ...(attempt?.id ? { attemptId: attempt.id } : {}), errors: [] };
}

/** The slice of `expo-apple-authentication` used here. */
export interface AppleAuthenticationLike {
  signInAsync(options: { requestedScopes?: unknown[]; nonce?: string }): Promise<{ identityToken: string | null }>;
  AppleAuthenticationScope: { EMAIL: unknown; FULL_NAME: unknown };
}

/** Sign in with the Apple system sheet. A dismissed sheet resolves as `cancelled`. */
export async function signInWithApple(client: FapiClient, apple: AppleAuthenticationLike): Promise<NativeSocialResult> {
  const nonce = (await mintNativeNonce(client, 'apple')) ?? undefined;
  if (!nonce) return { status: 'error', errors: [{ code: 'NONCE', message: 'Could not start Apple sign-in.' }] };
  let idToken: string | null;
  try {
    ({ identityToken: idToken } = await apple.signInAsync({ requestedScopes: [apple.AppleAuthenticationScope.EMAIL, apple.AppleAuthenticationScope.FULL_NAME], nonce }));
  } catch {
    return { status: 'cancelled', errors: [] };
  }
  if (!idToken) return { status: 'cancelled', errors: [] };
  return signInWithIdToken(client, { provider: 'apple', idToken, nonce });
}

/** The slice of `@react-native-google-signin/google-signin` used here. */
export interface GoogleSigninLike {
  signIn(options?: { nonce?: string }): Promise<unknown>;
}

/** Sign in with the Google system sheet (use `@atlasauth/expo-google-signin` for Play Services checks). */
export async function signInWithGoogle(client: FapiClient, google: GoogleSigninLike): Promise<NativeSocialResult> {
  const nonce = (await mintNativeNonce(client, 'google')) ?? undefined;
  if (!nonce) return { status: 'error', errors: [{ code: 'NONCE', message: 'Could not start Google sign-in.' }] };
  let response: unknown;
  try {
    response = await google.signIn({ nonce });
  } catch {
    return { status: 'cancelled', errors: [] };
  }
  const r = response as { idToken?: string; data?: { idToken?: string } } | null;
  const idToken = r?.data?.idToken ?? r?.idToken;
  if (!idToken) return { status: 'cancelled', errors: [] };
  return signInWithIdToken(client, { provider: 'google', idToken, nonce });
}
