/**
 * Per-flow captcha rendering for the prebuilt sign-in / sign-up surfaces.
 *
 * The server tells the browser, per flow, which provider to render and in what
 * mode (`GET /v1/appearance` → `captchaFlows`). This module loads that
 * provider's script once, renders (or executes) its widget into a container,
 * and resolves the token the flow's request then carries as `captcha_token`.
 *
 * Shared by `@atlasauth/react`'s `<SignIn>`/`<SignUp>` and the
 * `@atlasauth/embed` widget, so both draw the same widget the same way.
 *
 * Only providers that expose a standard browser widget are renderable;
 * score/edge/fingerprint providers (SEON, PerimeterX, Akamai, Kasada, Incapsula,
 * mCaptcha, AWS WAF, …) are verified server-side from a token a custom
 * integration supplies, so the prebuilt UIs do not draw them —
 * {@link isRenderableCaptcha} is false and the caller proceeds without a token
 * (the server still fails closed if it required one).
 *
 * Everything is SSR-safe: nothing touches `window`/`document` until a call that
 * renders into a DOM element.
 *
 * Provider `atlas` is Atlas's own captcha: no vendor script, no site key (see
 * `atlas-captcha.ts`).
 */
import { renderAtlasCaptcha, type AtlasCaptchaOptions } from './atlas-captcha';

/** The flows `captchaFlows` covers. */
export type CaptchaFlowKey = 'signUp' | 'signIn' | 'guest' | 'passwordReset';

/** How a widget-drawing provider renders. */
export type CaptchaWidgetMode = 'invisible' | 'managed' | 'visible';

/**
 * One flow's public captcha settings, exactly as `/v1/appearance` →
 * `captchaFlows[flow]` returns them. No secrets: the provider secret never
 * leaves the server. `enabled` means "this flow ALWAYS requires a token"; the
 * provider is still reported when it is false so a risk-triggered sign-in
 * challenge can be drawn.
 */
export interface FlowCaptcha {
  enabled: boolean;
  provider?: string;
  siteKey?: string | null;
  widget?: CaptchaWidgetMode;
  /**
   * Provider `atlas` (Atlas's own captcha, no keys): where the widget fetches
   * each fresh challenge. Set by `/v1/appearance`.
   */
  challengeUrl?: string;
  /**
   * Provider `vercel_botid`: the route on the app's own Vercel deployment that
   * runs `checkBotId()` and answers `{ token }` (a signed BotID verdict). The
   * widget POSTs to it — BotID's client (`initBotId`) must protect this path —
   * and sends the token as `captcha_token`.
   */
  attestationUrl?: string;
}

/** The providers the prebuilt UIs can natively render. */
const RENDERABLE = new Set([
  'atlas',
  'turnstile',
  'hcaptcha',
  'recaptcha',
  'recaptcha_v3',
  'recaptcha_enterprise',
  'captchafox',
  'vercel_botid',
]);

/**
 * Whether the prebuilt UIs can draw this provider's widget. Vercel BotID draws
 * nothing — the "widget" fetches a signed verdict from the app's own route — so
 * it is only obtainable when the flow names that route (`attestationUrl`); pass
 * the flow to account for it.
 */
export function isRenderableCaptcha(provider?: string | null, flow?: Pick<FlowCaptcha, 'attestationUrl'> | null): boolean {
  if (!provider || !RENDERABLE.has(provider)) return false;
  if (provider === 'vercel_botid') return !!flow?.attestationUrl;
  return true;
}

/** True when this flow always needs a rendered token before its request can proceed. */
export function flowNeedsCaptcha(flow: FlowCaptcha | null | undefined): flow is FlowCaptcha {
  return !!flow && flow.enabled === true && isRenderableCaptcha(flow.provider, flow);
}

/** The two captcha error codes the Frontend API answers a gated request with. */
export const CAPTCHA_ERROR_CODES: readonly string[] = ['CAPTCHA_REQUIRED', 'CAPTCHA_FAILED'];

/** Whether a Frontend API error is a captcha refusal (missing or rejected token). */
export function isCaptchaError(error: { code?: string } | null | undefined): boolean {
  return !!error && typeof error.code === 'string' && CAPTCHA_ERROR_CODES.includes(error.code);
}

type Win = Window & Record<string, unknown>;

/** Minimal shape of each vendor global we touch (kept loose — vendor-typed at runtime). */
interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  execute?: (id: string, opts?: Record<string, unknown>) => void;
  remove?: (id: string) => void;
  reset?: (id: string) => void;
}
interface HcaptchaApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  execute: (id: string, opts?: Record<string, unknown>) => Promise<{ response: string }> | void;
  remove?: (id: string) => void;
}
interface CaptchafoxApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => Promise<string> | string;
  execute?: (id?: string) => Promise<string> | void;
  remove?: (id?: string) => void;
  reset?: (id?: string) => void;
}
interface GrecaptchaApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => number;
  execute: (siteKeyOrId?: string, opts?: Record<string, unknown>) => Promise<string> | void;
  ready?: (cb: () => void) => void;
  reset?: (id?: number) => void;
}

const SCRIPTS: Record<string, { src: (siteKey: string) => string; global: string }> = {
  turnstile: {
    src: () => 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    global: 'turnstile',
  },
  hcaptcha: {
    src: () => 'https://js.hcaptcha.com/1/api.js?render=explicit',
    global: 'hcaptcha',
  },
  recaptcha: {
    src: () => 'https://www.google.com/recaptcha/api.js?render=explicit',
    global: 'grecaptcha',
  },
  recaptcha_v3: {
    src: (siteKey) => `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`,
    global: 'grecaptcha',
  },
  recaptcha_enterprise: {
    src: (siteKey) =>
      `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(siteKey)}`,
    global: 'grecaptcha',
  },
  captchafox: {
    src: () => 'https://cdn.captchafox.com/api.js?render=explicit',
    global: 'captchafox',
  },
};

/**
 * Load a provider's script and resolve its global. Idempotent: a second call for
 * the same provider reuses the in-flight or resolved load. When the global is
 * already present (a prior load, or a test that preset it) it resolves at once.
 */
export function loadCaptchaProvider(provider: string, siteKey: string, win: Win): Promise<unknown> {
  const spec = SCRIPTS[provider];
  if (!spec) return Promise.reject(new Error(`captcha: ${provider} is not renderable`));
  if (win[spec.global]) return Promise.resolve(win[spec.global]);

  const doc = win.document;
  const cacheKey = `__atlasCaptchaLoad_${provider}`;
  const existing = win[cacheKey] as Promise<unknown> | undefined;
  if (existing) return existing;

  const promise = new Promise<unknown>((resolve, reject) => {
    const done = () => {
      if (win[spec.global]) resolve(win[spec.global]);
      else reject(new Error(`captcha: ${provider} script loaded but global missing`));
    };
    const src = spec.src(siteKey);
    // Reuse a script tag another flow may have injected for the same src.
    let el = doc.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (el) {
      if (win[spec.global]) return resolve(win[spec.global]);
      el.addEventListener('load', done, { once: true });
      el.addEventListener('error', () => reject(new Error(`captcha: ${provider} script failed`)), {
        once: true,
      });
      return;
    }
    el = doc.createElement('script');
    el.src = src;
    el.async = true;
    el.defer = true;
    el.addEventListener('load', done, { once: true });
    el.addEventListener('error', () => reject(new Error(`captcha: ${provider} script failed`)), {
      once: true,
    });
    (doc.head ?? doc.body ?? doc.documentElement).appendChild(el);
  });
  win[cacheKey] = promise;
  // A failed load must not poison every later attempt (a flaky network, a
  // content blocker toggled off): forget it so the next render retries.
  promise.catch(() => {
    if (win[cacheKey] === promise) delete win[cacheKey];
  });
  return promise;
}

/** Per-render options. Only Atlas's own captcha reads any today. */
export interface RenderCaptchaOptions {
  /** Atlas captcha: a custom challenge fetcher (e.g. through your FAPI proxy) and localised labels. */
  atlas?: Pick<AtlasCaptchaOptions, 'fetchChallenge' | 'labels' | 'workers'>;
}

/** A rendered widget's teardown. */
type Teardown = () => void;

/** Cloudflare Turnstile: render into the container, resolve on the callback. */
function turnstileToken(
  api: TurnstileApi,
  el: HTMLElement,
  siteKey: string,
  mode: CaptchaWidgetMode,
  onTeardown: (t: Teardown) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = api.render(el, {
      sitekey: siteKey,
      // Turnstile's own modes map cleanly onto ours.
      appearance: mode === 'invisible' ? 'interaction-only' : 'always',
      callback: (token: string) => resolve(token),
      'error-callback': () => reject(new Error('captcha: turnstile error')),
      'timeout-callback': () => reject(new Error('captcha: turnstile timeout')),
    });
    onTeardown(() => api.remove?.(id));
    if (mode === 'invisible' && api.execute) api.execute(id);
  });
}

/** hCaptcha: render, then execute for invisible; resolve on the callback. */
function hcaptchaToken(
  api: HcaptchaApi,
  el: HTMLElement,
  siteKey: string,
  mode: CaptchaWidgetMode,
  onTeardown: (t: Teardown) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = api.render(el, {
      sitekey: siteKey,
      size: mode === 'invisible' ? 'invisible' : 'normal',
      callback: (token: string) => resolve(token),
      'error-callback': () => reject(new Error('captcha: hcaptcha error')),
    });
    onTeardown(() => api.remove?.(id));
    if (mode === 'invisible') {
      const r = api.execute(id, { async: true });
      if (r && typeof (r as Promise<{ response: string }>).then === 'function') {
        (r as Promise<{ response: string }>).then((v) => resolve(v.response), reject);
      }
    }
  });
}

/** reCAPTCHA v2 (checkbox/invisible): render, resolve on callback. */
function recaptchaV2Token(
  api: GrecaptchaApi,
  el: HTMLElement,
  siteKey: string,
  mode: CaptchaWidgetMode,
  onTeardown: (t: Teardown) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = api.render(el, {
      sitekey: siteKey,
      size: mode === 'invisible' ? 'invisible' : 'normal',
      callback: (token: string) => resolve(token),
      'error-callback': () => reject(new Error('captcha: recaptcha error')),
    });
    // reCAPTCHA has no remove(); reset frees the widget, the container is cleared.
    onTeardown(() => api.reset?.(id));
    if (mode === 'invisible' && api.execute) {
      const r = api.execute(undefined, { widgetId: id });
      if (r && typeof (r as Promise<string>).then === 'function') {
        (r as Promise<string>).then(resolve, reject);
      }
    }
  });
}

/** CaptchaFox: `render` resolves the widget id; hidden mode runs on `execute`. */
function captchafoxToken(
  api: CaptchafoxApi,
  el: HTMLElement,
  siteKey: string,
  mode: CaptchaWidgetMode,
  onTeardown: (t: Teardown) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('captcha: captchafox error'));
    Promise.resolve(
      api.render(el, {
        sitekey: siteKey,
        mode: mode === 'invisible' ? 'hidden' : 'inline',
        onVerify: (token: string) => resolve(token),
        onError: fail,
        onFail: fail,
      }),
    ).then((id) => {
      onTeardown(() => api.remove?.(id));
      if (mode === 'invisible' && api.execute) {
        Promise.resolve(api.execute(id)).then((token) => {
          if (typeof token === 'string' && token) resolve(token);
        }, fail);
      }
    }, fail);
  });
}

/**
 * Vercel BotID: no widget. POST the app's own attestation route (same-origin
 * credentials, so the BotID client that protects it can attach its headers)
 * and read the signed verdict `{ token }` it answers with.
 */
export async function fetchBotIdAttestation(
  attestationUrl: string,
  fetchImpl: typeof fetch = (globalThis as { fetch: typeof fetch }).fetch,
): Promise<string> {
  const response = await fetchImpl(attestationUrl, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`captcha: BotID attestation route answered ${response.status}`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string' || !body.token) throw new Error('captcha: BotID attestation missing');
  return body.token;
}

/** reCAPTCHA v3 / Enterprise (score): execute programmatically, no visible widget. */
function recaptchaV3Token(api: GrecaptchaApi, siteKey: string): Promise<string> {
  const run = () => {
    const r = api.execute(siteKey, { action: 'submit' });
    return r && typeof (r as Promise<string>).then === 'function'
      ? (r as Promise<string>)
      : Promise.reject(new Error('captcha: recaptcha v3 execute returned no promise'));
  };
  return new Promise((resolve, reject) => {
    if (api.ready) api.ready(() => run().then(resolve, reject));
    else run().then(resolve, reject);
  });
}

/** A widget rendered into a container: its eventual token, and a way to take it down. */
export interface CaptchaWidgetHandle {
  /** Resolves with the solved token; rejects on provider error/timeout or removal. */
  token: Promise<string>;
  /**
   * True when the solved token is about to expire unspent (Atlas's captcha), so
   * the caller draws a fresh widget instead of sending it. Absent: never stale.
   */
  stale?(): boolean;
  /**
   * Remove the widget (provider teardown + empty the container). Tokens are
   * single-use, so call this after a submit spent the token and render a fresh
   * widget for the next try.
   */
  remove(): void;
}

/**
 * Render a flow's captcha widget into `container` and return a handle on its
 * token. Loads the provider, renders/executes the right widget for the mode.
 * `container` is where a visible/managed widget draws; score providers draw
 * nothing there.
 */
export function renderCaptchaWidget(
  flow: FlowCaptcha,
  container: HTMLElement,
  options: RenderCaptchaOptions = {},
): CaptchaWidgetHandle {
  const provider = flow.provider ?? '';
  if (provider === 'atlas') {
    return renderAtlasCaptcha(container, {
      challengeUrl: flow.challengeUrl,
      mode: flow.widget ?? 'managed',
      ...options.atlas,
    });
  }
  if (provider === 'vercel_botid') {
    let removed = false;
    const win = (container.ownerDocument?.defaultView ?? globalThis) as unknown as { fetch?: typeof fetch };
    const token = flow.attestationUrl
      ? fetchBotIdAttestation(flow.attestationUrl, win.fetch?.bind(win)).then((t) => {
          if (removed) throw new Error('captcha: widget removed');
          return t;
        })
      : Promise.reject(new Error('captcha: vercel_botid needs an attestationUrl'));
    token.catch(() => {});
    return {
      token,
      remove() {
        removed = true;
      },
    };
  }
  const siteKey = flow.siteKey ?? '';
  const mode: CaptchaWidgetMode = flow.widget ?? 'managed';
  const win = (container.ownerDocument?.defaultView ?? globalThis) as unknown as Win;

  let removed = false;
  let teardown: Teardown | null = null;
  let cancel: ((e: Error) => void) | null = null;
  const onTeardown = (t: Teardown) => {
    teardown = t;
  };

  const token = new Promise<string>((resolve, reject) => {
    cancel = reject;
    loadCaptchaProvider(provider, siteKey, win)
      .then((api) => {
        if (removed) throw new Error('captcha: widget removed');
        switch (provider) {
          case 'turnstile':
            return turnstileToken(api as TurnstileApi, container, siteKey, mode, onTeardown);
          case 'hcaptcha':
            return hcaptchaToken(api as HcaptchaApi, container, siteKey, mode, onTeardown);
          case 'recaptcha':
            return recaptchaV2Token(api as GrecaptchaApi, container, siteKey, mode, onTeardown);
          case 'recaptcha_v3':
          case 'recaptcha_enterprise':
            return recaptchaV3Token(api as GrecaptchaApi, siteKey);
          case 'captchafox':
            return captchafoxToken(api as CaptchafoxApi, container, siteKey, mode, onTeardown);
          default:
            throw new Error(`captcha: ${provider} is not renderable`);
        }
      })
      .then(resolve, reject);
  });

  return {
    token,
    remove() {
      if (removed) return;
      removed = true;
      try {
        (teardown as Teardown | null)?.();
      } catch {
        /* a vendor that already tore itself down */
      }
      while (container.firstChild) container.removeChild(container.firstChild);
      (cancel as ((e: Error) => void) | null)?.(new Error('captcha: widget removed'));
    },
  };
}

/**
 * Obtain a captcha token for a flow: render the widget into `container` and
 * resolve its token. Rejects on provider error/timeout — the caller decides
 * whether to surface it or let the (fail-closed) server reject the tokenless
 * request.
 */
export async function getCaptchaToken(
  flow: FlowCaptcha,
  container: HTMLElement,
  options?: RenderCaptchaOptions,
): Promise<string> {
  return renderCaptchaWidget(flow, container, options).token;
}
