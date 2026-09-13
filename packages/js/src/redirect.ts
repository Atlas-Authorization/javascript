/**
 * §6.3 step 3 / §7.1: completing a redirect-based sign-in.
 *
 * OAuth and hosted-page sign-ins finish by redirecting the browser back to the
 * customer's app with params appended to the URL:
 *   - `__atlas_attempt` — the sign-in attempt id (always present)
 *   - `__atlas_ticket`  — a one-time, 60-second ticket to exchange for cookies
 *   - `__atlas_status`  — the attempt status, present when a step REMAINS
 *
 * A ticket means the sign-in is complete and may be turned into a session. A
 * status WITHOUT a ticket (e.g. `needs_second_factor`) means the server
 * deliberately withheld the session because a factor is still owed — the client
 * must not treat that as signed-in. Parsing this is pure and lives here so both
 * the React provider and any custom integration read the exact same contract.
 */

export const REDIRECT_PARAMS = ['__atlas_attempt', '__atlas_ticket', '__atlas_status'] as const;

export interface RedirectResult {
  attemptId: string;
  /** Present only when the sign-in completed — exchange it for cookies. */
  ticket?: string;
  /** Present when a step remains (e.g. `needs_second_factor`); no session yet. */
  status?: string;
}

/**
 * Read Atlas's redirect params from a query string (`window.location.search`).
 *
 * Returns null when this is not an Atlas redirect: an `__atlas_attempt` on its
 * own — with neither a ticket nor a status — is not actionable and is treated
 * as absent, so a stray param cannot put the SDK into a half-state.
 */
export function readRedirectResult(search: string): RedirectResult | null {
  const params = new URLSearchParams(search);
  const attemptId = params.get('__atlas_attempt');
  if (!attemptId) return null;

  const ticket = params.get('__atlas_ticket');
  const status = params.get('__atlas_status');
  if (!ticket && !status) return null;

  return {
    attemptId,
    ...(ticket ? { ticket } : {}),
    ...(status ? { status } : {}),
  };
}

/**
 * Return `href` with every Atlas redirect param removed, leaving the customer's
 * own query intact. Called after handling a redirect so a reload — or a link
 * copied from the address bar — cannot replay a spent ticket or resurrect a
 * stale status.
 */
export function stripRedirectParams(href: string): string {
  const url = new URL(href);
  for (const key of REDIRECT_PARAMS) url.searchParams.delete(key);
  return url.toString();
}
