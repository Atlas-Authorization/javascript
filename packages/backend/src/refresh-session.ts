/**
 * Renew a lapsed `__session` on the server, for a same-site request that still
 * carries the refresh cookie. Calls the Frontend API session boot
 * (`GET {frontendApi}/v1/client`), which mints a fresh session token and its
 * `Set-Cookie` headers. Returns `null` on any failure, including network errors;
 * it never throws.
 */
export interface RefreshSessionOptions {
  /** Origin of your Atlas Frontend API (a custom domain or the instance host). */
  frontendApi: string;
  /** Sent as `x-publishable-key` (needed on the shared Frontend API host). */
  publishableKey?: string;
  fetchImpl?: typeof fetch;
  /** Default 3000. */
  timeoutMs?: number;
}

export interface RefreshedSession {
  token: string;
  /** Raw `Set-Cookie` values to forward to the browser. */
  setCookie: string[];
}

/** Only Atlas's own cookies go to Atlas; the app's other cookies stay home. */
function atlasCookies(header: string): string {
  return header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => /^(__session|__client|__atlas_)/.test(p))
    .join('; ');
}

export async function refreshSessionFromRequest(
  request: { headers: { get(name: string): string | null } },
  options: RefreshSessionOptions,
): Promise<RefreshedSession | null> {
  try {
    const cookie = atlasCookies(request.headers.get('cookie') ?? '');
    if (!/(^|; )__atlas_rt(?:_[a-z0-9]{8})?=[^;]/.test(cookie)) return null;

    const headers: Record<string, string> = { cookie, accept: 'application/json' };
    if (options.publishableKey) headers['x-publishable-key'] = options.publishableKey;
    const ua = request.headers.get('user-agent');
    if (ua) headers['user-agent'] = ua;

    const response = await (options.fetchImpl ?? fetch)(new URL('/v1/client', options.frontendApi).toString(), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { jwt?: unknown };
    if (typeof body.jwt !== 'string' || !body.jwt) return null;

    const h = response.headers as Headers & { getSetCookie?: () => string[] };
    const single = response.headers.get('set-cookie');
    const setCookie = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    return { token: body.jwt, setCookie };
  } catch {
    return null;
  }
}
