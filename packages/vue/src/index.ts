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
export { ManageCiba } from './manage-ciba';
// API keys, billing and device authorization: the components and the composables behind them.
export { ApiKeys } from './api-keys';
export { DeviceAuthorization } from './device-authorization';
export { PricingTable, Invoices, EmbeddedCheckout, Checkout, type PricingTableLabels } from './billing';
export { useApiKeys, useBilling, useCheckoutStep, useDeviceAuthorization, useUsage } from './managed-components';
export {
  API_KEYS_LABELS,
  BILLING_LABELS,
  CHECKOUT_LABELS,
  DEVICE_AUTH_LABELS,
  type ApiKeysState,
  type BillingState,
  type DeviceAuthorizationState,
} from '@atlasauth/js';
export { PolicyAcceptStep, PolicyClickwrap, PolicyConsent, PolicyGate, usePolicies, usePolicyState } from './policies';

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
