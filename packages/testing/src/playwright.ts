/**
 * Playwright adapter for `@atlasauth/testing`.
 *
 * `@playwright/test` is an OPTIONAL peer, so this module imports nothing from it
 * and instead models the two surfaces it touches — a `Page` that can install a
 * `route` interceptor, and the `Route`/`Request` pair that interceptor receives
 * — as minimal STRUCTURAL interfaces. The real Playwright types are supersets of
 * these, so a real `Page` passes wherever {@link PlaywrightPage} is asked for,
 * and the package compiles whether or not Playwright is installed (mirroring how
 * `@atlasauth/electron` treats `electron`). When you DO have Playwright:
 *
 * ```ts
 * import type { Page } from '@playwright/test';
 * import { setupAtlasTestingToken } from '@atlasauth/testing/playwright';
 *
 * test.beforeEach(async ({ page }: { page: Page }) => {
 *   await setupAtlasTestingToken({ page, secretKey: process.env.ATLAS_SECRET_KEY! });
 * });
 * ```
 */
import { getTestingToken } from './testing-token';

/**
 * The query parameter the testing token rides on. Atlas FAPI reads it to waive
 * bot/abuse protection for the request, the same role `__clerk_testing_token`
 * plays for Clerk.
 */
export const TESTING_TOKEN_PARAM = '__atlas_testing_token';

/** The Atlas FAPI surface, as a Playwright URL glob — every versioned endpoint. */
export const DEFAULT_FAPI_GLOB = '**/v1/**';

/** Structural subset of Playwright's `Request` used by the route handler. */
export interface PlaywrightRequest {
  /** The absolute request URL. */
  url(): string;
}

/** Structural subset of Playwright's `Route` used by the route handler. */
export interface PlaywrightRoute {
  /** Continue the request, optionally overriding the URL (and other fields). */
  continue(options?: { url?: string }): Promise<void>;
}

/** The handler shape `page.route(...)` invokes — compatible with Playwright's. */
export type PlaywrightRouteHandler = (
  route: PlaywrightRoute,
  request: PlaywrightRequest,
) => unknown | Promise<unknown>;

/** Structural subset of Playwright's `Page` used here. */
export interface PlaywrightPage {
  /** Install a request interceptor for URLs matching `glob`. */
  route(glob: string, handler: PlaywrightRouteHandler): Promise<void>;
}

/** Options for {@link setupAtlasTestingToken}. */
export interface SetupAtlasTestingTokenOptions {
  /** The Playwright `page` whose Atlas requests should carry the testing token. */
  page: PlaywrightPage;
  /** The instance secret key (`sk_...`), used once to mint the testing token. */
  secretKey: string;
  /**
   * The instance's FAPI origin, e.g. `https://fapi.acme.atlasauth.net`. When
   * given, interception is scoped to `${frontendApiUrl}/v1/**`; otherwise every
   * `**\/v1/**` request is matched. Narrow it on sites that also call unrelated
   * `/v1/` APIs you do not want rewritten.
   */
  frontendApiUrl?: string;
  /**
   * Base URL of the Backend API that mints the token.
   * @default `https://api.atlasauth.net`
   */
  apiUrl?: string;
  /** Injectable `fetch`, for tests and non-global-fetch runtimes. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the route handler that appends the testing token to each intercepted
 * request. Exported for unit testing and for callers who manage `page.route`
 * themselves. **Fail-soft:** if the URL can't be rewritten the request is let
 * through untouched rather than dropped.
 */
export function createTestingTokenRoute(token: string): PlaywrightRouteHandler {
  return async (route, request) => {
    try {
      const url = new URL(request.url());
      url.searchParams.set(TESTING_TOKEN_PARAM, token);
      await route.continue({ url: url.toString() });
    } catch {
      try {
        await route.continue();
      } catch {
        // Route already consumed elsewhere — nothing left to do.
      }
    }
  };
}

/**
 * Mint a testing token and route the page's Atlas FAPI requests through a
 * handler that appends it as the `__atlas_testing_token` query parameter, so a
 * subsequent `page.goto(...)` of your app signs in without tripping bot
 * protection. Call it once per test (e.g. in `test.beforeEach`) before
 * navigating.
 *
 * **Fail-soft:** if the token cannot be minted (see {@link getTestingToken}) no
 * interception is installed and the function resolves normally — the test still
 * runs, it simply faces whatever bot protection the instance enforces.
 *
 * @returns the minted token, or `null` when none could be obtained.
 */
export async function setupAtlasTestingToken(
  options: SetupAtlasTestingTokenOptions,
): Promise<string | null> {
  const token = await getTestingToken({
    secretKey: options.secretKey,
    apiUrl: options.apiUrl,
    fetchImpl: options.fetchImpl,
  });
  if (!token) return null;

  const glob = options.frontendApiUrl
    ? `${options.frontendApiUrl.replace(/\/+$/, '')}/v1/**`
    : DEFAULT_FAPI_GLOB;

  await options.page.route(glob, createTestingTokenRoute(token));
  return token;
}
