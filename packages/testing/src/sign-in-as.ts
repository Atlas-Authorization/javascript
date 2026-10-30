import { DEFAULT_API_URL } from '@atlasauth/backend';

/**
 * Sign a browser in as a given user, for end-to-end tests.
 *
 * `POST /v1/testing/sign_in_url` (development instances) mints a one-time URL.
 * Opening it in the browser under test redeems a ticket and lands on your
 * `redirectUrl` with a real session, through the same ticket exchange every
 * sign-in uses — the Atlas SDK on that page sets the session, so the app sees a
 * normal signed-in user. Works with any runner: Playwright ({@link signInAs} in
 * `@atlasauth/testing/playwright`), Cypress (mint in a `cy.task`, then
 * `cy.visit(url)`), WebDriver, Puppeteer.
 *
 * Unlike the testing-token helpers this THROWS on failure: a sign-in a test
 * depends on must fail loudly, never silently leave the browser signed out.
 */
export interface GetSignInUrlOptions {
  /** A development instance secret key (`sk_test_...`). Stays in the test runner. */
  secretKey: string;
  /** The user to sign in as. */
  userId: string;
  /** Where the browser lands, signed in: one of the instance's allowed origins, or a localhost origin. */
  redirectUrl: string;
  /** URL lifetime in seconds (default 60, at most 300). */
  expiresInSeconds?: number;
  /** @default `https://api.atlasauth.net` */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

/** The minted sign-in URL. */
export interface SignInUrl {
  /** Open this in the browser. */
  url: string;
  /** The same one-time ticket, for `POST /v1/client/sign_ins {strategy:"ticket"}` if you drive the flow yourself. */
  ticket: string;
  expiresAt: string;
}

/** Thrown when the sign-in URL cannot be minted; `status` and `code` come from the API. */
export class AtlasSignInError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AtlasSignInError';
  }
}

export async function getSignInUrl(options: GetSignInUrlOptions): Promise<SignInUrl> {
  if (!options.secretKey) throw new AtlasSignInError('A secret key is required.', 0);
  if (!options.userId) throw new AtlasSignInError('A userId is required.', 0);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = `${(options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')}/v1/testing/sign_in_url`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.secretKey}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      user_id: options.userId,
      redirect_url: options.redirectUrl,
      ...(options.expiresInSeconds !== undefined ? { expires_in_seconds: options.expiresInSeconds } : {}),
    }),
  });
  const data = (await response.json().catch(() => null)) as
    | { url?: unknown; ticket?: unknown; expires_at?: unknown; errors?: Array<{ code?: string; message?: string }> }
    | null;
  if (!response.ok || typeof data?.url !== 'string' || typeof data.ticket !== 'string') {
    const err = data?.errors?.[0];
    throw new AtlasSignInError(
      `Could not mint a sign-in URL (${response.status}${err?.code ? ` ${err.code}` : ''}): ${err?.message ?? 'unexpected response'}`,
      response.status,
      err?.code,
    );
  }
  return { url: data.url, ticket: data.ticket, expiresAt: String(data.expires_at ?? '') };
}
