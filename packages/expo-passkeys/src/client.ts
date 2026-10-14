import { FapiClient, resolveFrontendApi } from '@atlasauth/js';

/**
 * How a helper reaches an Atlas instance. The begin/finish FAPI calls run from
 * the device, so — unlike the web, where a cookie carries the session — the
 * app's session token (for the signed-in `me` routes) rides in an
 * `Authorization: Bearer` header. `getToken` is optional: a sign-in ceremony has
 * no session yet, a register ceremony does.
 */
export interface AtlasFapiConfig {
  /** The instance's FAPI origin, e.g. `https://fapi.acme.atlasauth.net`. */
  frontendApi: string;
  /** The publishable key — sent as `x-publishable-key` on every request. */
  publishableKey: string;
  /** The current session token, for authenticated (`/me/*`) routes. */
  getToken?: () => string | null | Promise<string | null>;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Build a bearer-authenticated `@atlasauth/js` FapiClient from the config. */
export function createFapiClient(config: AtlasFapiConfig): FapiClient {
  // A native app has no origin of its own: a missing value, "same-origin" or a
  // bare path throws an `AtlasConfigError` instead of producing relative URLs.
  const baseUrl = resolveFrontendApi(config.frontendApi, {
    component: 'createFapiClient()',
    allowSameOrigin: false,
  });
  const base = config.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const token = config.getToken ? await config.getToken() : null;
    if (token) headers.set('authorization', `Bearer ${token}`);
    return base(input, { ...init, headers });
  };
  return new FapiClient({
    publishableKey: config.publishableKey,
    baseUrl,
    fetchImpl,
  });
}
