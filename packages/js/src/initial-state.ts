/**
 * The public, per-instance data a sign-in panel needs before it can paint: the
 * dashboard design and sign-in settings (`GET /v1/appearance`) and the enabled
 * sign-in methods and social buttons (`GET /v1/client/environment`).
 *
 * Fetched on the SERVER and handed to the provider (`initialState`), the panel
 * renders fully styled, with its social buttons, in the first HTML — no
 * round trips from the browser before it looks right. Both responses are public
 * and identical for every visitor of an instance, so they cache well.
 *
 * Never throws: a part that can't be fetched is left out and the browser fetches
 * it as before, so a slow or unreachable API can't break the page render.
 */

export interface AtlasInitialState {
  /** The raw `GET /v1/appearance` body. */
  appearance?: unknown;
  /** The raw `GET /v1/client/environment` body. */
  environment?: unknown;
}

export interface FetchInitialStateOptions {
  publishableKey: string;
  /** The Frontend API origin, e.g. `https://auth.example.com`. */
  frontendApi: string;
  /** Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Extra `fetch` options for both requests — e.g. `{ next: { revalidate: 60 } }`
   * on Next.js to cache them between renders.
   */
  init?: RequestInit & Record<string, unknown>;
  /** Give up on a request after this long and leave it to the browser. Default 1500 ms. */
  timeoutMs?: number;
}

export async function fetchAtlasInitialState(options: FetchInitialStateOptions): Promise<AtlasInitialState> {
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch || !options.publishableKey || !options.frontendApi) return {};
  const base = options.frontendApi.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 1500;

  const get = async (path: string): Promise<unknown> => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(`${base}${path}`, {
        ...options.init,
        method: 'GET',
        headers: { accept: 'application/json', 'x-publishable-key': options.publishableKey },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) return undefined;
      return (await res.json()) as unknown;
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const [appearance, environment] = await Promise.all([get('/v1/appearance'), get('/v1/client/environment')]);
  const state: AtlasInitialState = {};
  if (appearance && typeof appearance === 'object') state.appearance = appearance;
  if (environment && typeof environment === 'object') state.environment = environment;
  return state;
}
