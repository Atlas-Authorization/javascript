/**
 * The FAPI client and the server-driven sign-in flow driver live in `@atlasauth/js`
 * — the pure, framework-agnostic browser flow. This thin re-export lets the
 * Angular components, guards and services resolve the driver from one place, so
 * the Angular `<atlas-sign-in>` and the React `<SignIn/>` drive the exact same
 * endpoints and cannot diverge in what the server sees.
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
