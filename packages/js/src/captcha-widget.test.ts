// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchBotIdAttestation,
  flowNeedsCaptcha,
  isCaptchaError,
  isRenderableCaptcha,
  loadCaptchaProvider,
  renderCaptchaWidget,
} from './captcha-widget';

const win = window as unknown as Record<string, unknown>;

afterEach(() => {
  for (const g of ['turnstile', 'hcaptcha', 'grecaptcha', 'captchafox']) delete win[g];
  for (const k of Object.keys(win)) if (k.startsWith('__atlasCaptchaLoad_')) delete win[k];
});

const container = () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
};

describe('captcha widget helpers', () => {
  it('classifies renderable providers, always-on flows and captcha errors', () => {
    expect(isRenderableCaptcha('turnstile')).toBe(true);
    expect(isRenderableCaptcha('seon')).toBe(false);
    expect(flowNeedsCaptcha({ enabled: true, provider: 'hcaptcha', siteKey: 'k' })).toBe(true);
    expect(flowNeedsCaptcha({ enabled: false, provider: 'hcaptcha' })).toBe(false);
    expect(flowNeedsCaptcha(null)).toBe(false);
    expect(isCaptchaError({ code: 'CAPTCHA_FAILED' })).toBe(true);
    expect(isCaptchaError({ code: 'CAPTCHA_REQUIRED' })).toBe(true);
    expect(isCaptchaError({ code: 'VALIDATION_FAILED' })).toBe(false);
  });
});

describe('renderCaptchaWidget', () => {
  it('remove() tears the widget down, empties the container and rejects the pending token', async () => {
    const remove = vi.fn();
    win.turnstile = {
      render: (el: HTMLElement) => {
        el.appendChild(document.createElement('iframe'));
        return 'w1';
      },
      remove,
    };
    const el = container();
    const handle = renderCaptchaWidget({ enabled: true, provider: 'turnstile', siteKey: 'k' }, el);
    await vi.waitFor(() => expect(el.querySelector('iframe')).not.toBeNull());
    handle.remove();
    expect(remove).toHaveBeenCalledWith('w1');
    expect(el.childNodes).toHaveLength(0);
    await expect(handle.token).rejects.toThrow(/removed/);
  });

  it('passes hCaptcha the invisible size and resolves the execute() response', async () => {
    const render = vi.fn((_el: HTMLElement, _opts: Record<string, unknown>) => 'h1');
    win.hcaptcha = { render, execute: vi.fn(async () => ({ response: 'hc-token' })) };
    const handle = renderCaptchaWidget(
      { enabled: true, provider: 'hcaptcha', siteKey: 'k', widget: 'invisible' },
      container(),
    );
    expect(await handle.token).toBe('hc-token');
    expect(render.mock.calls[0]![1]).toMatchObject({ sitekey: 'k', size: 'invisible' });
  });
});

describe('CaptchaFox', () => {
  it('renders inline with the site key and resolves onVerify', async () => {
    const render = vi.fn(async (_el: HTMLElement, opts: Record<string, unknown>) => {
      setTimeout(() => (opts.onVerify as (t: string) => void)('cf-token'), 0);
      return 'cf1';
    });
    const remove = vi.fn();
    win.captchafox = { render, remove };
    const handle = renderCaptchaWidget({ enabled: true, provider: 'captchafox', siteKey: 'k' }, container());
    expect(await handle.token).toBe('cf-token');
    expect(render.mock.calls[0]![1]).toMatchObject({ sitekey: 'k', mode: 'inline' });
    handle.remove();
    expect(remove).toHaveBeenCalledWith('cf1');
  });

  it('runs hidden mode through execute() for an invisible widget', async () => {
    const render = vi.fn(async () => 'cf2');
    const execute = vi.fn(async () => 'cf-hidden-token');
    win.captchafox = { render, execute };
    const handle = renderCaptchaWidget({ enabled: true, provider: 'captchafox', siteKey: 'k', widget: 'invisible' }, container());
    expect(await handle.token).toBe('cf-hidden-token');
    expect(execute).toHaveBeenCalledWith('cf2');
    expect((render.mock.calls[0] as unknown[])[1]).toMatchObject({ mode: 'hidden' });
  });
});

describe('Vercel BotID', () => {
  it('is renderable only when the flow names its attestation route', () => {
    expect(isRenderableCaptcha('vercel_botid')).toBe(false);
    expect(isRenderableCaptcha('vercel_botid', { attestationUrl: '/api/atlas/botid' })).toBe(true);
    expect(flowNeedsCaptcha({ enabled: true, provider: 'vercel_botid' })).toBe(false);
    expect(flowNeedsCaptcha({ enabled: true, provider: 'vercel_botid', attestationUrl: '/api/atlas/botid' })).toBe(true);
  });

  it('POSTs the attestation route same-origin and returns its token', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'atlas_botid.v1.a.b' }), { status: 200 }));
    expect(await fetchBotIdAttestation('/api/atlas/botid', fetchImpl as unknown as typeof fetch)).toBe('atlas_botid.v1.a.b');
    expect(fetchImpl).toHaveBeenCalledWith('/api/atlas/botid', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
  });

  it('rejects when the route fails or answers without a token', async () => {
    const down = vi.fn(async () => new Response('{}', { status: 503 }));
    await expect(fetchBotIdAttestation('/x', down as unknown as typeof fetch)).rejects.toThrow(/503/);
    const empty = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(fetchBotIdAttestation('/x', empty as unknown as typeof fetch)).rejects.toThrow(/missing/);
  });

  it('the widget handle resolves the fetched verdict', async () => {
    const original = window.fetch;
    window.fetch = vi.fn(async () => new Response(JSON.stringify({ token: 'atlas_botid.v1.c.d' }), { status: 200 })) as unknown as typeof fetch;
    try {
      const handle = renderCaptchaWidget({ enabled: true, provider: 'vercel_botid', attestationUrl: '/api/atlas/botid' }, container());
      expect(await handle.token).toBe('atlas_botid.v1.c.d');
    } finally {
      window.fetch = original;
    }
  });
});

describe('loadCaptchaProvider', () => {
  /** A window whose document records the injected script (no real network load). */
  function fakeWindow() {
    const scripts: { src: string; on: Record<string, () => void> }[] = [];
    const w: Record<string, unknown> = {
      document: {
        querySelector: () => null,
        createElement: () => {
          const s = { src: '', async: false, defer: false, on: {} as Record<string, () => void>,
            addEventListener(type: string, fn: () => void) { this.on[type] = fn; } };
          scripts.push(s);
          return s;
        },
        head: { appendChild: () => undefined },
      },
    };
    return { w, scripts };
  }

  it('a failed script load is forgotten, so the next render retries', async () => {
    const { w, scripts } = fakeWindow();
    const first = loadCaptchaProvider('turnstile', 'k', w as never);
    expect(scripts[0]!.src).toContain('challenges.cloudflare.com');
    scripts[0]!.on.error!();
    await expect(first).rejects.toThrow(/failed/);

    const second = loadCaptchaProvider('turnstile', 'k', w as never);
    expect(second).not.toBe(first);
    expect(scripts).toHaveLength(2);
    w.turnstile = { render: () => 'w' };
    scripts[1]!.on.load!();
    await expect(second).resolves.toBe(w.turnstile);
  });
});
