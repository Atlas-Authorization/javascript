/**
 * `@atlasauth/svelte` — the official Svelte / SvelteKit SDK for Atlas.
 *
 * The Svelte peer of `@atlasauth/react`: the same surface, expressed as Svelte
 * stores, context, and `.svelte` components. Install the client with
 * {@link initAtlas} (or `<AtlasProvider>`), read reactive state through the
 * accessors, and gate UI with the components.
 *
 * The SvelteKit server helper (`handleAtlas`, `getServerAuth`) lives at the
 * separate `@atlasauth/svelte/server` entry — it depends on `@atlasauth/backend` and
 * must never be pulled into a browser bundle.
 */

// Theming, i18n, authorization, and shared types (identical to @atlasauth/react).
export * from './appearance';
export * from './protect';
export * from './i18n';
export * from './types';
export * from './fapi';

// The client, context install, and the base accessor.
export {
  ATLAS_KEY,
  initAtlas,
  createAtlasClient,
  useAtlas,
  type AuthStatus,
  type AtlasInitOptions,
  type AtlasStores,
  type AtlasClient,
} from './context';

// Store accessors (peers of the React hooks) and action helpers.
export {
  getUser,
  getSession,
  getAuth,
  getOrganization,
  getOrganizationAuditLog,
  getToken,
  signIn,
  signUp,
  signOut,
  type UseUser,
  type UseSession,
  type UseAuth,
  type UseOrganization,
  type OrganizationAuditLogStore,
  type FlowController,
} from './accessors';

// Components.
export { default as AtlasProvider } from './components/AtlasProvider.svelte';
export { default as SignedIn } from './components/SignedIn.svelte';
export { default as SignedOut } from './components/SignedOut.svelte';
export { default as AtlasLoading } from './components/AtlasLoading.svelte';
export { default as AtlasLoaded } from './components/AtlasLoaded.svelte';
export { default as Protect } from './components/Protect.svelte';
export { default as SignIn } from './components/SignIn.svelte';
export { default as SignUp } from './components/SignUp.svelte';
export { default as UserButton } from './components/UserButton.svelte';
export { default as UserProfile } from './components/UserProfile.svelte';
export { default as ManageCiba } from './components/ManageCiba.svelte';
// API keys, billing and device authorization.
export { default as ApiKeys } from './components/ApiKeys.svelte';
export { default as DeviceAuthorization } from './components/DeviceAuthorization.svelte';
export { default as PricingTable } from './components/PricingTable.svelte';
export { default as Invoices } from './components/Invoices.svelte';
export { default as EmbeddedCheckout } from './components/EmbeddedCheckout.svelte';
export { default as Checkout } from './components/Checkout.svelte';
export { controllerStore, createApiKeysController, createBillingController, createCheckoutController, createDeviceAuthorizationController, createUsage } from './managed';
export {
  API_KEYS_LABELS,
  BILLING_LABELS,
  CHECKOUT_LABELS,
  DEVICE_AUTH_LABELS,
  type ApiKeysState,
  type BillingState,
  type DeviceAuthorizationState,
} from '@atlasauth/js';
export { default as OrganizationSwitcher } from './components/OrganizationSwitcher.svelte';
export { default as OrganizationProfile } from './components/OrganizationProfile.svelte';
export { default as OrganizationAuditLog } from './components/OrganizationAuditLog.svelte';
export type { OrganizationAuditLogEntry, OrganizationAuditLogState } from '@atlasauth/js';
export { default as ImpersonationBanner } from './components/ImpersonationBanner.svelte';
// Policy acceptance (terms, privacy, any policy): the consent block, clickwrap line, sign-in step and in-app gate.
export { default as PolicyConsent } from './components/PolicyConsent.svelte';
export { default as PolicyClickwrap } from './components/PolicyClickwrap.svelte';
export { default as PolicyAcceptStep } from './components/PolicyAcceptStep.svelte';
export { default as PolicyGate } from './components/PolicyGate.svelte';

// The instance's public sign-in / sign-up settings the prebuilt forms read
// (`signUp().settings`, including `emailDelivery`), and the captcha types they render.
export type {
  InstanceSettings,
  EmailDelivery,
  PublicSignUpField,
  CaptchaController,
  CaptchaFlowKey,
  CaptchaWidgetMode,
  FlowCaptcha,
} from '@atlasauth/js';

// What `signOut()` resolves with, and what it rejects with under `{ strict: true }`.
export { SignOutError } from '@atlasauth/js';
export type { SignOutOptions, SignOutResult } from '@atlasauth/js';

// `onSignOut({ reason })` event types + the `atlas:signout` window event; this SDK's version.
export { SIGN_OUT_EVENT, onAtlasSignOut } from '@atlasauth/js';
export type { SignOutEvent, SignOutReason } from '@atlasauth/js';
export { ATLAS_SVELTE_SDK, ATLAS_SVELTE_VERSION } from './version';
