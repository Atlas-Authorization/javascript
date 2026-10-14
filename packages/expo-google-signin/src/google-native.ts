/**
 * The slice of [`@react-native-google-signin/google-signin`](https://react-native-google-signin.github.io/)
 * this helper uses, declared structurally.
 *
 * The module is an OPTIONAL peer; this package never imports it (the app passes
 * `GoogleSignin` in), so it compiles and typechecks without it. The real module
 * is structurally compatible with {@link GoogleSignin}.
 *
 * The response shape changed across major versions: v13+ wraps the payload as
 * `{ type: 'success', data: { idToken, … } }`, older versions return
 * `{ idToken, … }` directly. {@link extractIdToken} handles both.
 */

export interface GoogleUserInfo {
  idToken?: string | null;
  user?: { id: string; email: string; name?: string | null } | null;
}

/** v13+ success/cancel envelope. */
export interface GoogleSignInResponseV13 {
  type: 'success' | 'cancelled' | 'noSavedCredentialFound';
  data?: GoogleUserInfo | null;
}

/** Either the v13 envelope or an older flat `UserInfo`. */
export type GoogleSignInResponse = GoogleSignInResponseV13 | GoogleUserInfo;

export interface GoogleSignin {
  hasPlayServices(options?: { showPlayServicesUpdateDialog?: boolean }): Promise<boolean>;
  signIn(options?: unknown): Promise<GoogleSignInResponse>;
}

/** Pull the id_token out of either response shape. Null when cancelled / absent. */
export function extractIdToken(response: GoogleSignInResponse | null | undefined): string | null {
  if (!response) return null;
  const envelope = response as GoogleSignInResponseV13;
  if (typeof envelope.type === 'string') {
    if (envelope.type !== 'success') return null;
    return envelope.data?.idToken ?? null;
  }
  return (response as GoogleUserInfo).idToken ?? null;
}
