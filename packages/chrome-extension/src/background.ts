/**
 * `@atlasauth/chrome-extension/background` — the service-worker surface.
 *
 * A convenience alias for the React-free core, named for where it is used. A
 * background service worker creates the client once and refreshes the token on
 * each wake:
 *
 *   import { createAtlasClient } from '@atlasauth/chrome-extension/background';
 *
 *   const atlas = createAtlasClient({
 *     publishableKey: 'pk_...',
 *     frontendApi: 'https://fapi.your-instance.atlasauth.net',
 *     background: true,
 *   });
 *
 *   chrome.alarms.create('atlas-refresh', { periodInMinutes: 1 });
 *   chrome.alarms.onAlarm.addListener((a) => {
 *     if (a.name === 'atlas-refresh') void atlas.syncSessionToken();
 *   });
 */
export * from './storage';
export * from './client';
export * from './native-session';
export * from './web-auth-flow';
