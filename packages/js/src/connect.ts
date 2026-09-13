/**
 * §6.6 Connect a NEW OAuth provider to the signed-in user.
 *
 * This is the SDK call behind a customer's OWN "Connect GitHub" button in their
 * settings page — no Atlas widget, no panel. It starts the provider OAuth link
 * flow and resolves with the `authorizationUrl` to send the browser to. On the
 * customer's `redirectUrl` the provider returns with `?__atlas_status=connected`
 * (or `error`), which {@link readRedirectResult} parses.
 *
 * The link is bound to the CURRENT session's user, so — unlike a sign-in — it
 * never creates a new account or session, never resolves an identity by email,
 * and is unaffected by the account-linking `block` policy (the user is already
 * authenticated and explicitly linking). Requires the browser session cookie, so
 * the request is sent with credentials.
 */

export interface ConnectOptions {
  /** FAPI base, e.g. 'https://accounts.acme.com' or '' for same-origin. */
  api: string;
  publishableKey: string;
  /**
   * Where the provider returns after the user authorizes — must be one of the
   * instance's allowed origins. Read the outcome there with `readRedirectResult`.
   */
  redirectUrl: string;
  /** Extra provider scopes on top of the provider's defaults. */
  additionalScopes?: string[];
  fetchImpl?: typeof fetch;
}

export interface ConnectStart {
  provider: string;
  attemptId: string;
  /** Navigate the browser here to let the user authorize the provider. */
  authorizationUrl: string;
  /** The scopes the connect will request (provider defaults ∪ additionalScopes). */
  scopes: string[];
}

/**
 * Begin linking `provider` to the signed-in user. Resolves with the provider
 * authorize URL to navigate to; throws with the server's message (and a `.code`,
 * e.g. `IDENTITY_ALREADY_LINKED`) on failure. Use {@link startConnect} if you
 * just want it to redirect for you.
 */
export async function connectExternalAccount(
  provider: string,
  opts: ConnectOptions,
): Promise<ConnectStart> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.api}/v1/client/me/external_accounts/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-publishable-key': opts.publishableKey },
    credentials: 'include',
    body: JSON.stringify({
      provider,
      redirect_url: opts.redirectUrl,
      additional_scopes: opts.additionalScopes,
    }),
  });

  if (!res.ok) {
    let message = 'Could not start connecting that provider.';
    let code: string | undefined;
    try {
      const parsed = (await res.json()) as { errors?: { message?: string; code?: string }[] };
      message = parsed.errors?.[0]?.message ?? message;
      code = parsed.errors?.[0]?.code;
    } catch {
      /* keep the default */
    }
    const err = new Error(message);
    (err as { code?: string }).code = code;
    throw err;
  }

  const data = (await res.json()) as {
    provider: string;
    attempt_id: string;
    authorization_url: string;
    scopes?: string[];
  };
  return {
    provider: data.provider,
    attemptId: data.attempt_id,
    authorizationUrl: data.authorization_url,
    scopes: data.scopes ?? [],
  };
}

/**
 * Convenience wrapper: start the connection AND navigate the browser to the
 * provider. A settings-page button handler can be just:
 *
 *   onClick={() => startConnect('github', { api, publishableKey, redirectUrl })}
 */
export async function startConnect(provider: string, opts: ConnectOptions): Promise<void> {
  const { authorizationUrl } = await connectExternalAccount(provider, opts);
  if (typeof window !== 'undefined') window.location.assign(authorizationUrl);
}
