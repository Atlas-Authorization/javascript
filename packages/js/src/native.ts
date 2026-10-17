/**
 * §6 native / One-Tap sign-in — the client half.
 *
 * The SDK does not make HTTP calls (the app owns fetch + cookies), so this
 * module is two pure helpers for the request/response shape plus a
 * framework-agnostic Google Identity Services loader that resolves a credential
 * id_token. The app posts that to `/v1/client/sign_ins/id_token` and then reads
 * the result exactly like any other attempt (nextStep / a returned ticket).
 */

import type { AttemptView } from './attempt';
import { initialFlow, type FapiClient, type FlowState } from './fapi';

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

/**
 * Mint a single-use, replay-binding nonce for a native id_token sign-in. Call
 * this FIRST, hand the returned nonce to the provider SDK (Google GSI
 * `initialize({ nonce })`), then post the resulting id_token with the SAME nonce
 * via {@link nativeSignIn}. Returns null if the mint failed (e.g. the provider
 * doesn't support native sign-in) — the caller should surface an error rather
 * than fall back to a nonce-less sign-in.
 */
export async function mintNativeNonce(
  client: FapiClient,
  provider: string,
): Promise<string | null> {
  const response = await client.post<{ nonce?: string }>('/v1/client/sign_ins/id_token/nonce', {
    provider,
  });
  return response.ok && response.data?.nonce ? response.data.nonce : null;
}

/**
 * Post a provider id_token (+ the nonce from {@link mintNativeNonce}) to the
 * native sign-in endpoint and return a {@link FlowState} — the same shape the
 * password/redirect drivers return, so a caller drives completion identically:
 * a `complete` attempt carries the one-time `ticket` to exchange for cookies; a
 * `needs_second_factor` status means a factor is still owed.
 */
export async function nativeSignIn(
  client: FapiClient,
  input: { provider: string; idToken: string; nonce?: string },
): Promise<FlowState> {
  const response = await client.post<AttemptView & { ticket?: string }>(
    '/v1/client/sign_ins/id_token',
    nativeSignInBody(input),
  );

  if (!response.ok || !response.data) {
    return { ...initialFlow, busy: false, errors: response.errors };
  }

  return {
    attempt: response.data,
    errors: [],
    busy: false,
    pollSecret: initialFlow.pollSecret,
    ticket: response.data.ticket ?? null,
  };
}

/* ---- provider-health telemetry ------------------------------------------- */

/** The client-observed reason a native (in-page) provider could not be used. */
export type ProviderUnavailableReason = 'script_blocked' | 'not_rendered';

/**
 * Best-effort health beacon: tell Atlas's server that a native (in-page)
 * provider could not be rendered/used on this page, so the dashboard can surface
 * a provider-health signal. This COMPLEMENTS the caller's `onProviderUnavailable`
 * callback — the callback tells the customer's page, this tells Atlas.
 *
 * Fire-and-forget: the endpoint answers `204 No Content`; the response is ignored
 * and every error is swallowed. Telemetry must never disturb a real sign-in, nor
 * its fall back to the ordinary redirect flow.
 *
 * Transport — why fetch+keepalive and NOT `navigator.sendBeacon`: this endpoint
 * authenticates with the `x-publishable-key` HEADER (the same publishable-key
 * auth every {@link FapiClient} request already sends). `sendBeacon` cannot set
 * arbitrary request headers, so a beacon would arrive with no pk, be
 * unattributable, and get dropped — it can NOT reliably carry the pk here. So we
 * POST through the FapiClient with `keepalive: true`, which carries the pk header
 * AND, like sendBeacon, lets the request outlive the page navigating away (e.g.
 * the redirect fallback firing immediately after the failure).
 */
export function reportProviderUnavailable(
  client: FapiClient,
  provider: string,
  reason: ProviderUnavailableReason,
): void {
  // SSR-safe: there is no browser here to send a beacon from.
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  try {
    // `request` already sets `x-publishable-key` + `credentials: 'include'` and
    // never throws on a network failure; `keepalive` is spread straight into the
    // underlying fetch. We do not await it — this is fire-and-forget.
    void client
      .request('/v1/client/telemetry/provider_unavailable', {
        method: 'POST',
        body: JSON.stringify({ provider, reason }),
        keepalive: true,
      })
      .catch(() => {
        // never reject
      });
  } catch {
    // never throw
  }
}

/* ---- Google Identity Services (One-Tap / GSI) ---------------------------- */

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let gsiLoad: Promise<void> | null = null;

/**
 * NODE_ENV without requiring `@types/node` (this package is DOM-typed, `types: []`).
 * Declared locally and probed with `typeof` so it is a no-op wherever `process`
 * is absent (the browser bundle, SSR without a shim).
 */
declare const process: { env?: { NODE_ENV?: string } } | undefined;
function isDevEnv(): boolean {
  return typeof process !== 'undefined' && process?.env?.NODE_ENV !== 'production';
}

/**
 * Module-level registry of the overlay buttons currently mounted, so a hook-free
 * {@link diagnoseProvider} can measure a live overlay against its wrapper without a
 * handle. Entries are added when {@link renderGoogleOverlayButton} draws and removed
 * on `destroy()`.
 */
interface MountedOverlay {
  provider: string;
  wrapper: HTMLElement;
  overlay: HTMLElement;
}
const mountedOverlays = new Set<MountedOverlay>();

/**
 * Session flag: has a Google credential (id_token) actually been minted in this
 * document since the module loaded? Set in the GSI credential callback. Exposed
 * (read-only) through {@link diagnoseProvider} so a caller can tell "the button is
 * mounted and looks healthy but no click has ever produced a credential" apart from
 * "it has worked at least once".
 */
let googleCredentialMintedThisSession = false;

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
  MutationObserver?: typeof MutationObserver;
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
 * wrapper, GSI's rendered button is STRETCHED (inline) to fill the overlay rather
 * than centred-and-clipped, and a ResizeObserver re-renders on layout changes so
 * the whole surface stays clickable. In development it also self-verifies the
 * coverage and warns (loudly, never throwing) when the geometry is off.
 *
 * `wrapper` is YOUR styled button (or its container); it is made position:relative
 * if it is not already positioned. Returns `{ destroy }` to tear the overlay down.
 *
 * `visible` (default false) picks WHAT the user sees (customer spec 4.5):
 *   - false — today's behaviour: Google's button is drawn at opacity 0 as an
 *     invisible click-target overlaid on YOUR styled button. The user sees your
 *     button; the click lands on Google's. The overlay is `aria-hidden`.
 *   - true — Google's OWN button is drawn VISIBLY (opacity 1), on top of the
 *     wrapper, and IS the button the user operates (for teams who'd rather not
 *     maintain a styled button). It is NOT aria-hidden, since it is the real
 *     control. The host button underneath is then unnecessary.
 * Either way the stretch-to-fill + ResizeObserver run, so Google's button tracks
 * the wrapper's width.
 */
export async function renderGoogleOverlayButton(opts: {
  wrapper: HTMLElement;
  clientId: string;
  nonce?: string;
  onCredential: (idToken: string) => void;
  onError?: (error: Error) => void;
  size?: 'large' | 'medium' | 'small';
  /** Also show the One-Tap prompt (OFF by default; the overlay button always shows). */
  oneTap?: boolean;
  /**
   * Render Google's button VISIBLY (opacity 1) instead of as a transparent overlay
   * (default false = the invisible-overlay technique). See the function doc.
   */
  visible?: boolean;
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
      if (response.credential) {
        // Record that native Google has produced a credential at least once this
        // session (read back by {@link diagnoseProvider}), then hand it off.
        googleCredentialMintedThisSession = true;
        opts.onCredential(response.credential);
      } else opts.onError?.(new Error('Google returned no credential.'));
    },
  });

  // Ensure the wrapper can anchor an absolutely-positioned overlay.
  const hadPosition = opts.wrapper.style.position !== '';
  if (!hadPosition) opts.wrapper.style.position = 'relative';

  const visible = opts.visible ?? false;

  const overlay = doc.createElement('div');
  // Invisible-overlay mode (default): Google's button is a transparent click-target
  // laid over the host's own button, so hide it from assistive tech (the host button
  // carries the accessible name). Visible mode (spec 4.5 `googleButton:"google"`):
  // it IS the real, operable button — leave it exposed.
  if (!visible) overlay.setAttribute('aria-hidden', 'true');
  // On top, click-catching. Google's own button shown visibly => opacity 1. Invisible
  // overlay (host styling) => a NEAR-zero opacity, NOT exactly 0: GSI's visibility /
  // anti-clickjacking check treats an element at exactly `opacity:0` as not-visible and
  // SILENTLY refuses the click (dead button, no callback, no error — the reported bug),
  // while it accepts a tiny non-zero opacity that is still invisible to the user (the
  // host button shows through). This is the specific cause of "opacity 0 dead / opacity
  // 1 works, regardless of geometry". NO flex centring — the iframe is stretched to fill
  // the wrapper below (inline) so every click lands on the real GSI button.
  const INVISIBLE_OPACITY = 0.004;
  overlay.style.cssText =
    `position:absolute;inset:0;z-index:2;opacity:${visible ? 1 : INVISIBLE_OPACITY};overflow:hidden;`;
  opts.wrapper.appendChild(overlay);
  const mounted: MountedOverlay = { provider: 'google', wrapper: opts.wrapper, overlay };
  mountedOverlays.add(mounted);

  // Force an element GSI injected to fill the overlay exactly. INLINE and
  // synchronous on purpose: the customer found the identical geometry applied via a
  // stylesheet behaved differently from inline (specificity / cascade timing), so
  // the working config sets width/height:100% directly on the style attribute.
  const stretchToFill = (el: Element | null | undefined): void => {
    const style = (el as HTMLElement | null | undefined)?.style;
    if (!style) return;
    // Guarded so re-applying from the MutationObserver below doesn't churn the DOM
    // or loop against our own attribute writes.
    if (style.width !== '100%') style.width = '100%';
    if (style.height !== '100%') style.height = '100%';
  };
  // GSI injects its <iframe> ASYNCHRONOUSLY after renderButton() returns and sizes it
  // to a fixed px width — so stretching synchronously only catches GSI's direct child
  // div, never the iframe (it isn't in the DOM yet), leaving the iframe clipped inside
  // the wrapper (the exact "renders but a click misses" defect). Apply to whatever is
  // present now AND re-apply whenever GSI mutates the subtree (observer after draw()).
  const applyStretch = (): void => {
    stretchToFill(overlay.firstElementChild);
    const frame = overlay.querySelector('iframe');
    stretchToFill(frame);
    // GSI gives its iframe a -10px side margin, which shifts it off the host
    // button's right edge and leaves a strip where clicks miss Google's button.
    const fs = (frame as HTMLElement | null)?.style;
    if (fs && fs.margin !== '0px') fs.margin = '0';
  };

  const draw = (): void => {
    // Google's button width must track the wrapper so every click lands on it;
    // width is fixed at render time, so re-render on resize. Clamp to GSI's range so
    // GSI still draws a real button, which we then CSS-stretch to cover the wrapper.
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
    // Customer's working fix: stretch GSI's rendered container (the direct child div
    // GSI creates) AND the <iframe> it injects to fill the wrapper, inline, instead
    // of letting a fixed-size button sit centred under overflow:hidden (which leaves
    // dead zones where a click misses).
    applyStretch();
    verifyCoverage();
  };

  // Dev-only, loud, never-throwing self-check that the transparent overlay actually
  // covers the host button and GSI drew a sane-sized iframe. A healthy-looking button
  // whose overlay doesn't cover it is exactly the "clicks do nothing" bug.
  const rectOf = (r: DOMRect): Rect => ({
    width: r.width,
    height: r.height,
    top: r.top,
    left: r.left,
    right: r.right,
    bottom: r.bottom,
  });
  const verifyCoverage = (): void => {
    if (!isDevEnv()) return;
    if (typeof window === 'undefined') return; // SSR: nothing to measure.
    try {
      const w = opts.wrapper.getBoundingClientRect();
      const o = overlay.getBoundingClientRect();
      // Overlay must cover the wrapper on every edge (1px rounding slack), or clicks
      // fall through to dead space outside the invisible button.
      const covers =
        o.left <= w.left + 1 &&
        o.top <= w.top + 1 &&
        o.right >= w.right - 1 &&
        o.bottom >= w.bottom - 1;
      const frame = overlay.querySelector('iframe');
      const fr = frame?.getBoundingClientRect();
      const iframeOk = !!fr && fr.width >= 8 && fr.height >= 8;
      if (!covers || !iframeOk) {
        console.warn(
          '[atlas] Google overlay misaligned/undersized — clicks may miss the invisible GSI button',
          {
            covers,
            iframeOk,
            wrapper: rectOf(w),
            overlay: rectOf(o),
            iframe: fr ? { width: fr.width, height: fr.height } : null,
          },
        );
      }
    } catch {
      // Dev diagnostics must never disturb a real sign-in.
    }
  };

  draw();

  let observer: ResizeObserver | undefined;
  const RO = host.ResizeObserver ?? (typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined);
  if (RO) {
    observer = new RO(() => draw());
    observer.observe(opts.wrapper);
  }

  // The async half of the stretch: GSI injects/resizes its iframe after draw()
  // returns, so watch the overlay subtree and re-stretch the moment that happens.
  // Without this the iframe keeps GSI's fixed px size and stays clipped — the bug a
  // synchronous-only stretch leaves behind.
  let mutationObserver: MutationObserver | undefined;
  const MO =
    host.MutationObserver ?? (typeof MutationObserver !== 'undefined' ? MutationObserver : undefined);
  if (MO) {
    mutationObserver = new MO(() => applyStretch());
    mutationObserver.observe(overlay, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'width', 'height'],
    });
  }

  // One-Tap is opt-in and independent of the button: the same initialized `id`
  // (with the same nonce + callback) drives the prompt, so a One-Tap credential
  // flows through the identical `onCredential` path.
  if (opts.oneTap) id.prompt();

  return {
    destroy: () => {
      observer?.disconnect();
      mutationObserver?.disconnect();
      mountedOverlays.delete(mounted);
      overlay.remove();
      if (!hadPosition) opts.wrapper.style.position = '';
    },
  };
}

/* ---- diagnostics --------------------------------------------------------- */

/** A measured bounding box, plain numbers so the diagnosis serialises cleanly. */
export interface Rect {
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** The overlay-vs-wrapper geometry for a currently mounted overlay button. */
export interface OverlayGeometry {
  /** Does the transparent overlay cover the host button on every edge? */
  covers: boolean;
  wrapper: Rect;
  overlay: Rect;
  /** The GSI iframe's size, or null if no iframe is present yet. */
  iframe: { width: number; height: number } | null;
}

/**
 * The knowable facts about a provider's native-sign-in setup, as the SDK can see
 * them. Deliberately honest about its limits: it reports the CURRENT page origin,
 * NOT the provider's registered JavaScript origins — the SDK cannot read Google's
 * client config, so the caller must compare `origin` against what they registered.
 */
export interface ProviderDiagnosis {
  provider: string;
  /** Resolved render mode from `/v1/client/environment` (`native` when unset but native), else null if the provider isn't listed. */
  mode: 'native' | 'redirect' | null;
  /** The public client_id from the environment, or null. */
  clientId: string | null;
  /** Whether the environment marks this provider native. */
  native: boolean;
  /** This page's origin — compare it to YOUR registered JS origins; the SDK can't. */
  origin: string | null;
  /** Overlay geometry if a button for this provider is currently mounted, else null. */
  overlay: OverlayGeometry | null;
  /** Has a Google credential been minted in this session? (Only tracked for google.) */
  credentialMintedThisSession: boolean;
}

interface EnvSocialProviderLite {
  provider: string;
  native?: boolean;
  client_id?: string;
  mode?: 'native' | 'redirect';
}

/** Measure a mounted overlay for `provider` against its wrapper, or null. */
function measureMountedOverlay(provider: string): OverlayGeometry | null {
  if (typeof window === 'undefined') return null;
  for (const m of mountedOverlays) {
    if (m.provider !== provider) continue;
    try {
      const w = m.wrapper.getBoundingClientRect();
      const o = m.overlay.getBoundingClientRect();
      const frame = m.overlay.querySelector('iframe');
      const fr = frame?.getBoundingClientRect();
      return {
        covers:
          o.left <= w.left + 1 &&
          o.top <= w.top + 1 &&
          o.right >= w.right - 1 &&
          o.bottom >= w.bottom - 1,
        wrapper: {
          width: w.width,
          height: w.height,
          top: w.top,
          left: w.left,
          right: w.right,
          bottom: w.bottom,
        },
        overlay: {
          width: o.width,
          height: o.height,
          top: o.top,
          left: o.left,
          right: o.right,
          bottom: o.bottom,
        },
        iframe: fr ? { width: fr.width, height: fr.height } : null,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Collect the knowable facts about a native provider's setup for a support ticket
 * or a dev console: its resolved `mode` and `client_id` (from
 * `/v1/client/environment`), whether it's native, the current page origin, the
 * live overlay geometry IF a button is mounted, and whether a Google credential has
 * been minted this session. Hook-free, SSR-safe, and never throws — a failed
 * environment fetch simply leaves the server-sourced fields null.
 *
 * It does NOT (and cannot) report the provider's registered JavaScript origins: the
 * caller compares the returned `origin` against what they registered with Google.
 */
export async function diagnoseProvider(
  client: FapiClient,
  provider: string,
): Promise<ProviderDiagnosis> {
  const origin =
    typeof window !== 'undefined' && window.location ? window.location.origin : null;

  let mode: 'native' | 'redirect' | null = null;
  let clientId: string | null = null;
  let native = false;
  try {
    const res = await client.get<{ social_providers?: EnvSocialProviderLite[] }>(
      '/v1/client/environment',
    );
    const p = res.data?.social_providers?.find((x) => x.provider === provider);
    if (p) {
      native = p.native === true;
      clientId = typeof p.client_id === 'string' ? p.client_id : null;
      // `mode` absent but native means the default native mode (see usesNativeGoogle).
      mode = p.mode === 'redirect' ? 'redirect' : p.mode === 'native' ? 'native' : native ? 'native' : null;
    }
  } catch {
    // never throw — leave the server-sourced fields at their null defaults.
  }

  return {
    provider,
    mode,
    clientId,
    native,
    origin,
    overlay: measureMountedOverlay(provider),
    credentialMintedThisSession: provider === 'google' ? googleCredentialMintedThisSession : false,
  };
}

/** Reset the session credential flag (tests). */
export function resetGoogleCredentialFlag(): void {
  googleCredentialMintedThisSession = false;
}
