/**
 * The FAPI client and sign-in flow driver now live in `@atlasauth/js` — the pure,
 * framework-agnostic browser FAPI flow — so the React `<SignIn/>` and the
 * framework-agnostic `@atlasauth/embed` widget drive the exact same endpoints
 * through one implementation and cannot diverge in what the server sees.
 *
 * This module is kept as a thin re-export so every existing importer inside the
 * React SDK (`./components`, the public barrel, the tests) keeps resolving the
 * driver from `./fapi` unchanged.
 */
export {
  FapiClient,
  advance,
  prepareFactor,
  pollAttempt,
  shouldKeepPolling,
  requestForStep,
  flowFromPending,
  initialFlow,
  getProviderToken,
  type FapiClientOptions,
  type FapiResponse,
  type FlowState,
  type ProviderToken,
} from '@atlasauth/js';
