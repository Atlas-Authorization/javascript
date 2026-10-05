/**
 * `@atlasauth/electron` — the Atlas SDK for Electron.
 *
 * The main entry bundles the MAIN-process and RENDERER pieces plus the shared
 * contract and token storage. The preload helper is a separate entry
 * (`@atlasauth/electron/preload`) because a preload script runs in its own
 * realm and imports only what it needs.
 */
export * from './shared';
export * from './storage';
export * from './main';
export * from './renderer';
export * from './native-session';
