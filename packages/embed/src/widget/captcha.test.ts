// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { flowNeedsCaptcha, getCaptchaToken, isRenderable } from './captcha';
import type { FlowCaptcha } from '../appearance';

afterEach(() => {
  // Clear any vendor globals a test installed.
  for (const g of ['turnstile', 'hcaptcha', 'grecaptcha']) {
    delete (window as unknown as Record<string, unknown>)[g];
  }
});

describe('isRenderable', () => {
  it('accepts the widget providers and rejects score/edge/none', () => {
    for (const p of ['turnstile', 'hcaptcha', 'recaptcha', 'recaptcha_v3', 'recaptcha_enterprise']) {
      expect(isRenderable(p)).toBe(true);
    }
    for (const p of ['none', 'seon', 'perimeterx', 'akamai', 'kasada', 'incapsula', 'awswaf', 'mcaptcha', undefined]) {
      expect(isRenderable(p)).toBe(false);
    }
  });
});

describe('flowNeedsCaptcha', () => {
  it('is true only when enabled AND the provider is renderable', () => {
    expect(flowNeedsCaptcha({ enabled: true, provider: 'turnstile' })).toBe(true);
    expect(flowNeedsCaptcha({ enabled: false, provider: 'turnstile' })).toBe(false);
    expect(flowNeedsCaptcha({ enabled: true, provider: 'seon' })).toBe(false);
    expect(flowNeedsCaptcha(undefined)).toBe(false);
  });
});

describe('getCaptchaToken', () => {
  const container = () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  };

  it('renders Turnstile and resolves the callback token (managed)', async () => {
    (window as unknown as Record<string, unknown>).turnstile = {
      render: (_el: HTMLElement, opts: { callback: (t: string) => void }) => {
        // Simulate the provider solving asynchronously.
        setTimeout(() => opts.callback('ts-token'), 0);
        return 'w1';
      },
    };
    const flow: FlowCaptcha = { enabled: true, provider: 'turnstile', siteKey: 'sk', widget: 'managed' };
    expect(await getCaptchaToken(flow, container())).toBe('ts-token');
  });

  it('executes an invisible Turnstile widget', async () => {
    let executed = false;
    (window as unknown as Record<string, unknown>).turnstile = {
      render: (_el: HTMLElement, opts: { callback: (t: string) => void }) => {
        setTimeout(() => opts.callback('inv-token'), 0);
        return 'w2';
      },
      execute: () => {
        executed = true;
      },
    };
    const flow: FlowCaptcha = { enabled: true, provider: 'turnstile', siteKey: 'sk', widget: 'invisible' };
    expect(await getCaptchaToken(flow, container())).toBe('inv-token');
    expect(executed).toBe(true);
  });

  it('executes reCAPTCHA v3 with no visible widget', async () => {
    (window as unknown as Record<string, unknown>).grecaptcha = {
      ready: (cb: () => void) => cb(),
      execute: (siteKey: string, opts: { action: string }) => {
        expect(siteKey).toBe('v3-key');
        expect(opts.action).toBe('submit');
        return Promise.resolve('v3-token');
      },
      render: () => 0,
    };
    const flow: FlowCaptcha = { enabled: true, provider: 'recaptcha_v3', siteKey: 'v3-key' };
    expect(await getCaptchaToken(flow, container())).toBe('v3-token');
  });

  it('rejects a provider it cannot render', async () => {
    const flow: FlowCaptcha = { enabled: true, provider: 'seon', siteKey: 'x' };
    await expect(getCaptchaToken(flow, container())).rejects.toThrow(/not renderable/);
  });
});
