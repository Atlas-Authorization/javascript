/**
 * What the module surfaces from `@atlasauth/vue`: the composables auto-imported
 * into every Nuxt file and the components registered app-wide. Kept in one place
 * (and apart from the Nuxt kit calls) so a test can check the lists against
 * `@atlasauth/vue`'s real exports.
 */
export const VUE_COMPOSABLES = [
  'useAtlas',
  'useUser',
  'useSession',
  'useAuth',
  'useOrganization',
  'useSignIn',
  'useSignUp',
  'useFlow',
  // Policy acceptance (terms, privacy): load the instance's policies into a controller
  // for a custom form, and subscribe a component to one.
  'usePolicies',
  'usePolicyState',
] as const;

export const VUE_COMPONENTS = [
  'SignedIn',
  'SignedOut',
  'AtlasLoading',
  'AtlasLoaded',
  'Protect',
  'SignIn',
  'SignUp',
  'UserButton',
  'OrganizationSwitcher',
  'UserProfile',
  'OrganizationProfile',
  // Policy acceptance (terms, privacy): the checkbox block with its document viewer, the
  // clickwrap sentence, the held-sign-in step, and the signed-in re-acceptance banner.
  'PolicyConsent',
  'PolicyClickwrap',
  'PolicyAcceptStep',
  'PolicyGate',
] as const;
