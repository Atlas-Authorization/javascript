import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import { h } from './h';
import { AtlasProvider } from './provider';
import { SIGN_UP_TEXT, SignIn, SignUp } from './widgets';

/**
 * `<SignUp>` really creates the account (POST /v1/client/sign_ups, then the
 * emailed code), draws the configured captcha, sends its token, and recovers
 * from a refused token; `<SignIn>` answers the `needs_captcha` step. The
 * provider is a fake Turnstile global, so the shared `@atlasauth/js` renderer
 * runs against it with no network; FAPI is a scripted fetch.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
type Route = (call: Call) => Response | undefined;

function fakeTurnstile() {
  const widgets: { el: HTMLElement; opts: Record<string, unknown> }[] = [];
  const api = {
    render: vi.fn((el: HTMLElement, opts: Record<string, unknown>) => {
      widgets.push({ el, opts });
      return `w${widgets.length}`;
    }),
    remove: vi.fn(),
    execute: vi.fn(),
  };
  (window as unknown as Record<string, unknown>).turnstile = api;
  return {
    api,
    solve(token: string) {
      (widgets[widgets.length - 1]!.opts.callback as (t: string) => void)(token);
    },
  };
}

let calls: Call[] = [];
beforeEach(() => {
  calls = [];
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).turnstile;
  vi.unstubAllGlobals();
});

async function mountFlow(
  component: typeof SignIn | typeof SignUp,
  opts: { captchaFlows?: Record<string, unknown>; emailDelivery?: Record<string, unknown>; routes: Route[] },
) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (call.path === '/v1/client') return json({ session: null, user: null });
    if (call.path === '/v1/appearance') {
      return json({
        object: 'appearance',
        appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] },
        captchaFlows: opts.captchaFlows ?? {},
        ...(opts.emailDelivery ? { email_delivery: opts.emailDelivery } : {}),
      });
    }
    for (const route of opts.routes) {
      const res = route(call);
      if (res) return res;
    }
    return json({});
  }) as unknown as typeof fetch;
  // The flow's FAPI client uses the global fetch; the provider takes fetchImpl.
  vi.stubGlobal('fetch', fetchImpl);
  const { container } = render(() =>
    h(AtlasProvider, { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl }, h(component, {})),
  );
  await vi.waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance')).toBe(true));
  await new Promise((r) => setTimeout(r, 0));
  return container as HTMLElement;
}

function setInput(el: HTMLElement, name: string, value: string) {
  const input = el.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  expect(input, `input[name=${name}]`).not.toBeNull();
  input.value = value;
}

function submit(el: HTMLElement) {
  el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);
const TURNSTILE = { enabled: true, provider: 'turnstile', siteKey: 'ts-site', widget: 'managed' };

describe('<SignUp> creates the account', () => {
  it('posts /v1/client/sign_ups (not sign_ins), then verifies the emailed code and exchanges the ticket', async () => {
    const el = await mountFlow(SignUp, {
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ups'
            ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201)
            : undefined,
        (c) =>
          c.path === '/v1/client/sign_ups/sua_1/attempt_verification'
            ? json({ id: 'sua_1', status: 'complete', ticket: 'tkt_1' })
            : undefined,
      ],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    expect(el.querySelector('.atlas-captcha')).toBeNull();

    setInput(el, 'email', 'new@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());

    expect(posts('/v1/client/sign_ins')).toHaveLength(0);
    expect(posts('/v1/client/sign_ups')[0]!.body).toEqual({
      email: 'new@example.com',
      password: 'blue tangerine anvil 71!',
      consent: true,
    });

    setInput(el, 'code', '424242');
    submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups/sua_1/attempt_verification')[0]!.body).toEqual({ code: '424242' });
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toEqual({ attempt_id: 'sua_1', ticket: 'tkt_1', return_refresh_token: true });
  });
});

describe('<SignUp> captcha', () => {
  it('draws the configured widget and sends its token as captcha_token on create', async () => {
    const ts = fakeTurnstile();
    const el = await mountFlow(SignUp, {
      captchaFlows: { signUp: TURNSTILE },
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ups'
            ? json({ id: 'sua_2', status: 'needs_email_verification' }, 201)
            : undefined,
      ],
    });

    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    const [host, params] = ts.api.render.mock.calls[0]!;
    expect((host as HTMLElement).classList.contains('atlas-captcha')).toBe(true);
    expect(params).toMatchObject({ sitekey: 'ts-site', appearance: 'always' });

    setInput(el, 'email', 'cap@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    ts.solve('tok-1');
    submit(el);

    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups')[0]!.body).toMatchObject({
      email: 'cap@example.com',
      captcha_token: 'tok-1',
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
  });

  it('on CAPTCHA_FAILED shows the message, draws a fresh widget, keeps the typed values and sends the NEW token', async () => {
    const ts = fakeTurnstile();
    let tries = 0;
    const el = await mountFlow(SignUp, {
      captchaFlows: { signUp: TURNSTILE },
      routes: [
        (c) => {
          if (c.path !== '/v1/client/sign_ups') return undefined;
          tries += 1;
          return tries === 1
            ? json({ errors: [{ code: 'CAPTCHA_FAILED', message: 'x', param: 'captcha_token' }] }, 400)
            : json({ id: 'sua_3', status: 'needs_email_verification' }, 201);
        },
      ],
    });
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));

    setInput(el, 'email', 'retry@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    ts.solve('tok-bad');
    submit(el);

    await vi.waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(SIGN_UP_TEXT['captcha.failed']),
    );
    expect(ts.api.remove).toHaveBeenCalledWith('w1');
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(2));
    expect((el.querySelector('input[name="email"]') as HTMLInputElement).value).toBe('retry@example.com');

    ts.solve('tok-good');
    submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(2));
    expect(posts('/v1/client/sign_ups')[1]!.body).toMatchObject({ captcha_token: 'tok-good' });
  });
});

describe('<SignIn> captcha', () => {
  it('answers needs_captcha: draws the widget and, once solved, re-sends the identifier with the token', async () => {
    const ts = fakeTurnstile();
    const el = await mountFlow(SignIn, {
      captchaFlows: { signIn: { ...TURNSTILE, enabled: false } },
      routes: [
        (c) => {
          if (c.path !== '/v1/client/sign_ins') return undefined;
          return c.body?.captcha_token
            ? json({ id: 'sia_1', status: 'needs_first_factor', supported_first_factors: [{ strategy: 'password' }] }, 201)
            : json({ id: null, status: 'needs_captcha', identifier: 'me@example.com' }, 201);
        },
      ],
    });

    await vi.waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
    expect(el.querySelector('.atlas-captcha')).toBeNull();
    setInput(el, 'identifier', 'me@example.com');
    submit(el);

    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    expect(el.textContent).toContain(SIGN_UP_TEXT['captcha.prompt']);

    ts.solve('tok-si');
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins')).toHaveLength(2));
    expect(posts('/v1/client/sign_ins')[1]!.body).toEqual({
      identifier: 'me@example.com',
      captcha_token: 'tok-si',
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
  });
});

describe('email delivery', () => {
  const NO_EMAIL = { available: false, password_reset: false, password_sign_up: false };

  it('<SignUp> shows the "can\'t send email" notice instead of the email + password form', async () => {
    const el = await mountFlow(SignUp, { emailDelivery: NO_EMAIL, routes: [] });
    await vi.waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(SIGN_UP_TEXT['signUp.emailUnavailable']),
    );
    expect(SIGN_UP_TEXT['signUp.emailUnavailable']).toBe(
      "This app can't send email right now. Try another sign-in method or contact the app owner.",
    );
    expect(el.querySelector('input[name="password"]')).toBeNull();
    expect(el.querySelector('input[name="email"]')).toBeNull();
    expect(el.querySelector('button[type="submit"]')).toBeNull();
  });

  it('<SignUp> keeps the form when the server omits email_delivery', async () => {
    const el = await mountFlow(SignUp, { routes: [] });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    expect(el.textContent).not.toContain(SIGN_UP_TEXT['signUp.emailUnavailable']);
  });

  const toFirstFactor: Route = (c) =>
    c.path === '/v1/client/sign_ins'
      ? json({ id: 'sia_9', status: 'needs_first_factor', supported_first_factors: ['password', 'email_code'] }, 201)
      : undefined;

  it('<SignIn> hides email_code from the first-factor choice when email is unavailable', async () => {
    const el = await mountFlow(SignIn, { emailDelivery: NO_EMAIL, routes: [toFirstFactor] });
    setInput(el, 'identifier', 'me@example.com');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    expect(el.textContent).not.toContain('Email me a code');
  });

  it('<SignIn> offers email_code when email can be delivered, and submits the emailed code', async () => {
    const el = await mountFlow(SignIn, {
      routes: [
        toFirstFactor,
        (c) => (c.path === '/v1/client/sign_ins/sia_9/prepare_first_factor' ? json({}) : undefined),
      ],
    });
    setInput(el, 'identifier', 'me@example.com');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    const button = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Email me a code');
    expect(button).toBeDefined();
    button!.click();
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_9/prepare_first_factor')[0]!.body).toEqual({ strategy: 'email_code' });
    expect(el.querySelector('input[name="password"]')).toBeNull();

    setInput(el, 'code', '123456');
    submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/sia_9/attempt_first_factor')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_9/attempt_first_factor')[0]!.body).toEqual({
      strategy: 'email_code',
      code: '123456',
    });
  });

  it('<SignIn> with no password on offer emails the code by itself and never shows a password field', async () => {
    const el = await mountFlow(SignIn, {
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ins'
            ? json({ id: 'sia_9', status: 'needs_first_factor', supported_first_factors: ['email_code', 'passkey'] }, 201)
            : undefined,
        (c) => (c.path === '/v1/client/sign_ins/sia_9/prepare_first_factor' ? json({}) : undefined),
      ],
    });
    setInput(el, 'identifier', 'me@example.com');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    expect(el.querySelector('input[name="password"]')).toBeNull();
    expect(posts('/v1/client/sign_ins/sia_9/prepare_first_factor')).toHaveLength(1);
    expect(posts('/v1/client/sign_ins/sia_9/prepare_first_factor')[0]!.body).toEqual({ strategy: 'email_code' });
    expect(el.querySelector('[data-atlas-resend]')).not.toBeNull();

    setInput(el, 'code', '123456');
    submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/sia_9/attempt_first_factor')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_9/attempt_first_factor')[0]!.body).toEqual({
      strategy: 'email_code',
      code: '123456',
    });
  });
});
