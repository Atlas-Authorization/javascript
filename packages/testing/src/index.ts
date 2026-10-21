/**
 * `@atlasauth/testing` — test helpers that let automated end-to-end suites
 * (Playwright, Cypress) sign a user into an Atlas-backed app WITHOUT tripping
 * the instance's bot/abuse protection. The Atlas peer of Clerk's `@clerk/testing`.
 *
 * The core is a single Backend-API call that mints a short-lived **testing
 * token** ({@link getTestingToken}); the framework adapters ride that token on
 * the browser's Atlas requests. {@link atlasSetup} fetches and caches one token
 * for the whole run.
 *
 * Everything here is FAIL-SOFT: a failure to mint a token resolves to `null`
 * rather than throwing, so a flaky network or a misconfigured key never takes
 * the whole suite down before the first test.
 */
import { getTestingToken } from './testing-token';

export { getTestingToken } from './testing-token';
export type { GetTestingTokenOptions } from './testing-token';

// Offline token fixtures for backend unit tests: session tokens, ID tokens, a
// fake token endpoint (`issuer.fetch`) and the six negative cases. The same
// functions as `@atlasauth/backend`, re-exported so one import covers testing.
export { createTestIssuer, TEST_TOKEN_TAMPERS } from '@atlasauth/backend';
export type {
  CreateTestIssuerOptions,
  MintIdTokenOptions,
  TestAuthorizeOptions,
  TestAuthorizeResult,
  TestIssuer,
  TestTokenTamper,
} from '@atlasauth/backend';

// Framework adapters — re-exported so a consumer can reach everything from the
// root, while the dedicated subpaths (`@atlasauth/testing/playwright`,
// `@atlasauth/testing/cypress`) stay available for a tighter import.
export * from './playwright';
export * from './cypress';

/** Options for {@link atlasSetup}. */
export interface AtlasSetupOptions {
  /**
   * The instance publishable key (`pk_...`). Optional and display-only here —
   * kept so a caller can pass the same config object it gives the browser SDK,
   * and reserved for adapters that need the frontend origin encoded in it.
   */
  publishableKey?: string;
  /**
   * The instance secret key (`sk_...`), used to mint the testing token. Stays in
   * the test runner's Node process; only the minted token reaches the browser.
   */
  secretKey: string;
  /**
   * Base URL of the Backend API that mints the token.
   * @default `https://api.atlasauth.net`
   */
  apiUrl?: string;
  /** Injectable `fetch`, for tests and non-global-fetch runtimes. */
  fetchImpl?: typeof fetch;
}

/** The handle {@link atlasSetup} returns. */
export interface AtlasTestingSetup {
  /**
   * Resolve the run's testing token, minting it on first call and returning the
   * SAME cached value (and in-flight promise) on every call thereafter — so N
   * tests share one Backend-API round-trip. Resolves to `null` if minting failed.
   */
  getToken(): Promise<string | null>;
}

/**
 * Prepare `@atlasauth/testing` for a test run: wire up a lazily-minted,
 * per-run-cached testing token and hand back a {@link AtlasTestingSetup} whose
 * `getToken()` every adapter and test can call cheaply.
 *
 * The token is minted on the FIRST `getToken()` call, not eagerly, and the
 * resulting promise is memoized: concurrent callers await the one request, and
 * later callers get the resolved value immediately. Mirrors the single
 * `clerkSetup()` a Clerk e2e suite runs once in global setup.
 *
 * @example
 * ```ts
 * // playwright global-setup.ts
 * const atlas = atlasSetup({ secretKey: process.env.ATLAS_SECRET_KEY! });
 * const token = await atlas.getToken();
 * ```
 */
export function atlasSetup(options: AtlasSetupOptions): AtlasTestingSetup {
  let pending: Promise<string | null> | null = null;

  return {
    getToken(): Promise<string | null> {
      if (pending === null) {
        pending = getTestingToken({
          secretKey: options.secretKey,
          apiUrl: options.apiUrl,
          fetchImpl: options.fetchImpl,
        });
      }
      return pending;
    },
  };
}
