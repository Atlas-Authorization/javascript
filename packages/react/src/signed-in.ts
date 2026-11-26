import type { GetTokenOptions } from './active-atlas';

/** What `<SignIn onSignedIn>` / `<SignUp onSignedIn>` receive once this browser holds the session. */
export interface SignedInContext {
  getToken: (options?: GetTokenOptions) => Promise<string | null>;
  /** The session id (`sid` claim); empty if the token carries none. */
  sessionId: string;
  /** The user id (`sub` claim); empty if the token carries none. */
  userId: string;
}

/** The `sid` and `sub` of a session token, for the `onSignedIn` context only (never trusted for a decision). */
export function tokenIds(jwt: string | null): { sid: string; sub: string } {
  try {
    const part = jwt?.split('.')[1];
    if (!part) return { sid: '', sub: '' };
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const c = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { sid?: unknown; sub?: unknown };
    return { sid: typeof c.sid === 'string' ? c.sid : '', sub: typeof c.sub === 'string' ? c.sub : '' };
  } catch {
    return { sid: '', sub: '' };
  }
}

/**
 * `exchange` (POST the token to your route, which must answer 2xx), then `onSignedIn`. `failed` keeps the user on
 * the panel with an error and no navigation; `url` is an `onSignedIn` override of `afterUrl`.
 */
export async function runSignedIn(opts: {
  exchange?: string;
  onSignedIn?: (ctx: SignedInContext) => Promise<string | void>;
  getToken: (options?: GetTokenOptions) => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): Promise<{ failed: boolean; url?: string }> {
  if (!opts.onSignedIn && !opts.exchange) return { failed: false };
  const jwt = await opts.getToken();
  const ids = tokenIds(jwt);
  try {
    if (opts.exchange) {
      const res = await (opts.fetchImpl ?? fetch)(opts.exchange, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
        body: JSON.stringify({ token: jwt }),
      });
      if (!res.ok) throw new Error(`exchange answered ${res.status}`);
    }
    const out = opts.onSignedIn ? await opts.onSignedIn({ getToken: opts.getToken, sessionId: ids.sid, userId: ids.sub }) : undefined;
    return { failed: false, url: typeof out === 'string' && out.trim() ? out : undefined };
  } catch {
    return { failed: true };
  }
}
