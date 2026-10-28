/**
 * @atlasauth/expo-biometrics — gate a stored Atlas session behind Face ID /
 * Touch ID / fingerprint.
 *
 * A persisted session (e.g. in `expo-secure-store`, via `@atlasauth/expo`) keeps
 * a returning user signed in across restarts — convenient, but it also means
 * whoever holds an unlocked phone is signed in. `protectWithBiometrics` adds a
 * local biometric prompt in front of revealing that token, so the session is
 * only handed back after the device owner authenticates. It is a thin wrapper
 * over `expo-local-authentication` (an optional peer, passed in).
 *
 * This is a LOCAL gate, not a server one: it decides whether the app reveals a
 * token it already holds. The server still validates that token on every call.
 */

import type {
  LocalAuthentication,
  LocalAuthenticationOptions,
  StoredSession,
} from './local-authentication';

export * from './local-authentication';
export * from './device-key';

export type BiometricReason =
  | 'no_hardware'
  | 'not_enrolled'
  | 'authentication_failed'
  | 'no_session';

export interface ProtectResult {
  /** True only when biometrics passed AND a stored session was present. */
  ok: boolean;
  /** The revealed session token when `ok`, else null. */
  token: string | null;
  /** Why the gate did not open, when `!ok`. */
  reason?: BiometricReason;
  /** The raw `expo-local-authentication` error code, when it failed the prompt. */
  error?: string;
}

/**
 * Whether a biometric prompt is even possible right now (hardware present and a
 * biometric enrolled). Use it to decide whether to OFFER a "unlock with Face ID"
 * affordance at all.
 */
export async function isBiometricsAvailable(auth: LocalAuthentication): Promise<boolean> {
  return (await auth.hasHardwareAsync()) && (await auth.isEnrolledAsync());
}

export interface ProtectWithBiometricsOptions {
  /** The `expo-local-authentication` module. */
  auth: LocalAuthentication;
  /** Where the session token is stored (a `TokenStorage` from `@atlasauth/expo` fits). */
  storage: StoredSession;
  /** Prompt / UI copy forwarded to `authenticateAsync`. */
  prompt?: LocalAuthenticationOptions;
  /**
   * When the device has no biometric hardware or none enrolled, reveal the
   * session anyway rather than locking the user out. Off by default: a biometric
   * gate that silently no-ops on an un-enrolled device is not a gate.
   *
   * @default false
   */
  allowWhenUnavailable?: boolean;
}

/**
 * Prompt for a biometric and, on success, return the stored session token.
 *
 * Resolves (never throws) with an outcome: `ok` + the token when the device
 * owner authenticated and a session was present, otherwise `ok: false` with a
 * {@link BiometricReason}. A missing session is reported as `no_session` so the
 * caller routes to a fresh sign-in rather than an error screen.
 */
export async function protectWithBiometrics(
  options: ProtectWithBiometricsOptions,
): Promise<ProtectResult> {
  const { auth, storage, prompt, allowWhenUnavailable = false } = options;

  const available = await isBiometricsAvailable(auth);
  if (!available) {
    if (!allowWhenUnavailable) {
      const reason: BiometricReason = (await auth.hasHardwareAsync())
        ? 'not_enrolled'
        : 'no_hardware';
      return { ok: false, token: null, reason };
    }
    // Fallback allowed: skip the prompt and reveal the session directly.
    const token = (await storage.getToken()) ?? null;
    return token ? { ok: true, token } : { ok: false, token: null, reason: 'no_session' };
  }

  const result = await auth.authenticateAsync(prompt);
  if (!result.success) {
    return {
      ok: false,
      token: null,
      reason: 'authentication_failed',
      ...(result.error ? { error: result.error } : {}),
    };
  }

  const token = (await storage.getToken()) ?? null;
  return token ? { ok: true, token } : { ok: false, token: null, reason: 'no_session' };
}
