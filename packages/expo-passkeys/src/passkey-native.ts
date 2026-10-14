/**
 * The slice of [`react-native-passkey`](https://github.com/f-23/react-native-passkey)
 * this helper uses, declared structurally.
 *
 * `react-native-passkey` is an OPTIONAL peer that bridges to the platform
 * authenticator (iOS ASAuthorization / Android Credential Manager). This package
 * never imports it — the app passes the `Passkey` object in — so the package
 * compiles and typechecks without the native module, and without a config plugin
 * / prebuild in CI. The real `Passkey` is structurally compatible with the shapes
 * below.
 *
 * `Passkey.create` / `Passkey.get` accept the server's WebAuthn options JSON
 * verbatim (the `begin` response) and return the ceremony result with base64url
 * string fields — exactly what the Atlas `finish` routes want.
 */

/** Result of `Passkey.create` — a WebAuthn attestation. */
export interface PasskeyCreateResult {
  id?: string;
  rawId?: string;
  response: {
    attestationObject: string;
    clientDataJSON: string;
  };
}

/** Result of `Passkey.get` — a WebAuthn assertion. */
export interface PasskeyGetResult {
  id?: string;
  rawId?: string;
  response: {
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    userHandle?: string | null;
  };
}

/** The `Passkey` object `react-native-passkey` exports. */
export interface ReactNativePasskey {
  create(request: Record<string, unknown>): Promise<PasskeyCreateResult>;
  get(request: Record<string, unknown>): Promise<PasskeyGetResult>;
}
