/**
 * Emailed links, both ends. A mailed link completes nothing by being opened: the
 * opener must prove a tie to the tab that started the flow, or anyone who starts
 * a flow with someone else's address would collect the session when they click.
 *
 *   - Starting tab: the sign-up / sign-in response carries `poll_secret` and
 *     `match_code`. {@link rememberLinkProof} stores the secret for this browser;
 *     the flow shows the code (`FlowState.matchCode`) and polls as usual. An
 *     answer that mailed nothing has a secret and no code: nothing is stored or shown.
 *   - Link page: {@link createEmailLinkConfirmation} checks the link, tries the
 *     stored secret (same browser AND same origin: one click, no typing), and
 *     otherwise asks the person to type the code from the starting tab. Storage is
 *     per origin, so a flow started on another origin always types. The server never sends the
 *     code to this page. A success gives the opener nothing to sign in with: the
 *     starting tab collects the ticket by polling.
 */
import type { FieldError } from './attempt';
import type { FapiClient, FapiResponse } from './fapi';

const storageKey = (attemptId: string) => `atlas_link_${attemptId}`;

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Keep a mailed link's poll secret for this browser. Returns the code to show, or null when no link was mailed. */
export function rememberLinkProof(attemptId: string, response: { poll_secret?: unknown; match_code?: unknown }): string | null {
  const code = typeof response.match_code === 'string' && response.match_code ? response.match_code : null;
  if (code && typeof response.poll_secret === 'string' && response.poll_secret) {
    try {
      storage()?.setItem(storageKey(attemptId), response.poll_secret);
    } catch {
      // Storage full or blocked: the link page falls back to the typed code.
    }
  }
  return code;
}

/** The poll secret this browser holds for an attempt, if it started it. */
export function readLinkSecret(attemptId: string): string | null {
  try {
    return storage()?.getItem(storageKey(attemptId)) ?? null;
  } catch {
    return null;
  }
}

/** Forget an attempt's poll secret (it completed, or the link was confirmed). */
export function forgetLinkSecret(attemptId: string): void {
  try {
    storage()?.removeItem(storageKey(attemptId));
  } catch {
    // Nothing to clean up where storage is blocked.
  }
}

/** Which route a mailed link belongs to: attempt ids don't say. */
export type EmailLinkFlow = 'sign_in' | 'sign_up' | 'password_reset';

/** A mailed link, as its page reads it. */
export interface EmailLink {
  attempt: string;
  token: string;
  /** Default `sign_in`. */
  flow?: EmailLinkFlow;
}

/**
 * The mailed link in a URL (`?attempt=sia_…&token=…`), or null. The id's prefix
 * keeps an app's own `?attempt=&token=` params from being taken for a link.
 */
export function emailLinkFromUrl(href?: string, flow: EmailLinkFlow = 'sign_in'): EmailLink | null {
  const url = href ?? (globalThis as { location?: { href?: string } }).location?.href;
  if (!url) return null;
  try {
    const params = new URL(url).searchParams;
    const attempt = params.get('attempt');
    const token = params.get('token');
    return attempt?.startsWith('sia_') && token ? { attempt, token, flow } : null;
  } catch {
    return null;
  }
}

const verifyPath = (link: EmailLink) =>
  `/v1/client/${link.flow === 'sign_up' ? 'sign_ups' : link.flow === 'password_reset' ? 'password_resets' : 'sign_ins'}/verify`;

/** Whether a mailed link is still live. Spends and completes nothing, so a mail scanner's visit is harmless. Null when refused. */
export async function previewCrossDeviceLink(client: FapiClient, link: EmailLink): Promise<{ requiresConfirmation: boolean } | null> {
  const response = await client.get<{ requires_confirmation?: boolean }>(
    `${verifyPath(link)}?attempt=${encodeURIComponent(link.attempt)}&token=${encodeURIComponent(link.token)}`,
  );
  if (!response.ok || !response.data) return null;
  return { requiresConfirmation: response.data.requires_confirmation === true };
}

/** Exactly one proof: the secret this browser stored, or the code the person typed. */
export type EmailLinkProof = { pollSecret: string; matchCode?: never } | { matchCode: string; pollSecret?: never };

function postConfirmation(client: FapiClient, link: EmailLink & EmailLinkProof): Promise<FapiResponse<{ reset_url?: unknown }>> {
  return client.post(`${verifyPath(link)}/confirm`, {
    attempt: link.attempt,
    token: link.token,
    ...(link.pollSecret ? { poll_secret: link.pollSecret } : { match_code: link.matchCode }),
  });
}

/**
 * Confirm a mailed link. The starting tab's `pollAttempt` then returns the ticket.
 * A wrong code burns the link; a wrong secret does not, so the page can ask for the code.
 */
export async function confirmCrossDeviceLink(client: FapiClient, link: EmailLink & EmailLinkProof): Promise<boolean> {
  return (await postConfirmation(client, link)).ok;
}

export interface EmailLinkConfirmationState {
  /** `checking`, then `confirmed`, `needs_code` (draw the typed input) or `invalid` (the single refusal, for every failure). */
  status: 'checking' | 'needs_code' | 'confirmed' | 'invalid';
  busy: boolean;
  /** Why a typed code could not be checked (rate limit, network). The link is still live. */
  errors: FieldError[];
  /** `confirmed`, a sign-up on an address with an account: where to reset its password. */
  resetUrl?: string;
}

export interface EmailLinkConfirmation {
  readonly state: EmailLinkConfirmationState;
  /** Called after every state change; returns the unsubscribe. */
  subscribe(listener: (state: EmailLinkConfirmationState) => void): () => void;
  /** Check the link and try this browser's secret. Runs once, however often it is called. */
  start(): Promise<void>;
  /** Confirm with the code typed at `needs_code`. */
  submitCode(code: string): Promise<void>;
}

/** The link page's state and requests, independent of any framework. */
export function createEmailLinkConfirmation(client: FapiClient, link: EmailLink): EmailLinkConfirmation {
  let state: EmailLinkConfirmationState = { status: 'checking', busy: false, errors: [] };
  let started = false;
  const listeners = new Set<(s: EmailLinkConfirmationState) => void>();
  const set = (patch: Partial<EmailLinkConfirmationState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };
  const confirmed = (response: FapiResponse<{ reset_url?: unknown }>) => {
    forgetLinkSecret(link.attempt);
    const resetUrl = response.data?.reset_url;
    // Only a page a link can safely go to.
    set({ status: 'confirmed', busy: false, errors: [], ...(typeof resetUrl === 'string' && /^https:\/\//i.test(resetUrl) ? { resetUrl } : {}) });
  };
  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      if (started) return;
      started = true;
      const preview = await previewCrossDeviceLink(client, link);
      if (!preview?.requiresConfirmation) {
        set({ status: 'invalid' });
        return;
      }
      const pollSecret = readLinkSecret(link.attempt);
      if (pollSecret) {
        const response = await postConfirmation(client, { ...link, pollSecret });
        if (response.ok) {
          confirmed(response);
          return;
        }
      }
      set({ status: 'needs_code' });
    },
    async submitCode(code) {
      const matchCode = code.replace(/\s+/g, '');
      // An empty submit must not reach the server: a wrong code burns the link.
      if (state.status !== 'needs_code' || state.busy || !matchCode) return;
      set({ busy: true, errors: [] });
      const response = await postConfirmation(client, { ...link, matchCode });
      if (response.ok) {
        confirmed(response);
      } else if (response.status === 0 || response.status === 429) {
        // Never reached the check, so the link wasn't burned: let them try again.
        set({ busy: false, errors: response.errors });
      } else {
        set({ status: 'invalid', busy: false, errors: [] });
      }
    },
  };
}
