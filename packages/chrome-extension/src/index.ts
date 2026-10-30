/**
 * `@atlasauth/chrome-extension` — the React-free core.
 *
 * This entry point (the package root) pulls in NO React and NO DOM renderer, so
 * it is safe to import from a background service worker or a content script. It
 * gives you the token store and the FAPI client + session-token lifecycle:
 *
 *   import { createAtlasClient, StorageCache } from '@atlasauth/chrome-extension';
 *
 * For the React provider + hooks, import from `@atlasauth/chrome-extension/react`
 * (React is an optional peer). For the background helpers under an explicit,
 * intent-revealing name, `@atlasauth/chrome-extension/background` re-exports them.
 */
export * from './storage';
export * from './client';
export * from './native-session';
export * from './web-auth-flow';
export * from './posture';
