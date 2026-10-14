/**
 * The slice of [`expo-local-authentication`](https://docs.expo.dev/versions/latest/sdk/local-authentication/)
 * this helper uses, declared structurally.
 *
 * `expo-local-authentication` is an OPTIONAL peer; this package never imports it
 * (the app passes the module in), so it compiles and typechecks without it. The
 * real module is structurally compatible with {@link LocalAuthentication}.
 */

/** The result `authenticateAsync` resolves with. */
export interface LocalAuthenticationResult {
  success: boolean;
  /** Present on failure — e.g. `user_cancel`, `lockout`, `not_enrolled`. */
  error?: string;
  warning?: string;
}

export interface LocalAuthenticationOptions {
  promptMessage?: string;
  cancelLabel?: string;
  disableDeviceFallback?: boolean;
  fallbackLabel?: string;
  requireConfirmation?: boolean;
}

/** The `expo-local-authentication` surface used here. */
export interface LocalAuthentication {
  /** Whether the device has biometric hardware (Face ID / Touch ID / fingerprint). */
  hasHardwareAsync(): Promise<boolean>;
  /** Whether the user has enrolled a biometric. */
  isEnrolledAsync(): Promise<boolean>;
  /** Prompt for a biometric. */
  authenticateAsync(options?: LocalAuthenticationOptions): Promise<LocalAuthenticationResult>;
}

/** The stored session this helper reveals once biometrics pass. */
export interface StoredSession {
  /** The persisted session token, or null when signed out. */
  getToken(): string | null | Promise<string | null>;
}
