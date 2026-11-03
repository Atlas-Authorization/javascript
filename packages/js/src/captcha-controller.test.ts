// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advanceWithCaptcha,
  createCaptchaController,
  createSignUp,
  localizeCaptchaErrors,
  signInCaptchaOptions,
} from './captcha-controller';
import { fetchInstanceSettings, instanceSettingsFrom, toSignUpInput } from './instance-settings';
import { FapiClient, initialFlow, type FlowState } from './fapi';

const win = window as unknown as Record<string, unknown>;
const TS = { enabled: true, provider: 'turnstile', siteKey: 'k', widget: 'managed' as const };
const t = (key: string) => `[${key}]`;

function fakeTurnstile() {
  const widgets: Record<string, unknown>[] = [];
  const api = {
    render: vi.fn((_el: HTMLElement, opts: Record<string, unknown>) => {
      widgets.push(opts);
      return `w${widgets.length}`;
    }),
    remove: vi.fn(),
    execute: vi.fn(),
  };
  win.turnstile = api;
  return {
    api,
    solve: (token: string) => (widgets[widgets.length - 1]!.callback as (t: string) => void)(token),
  };
}

function scripted(routes: (path: string, body: Record<string, unknown> | null) => unknown) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    const res = routes(path, body) as { status?: number; body: unknown };
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk', baseUrl: 'https://f.example', fetchImpl }), calls };
}

const slot = () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
};

afterEach(() => {
  delete win.turnstile;
});

describe('createCaptchaController', () => {
  it('draws an eager widget on attach, resolves its token, and redraws fresh on reset', async () => {
    const ts = fakeTurnstile();
    const c = createCaptchaController({ flow: TS, active: true });
    expect(c.needed).toBe(true);
    c.attach(slot());
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    ts.solve('tok-1');
    expect(await c.getToken()).toBe('tok-1');
    c.reset();
    expect(ts.api.remove).toHaveBeenCalledWith('w1');
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(2));
    c.destroy();
  });

  it('an invisible widget is executed only on getToken; inactive settings draw nothing', async () => {
    const ts = fakeTurnstile();
    ts.api.render.mockImplementation((_el: HTMLElement, opts: Record<string, unknown>) => {
      setTimeout(() => (opts.callback as (t: string) => void)('tok-inv'), 0);
      return 'w1';
    });
    const c = createCaptchaController({ flow: { ...TS, widget: 'invisible' }, active: true });
    c.attach(slot());
    await Promise.resolve();
    expect(ts.api.render).not.toHaveBeenCalled();
    expect(await c.getToken()).toBe('tok-inv');

    c.configure({ flow: TS, active: false });
    expect(c.needed).toBe(false);
    expect(await c.getToken()).toBeNull();
  });
});

describe('sign-in / sign-up helpers', () => {
  it('signInCaptchaOptions: always-on gates the identifier step; needs_captcha is eager', () => {
    const solved = vi.fn();
    expect(signInCaptchaOptions(TS, initialFlow, solved).active).toBe(true);
    expect(signInCaptchaOptions({ ...TS, enabled: false }, initialFlow, solved).active).toBe(false);
    const challenged: FlowState = { ...initialFlow, attempt: { id: null, status: 'needs_captcha' } as never };
    const opts = signInCaptchaOptions({ ...TS, enabled: false }, challenged, solved);
    expect(opts).toMatchObject({ active: true, eager: true });
    opts.onSolved!('x');
    expect(solved).toHaveBeenCalled();
  });

  it('advanceWithCaptcha re-sends the identifier with the token and flags a rejected token', async () => {
    const ts = fakeTurnstile();
    const { client, calls } = scripted(() => ({
      status: 201,
      body: { id: null, status: 'needs_captcha', identifier: 'me@example.com' },
    }));
    const captcha = createCaptchaController({ flow: TS, active: true });
    captcha.attach(slot());
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    ts.solve('tok-bad');
    const out = await advanceWithCaptcha(client, initialFlow, { identifier: 'me@example.com' }, { captcha, t });
    expect(calls[0]!.body).toEqual({ identifier: 'me@example.com', captcha_token: 'tok-bad' });
    expect(out.identifier).toBe('me@example.com');
    expect(out.state.errors).toEqual([{ code: 'CAPTCHA_FAILED', message: '[captcha.failed]' }]);
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(2));
  });

  it('createSignUp posts sign_ups with the token and resets the widget on CAPTCHA_FAILED', async () => {
    const ts = fakeTurnstile();
    const { client, calls } = scripted(() => ({
      status: 400,
      body: { errors: [{ code: 'CAPTCHA_FAILED', message: 'nope', param: 'captcha_token' }] },
    }));
    const captcha = createCaptchaController({ flow: TS, active: true });
    captcha.attach(slot());
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    ts.solve('tok-1');
    const next = await createSignUp(
      client,
      { email: 'a@b.co', password: 'pw', company: 'Acme', nickname: '' },
      { consent: true, captcha, t },
    );
    expect(calls[0]!.path).toBe('/v1/client/sign_ups');
    expect(calls[0]!.body).toEqual({
      email: 'a@b.co',
      password: 'pw',
      fields: { company: 'Acme' },
      consent: true,
      captcha_token: 'tok-1',
      // The stable device id rides on every sign-up start (accounts-per-device limit).
      device_id: expect.stringMatching(/^d_/),
    });
    expect(next.errors).toEqual([{ code: 'CAPTCHA_FAILED', message: '[captcha.failed]' }]);
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(2));
  });

  it('localizeCaptchaErrors leaves other errors alone', () => {
    const out = localizeCaptchaErrors(
      [{ code: 'CAPTCHA_REQUIRED', message: 'x' }, { code: 'FORM_PASSWORD_PWNED', message: 'y', param: 'password' }],
      t,
    );
    expect(out.captchaRejected).toBe(true);
    expect(out.errors[0]).toEqual({ code: 'CAPTCHA_REQUIRED', message: '[captcha.required]' });
    expect(out.errors[1]!.param).toBe('password');
  });

  it('toSignUpInput / instanceSettingsFrom / fetchInstanceSettings', async () => {
    expect(toSignUpInput({ email: 'e', password: 'p', a: '', b: '1' }, false)).toEqual({
      email: 'e',
      password: 'p',
      fields: { b: '1' },
      consent: false,
    });
    expect(instanceSettingsFrom(null)).toEqual({
      captchaFlows: {},
      signUpFields: [],
      legal: { termsUrl: null, privacyUrl: null, required: false },
      emailDelivery: { available: true, passwordReset: true, passwordSignUp: true },
      account: { username: null, lastSignInMethod: false, emailVerification: 'code', passwordReset: 'code', emailSecondFactor: false, passkeySignUp: null },
      passkeySignIn: false,
    });
    expect(instanceSettingsFrom({ strategies: { passkey: true } }).passkeySignIn).toBe(true);
    const { client } = scripted(() => ({
      body: {
        appearance: { legal: { termsUrl: 'https://t', required: true }, signUpFields: [{ key: 'k', label: 'K' }] },
        captchaFlows: { signUp: { ...TS, secret: 'never' } },
      },
    }));
    const settings = await fetchInstanceSettings(client);
    expect(settings!.captchaFlows.signUp).toEqual(TS);
    expect(settings!.legal).toEqual({ termsUrl: 'https://t', privacyUrl: null, required: true });
    expect(settings!.signUpFields).toHaveLength(1);
  });
});
