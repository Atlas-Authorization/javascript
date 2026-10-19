export * from './types';
export * from './context';
export * from './provider';
export * from './accessors';
export * from './control-components';
export * from './widgets';

// `onSignOut({ reason })` event types + the `atlas:signout` window event; this SDK's version.
export { SIGN_OUT_EVENT, onAtlasSignOut } from '@atlasauth/js';
export type { SignOutEvent, SignOutReason } from '@atlasauth/js';
export { ATLAS_SOLID_SDK, ATLAS_SOLID_VERSION } from './version';
