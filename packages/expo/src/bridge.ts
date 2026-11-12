/**
 * Upgrade bridge for apps that already have signed-in users: trade the legacy
 * session token the app still holds for an Atlas session, with no sign-in screen.
 *
 * The exchange asks for the tokens in the response body (a native app has no
 * cookies). Pass the provider's client (`useExpoFapiClient()`) and the session
 * JWT is stored by the token cache like any other; pass `storage` as well to keep
 * the refresh token for `createNativeSessionManager`.
 */
import { serializeNativeSession, migrationBrowserExchangePath, type FapiClient, type NativeSession } from '@atlasauth/js';
import type { TokenStorage } from './token-cache';

export type LegacyTokenExchangeOutcome =
  | { status: 'none' }
  | { status: 'complete'; session: NativeSession; userId: string }
  | { status: 'needs_second_factor' | 'needs_mfa_enrollment'; attemptId: string }
  | { status: 'refused'; outcome: string };

/** Refusals after which the legacy token will never exchange, so it is safe to delete. */
const FINAL = new Set(['invalid', 'signature_invalid', 'expired', 'reused', 'user_unavailable', 'user_unknown']);

export async function exchangeLegacyToken(
  client: FapiClient,
  input: {
    /** The legacy provider key, e.g. `better_auth`, `firebase`, `supabase`. */
    source: string;
    /** The token the app holds; absent means nothing to do. */
    token?: string | null;
    /** Called after a success or a final refusal: delete the legacy token here. */
    clear?: () => void | Promise<void>;
    /** Where to keep the refresh token (a slot dedicated to the native session). */
    storage?: TokenStorage;
  },
): Promise<LegacyTokenExchangeOutcome> {
  if (!input.token) return { status: 'none' };
  const clear = async () => { try { await input.clear?.(); } catch { /* best effort */ } };
  let response;
  try {
    response = await client.post<{ object?: string; id?: string; status?: string; user_id?: string; session_id?: string; jwt?: string; refresh_token?: string; expires_in?: number }>(
      migrationBrowserExchangePath(input.source),
      { token: input.token, delivery: 'body' },
    );
  } catch {
    return { status: 'refused', outcome: 'error' };
  }
  const d = response.data;
  if (response.ok && d?.jwt && d.session_id) {
    const session: NativeSession = { sessionToken: d.jwt, refreshToken: d.refresh_token ?? '', sessionId: d.session_id, expiresInSeconds: d.expires_in ?? 0 };
    if (input.storage && session.refreshToken) await input.storage.setToken(serializeNativeSession(session));
    await clear();
    return { status: 'complete', session, userId: d.user_id ?? '' };
  }
  if (response.ok && d?.id && (d.status === 'needs_second_factor' || d.status === 'needs_mfa_enrollment')) {
    await clear();
    return { status: d.status, attemptId: d.id };
  }
  const reason = response.errors[0]?.meta?.bridge_outcome;
  const outcome = typeof reason === 'string' ? reason : 'error';
  if (FINAL.has(outcome)) await clear();
  return { status: 'refused', outcome };
}
