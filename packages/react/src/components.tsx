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
export type { PolicyGateProps, PolicyModalProps, UsePoliciesOptions, UsePoliciesResult } from './policies';
export {
  PolicyAcceptStep,
  PolicyClickwrap,
  PolicyConsent,
  PolicyGate,
  PolicyModal,
  PolicyScrollQueue,
  PolicyViewer,
  usePolicies,
  usePolicyState,
  usePolicyText,
} from './policies';

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
  OrganizationAuditLog,
  useOrganizationAuditLog,
  useOrganizationProfile,
} from './organization';
export type { OrganizationAuditLogEntry } from './organization';
export { LeadForm, type LeadFormLabels } from './marketing';
export {
  OrganizationSsoConnection,
  OrganizationDirectory,
  OrganizationDomains,
  OrganizationLogStreams,
  OrganizationApiKeys,
  OrganizationIpAllowlist,
  OrganizationWebhooks,
  AppWebhookEndpoints,
} from './organization-admin';
export type { OrganizationProfileProps } from './organization';

// Post-login account surface (profile, 2FA, passkeys, devices, `<UserProfile>`).
export type { ProfilePageProps, ProfileLinkProps, ManagePasskeysProps } from './account';
export { ManageMoreFactors, ManageSecurityQuestions } from './account-factors';
export {
  ActiveSessions,
  ManageCiba,
  ProfileCard,
  ManageMfa,
  ManagePasskeys,
  PasskeyPrompt,
  ManagePhoneNumbers,
  UserProfile,
} from './account';

// Waitlist.
export { useWaitlist, Waitlist } from './waitlist';

// Impersonation: the banner with "Return to admin", and its hook.
export { ImpersonationBanner, useImpersonation } from './impersonation';
export type { ImpersonationBannerProps, UseImpersonationReturn } from './impersonation';

// Step-up reverification.
export { useReverification, ReverificationPrompt, isReverificationCancelled, type Reverification } from './reverification';

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
// The profile fields the application defined (`<ProfileTraits/>` + `useProfileTraits()`).
export type { ProfileTraitsProps, ProfileTraitsStatus, UseProfileTraitsResult } from './profile-traits';
export { ProfileTraits, useProfileTraits } from './profile-traits';
// Progressive profiling before a feature (`<ProfileCompletion/>`).
export type { ProfileCompletionProps } from './profile-completion';
export { ProfileCompletion } from './profile-completion';
// Connected accounts (`<ConnectedAccounts/>` + `useConnectedAccounts()`): app-defined connections with live status.
export type { ConnectedAccountsProps, UseConnectedAccountsResult } from './connected-accounts';
export { ConnectedAccounts, useConnectedAccounts } from './connected-accounts';
// Device sign-in approval on your own page (`<DeviceAuthorization/>` + `useDeviceAuthorization()`).
export type {
  DeviceAuthorizationProps,
  DeviceAuthorizationStatus,
  UseDeviceAuthorizationResult,
} from './device-authorization';
export { DeviceAuthorization, useDeviceAuthorization } from './device-authorization';
export { AppLauncher } from './app-launcher';
export type { AppLauncherProps } from './app-launcher';
export { IntegrationGallery } from './integration-gallery';
export type { IntegrationGalleryProps } from './integration-gallery';

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
