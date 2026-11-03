/**
 * "CAPTCHA anywhere" — the browser half of Atlas's standalone captcha primitive.
 *
 * Atlas holds the provider secret and does the verification; the frontend only
 * ever handles the PUBLIC provider + site key. This surface lets an app protect
 * any action with a centrally-managed captcha and delete its own widget/verify
 * code:
 *
 *   - `config(action?)`  → GET  /v1/client/captcha        (public provider + key)
 *   - `verify(token, a?)`→ POST /v1/client/captcha/verify (server-side check)
 *   - `protect(el, a?)`  → lazily load the provider's widget CDN script, render
 *                          it into `el`, and resolve the solved token.
 *
 * Everything is SSR-guarded (no `document`/`window` touched until a call that
 * needs the DOM) and the script loaders are one-shot per CDN URL.
 */
import type { FapiClient } from './fapi';
import { renderAtlasCaptcha, type AtlasChallenge } from './atlas-captcha';
import { fetchBotIdAttestation } from './captcha-widget';

/** The public widget config `GET /v1/client/captcha` returns. No secrets. */
export interface CaptchaWidgetConfig {
  object: 'captcha_config';
  /** The action this config resolved for, or null for the base provider. */
  action: string | null;
  /** The resolved provider key (`none` when captcha is off for this action). */
  provider: string;
  /** The public site key the widget renders with; null for score/edge providers. */
  site_key: string | null;
  /** How a widget-drawing provider should render. */
  widget_mode: 'invisible' | 'managed' | 'visible';
  /**
   * Vercel BotID only: the route on your own Vercel deployment that answers
   * `{ token }` (a signed BotID verdict). Null for every other provider.
   */
  attestation_url?: string | null;
  /** Whether this action ALWAYS requires a passing captcha. */
  enabled: boolean;
}

/** The result `POST /v1/client/captcha/verify` returns (no provider `meta`). */
export interface CaptchaVerification {
  object: 'captcha_verification';
  success: boolean;
  action: string | null;
  provider: string;
  /** Normalized 0..1 (higher = more human); absent for pass/fail-only providers. */
  score?: number;
}

/**
 * The widget CDN script per provider. A string is a fixed URL (rendered
 * explicitly); a function builds the URL from the site key (reCAPTCHA v3 embeds
 * it in the query). Only providers that draw a browser widget appear here.
 */
const PROVIDER_SCRIPTS: Record<string, string | ((siteKey: string) => string)> = {
  hcaptcha: 'https://js.hcaptcha.com/1/api.js?render=explicit',
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  recaptcha: 'https://www.google.com/recaptcha/api.js?render=explicit',
  recaptcha_v3: (siteKey) =>
    `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`,
  captchafox: 'https://cdn.captchafox.com/api.js?render=explicit',
};

/** One-shot loaders, keyed by script URL, so a provider script injects once. */
const scriptLoads = new Map<string, Promise<void>>();

/** Inject a widget CDN script once; resolves when it is ready. SSR-safe (rejects). */
export function loadCaptchaScript(src: string): Promise<void> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('Atlas captcha widgets require a browser DOM.'));
  }
  const existing = scriptLoads.get(src);
  if (existing) return existing;
  const load = new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error(`Failed to load captcha script: ${src}`)));
    document.head.appendChild(script);
  });
  scriptLoads.set(src, load);
  return load;
}

/** Reset the one-shot script loaders (tests). */
export function resetCaptchaScripts(): void {
  scriptLoads.clear();
}

/** The subset of each provider's global widget API we drive. */
interface WidgetApi {
  render(container: HTMLElement | string, params: Record<string, unknown>): unknown;
  execute?(siteKey?: unknown, opts?: Record<string, unknown>): unknown;
  ready?(cb: () => void): void;
}
interface CaptchaWindow {
  hcaptcha?: WidgetApi;
  turnstile?: WidgetApi;
  grecaptcha?: WidgetApi;
  captchafox?: WidgetApi;
}

/** Render the resolved provider's widget into `element` and resolve its token. */
function renderWidget(
  provider: string,
  siteKey: string,
  element: HTMLElement,
  action: string | undefined,
  widgetMode: CaptchaWidgetConfig['widget_mode'],
): Promise<string> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Atlas captcha widgets require a browser window.'));
  }
  const w = window as unknown as CaptchaWindow;
  const invisible = widgetMode === 'invisible';

  return new Promise<string>((resolve, reject) => {
    switch (provider) {
      case 'hcaptcha': {
        const api = w.hcaptcha;
        if (!api) return reject(new Error('hCaptcha did not load.'));
        api.render(element, {
          sitekey: siteKey,
          ...(invisible ? { size: 'invisible' } : {}),
          callback: (token: string) => resolve(token),
          'error-callback': () => reject(new Error('hCaptcha challenge failed.')),
        });
        return;
      }
      case 'turnstile': {
        const api = w.turnstile;
        if (!api) return reject(new Error('Turnstile did not load.'));
        api.render(element, {
          sitekey: siteKey,
          callback: (token: string) => resolve(token),
          'error-callback': () => reject(new Error('Turnstile challenge failed.')),
        });
        return;
      }
      case 'recaptcha': {
        const api = w.grecaptcha;
        if (!api) return reject(new Error('reCAPTCHA did not load.'));
        api.render(element, {
          sitekey: siteKey,
          ...(invisible ? { size: 'invisible' } : {}),
          callback: (token: string) => resolve(token),
          'error-callback': () => reject(new Error('reCAPTCHA challenge failed.')),
        });
        return;
      }
      case 'recaptcha_v3': {
        // v3 is scoreless-UI: no widget to click — execute against the action.
        const api = w.grecaptcha;
        if (!api || !api.ready || !api.execute) return reject(new Error('reCAPTCHA v3 did not load.'));
        api.ready(() => {
          Promise.resolve(api.execute!(siteKey, { action: action || 'submit' })).then(
            (token) => resolve(String(token)),
            (err) => reject(err instanceof Error ? err : new Error('reCAPTCHA v3 execution failed.')),
          );
        });
        return;
      }
      case 'captchafox': {
        const api = w.captchafox;
        if (!api) return reject(new Error('CaptchaFox did not load.'));
        const fail = () => reject(new Error('CaptchaFox challenge failed.'));
        Promise.resolve(
          api.render(element, {
            sitekey: siteKey,
            mode: invisible ? 'hidden' : 'inline',
            onVerify: (token: string) => resolve(token),
            onError: fail,
            onFail: fail,
          }),
        ).then((id) => {
          if (invisible && api.execute) {
            Promise.resolve(api.execute(id)).then((token) => {
              if (typeof token === 'string' && token) resolve(token);
            }, fail);
          }
        }, fail);
        return;
      }
      default:
        reject(new Error(`Captcha provider "${provider}" has no browser widget.`));
    }
  });
}

/**
 * The captcha surface, bound to a {@link FapiClient}. `config`/`verify` are the
 * two network calls; `protect` composes "fetch config → load script → render →
 * resolve token" so a caller renders the central widget with no hardcoded keys.
 */
export function captcha(client: FapiClient) {
  const config = async (action?: string): Promise<CaptchaWidgetConfig | null> => {
    const path = action
      ? `/v1/client/captcha?action=${encodeURIComponent(action)}`
      : '/v1/client/captcha';
    const res = await client.get<CaptchaWidgetConfig>(path);
    return res.ok ? res.data : null;
  };

  const verify = async (token: string, action?: string): Promise<CaptchaVerification | null> => {
    const res = await client.post<CaptchaVerification>('/v1/client/captcha/verify', {
      token,
      ...(action ? { action } : {}),
    });
    return res.ok ? res.data : null;
  };

  const protect = async (element: HTMLElement, action?: string): Promise<string> => {
    const cfg = await config(action);
    if (!cfg) throw new Error('Could not load the captcha configuration.');
    if (cfg.provider === 'atlas') {
      // Atlas's own captcha: no site key, the challenge comes from this client's FAPI.
      const path = `/v1/client/captcha/challenge${action ? `?action=${encodeURIComponent(action)}` : ''}`;
      return renderAtlasCaptcha(element, {
        mode: cfg.widget_mode,
        fetchChallenge: async (accessible) => {
          const res = await client.get<AtlasChallenge>(
            accessible ? `${path}${action ? '&' : '?'}accessible=true` : path,
          );
          if (!res.ok || !res.data) throw new Error('Could not load the captcha challenge.');
          return res.data;
        },
      }).token;
    }
    if (cfg.provider === 'vercel_botid') {
      // No widget: the app's own Vercel route signs a BotID verdict.
      if (!cfg.attestation_url) {
        throw new Error('Vercel BotID needs an attestation URL (captcha.attestationUrl) to fetch a verdict from.');
      }
      return fetchBotIdAttestation(cfg.attestation_url);
    }
    if (cfg.provider === 'none' || !cfg.site_key) {
      throw new Error(
        `No renderable captcha provider is configured${action ? ` for "${action}"` : ''}.`,
      );
    }
    const scriptSrc = PROVIDER_SCRIPTS[cfg.provider];
    if (!scriptSrc) throw new Error(`Captcha provider "${cfg.provider}" has no browser widget.`);
    const src = typeof scriptSrc === 'function' ? scriptSrc(cfg.site_key) : scriptSrc;
    await loadCaptchaScript(src);
    return renderWidget(cfg.provider, cfg.site_key, element, action, cfg.widget_mode);
  };

  return { config, verify, protect };
}
