/**
 * §oauth popup mode — the same-origin hand-back for a popup whose
 * `window.opener` was severed.
 *
 * When the page that opens the sign-in popup sends a restrictive
 * Cross-Origin-Opener-Policy (`same-origin`), the browser puts the cross-origin
 * popup in another browsing-context group: `popup.closed` reads `true` to the
 * opener almost at once and `window.opener` is `null` inside the popup, so the
 * Frontend API's `postMessage` can never arrive. The Frontend API then sends the
 * popup back to the OPENER's own page with the result in the URL fragment
 * (`#atlas_popup_result=…`, never the query). That page runs the SDK, which:
 *
 *   1. reads and scrubs the fragment ({@link completeOAuthPopupLanding}),
 *   2. relays the result to the opener over
 *      `BroadcastChannel('atlas:oauth:<nonce>')` (a `localStorage` `storage`
 *      event where BroadcastChannel is missing) — both are same-origin, so
 *      they connect where `window.opener` cannot,
 *   3. closes the popup once the opener acknowledges.
 *
 * Nothing here carries a token: the result is the same one-time ticket (or
 * continuation) the redirect flow puts in its URL, and the opener exchanges it.
 */

import { broadcastChannel, storageChannel, type Channel } from './tab-election';

/** The window name {@link startOauthPopup} opens the popup with. */
export const OAUTH_POPUP_WINDOW_NAME = 'atlas:oauth';
/** The fragment key the Frontend API lands the popup result in. */
export const POPUP_RESULT_FRAGMENT = 'atlas_popup_result';
/** The channel a page that finished sign-in inside the popup announces on. */
export const POPUP_SIGNAL_CHANNEL = 'atlas:oauth';

/** The per-flow channel: `atlas:oauth:<nonce>`. */
export function popupChannelName(nonce: string): string {
  return `${POPUP_SIGNAL_CHANNEL}:${nonce}`;
}

/** A fresh base64url channel nonce (22 characters). */
export function createPopupNonce(): string {
  const bytes = new Uint8Array(16);
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The messages on the popup channels. */
export type PopupRelayMessage =
  | { type: 'atlas:oauth:result'; id: string; result: Record<string, unknown> }
  | { type: 'atlas:oauth:signed_in'; id: string }
  | { type: 'atlas:oauth:ack'; id: string };

function isRelayMessage(value: unknown): value is PopupRelayMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as { type?: unknown; id?: unknown; result?: unknown };
  if (typeof m.id !== 'string') return false;
  if (m.type === 'atlas:oauth:result') return !!m.result && typeof m.result === 'object';
  return m.type === 'atlas:oauth:signed_in' || m.type === 'atlas:oauth:ack';
}

function openChannel(name: string): Channel | null {
  try {
    return broadcastChannel(name) ?? storageChannel(name);
  } catch {
    return null;
  }
}

/**
 * Post `message` on `name` and resolve whether anyone acknowledged it within
 * `timeoutMs`.
 */
function relay(
  name: string,
  message: { type: 'atlas:oauth:result'; result: Record<string, unknown> } | { type: 'atlas:oauth:signed_in' },
  timeoutMs: number,
): Promise<boolean> {
  const channel = openChannel(name);
  if (!channel) return Promise.resolve(false);
  const id = createPopupNonce();
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (acked: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      channel.close();
      resolve(acked);
    };
    const unsubscribe = channel.subscribe((m) => {
      if (isRelayMessage(m) && m.type === 'atlas:oauth:ack' && m.id === id) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      channel.post({ ...message, id });
    } catch {
      finish(false);
    }
  });
}

/**
 * Opener side: listen on the flow's channel (and the shared signal channel) for
 * the popup's result. Every message is acknowledged so the popup can close.
 * Returns the stop function.
 */
export function listenForPopupResult(
  nonce: string,
  handlers: {
    /** The landing page relayed the Frontend API's result payload. */
    onResult: (payload: Record<string, unknown>) => void;
    /** A page in the popup finished the sign-in itself (cookies are set). */
    onSignedIn?: () => void;
  },
): () => void {
  const flow = openChannel(popupChannelName(nonce));
  const signal = handlers.onSignedIn ? openChannel(POPUP_SIGNAL_CHANNEL) : null;
  const unsubscribers: (() => void)[] = [];
  if (flow) {
    unsubscribers.push(
      flow.subscribe((m) => {
        if (!isRelayMessage(m) || m.type !== 'atlas:oauth:result') return;
        flow.post({ type: 'atlas:oauth:ack', id: m.id });
        handlers.onResult(m.result);
      }),
    );
  }
  if (signal) {
    unsubscribers.push(
      signal.subscribe((m) => {
        if (!isRelayMessage(m) || m.type !== 'atlas:oauth:signed_in') return;
        signal.post({ type: 'atlas:oauth:ack', id: m.id });
        handlers.onSignedIn?.();
      }),
    );
  }
  return () => {
    for (const u of unsubscribers) u();
    flow?.close();
    signal?.close();
  };
}

/** The popup result the Frontend API put in a URL fragment, or null. */
export function readPopupLanding(
  hash: string,
): { nonce: string; payload: Record<string, unknown> } | null {
  if (!hash || hash.length < 2) return null;
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get(POPUP_RESULT_FRAGMENT);
  if (!raw) return null;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    if (p.v !== 1 || typeof p.n !== 'string' || !p.n) return null;
    if (typeof p.type !== 'string' || !p.type.startsWith('atlas:oauth:')) return null;
    return { nonce: p.n, payload: p };
  } catch {
    return null;
  }
}

/** What {@link completeOAuthPopupLanding} did with a landed popup result. */
export interface PopupLanding {
  /** The Frontend API's result payload (`type`, `ticket`, `attemptId`, …). */
  payload: Record<string, unknown>;
  /**
   * True when the opener acknowledged the result: it completes the sign-in and
   * this window is being closed. False when nobody was listening (the opener tab
   * was closed, or is on another origin) — the caller should complete the
   * sign-in on this page instead, exactly like a redirect.
   */
  delivered: boolean;
}

/**
 * Popup side, run on startup: if this page is the landing of a severed popup
 * (`#atlas_popup_result=…` in the URL — normally with `window.name ===
 * 'atlas:oauth'`, though a browser may clear the name when the opener's COOP
 * switched browsing-context groups, so the fragment alone is decisive), scrub
 * the fragment, relay the result to the opener and close this window once the
 * opener acknowledges. Returns null when this is not such a landing.
 */
export async function completeOAuthPopupLanding(
  options: { win?: Window; ackTimeoutMs?: number } = {},
): Promise<PopupLanding | null> {
  const win = options.win ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win) return null;
  const landing = readPopupLanding(win.location.hash);
  if (!landing) return null;
  // Scrub first: a reload, the back button or a copied URL must never replay it.
  try {
    win.history.replaceState(win.history.state, '', win.location.href.split('#')[0]);
  } catch {
    /* a sandboxed history; the ticket is single-use regardless */
  }
  // We ARE the Atlas popup, whatever the browser did to the name.
  try {
    win.name = OAUTH_POPUP_WINDOW_NAME;
  } catch {
    /* ignore */
  }
  const delivered = await relay(
    popupChannelName(landing.nonce),
    { type: 'atlas:oauth:result', result: landing.payload },
    options.ackTimeoutMs ?? 1_500,
  );
  if (delivered) closeWindow(win);
  return { payload: landing.payload, delivered };
}

/**
 * Popup side, after a sign-in completed ON this page (the redirect flow ran in
 * the popup — e.g. an SDK or provider path without the channel): when this is
 * the Atlas popup window, tell the waiting opener and close. It closes only when
 * an opener is there to take over (it acknowledged, or `window.opener` is live),
 * never stranding a user whose opener tab is gone. Resolves whether it closed.
 */
export async function closeOAuthPopupAfterSignIn(
  options: { win?: Window; ackTimeoutMs?: number } = {},
): Promise<boolean> {
  const win = options.win ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win || win.name !== OAUTH_POPUP_WINDOW_NAME) return false;
  const acked = await relay(POPUP_SIGNAL_CHANNEL, { type: 'atlas:oauth:signed_in' }, options.ackTimeoutMs ?? 1_500);
  let hasOpener = false;
  try {
    hasOpener = !!win.opener && !win.opener.closed;
  } catch {
    hasOpener = false;
  }
  if (!acked && !hasOpener) return false;
  closeWindow(win);
  return true;
}

function closeWindow(win: Window): void {
  try {
    win.close();
  } catch {
    /* the browser refused; nothing else to do */
  }
}
