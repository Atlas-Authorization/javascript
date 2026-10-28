/**
 * Bring-your-own login and consent pages. Atlas sends the browser to your page
 * with `?login_challenge=` or `?consent_challenge=`. Reading, accepting and
 * rejecting the challenge needs a secret key, so your page talks to YOUR
 * backend (see `delegatedUiProxy` in @atlasauth/backend), and then follows the
 * `redirect_to` Atlas returned.
 */

export type DelegatedChallenge = { type: 'login' | 'consent'; challenge: string };

/** The challenge on the current page URL, or null when the page was not reached from Atlas. */
export function readDelegatedChallenge(href: string | URL | { href: string }): DelegatedChallenge | null {
  const url = new URL(typeof href === 'string' ? href : href instanceof URL ? href.href : href.href);
  const login = url.searchParams.get('login_challenge');
  if (login) return { type: 'login', challenge: login };
  const consent = url.searchParams.get('consent_challenge');
  return consent ? { type: 'consent', challenge: consent } : null;
}

export interface DelegatedLoginRequest {
  client: { id: string; client_id: string; name: string };
  requested_scope: string[];
  audience: string | null;
  page: 'sign-in' | 'sign-up';
  session_subject: string | null;
  ui_locales: string | null;
  login_hint: string | null;
  expires_at: number;
}
export interface DelegatedConsentRequest {
  subject: string;
  client: { id: string; client_id: string; name: string; first_party?: boolean };
  requested_scope: string[];
  audience: string | null;
  authorization_details: unknown[];
  organization_id: string | null;
  redirect_uri: string;
  expires_at: number;
}

export interface DelegatedUiClientOptions {
  /** Base URL of your backend routes that proxy the Atlas calls, e.g. `/atlas/oauth`. */
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

/**
 * Calls your backend's proxy routes (`GET {baseUrl}/login`, `POST {baseUrl}/login/accept`, …),
 * each taking the challenge as a query parameter. Errors throw with the server's message.
 */
export function createDelegatedUiClient(opts: DelegatedUiClientOptions) {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = opts.baseUrl.replace(/\/$/, '');
  async function call<T>(method: 'GET' | 'POST', path: string, kind: 'login' | 'consent', challenge: string, body?: unknown): Promise<T> {
    const res = await f(`${base}/${path}?${kind}_challenge=${encodeURIComponent(challenge)}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as { message?: string; error?: { message?: string } } & T;
    if (!res.ok) throw new Error(json.error?.message ?? json.message ?? `Request failed (${res.status}).`);
    return json;
  }
  return {
    getLoginRequest: (challenge: string) => call<DelegatedLoginRequest>('GET', 'login', 'login', challenge),
    /** `subject` is the Atlas user id your backend authenticated the visitor as. */
    acceptLogin: (challenge: string, body: { subject: string; remember?: boolean; amr?: string[]; acr?: string }) =>
      call<{ redirect_to: string }>('POST', 'login/accept', 'login', challenge, body),
    rejectLogin: (challenge: string, body: { error?: string; error_description?: string } = {}) =>
      call<{ redirect_to: string }>('POST', 'login/reject', 'login', challenge, body),
    getConsentRequest: (challenge: string) => call<DelegatedConsentRequest>('GET', 'consent', 'consent', challenge),
    acceptConsent: (challenge: string, body: { grant_scope?: string[]; remember?: boolean } = {}) =>
      call<{ redirect_to: string }>('POST', 'consent/accept', 'consent', challenge, body),
    rejectConsent: (challenge: string, body: { error?: string; error_description?: string } = {}) =>
      call<{ redirect_to: string }>('POST', 'consent/reject', 'consent', challenge, body),
  };
}

/**
 * Send the browser on to the `redirect_to` Atlas returned. Refuses anything that
 * is not https (or an allowed origin), so a tampered response cannot redirect elsewhere.
 */
export function continueDelegatedFlow(
  redirectTo: string,
  opts: { allowedOrigins?: string[]; navigate?: (url: string) => void } = {},
): void {
  const url = new URL(redirectTo);
  const ok = opts.allowedOrigins ? opts.allowedOrigins.includes(url.origin) : url.protocol === 'https:';
  if (!ok) throw new Error('Refusing to follow an unexpected redirect.');
  (opts.navigate ?? ((u: string) => window.location.assign(u)))(url.toString());
}
