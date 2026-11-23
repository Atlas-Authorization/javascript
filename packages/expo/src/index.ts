// Expo provider (wraps @atlasauth/react, swaps the cookie transport for an
// expo-secure-store-backed token cache) + the token cache itself.
export * from './token-cache';
export * from './cache-fetch';
export * from './AtlasProvider';

// Native session (first-party OAuth → cookie-free session with auto-refresh).
export * from './native-session';

/*
 * Re-export the NATIVE-SAFE React surface from @atlasauth/react, so an Expo app
 * reads auth with the very same hooks and control components a web app does.
 *
 * Deliberately a NAMED re-export, not `export *`: the hooks and the
 * conditional-render controls (`SignedIn` / `SignedOut` / `Protect`) decide
 * whether their children appear and render no host element, so they run fine
 * under React Native. The prebuilt UI components (`<SignIn>`, `<UserButton>`, …)
 * render DOM (`<div>`, `<input>`, `<style>`) and are web-only — build those
 * screens with React Native primitives and these headless hooks instead.
 */
export {
  useAuth,
  useUser,
  useSession,
  useSessionList,
  useOrganization,
  SignedIn,
  SignedOut,
  Protect,
  AtlasLoading,
  AtlasLoaded,
} from '@atlasauth/react';

// Policy acceptance (terms, privacy, any policy): native components + hooks bound to this provider.
export * from './policies';

// Native social sign-in, the upgrade bridge for apps with existing users, and approve-in-your-app.
export * from './social';
// The device key a native session is bound to (on by default in <AtlasProvider>).
export * from './device-key';
export * from './bridge';
export * from './app-approval';
export * from './push-devices';
export * from './account-security';

// Captcha with no browser: the proof-of-work solver for Hermes/JSC. Importing this
// package installs it as the headless solver, so the sign-in / sign-up / reset
// flows from `@atlasauth/js` answer a captcha on their own.
export {
  getCaptchaToken,
  solveAtlasChallengeNative,
  atlasHeadlessCaptchaSolver,
  installAtlasCaptchaSolver,
  type SolveCaptchaOptions,
  type GetCaptchaTokenOptions,
} from '@atlasauth/react-native';
export * from './account-security-hook';
export * from './step-up';

// Sign-in and account-security screens as view-models (steps, methods, fields, human errors, step-up inside).
export * from './screens';
export * from './screens-hook';

// Browser sign-in with a provider (PKCE, Expo Go aware): `useSignIn().signInWithOAuth('discord')`.
export * from './sign-in-hook';
export { createExpoOAuth, isExpoGo, type ExpoOAuthModules, type ExpoSignInOptions } from './expo-oauth';

// Default React Native screens (sign-in, sign-up, second factor, account security) built on those view-models,
// and the element builders behind them (themeable, testable without a renderer).
export * from './native-screens';
export {
  DEFAULT_SCREEN_STRINGS,
  DEFAULT_SCREEN_THEME,
  renderAuthScreen,
  renderField,
  renderSecuritySection,
  type AuthActions,
  type FieldValues,
  type RenderEnv,
  type ScreenPrimitives,
  type ScreenStyles,
  type ScreenTheme,
  type SecurityActions,
} from './native-screens-render';
