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

import type { FapiClient } from './fapi';

export const REDIRECT_PARAMS = ['__atlas_attempt', '__atlas_ticket', '__atlas_status'] as const;

/**
 * Start a redirect-based OAuth sign-in for a provider that has no in-page native
 * flow (GitHub, Microsoft, Discord, …). Returns the provider authorization URL to
 * navigate to; the provider redirects back to `redirectUrl` with the params
 * {@link readRedirectResult} parses. A `native:true` provider (Google/Apple/FB
 * Limited Login) should use the in-page id_token flow instead — no redirect, no
 * stranded tab. Returns null if the start failed.
 */
export async function startOauthRedirect(
  client: FapiClient,
  input: { provider: string; redirectUrl: string },
): Promise<{ authorizationUrl: string } | null> {
  const res = await client.post<{ authorization_url?: string }>('/v1/client/sign_ins/oauth', {
    provider: input.provider,
    redirect_url: input.redirectUrl,
  });
  const url = res.ok ? res.data?.authorization_url : undefined;
  return url ? { authorizationUrl: url } : null;
}

export interface RedirectResult {
  attemptId: string;
  /** Present only when the sign-in completed — exchange it for cookies. */
  ticket?: string;
  /** Present when a step remains (e.g. `needs_second_factor`); no session yet. */
  status?: string;
}

/**
 * §oauth popup mode — the same one-time-ticket contract as the redirect flow,
 * delivered by `postMessage` from the callback popup instead of URL params.
 */
export interface PopupOutcome {
  attemptId?: string;
  /** Present only when the sign-in completed — exchange it for cookies. */
  ticket?: string;
  /** Present for a remaining step / connect (no session yet). */
  status?: string;
  /** Present when the provider/flow errored (e.g. the user cancelled). */
  error?: string;
  /** Where the opener should navigate for a non-complete outcome. */
  continuationUrl?: string;
}

/**
 * Pure: validate a `message` event and map it to an outcome, or null to ignore.
 *
 * Ignores any message whose origin isn't the exact FAPI origin we opened, and
 * any payload that isn't one of our `atlas:oauth:*` shapes — so an unrelated
 * `postMessage` on the page can never drive the flow.
 */
export function parseOAuthPopupMessage(
  eventOrigin: string,
  expectedOrigin: string,
  data: unknown,
): PopupOutcome | null {
  if (eventOrigin !== expectedOrigin) return null;
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  switch (d.type) {
    case 'atlas:oauth:complete':
      return { ticket: str(d.ticket), attemptId: str(d.attemptId) };
    case 'atlas:oauth:error':
      return { error: str(d.code) ?? 'error', continuationUrl: str(d.continuationUrl) };
    case 'atlas:oauth:continue':
      return {
        status: str(d.status),
        attemptId: str(d.attemptId),
        continuationUrl: str(d.continuationUrl),
      };
    default:
      return null;
  }
}

export interface OAuthPopupHandlers {
  onOpen?: () => void;
  onComplete?: (r: { ticket?: string; attemptId?: string }) => void;
  onError?: (code: string) => void;
  /** Fired when the popup couldn't open; the caller should navigate to the URL. */
  onBlockedFallback?: (authorizationUrl: string) => void;
}

export interface PopupStartResult extends PopupOutcome {
  /** True when the popup was blocked — the caller falls back to a full redirect. */
  blocked?: boolean;
  authorizationUrl?: string;
  /**
   * Set (with `error: 'popup_closed'`) when the popup closed without posting a
   * result but the Frontend API now reports a signed-in session — e.g. the
   * browser severed `window.opener`, so the popup finished the sign-in itself.
   * The caller should re-boot its session state rather than treat it as a
   * cancel.
   */
  sessionDetected?: boolean;
}

function centeredPopupFeatures(w: number, h: number): string {
  const dualLeft = (window.screenLeft ?? window.screenX ?? 0) as number;
  const dualTop = (window.screenTop ?? window.screenY ?? 0) as number;
  const vw = window.outerWidth || document.documentElement.clientWidth || w;
  const vh = window.outerHeight || document.documentElement.clientHeight || h;
  const left = Math.max(0, dualLeft + (vw - w) / 2);
  const top = Math.max(0, dualTop + (vh - h) / 2);
  return `popup,width=${w},height=${h},left=${Math.round(left)},top=${Math.round(top)}`;
}

/**
 * Start a POPUP OAuth sign-in (GSI-style). Opens the provider authorize URL in a
 * popup and resolves when the callback posts back the one-time ticket (complete),
 * an error, or a continuation. Falls back to a full redirect when the popup is
 * blocked — resolves `{ blocked:true, authorizationUrl }` and the caller
 * navigates there, so it is always safe to enable. Browser-only.
 */
export async function startOauthPopup(
  client: FapiClient,
  input: { provider: string; redirectUrl: string },
  handlers: OAuthPopupHandlers = {},
): Promise<PopupStartResult> {
  const res = await client.post<{ authorization_url?: string }>('/v1/client/sign_ins/oauth', {
    provider: input.provider,
    redirect_url: input.redirectUrl,
    mode: 'popup',
  });
  const authorizationUrl = res.ok ? res.data?.authorization_url : undefined;
  if (!authorizationUrl) return { error: 'start_failed' };

  const expectedOrigin = client.frontendApiOrigin || window.location.origin;

  let popup: Window | null = null;
  try {
    popup = window.open(authorizationUrl, 'atlas:oauth', centeredPopupFeatures(500, 650));
  } catch {
    popup = null;
  }
  if (!popup) {
    handlers.onBlockedFallback?.(authorizationUrl);
    return { blocked: true, authorizationUrl };
  }
  handlers.onOpen?.();

  return await new Promise<PopupStartResult>((resolve) => {
    let done = false;
    const settle = (r: PopupStartResult) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
      try {
        if (popup && !popup.closed) popup.close();
      } catch {
        /* cross-origin close can throw; ignore */
      }
      resolve(r);
    };
    const onMessage = (ev: MessageEvent) => {
      const outcome = parseOAuthPopupMessage(ev.origin, expectedOrigin, ev.data);
      if (!outcome) return;
      if (outcome.ticket) handlers.onComplete?.({ ticket: outcome.ticket, attemptId: outcome.attemptId });
      if (outcome.error) handlers.onError?.(outcome.error);
      settle(outcome);
    };
    // The user closing the popup without finishing is a cancellation, not a hang.
    // But a popup can also close (or look closed to us) after completing the
    // sign-in itself: when a browser severs `window.opener` (a Cross-Origin-
    // Opener-Policy on some hop, a privacy feature), the callback page cannot
    // post back and finishes via the ordinary redirect instead, which sets the
    // session cookies. So check the session once before calling it a cancel.
    let probing = false;
    const timer = setInterval(() => {
      if (!popup || !popup.closed || probing || done) return;
      probing = true;
      clearInterval(timer);
      void probeSession(client).then((signedIn) =>
        settle(signedIn ? { error: 'popup_closed', sessionDetected: true } : { error: 'popup_closed' }),
      );
    }, 500);
    window.addEventListener('message', onMessage);
  });
}

/** One `GET /v1/client`: is there a signed-in session on this browser now? */
async function probeSession(client: FapiClient): Promise<boolean> {
  try {
    const res = await client.get<{ session?: unknown; user?: unknown }>('/v1/client');
    return Boolean(res.ok && res.data?.session && res.data?.user);
  } catch {
    return false;
  }
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
