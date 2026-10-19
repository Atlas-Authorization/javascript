export * from './appearance';
export * from './styles';
export * from './protect';
export * from './i18n';
export * from './types';
// 'use client' modules are re-exported by name: `export *` compiles to a loop
// over the module's keys, and a React Server Components client reference has
// none, so every export would arrive `undefined` in a server layout.
export type * from './AtlasProvider';
export { AtlasProvider, useAtlas } from './AtlasProvider';
export type * from './hooks';
export {
  authFromContext,
  useAuth,
  useOrganization,
  useSession,
  useSessionList,
  useSignOutListener,
  useSilentAuth,
  useUser,
} from './hooks';
export { ATLAS_REACT_SDK, ATLAS_REACT_VERSION } from './version';
// `onSignOut({ reason })`: the event type, and the `atlas:signout` window event for
// scripts outside the React tree.
export { SIGN_OUT_EVENT, onAtlasSignOut } from '@atlasauth/js';
export type { SignOutEvent, SignOutReason } from '@atlasauth/js';
export * from './fapi';
export * from './components';
export type * from './sign-in-with-atlas';
export {
  buildAtlasAuthorizeUrl,
  completeSignInWithAtlas,
  signInWithAtlasPopup,
  SignInWithAtlasButton,
} from './sign-in-with-atlas';
// Cross-property SSO: the browser silent-check (hidden-iframe OIDC prompt=none),
// surfaced first-class here from @atlasauth/js.
export { checkSession, handleSilentCallback } from '@atlasauth/js';
export type { CheckSessionOptions, CheckSessionResult } from '@atlasauth/js';
// Native-provider diagnostics: a hook-free helper returning the knowable facts about
// a provider's native-sign-in setup (resolved mode/client_id, page origin, live
// overlay geometry, session credential flag). Surfaced here from @atlasauth/js.
export { diagnoseProvider } from '@atlasauth/js';
// Provider configuration errors (a missing/invalid `frontendApi`) and the
// sign-out result/error types, surfaced from @atlasauth/js.
export { AtlasConfigError, SAME_ORIGIN_FRONTEND_API, SignOutError } from '@atlasauth/js';
export type { AtlasConfigErrorCode, SignOutOptions, SignOutResult, TombstoneStore } from '@atlasauth/js';
// Server-side prefetch for `<AtlasProvider initialState>`: the panel renders styled,
// with its social buttons, in the server HTML.
export { fetchAtlasInitialState } from '@atlasauth/js';
export type { AtlasInitialState, FetchInitialStateOptions } from '@atlasauth/js';
// Built-in UI languages for `<AtlasProvider locale>` + CI coverage helpers.
export { LOCALIZATION_KEYS, missingKeys, resolveLocale } from '@atlasauth/localizations';
export type { SupportedLocale } from '@atlasauth/localizations';
export type { ProviderDiagnosis, OverlayGeometry, Rect } from '@atlasauth/js';

// The instance's public sign-in / sign-up settings (`useAtlas().instanceSettings`).
export type { InstanceSettings, PublicSignUpField } from './instance-settings';
export type { CaptchaFlowKey, CaptchaWidgetMode, FlowCaptcha } from '@atlasauth/js';
