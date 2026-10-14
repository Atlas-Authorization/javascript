// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  flowNeedsCaptcha,
  isCaptchaError,
  isRenderableCaptcha,
  loadCaptchaProvider,
  renderCaptchaWidget,
} from './captcha-widget';

const win = window as unknown as Record<string, unknown>;

afterEach(() => {
  for (const g of ['turnstile', 'hcaptcha', 'grecaptcha']) delete win[g];
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
