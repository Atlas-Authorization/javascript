/**
 * View-models for native sign-in and account-security screens, bound to the provider's bearer-authenticated client.
 * No React in this file (so it is testable in Node); the hooks are in `./screens-hook`.
 *
 * Optional native pieces are passed in, never imported: Apple and Google sheets, a passkey provider from
 * `@atlasauth/expo-passkeys` (`{ signIn: nativePasskeySignIn(Passkey), assertion: nativePasskeyAssertion(Passkey) }`).
 * Whatever you leave out is simply not offered.
 */
import {
  createSecuritySection,
  createSignInScreen,
  type ErrorStrings,
  type FapiClient,
  type FieldError,
  type NativeSignInProvider,
  type PasskeyAssertionProvider,
  type SecuritySectionKind,
  type StepUpFlowOptions,
} from '@atlasauth/js';
import { appleSignInProvider, googleSignInProvider, type AppleAuthenticationLike, type GoogleSigninLike } from './social';

export type {
  ScreenField,
  SectionField,
  SecurityItem,
  SecuritySection,
  SecuritySectionKind,
  SecuritySectionStep,
  SecuritySectionView,
  SignInMethod,
  SignInScreen,
  SignInScreenStep,
  SignInScreenView,
} from '@atlasauth/js';

/** A passkey provider for a phone: `@atlasauth/expo-passkeys`'s `nativePasskeySignIn(Passkey)` and `nativePasskeyAssertion(Passkey)`. */
export interface NativePasskeyProvider {
  /** Passkey sign-in (the one-tap button). */
  signIn?: NativeSignInProvider;
  /** The passkey second factor, and the passkey re-authentication of a step-up. */
  assertion?: PasskeyAssertionProvider;
}

export interface SignInScreenSetup {
  localization?: ErrorStrings | null;
  /** `expo-apple-authentication`; offers the Apple button. */
  apple?: AppleAuthenticationLike;
  /** `@react-native-google-signin/google-signin`; offers the Google button. */
  google?: GoogleSigninLike;
  passkey?: NativePasskeyProvider;
}

/** The sign-in screen model on a client; separated from React so it is testable with a fake one. */
export function createExpoSignInScreen(client: FapiClient, setup: SignInScreenSetup = {}) {
  return createSignInScreen({
    client,
    ...(setup.localization !== undefined ? { localization: setup.localization } : {}),
    ...(setup.passkey?.assertion ? { passkeyAssertion: setup.passkey.assertion } : {}),
    nativeSignIn: {
      ...(setup.passkey?.signIn ? { passkey: setup.passkey.signIn } : {}),
      ...(setup.apple ? { apple: appleSignInProvider(setup.apple) } : {}),
      ...(setup.google ? { google: googleSignInProvider(setup.google) } : {}),
    },
  });
}

export interface SecuritySectionSetup {
  localization?: ErrorStrings | null;
  /** Asks the person to re-authenticate when the server requires it (see `useStepUp`). Without it the view says `stepUpRequired`. */
  choose?: StepUpFlowOptions['choose'];
  passkey?: NativePasskeyProvider;
  /** Registers a passkey on this device (`registerPasskey` from `@atlasauth/expo-passkeys`); offers `add_passkey`. */
  addPasskey?: (client: FapiClient) => Promise<{ ok: boolean; errors: FieldError[] }>;
}

/** One security section model on a client; separated from React so it is testable with a fake one. */
export function createExpoSecuritySection(client: FapiClient, kind: SecuritySectionKind, setup: SecuritySectionSetup = {}) {
  return createSecuritySection({
    client,
    kind,
    ...(setup.localization !== undefined ? { localization: setup.localization } : {}),
    ...(setup.choose ? { choose: setup.choose } : {}),
    ...(setup.passkey?.assertion ? { passkeyAssertion: setup.passkey.assertion } : {}),
    ...(setup.addPasskey ? { addPasskey: setup.addPasskey } : {}),
  });
}
