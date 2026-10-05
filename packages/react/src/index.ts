export * from './appearance';
export * from './styles';
export * from './protect';
export * from './i18n';
export * from './types';
export * from './AtlasProvider';
export * from './hooks';
export * from './fapi';
export * from './components';
// Cross-property SSO: the browser silent-check (hidden-iframe OIDC prompt=none),
// surfaced first-class here from @atlasauth/js.
export { checkSession, handleSilentCallback } from '@atlasauth/js';
export type { CheckSessionOptions, CheckSessionResult } from '@atlasauth/js';
// Native-provider diagnostics: a hook-free helper returning the knowable facts about
// a provider's native-sign-in setup (resolved mode/client_id, page origin, live
// overlay geometry, session credential flag). Surfaced here from @atlasauth/js.
export { diagnoseProvider } from '@atlasauth/js';
export type { ProviderDiagnosis, OverlayGeometry, Rect } from '@atlasauth/js';
