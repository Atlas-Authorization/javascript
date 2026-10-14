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
