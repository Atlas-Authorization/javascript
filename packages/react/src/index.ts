export * from './appearance';
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
