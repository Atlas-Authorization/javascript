export * from './appearance';
export * from './styles';
export * from './protect';
export * from './i18n';
export * from './types';
export * from './AtlasProvider';
export * from './hooks';
export * from './fapi';
export * from './components';
export * from './sign-in-with-atlas';
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
