/**
 * §6 native / One-Tap sign-in — the client half.
 *
 * The SDK does not make HTTP calls (the app owns fetch + cookies), so this
 * module is two pure helpers for the request/response shape plus a
 * framework-agnostic Google Identity Services loader that resolves a credential
 * id_token. The app posts that to `/v1/client/sign_ins/id_token` and then reads
 * the result exactly like any other attempt (nextStep / a returned ticket).
 */

export interface NativeSignInBody {
  provider: string;
  id_token: string;
  nonce?: string;
}

/** Build the POST body for `/v1/client/sign_ins/id_token`. */
export function nativeSignInBody(input: {
  provider: string;
  idToken: string;
  nonce?: string;
}): NativeSignInBody {
  return {
    provider: input.provider,
    id_token: input.idToken,
    ...(input.nonce ? { nonce: input.nonce } : {}),
  };
}

export interface NativeSignInResult {
  attemptId: string;
  status: string;
  /** Present only when the sign-in completed — exchange it for cookies. */
  ticket?: string;
}

/**
 * Parse the native sign-in response. A `ticket` means complete; a status
 * without a ticket (e.g. `needs_second_factor`) means a factor is still owed —
 * the same contract the redirect flow uses, so callers must not treat it as
 * signed-in.
 */
export function parseNativeSignInResponse(body: unknown): NativeSignInResult | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { id?: unknown; status?: unknown; ticket?: unknown };
  if (typeof b.id !== 'string' || typeof b.status !== 'string') return null;
  return {
    attemptId: b.id,
    status: b.status,
    ...(typeof b.ticket === 'string' ? { ticket: b.ticket } : {}),
  };
}

/* ---- Google Identity Services (One-Tap / GSI) ---------------------------- */

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let gsiLoad: Promise<void> | null = null;

interface GsiId {
  initialize(config: Record<string, unknown>): void;
  prompt(listener?: (notification: unknown) => void): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  cancel(): void;
}
interface GsiHost {
  google?: { accounts?: { id?: GsiId } };
  document: Document;
  ResizeObserver?: typeof ResizeObserver;
}

/** Inject the GSI script once; resolves when it is ready. */
export function loadGoogleIdentityServices(doc: Document): Promise<void> {
  if (gsiLoad) return gsiLoad;
  gsiLoad = new Promise<void>((resolve, reject) => {
    if (doc.querySelector(`script[src="${GSI_SRC}"]`)) {
      resolve();
      return;
    }
    const script = doc.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services.')));
    doc.head.appendChild(script);
  });
  return gsiLoad;
}

/** Reset the one-shot loader (tests). */
export function resetGoogleIdentityServices(): void {
  gsiLoad = null;
}

/**
 * Load GSI and resolve a Google credential (an OIDC id_token) from One-Tap.
 * The nonce, when supplied, is embedded in the credential and MUST be echoed to
 * the server so it can bind the token to this request.
 */
export async function requestGoogleCredential(opts: {
  clientId: string;
  nonce?: string;
  autoSelect?: boolean;
  host?: GsiHost;
}): Promise<string> {
  const host = opts.host ?? (window as unknown as GsiHost);
  await loadGoogleIdentityServices(host.document);
  const id = host.google?.accounts?.id;
  if (!id) throw new Error('Google Identity Services unavailable.');

  return new Promise<string>((resolve, reject) => {
    id.initialize({
      client_id: opts.clientId,
      nonce: opts.nonce,
      auto_select: opts.autoSelect ?? false,
      callback: (response: { credential?: string }) => {
        if (response.credential) resolve(response.credential);
        else reject(new Error('Google returned no credential.'));
      },
    });
    id.prompt();
  });
}

/**
 * Render the official "Sign in with Google" BUTTON into `parent` (and, when
 * `oneTap` is set, also show the One-Tap prompt). Each resolved credential
 * id_token is handed to `onCredential`, which the app posts to
 * /v1/client/sign_ins/id_token. Unlike {@link requestGoogleCredential} this does
 * not resolve once — a button can be clicked repeatedly — so it takes a
 * callback. Framework-agnostic: the caller owns the DOM node and the fetch.
 */
export async function renderGoogleButton(opts: {
  parent: HTMLElement;
  clientId: string;
  nonce?: string;
  onCredential: (idToken: string) => void;
  onError?: (error: Error) => void;
  /** GSI renderButton options (theme, size, text, shape, width…). */
  buttonOptions?: Record<string, unknown>;
  /** Also show the One-Tap prompt above the button. */
  oneTap?: boolean;
  host?: GsiHost;
}): Promise<void> {
  const host = opts.host ?? (window as unknown as GsiHost);
  await loadGoogleIdentityServices(host.document);
  const id = host.google?.accounts?.id;
  if (!id) throw new Error('Google Identity Services unavailable.');

  id.initialize({
    client_id: opts.clientId,
    nonce: opts.nonce,
    callback: (response: { credential?: string }) => {
      if (response.credential) opts.onCredential(response.credential);
      else opts.onError?.(new Error('Google returned no credential.'));
    },
  });
  id.renderButton(
    opts.parent,
    opts.buttonOptions ?? { theme: 'outline', size: 'large', text: 'continue_with', width: 320 },
  );
  if (opts.oneTap) id.prompt();
}

/**
 * Render YOUR uniform button, backed by Google's real (but invisible) GSI button.
 *
 * Google refuses to let you style its button, and One-Tap is FedCM-flaky — so to
 * show your OWN button while still using the secretless id_token flow, you overlay
 * Google's real button, at opacity 0, exactly on top of your styled one. The user
 * sees your button; the click lands on Google's, which mints the id_token. No
 * secret, no redirect.
 *
 * The failure mode people hit is misalignment — the invisible button not covering
 * the visible one, so clicks miss. This guards against it: the overlay fills the
 * wrapper, and a ResizeObserver keeps Google's button width matched to yours so
 * the whole surface stays clickable as the layout changes.
 *
 * `wrapper` is YOUR styled button (or its container); it is made position:relative
 * if it is not already positioned. Returns `{ destroy }` to tear the overlay down.
 */
export async function renderGoogleOverlayButton(opts: {
  wrapper: HTMLElement;
  clientId: string;
  nonce?: string;
  onCredential: (idToken: string) => void;
  onError?: (error: Error) => void;
  size?: 'large' | 'medium' | 'small';
  host?: GsiHost;
}): Promise<{ destroy: () => void }> {
  const host = opts.host ?? (window as unknown as GsiHost);
  const doc = host.document;
  await loadGoogleIdentityServices(doc);
  const id = host.google?.accounts?.id;
  if (!id) throw new Error('Google Identity Services unavailable.');

  id.initialize({
    client_id: opts.clientId,
    nonce: opts.nonce,
    callback: (response: { credential?: string }) => {
      if (response.credential) opts.onCredential(response.credential);
      else opts.onError?.(new Error('Google returned no credential.'));
    },
  });

  // Ensure the wrapper can anchor an absolutely-positioned overlay.
  const hadPosition = opts.wrapper.style.position !== '';
  if (!hadPosition) opts.wrapper.style.position = 'relative';

  const overlay = doc.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  // On top, transparent, click-catching, and it clips Google's fixed-size button
  // to the wrapper so nothing pokes out even at opacity 0.
  overlay.style.cssText =
    'position:absolute;inset:0;z-index:2;opacity:0;overflow:hidden;' +
    'display:flex;align-items:center;justify-content:center;';
  opts.wrapper.appendChild(overlay);

  const draw = (): void => {
    // Google's button width must track the wrapper so every click lands on it;
    // width is fixed at render time, so re-render on resize. Clamp to GSI's range.
    const measured = Math.round(opts.wrapper.getBoundingClientRect().width) || 320;
    const width = Math.max(200, Math.min(400, measured));
    overlay.replaceChildren();
    id.renderButton(overlay, {
      type: 'standard',
      theme: 'outline',
      size: opts.size ?? 'large',
      text: 'continue_with',
      width,
    });
  };
  draw();

  let observer: ResizeObserver | undefined;
  const RO = host.ResizeObserver ?? (typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined);
  if (RO) {
    observer = new RO(() => draw());
    observer.observe(opts.wrapper);
  }

  return {
    destroy: () => {
      observer?.disconnect();
      overlay.remove();
      if (!hadPosition) opts.wrapper.style.position = '';
    },
  };
}
