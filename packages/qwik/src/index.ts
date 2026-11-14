/**
 * `@atlasauth/qwik` — Qwik / Qwik City bindings for Atlas.
 *
 * Shape mirrors `@atlasauth/react` and `@atlasauth/vue`: a provider, the
 * `useAuth` / `useUser` / `useSession` hooks, the `<SignedIn>` / `<SignedOut>` /
 * `<Protect>` guards, and mountable `<SignIn>` / `<SignUp>` / `<UserButton>`.
 *
 * The Qwik City route-protection helper lives at `@atlasauth/qwik/server`.
 */
export * from './types';
export * from './client';
export * from './store';
export * from './context';
export * from './hooks';
export * from './provider';
export * from './control-components';
export * from './components';
export * from './ciba';
export { ManageCiba } from './ciba-components';
// API keys, billing and device authorization.
export { ApiKeys, type ApiKeysProps } from './api-keys';
export { DeviceAuthorization, type DeviceAuthorizationProps } from './device-authorization';
export { PricingTable, Invoices, EmbeddedCheckout, Checkout, useUsage, type PricingTableLabels } from './billing';
export {
  API_KEYS_LABELS,
  BILLING_LABELS,
  CHECKOUT_LABELS,
  DEVICE_AUTH_LABELS,
  type ApiKeysState,
  type BillingState,
  type DeviceAuthorizationState,
} from '@atlasauth/js';
export * from './widget';
export * from './policies';
export * from './policy-components';
export * from './protect';

// The sign-out result and its strict-mode error, so callers need not depend on
// `@atlasauth/js` directly to name or `instanceof` them.
export { SignOutError } from '@atlasauth/js';
export type { SignOutOptions, SignOutResult } from '@atlasauth/js';
