/**
 * §10.2 components — public aggregation point for the @atlasauth/react component
 * library.
 *
 * The implementations live in per-component sibling files (`sign-in.tsx`,
 * `sign-up.tsx`, `user-button.tsx`, `organization.tsx`, `account.tsx`,
 * `auth-buttons.tsx`, `control-components.tsx`, `billing.tsx`, `waitlist.tsx`,
 * `reverification.tsx`, and the shared `flow.tsx` / `components-shared.tsx`).
 * This module re-exports every one of them so the package's public API — what
 * `index.ts` re-exports via `export * from './components'` — stays byte-for-byte
 * identical after the split. Import sites (`@atlasauth/react`) are unaffected.
 *
 * `<SignIn/>` and `<SignUp/>` are "full multi-step flows driven entirely by the
 * server-side attempt status": no client here decides what comes next; each step
 * renders whatever `status` the server returned, via the exhaustive mapping in
 * @atlasauth/js. See `flow.tsx` for that shell.
 */

// Control / conditional-rendering components.
export {
  SignedIn,
  SignedOut,
  AtlasLoading,
  AtlasLoaded,
  Protect,
  MultisessionAppSupport,
} from './control-components';

// Sign-in / sign-up flows (shared shell + props live in `flow.tsx`).
export type { FlowProps, GoogleButtonMode, ProviderUnavailableReason } from './flow';
export { SignIn, SocialSignInButton, useSignIn } from './sign-in';
export { SignUp, useSignUp } from './sign-up';

// User button + avatar (and the `<UserButton.MenuItems/Action/Link>` extension API).
export type { MenuActionProps, MenuLinkProps } from './user-button';
export { UserButton, UserAvatar } from './user-button';

// Clerk-parity auth navigation buttons / redirects.
export type { AuthButtonProps } from './auth-buttons';
export {
  SignInButton,
  SignUpButton,
  SignOutButton,
  RedirectToSignIn,
  RedirectToSignUp,
} from './auth-buttons';

// Organizations.
export {
  OrganizationSwitcher,
  useOrganizationList,
  CreateOrganization,
  OrganizationList,
  OrganizationProfile,
} from './organization';

// Post-login account surface (profile, 2FA, passkeys, devices, `<UserProfile>`).
export type { ProfilePageProps, ProfileLinkProps } from './account';
export {
  ActiveSessions,
  ProfileCard,
  ManageMfa,
  ManagePasskeys,
  UserProfile,
} from './account';

// Waitlist.
export { useWaitlist, Waitlist } from './waitlist';

// Step-up reverification.
export { useReverification } from './reverification';

// End-user API key self-service (`<ApiKeys/>` + `useApiKeys()`).
export type {
  ApiKeysProps,
  ApiKeysStatus,
  ApiKeyClaimsFieldsContext,
  UseApiKeysResult,
  CreateUserApiKeyInput,
  CreatedUserApiKey,
  UserApiKey,
} from './api-keys';
export { ApiKeys, useApiKeys } from './api-keys';

// Commerce / billing.
export type { CheckoutParams } from './billing';
export {
  useBilling,
  useCheckout,
  useSubscription,
  useInvoices,
  usePaymentMethods,
  PricingTable,
  Invoices,
  EmbeddedCheckout,
} from './billing';
