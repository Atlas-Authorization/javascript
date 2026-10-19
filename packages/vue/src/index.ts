export * from './appearance';
export * from './protect';
export * from './i18n';
export * from './types';
export * from './plugin';
export * from './context';
export * from './composables';
export * from './flow';
export * from './fapi';
export * from './components';

// The instance's public sign-in / sign-up settings the prebuilt forms read
// (`useSignUp().settings`), and the captcha types they render.
export type {
  InstanceSettings,
  PublicSignUpField,
  CaptchaController,
  CaptchaFlowKey,
  CaptchaWidgetMode,
  FlowCaptcha,
} from '@atlasauth/js';

// What `signOut()` resolves with, and what `signOut({ strict: true })` rejects with.
export { SignOutError, type SignOutResult } from '@atlasauth/js';

// `onSignOut({ reason })` event types + the `atlas:signout` window event; this SDK's version.
export { SIGN_OUT_EVENT, onAtlasSignOut } from '@atlasauth/js';
export type { SignOutEvent, SignOutReason } from '@atlasauth/js';
export { ATLAS_VUE_SDK, ATLAS_VUE_VERSION } from './version';
