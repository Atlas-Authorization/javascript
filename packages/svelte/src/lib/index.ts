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
  getToken,
  signIn,
  signUp,
  signOut,
  type UseUser,
  type UseSession,
  type UseAuth,
  type UseOrganization,
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
export { default as OrganizationSwitcher } from './components/OrganizationSwitcher.svelte';
export { default as OrganizationProfile } from './components/OrganizationProfile.svelte';
