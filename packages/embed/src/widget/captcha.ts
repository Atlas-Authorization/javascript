import type { CaptchaWidgetMode, FlowCaptcha } from '../appearance';

/**
 * Client-side captcha rendering for the hosted widget.
 *
 * The server tells the widget, per flow, which provider to render and in what
 * mode (see `/v1/appearance` → `captchaFlows`). This module loads that
 * provider's script once and resolves a token the flow's API call then carries
 * as `captcha_token`. Only the providers that expose a standard browser widget
 * are renderable here; score/edge/fingerprint providers (SEON, PerimeterX,
 * Akamai, Kasada, Incapsula, mCaptcha, AWS WAF, …) are verified server-side from
 * a token a custom integration supplies, so the hosted widget does not draw
 * them — `isRenderable` returns false and the caller proceeds without a token
 * (the server still fails closed if it required one).
 */

/** The providers the hosted widget can natively render. */
const RENDERABLE = new Set([
  'turnstile',
  'hcaptcha',
  'recaptcha',
  'recaptcha_v3',
  'recaptcha_enterprise',
]);

export function isRenderable(provider?: string | null): boolean {
  return !!provider && RENDERABLE.has(provider);
}

/** True when this flow needs a rendered token before its request can proceed. */
export function flowNeedsCaptcha(flow: FlowCaptcha | undefined): flow is FlowCaptcha {
  return !!flow && flow.enabled === true && isRenderable(flow.provider);
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
};

/**
 * Load a provider's script and resolve its global. Idempotent: a second call for
 * the same provider reuses the in-flight or resolved load. When the global is
 * already present (a prior load, or a test that preset it) it resolves at once.
 */
export function loadProvider(provider: string, siteKey: string, win: Win): Promise<unknown> {
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
  return promise;
}

/** Cloudflare Turnstile: render into the container, resolve on the callback. */
function turnstileToken(
  api: TurnstileApi,
  el: HTMLElement,
  siteKey: string,
  mode: CaptchaWidgetMode,
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
    if (mode === 'invisible' && api.execute) api.execute(id);
  });
}

/** hCaptcha: render, then execute for invisible; resolve on the callback. */
function hcaptchaToken(
  api: HcaptchaApi,
  el: HTMLElement,
  siteKey: string,
  mode: CaptchaWidgetMode,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = api.render(el, {
      sitekey: siteKey,
      size: mode === 'invisible' ? 'invisible' : 'normal',
      callback: (token: string) => resolve(token),
      'error-callback': () => reject(new Error('captcha: hcaptcha error')),
    });
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
): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = api.render(el, {
      sitekey: siteKey,
      size: mode === 'invisible' ? 'invisible' : 'normal',
      callback: (token: string) => resolve(token),
      'error-callback': () => reject(new Error('captcha: recaptcha error')),
    });
    if (mode === 'invisible' && api.execute) {
      const r = api.execute(undefined, { widgetId: id });
      if (r && typeof (r as Promise<string>).then === 'function') {
        (r as Promise<string>).then(resolve, reject);
      }
    }
  });
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

/**
 * Obtain a captcha token for a flow. Loads the provider, renders/executes the
 * right widget for the mode, and resolves the token. `container` is where a
 * visible/managed widget draws; for score providers it is unused.
 *
 * Rejects on provider error/timeout — the caller decides whether to surface it
 * or let the (fail-closed) server reject the tokenless request.
 */
export async function getCaptchaToken(flow: FlowCaptcha, container: HTMLElement): Promise<string> {
  const provider = flow.provider ?? '';
  const siteKey = flow.siteKey ?? '';
  const mode: CaptchaWidgetMode = flow.widget ?? 'managed';
  const win = (container.ownerDocument?.defaultView ?? globalThis) as unknown as Win;

  const api = await loadProvider(provider, siteKey, win);

  switch (provider) {
    case 'turnstile':
      return turnstileToken(api as TurnstileApi, container, siteKey, mode);
    case 'hcaptcha':
      return hcaptchaToken(api as HcaptchaApi, container, siteKey, mode);
    case 'recaptcha':
      return recaptchaV2Token(api as GrecaptchaApi, container, siteKey, mode);
    case 'recaptcha_v3':
    case 'recaptcha_enterprise':
      return recaptchaV3Token(api as GrecaptchaApi, siteKey);
    default:
      throw new Error(`captcha: ${provider} is not renderable`);
  }
}
