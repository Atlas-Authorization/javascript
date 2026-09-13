/**
 * §5.6 Step-up re-authentication.
 *
 * A signed-in user re-proves a credential to refresh the "recent sign-in"
 * window IN PLACE — no sign-out, no new session — so the app can immediately
 * perform a security-sensitive action (changing 2FA) that requires it. This is
 * the SDK call a frontend makes when a step-up-gated request returns
 * `STEP_UP_REQUIRED`; retry the original action after it resolves.
 */

export type ReauthInput =
  | { strategy: 'password'; password: string }
  | { strategy: 'id_token'; provider: string; idToken: string };

export interface ReauthOptions {
  /** FAPI base, e.g. 'https://accounts.acme.com' or '' for same-origin. */
  api: string;
  publishableKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * Re-authenticate the current session. Resolves on success; throws with the
 * server's message (and a `.code`) on failure — `STEP_UP_REQUIRED` cannot recur
 * here, but a wrong password surfaces as a 401.
 */
export async function reauthenticate(input: ReauthInput, opts: ReauthOptions): Promise<void> {
  const body =
    input.strategy === 'password'
      ? { strategy: 'password', password: input.password }
      : { strategy: 'id_token', provider: input.provider, id_token: input.idToken };

  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.api}/v1/client/me/reauthenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-publishable-key': opts.publishableKey },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = 'Re-authentication failed.';
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
}
