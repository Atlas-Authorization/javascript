import { FapiClient } from '@atlasauth/js';
import { ATLAS_BRIDGE_KEY, type AtlasTokenBridge } from './shared';

/**
 * RENDERER-side helper.
 *
 * The renderer talks to Atlas through the same framework-agnostic
 * `@atlasauth/js` `FapiClient` the web SDK uses — there is exactly one
 * implementation of "how an Atlas request is shaped". The renderer only adds the
 * two things it needs that the browser gets for free:
 *
 *   1. Bearer auth. A renderer served from a custom scheme has no cookie against
 *      the FAPI origin, so the session token (fetched over IPC from
 *      `window.atlas`) rides in an `Authorization: Bearer` header instead.
 *   2. Reading the token from the bridge on every request, never capturing it, so
 *      a sign-in / sign-out in another part of the app is always reflected.
 */

/**
 * Read the bridge the preload published on `window.atlas`. Returns null when the
 * preload did not run (or `exposeAtlasBridge` was not called) — the renderer's
 * cue that it is mis-wired, rather than a crash on an undefined global.
 */
export function getAtlasBridge(): AtlasTokenBridge | null {
  const holder = globalThis as { [ATLAS_BRIDGE_KEY]?: AtlasTokenBridge };
  return holder[ATLAS_BRIDGE_KEY] ?? null;
}

/**
 * Wrap a fetch so every request carries the bridged session token as a bearer.
 * The token is read fresh from the bridge on each call.
 */
export function bearerFetch(
  fetchImpl: typeof fetch,
  getToken: () => Promise<string | null>,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = await getToken();
    const headers = new Headers(init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers });
  };
}

export interface CreateAtlasClientOptions {
  publishableKey: string;
  /** The instance's FAPI origin. Empty for same-origin. */
  frontendApi?: string;
  /**
   * The token bridge. Defaults to `window.atlas` (via {@link getAtlasBridge}).
   * Injectable for tests, or when the renderer holds a bridge reference already.
   */
  bridge?: AtlasTokenBridge | null;
  /** Injectable for tests; defaults to the renderer's `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the `@atlasauth/js` `FapiClient` the renderer uses: the shared client,
 * plus bearer auth sourced from the IPC bridge. When no bridge is available the
 * client still works for unauthenticated calls (the bearer is simply omitted).
 */
export function createAtlasClient(options: CreateAtlasClientOptions): FapiClient {
  const bridge = options.bridge === undefined ? getAtlasBridge() : options.bridge;
  const fetchImpl = options.fetchImpl ?? fetch;
  const getToken = (): Promise<string | null> =>
    bridge ? bridge.getToken() : Promise.resolve(null);

  return new FapiClient({
    publishableKey: options.publishableKey,
    baseUrl: options.frontendApi,
    fetchImpl: bearerFetch(fetchImpl, getToken),
  });
}
