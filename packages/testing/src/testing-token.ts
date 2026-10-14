import { DEFAULT_API_URL } from '@atlasauth/backend';

/**
 * Options for {@link getTestingToken}.
 *
 * The secret key never leaves the test runner's Node process: a testing token
 * is minted server-side from it and only the SHORT-LIVED token travels with the
 * browser's requests. Keep `secretKey` in the e2e environment (CI secret, `.env`),
 * never in page/renderer code or a committed fixture.
 */
export interface GetTestingTokenOptions {
  /**
   * The instance secret key (`sk_...`). Sent as `Authorization: Bearer <key>`
   * to mint the token; never placed in a URL and never logged by this package.
   */
  secretKey: string;
  /**
   * Base URL of the instance's Backend API, e.g. `https://api.atlasauth.net`.
   * @default DEFAULT_API_URL (`https://api.atlasauth.net`)
   */
  apiUrl?: string;
  /** Injectable `fetch`, for tests and non-global-fetch runtimes. */
  fetchImpl?: typeof fetch;
}

/** The Backend-API path that mints a testing token. */
const TESTING_TOKENS_PATH = '/v1/testing_tokens';

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Pluck the token string out of the Backend API's response, tolerating both the
 * flat `{ token }` shape and the nested `{ testing_token: { token } }` envelope
 * some resources wrap single objects in. Anything else yields `null`.
 */
function readToken(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const flat = (data as { token?: unknown }).token;
  if (typeof flat === 'string' && flat.length > 0) return flat;
  const nested = (data as { testing_token?: { token?: unknown } }).testing_token;
  if (nested && typeof nested.token === 'string' && nested.token.length > 0) {
    return nested.token;
  }
  return null;
}

/**
 * Mint a short-lived **testing token** from the Atlas Backend API.
 *
 * A testing token marks the requests that carry it as an automated end-to-end
 * test, so the instance's bot/abuse protection — CAPTCHA challenges, device
 * fingerprinting, velocity checks — is skipped for those requests. Without it, a
 * headless Playwright/Cypress browser signing in repeatedly looks exactly like
 * the abuse the protection is built to stop, and the sign-in is challenged or
 * blocked. This is the Atlas peer of Clerk's `@clerk/testing` token.
 *
 * Contract:
 * - `POST {apiUrl}/v1/testing_tokens` with `Authorization: Bearer <secretKey>`.
 * - A 2xx response body shaped `{ token: string }` (or `{ testing_token: { token } }`)
 *   resolves to that token string.
 * - The token is short-lived and single-run; mint a fresh one per test run (see
 *   {@link atlasSetup}, which caches one for you).
 *
 * **Never throws.** Any failure — network error, non-2xx status, unparseable or
 * token-less body — resolves to `null`. A test harness should treat `null` as
 * "proceed without a testing token" (the sign-in may then face bot protection)
 * rather than crash the whole suite before a single test runs. Enable Atlas bot
 * protection in test only when you pass a token.
 *
 * @example
 * ```ts
 * const token = await getTestingToken({ secretKey: process.env.ATLAS_SECRET_KEY! });
 * if (token) { /* attach it to your browser's Atlas requests *\/ }
 * ```
 */
export async function getTestingToken(options: GetTestingTokenOptions): Promise<string | null> {
  const { secretKey } = options;
  if (!secretKey) return null;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  const url = joinUrl(options.apiUrl ?? DEFAULT_API_URL, TESTING_TOKENS_PATH);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        accept: 'application/json',
      },
    });

    if (!response.ok) return null;

    const text = await response.text();
    if (!text) return null;

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    return readToken(data);
  } catch {
    // Network/DNS/abort/etc. — fail soft so the suite still boots.
    return null;
  }
}
