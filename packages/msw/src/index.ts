/**
 * `@atlasauth/msw` — Mock Service Worker (v2) request handlers that mock Atlas's
 * Frontend API (FAPI) and Backend API (BAPI), so an integrator can test their
 * Atlas integration against realistic, shape-correct responses without a live
 * server. The MSW peer of `@atlasauth/testing`.
 *
 * ```ts
 * import { setupServer } from 'msw/node';
 * import { atlasHandlers, createAtlasMock } from '@atlasauth/msw';
 *
 * const mock = createAtlasMock({ users: [{ email: 'ada@example.com', password: 'pw' }] });
 * const server = setupServer(...atlasHandlers(mock));
 * ```
 */
export { atlasHandlers, type AtlasHandlersOptions } from './handlers';
export {
  createAtlasMock,
  AtlasMock,
  IdFactory,
  ID_PREFIXES,
  type AtlasMockSeed,
  type SeedUser,
  type SeedOrganization,
  type EntityKind,
  type MockInstance,
  type MockUser,
  type MockEmail,
  type MockOrganization,
  type MockMembership,
  type MockSession,
  type MockAttempt,
  type MockSocialProvider,
} from './state';
export {
  errorBody,
  listEnvelope,
  presentUser,
  presentMeUser,
  presentMembership,
  presentOrganization,
  presentSession,
  presentSignInAttempt,
  presentSignUpAttempt,
} from './serializers';

// The full Backend API engine as msw handlers (users, organizations, roles, API keys, machines and grants,
// webhooks, the change feed, signed tokens), for code that needs more than the in-memory client model above.
export { coreHandlers } from '@atlasauth/emulator-core/msw';
export type { CoreHandlersOptions } from '@atlasauth/emulator-core/msw';
export { createEmulatorEngine } from '@atlasauth/emulator-core';
