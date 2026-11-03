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
import {
  OAUTH_POPUP_WINDOW_NAME,
  createPopupNonce,
  listenForPopupResult,
} from './popup-channel';

export const REDIRECT_PARAMS = ['__atlas_attempt', '__atlas_ticket', '__atlas_status', '__atlas_policy_token'] as const;

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
  /** With `needs_policy_acceptance`: the one-time token for `acceptAttemptPolicies`. */
  policyToken?: string;
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
  /** With `needs_policy_acceptance`: the one-time token for `acceptAttemptPolicies`. */
  policyToken?: string;
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
  return mapOAuthPopupPayload(data);
}

/**
 * Pure: map one of the Frontend API's `atlas:oauth:*` result payloads (from a
 * `postMessage`, or relayed from a severed popup's landing page) to an outcome,
 * or null when it is not one.
 */
export function mapOAuthPopupPayload(data: unknown): PopupOutcome | null {
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
        ...(str(d.policyToken) ? { policyToken: str(d.policyToken) } : {}),
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
  /**
   * Fired when the popup's link to this page was severed right after opening
   * (this page, or the provider, sends a Cross-Origin-Opener-Policy): the popup
   * still works, but closing it can no longer be noticed, so the flow keeps
   * waiting — up to 5 minutes — for its result. A good moment to show "Finish
   * signing in in the popup window" with a cancel button that aborts `signal`.
   */
  onSevered?: () => void;
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
  /** True when the popup's opener link was severed (see `onSevered`). */
  severed?: boolean;
}

/** Input to {@link startOauthPopup}. */
export interface OAuthPopupInput {
  provider: string;
  /**
   * Where the redirect flow would return to — normally the current page. A
   * popup whose opener link is severed lands back here (result in the
   * fragment), so it should be a page on THIS origin that runs the SDK.
   */
  redirectUrl: string;
  /** Abort to give up on the popup (settles as `popup_closed`). */
  signal?: AbortSignal;
}

/** `popup.closed` this soon after opening means the opener link was severed, not a user close. */
export const POPUP_SEVERED_WINDOW_MS = 1_500;
/** How long a severed popup is waited for before it counts as cancelled. */
export const POPUP_SEVERED_TIMEOUT_MS = 5 * 60_000;
/** Back-off between session probes while a severed popup is pending. */
const SEVERED_PROBE_DELAYS_MS = [2_000, 3_000, 5_000, 8_000, 13_000, 21_000, 30_000];

function centeredPopupFeatures(w: number, h: number): string {
  const dualLeft = (window.screenLeft ?? window.screenX ?? 0) as number;
  const dualTop = (window.screenTop ?? window.screenY ?? 0) as number;
  const vw = window.outerWidth || document.documentElement.clientWidth || w;
  const vh = window.outerHeight || document.documentElement.clientHeight || h;
  const left = Math.max(0, dualLeft + (vw - w) / 2);
  const top = Math.max(0, dualTop + (vh - h) / 2);
  return `popup,width=${w},height=${h},left=${Math.round(left)},top=${Math.round(top)}`;
}

/** The popup flow currently waiting in this page; a new one supersedes it. */
let cancelActivePopup: (() => void) | null = null;

/**
 * Start a POPUP OAuth sign-in (GSI-style). Opens the provider authorize URL in a
 * popup and resolves when the callback posts back the one-time ticket (complete),
 * an error, or a continuation. Falls back to a full redirect when the popup is
 * blocked — resolves `{ blocked:true, authorizationUrl }` and the caller
 * navigates there, so it is always safe to enable. Browser-only.
 *
 * The result arrives by `postMessage` from the Frontend API, or — when a
 * Cross-Origin-Opener-Policy severed the popup from this page — relayed over
 * `BroadcastChannel('atlas:oauth:<nonce>')` by the SDK on the page the popup
 * lands on (see ./popup-channel). Cancel semantics:
 *   - the popup closes after the first {@link POPUP_SEVERED_WINDOW_MS}: the user
 *     closed it — one final session probe, then `popup_closed`;
 *   - `popup.closed` reads true within that window: the link was severed (the
 *     popup is very much open). Keep waiting for the relayed result, probing
 *     the session with back-off, and settle as `popup_closed` only after
 *     {@link POPUP_SEVERED_TIMEOUT_MS}, an explicit error/cancel result,
 *     `input.signal` aborting, or a newer popup flow starting.
 */
export async function startOauthPopup(
  client: FapiClient,
  input: OAuthPopupInput,
  handlers: OAuthPopupHandlers = {},
): Promise<PopupStartResult> {
  const nonce = createPopupNonce();
  const res = await client.post<{ authorization_url?: string }>('/v1/client/sign_ins/oauth', {
    provider: input.provider,
    redirect_url: input.redirectUrl,
    mode: 'popup',
    popup_nonce: nonce,
    opener_origin: window.location.origin,
  });
  const authorizationUrl = res.ok ? res.data?.authorization_url : undefined;
  if (!authorizationUrl) return { error: 'start_failed' };

  const expectedOrigin = client.frontendApiOrigin || window.location.origin;

  let popup: Window | null = null;
  try {
    popup = window.open(authorizationUrl, OAUTH_POPUP_WINDOW_NAME, centeredPopupFeatures(500, 650));
  } catch {
    popup = null;
  }
  if (!popup) {
    handlers.onBlockedFallback?.(authorizationUrl);
    return { blocked: true, authorizationUrl };
  }
  const openedAt = Date.now();
  handlers.onOpen?.();
  // Only one popup flow at a time: starting another cancels the one waiting.
  cancelActivePopup?.();

  return await new Promise<PopupStartResult>((resolve) => {
    let done = false;
    let severed = false;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => settle({ error: 'popup_closed' });
    const settle = (r: PopupStartResult) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
      clearTimeout(probeTimer);
      clearTimeout(deadline);
      stopListening();
      input.signal?.removeEventListener('abort', cancel);
      if (cancelActivePopup === cancel) cancelActivePopup = null;
      try {
        if (popup && !popup.closed) popup.close();
      } catch {
        /* cross-origin close can throw; ignore */
      }
      resolve(severed ? { ...r, severed: true } : r);
    };
    const deliver = (outcome: PopupOutcome) => {
      if (done) return;
      if (outcome.ticket) handlers.onComplete?.({ ticket: outcome.ticket, attemptId: outcome.attemptId });
      if (outcome.error) handlers.onError?.(outcome.error);
      settle(outcome);
    };
    const onMessage = (ev: MessageEvent) => {
      const outcome = parseOAuthPopupMessage(ev.origin, expectedOrigin, ev.data);
      if (outcome) deliver(outcome);
    };
    // A probe that finds a session settles; otherwise `onMiss` decides.
    const probe = (onMiss: () => void) => {
      if (done) return;
      void probeSession(client).then((signedIn) => {
        if (done) return;
        if (signedIn) settle({ error: 'popup_closed', sessionDetected: true });
        else onMiss();
      });
    };
    const scheduleProbe = (attempt: number) => {
      const delay = SEVERED_PROBE_DELAYS_MS[Math.min(attempt, SEVERED_PROBE_DELAYS_MS.length - 1)]!;
      probeTimer = setTimeout(() => probe(() => scheduleProbe(attempt + 1)), delay);
    };
    const stopListening = listenForPopupResult(nonce, {
      onResult: (payload) => {
        const outcome = mapOAuthPopupPayload(payload);
        if (outcome) deliver(outcome);
      },
      // A page in the popup finished the sign-in itself: check now.
      onSignedIn: () => probe(() => undefined),
    });
    // The user closing the popup without finishing is a cancellation, not a hang.
    // But `popup.closed` turning true right after opening is not a close: the
    // opener link was severed (Cross-Origin-Opener-Policy) and the popup is
    // still on screen. Then wait for the relayed result instead.
    const timer = setInterval(() => {
      if (!popup || !popup.closed || done) return;
      clearInterval(timer);
      if (Date.now() - openedAt <= POPUP_SEVERED_WINDOW_MS) {
        severed = true;
        handlers.onSevered?.();
        deadline = setTimeout(cancel, POPUP_SEVERED_TIMEOUT_MS);
        scheduleProbe(0);
        return;
      }
      // A real close. It can still follow a sign-in the popup finished on its
      // own (an opener the browser severed later, mid-flow), so check the
      // session once before calling it a cancel.
      probe(cancel);
    }, 250);
    window.addEventListener('message', onMessage);
    input.signal?.addEventListener('abort', cancel);
    if (input.signal?.aborted) cancel();
    cancelActivePopup = cancel;
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

  const policyToken = params.get('__atlas_policy_token');
  return {
    attemptId,
    ...(ticket ? { ticket } : {}),
    ...(status ? { status } : {}),
    ...((status === 'needs_policy_acceptance' || status === 'needs_required_action') && policyToken ? { policyToken } : {}),
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
