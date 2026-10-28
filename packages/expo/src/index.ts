// Expo provider (wraps @atlasauth/react, swaps the cookie transport for an
// expo-secure-store-backed token cache) + the token cache itself.
export * from './token-cache';
export * from './cache-fetch';
export * from './AtlasProvider';

// Native session (first-party OAuth → cookie-free session with auto-refresh).
export * from './native-session';

/*
 * Re-export the NATIVE-SAFE React surface from @atlasauth/react, so an Expo app
 * reads auth with the very same hooks and control components a web app does.
 *
 * Deliberately a NAMED re-export, not `export *`: the hooks and the
 * conditional-render controls (`SignedIn` / `SignedOut` / `Protect`) decide
 * whether their children appear and render no host element, so they run fine
 * under React Native. The prebuilt UI components (`<SignIn>`, `<UserButton>`, …)
 * render DOM (`<div>`, `<input>`, `<style>`) and are web-only — build those
 * screens with React Native primitives and these headless hooks instead.
 */
export {
  useAuth,
  useUser,
  useSession,
  useSessionList,
  useOrganization,
  SignedIn,
  SignedOut,
  Protect,
  AtlasLoading,
  AtlasLoaded,
} from '@atlasauth/react';

// Policy acceptance (terms, privacy, any policy): native components + hooks bound to this provider.
export * from './policies';
