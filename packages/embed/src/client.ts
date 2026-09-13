import { FapiClient } from '@atlasauth/js';
import type { AppearanceResponse } from './appearance';

/**
 * The widget talks to FAPI cross-origin, so the browser sends a CORS preflight
 * before every non-simple request. A preflight `OPTIONS` carries NO custom
 * headers — the `x-publishable-key` the SDK normally sends is stripped — so the
 * API could not tell WHICH instance the request targets and could not decide
 * whether the page's Origin is allow-listed for it.
 *
 * The fix is to also carry the publishable key in the query string. The
 * preflight is sent to the same URL (query included), so the CORS gate resolves
 * the exact instance and checks THAT instance's `allowedOrigins` — never a
 * cross-tenant guess. The header is still sent on the real request; this only
 * adds the query param the preflight needs.
 */
function widgetFetch(publishableKey: string, base: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input.toString();
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return base(input, init);
    }
    if (!url.searchParams.has('publishable_key')) {
      url.searchParams.set('publishable_key', publishableKey);
    }
    return base(url.toString(), init);
  }) as typeof fetch;
}

export interface WidgetClientOptions {
  publishableKey: string;
  /** The instance's FAPI origin, e.g. `https://accounts.acme.com`. */
  frontendApi: string;
  fetchImpl?: typeof fetch;
}

/** A FAPI client wired for the widget: shared @atlasauth/js driver, pk in the query. */
export function createClient(options: WidgetClientOptions): FapiClient {
  const base = options.fetchImpl ?? fetch;
  return new FapiClient({
    publishableKey: options.publishableKey,
    baseUrl: options.frontendApi.replace(/\/$/, ''),
    fetchImpl: widgetFetch(options.publishableKey, base),
  });
}

/** Fetch the tenant's public appearance + enabled providers/strategies. */
export async function fetchAppearance(client: FapiClient): Promise<AppearanceResponse | null> {
  const response = await client.get<AppearanceResponse>('/v1/appearance');
  return response.ok ? response.data : null;
}
