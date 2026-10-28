// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { SignUp } from './sign-up';
import { SignIn } from './sign-in';
import { EMAIL_UNAVAILABLE_MESSAGE } from '@atlasauth/js';
import { EN_US } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ATL-01: switching captcha on for an instance must "just work" in the prebuilt
 * components. `<SignUp>` really creates the account (POST /v1/client/sign_ups,
 * then the emailed code), draws the configured widget, sends its token, and
 * recovers from a refused token; `<SignIn>` answers the `needs_captcha` step.
 *
 * The provider is a fake Turnstile global, so the real shared renderer runs
 * against it with no network; FAPI is a scripted fetch.
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

/** A fake Turnstile: records each render, lets a test solve the latest widget. */
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
    widgets,
    solve(token: string) {
      const w = widgets[widgets.length - 1]!;
      (w.opts.callback as (t: string) => void)(token);
    },
  };
}

let unmount: (() => void) | null = null;
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  unmount?.();
  unmount = null;
  delete (window as unknown as Record<string, unknown>).turnstile;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(
  component: typeof SignUp | typeof SignIn,
  opts: {
    captchaFlows?: Record<string, unknown>;
    emailDelivery?: Record<string, boolean>;
    account?: Record<string, unknown>;
    routes: Route[];
  },
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
        ...(opts.account ? { account: opts.account } : {}),
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

  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      createElement(AtlasProvider, {
        publishableKey: 'pk_test_x',
        frontendApi: FAPI,
        fetchImpl,
        appearance: { instanceDesign: false },
        children: createElement(component),
      }),
    );
  });
  unmount = () => act(() => root.unmount());
  return el;
}

function setInput(el: HTMLElement, name: string, value: string) {
  const input = el.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  expect(input, `input[name=${name}]`).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(el: HTMLElement) {
  const form = el.querySelector('form')!;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

const TURNSTILE = { enabled: true, provider: 'turnstile', siteKey: 'ts-site', widget: 'managed' };

describe('<SignUp> creates the account', () => {
  it('posts /v1/client/sign_ups (not sign_ins), then verifies the emailed code and exchanges the ticket', async () => {
    const el = await mount(SignUp, {
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

    // The create-account form, with no captcha when none is configured.
    expect(el.querySelector('input[name="password"]')).not.toBeNull();
    expect(el.querySelector('.atlas-captcha')).toBeNull();

    setInput(el, 'email', 'new@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());

    expect(posts('/v1/client/sign_ins')).toHaveLength(0);
    expect(posts('/v1/client/sign_ups')[0]!.body).toEqual({
      email: 'new@example.com',
      password: 'blue tangerine anvil 71!',
      consent: true,
      device_id: expect.stringMatching(/^d_/),
    });

    setInput(el, 'code', '424242');
    await submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups/sua_1/attempt_verification')[0]!.body).toEqual({ code: '424242' });
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toEqual({ attempt_id: 'sua_1', ticket: 'tkt_1', return_refresh_token: true });
  });
});

describe('<SignUp> captcha', () => {
  it('draws the configured widget and sends its token as captcha_token on create', async () => {
    const ts = fakeTurnstile();
    const el = await mount(SignUp, {
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
    await act(async () => ts.solve('tok-1'));
    await submit(el);

    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups')[0]!.body).toMatchObject({
      email: 'cap@example.com',
      captcha_token: 'tok-1',
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
  });

  it('on CAPTCHA_FAILED shows the localized message, draws a fresh widget and sends the NEW token next time', async () => {
    const ts = fakeTurnstile();
    let tries = 0;
    const el = await mount(SignUp, {
      captchaFlows: { signUp: TURNSTILE },
      routes: [
        (c) => {
          if (c.path !== '/v1/client/sign_ups') return undefined;
          tries += 1;
          return tries === 1
            ? json(
                {
                  errors: [
                    { code: 'CAPTCHA_FAILED', message: 'That captcha could not be verified.', param: 'captcha_token' },
                  ],
                },
                400,
              )
            : json({ id: 'sua_3', status: 'needs_email_verification' }, 201);
        },
      ],
    });
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));

    setInput(el, 'email', 'retry@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    await act(async () => ts.solve('tok-bad'));
    await submit(el);

    await vi.waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(EN_US['captcha.failed']),
    );
    // The spent widget was removed and a fresh one drawn.
    expect(ts.api.remove).toHaveBeenCalledWith('w1');
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(2));
    // The typed values survive the refusal.
    expect((el.querySelector('input[name="email"]') as HTMLInputElement).value).toBe('retry@example.com');

    await act(async () => ts.solve('tok-good'));
    await submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(2));
    expect(posts('/v1/client/sign_ups')[1]!.body).toMatchObject({ captcha_token: 'tok-good' });
  });

  it('on CAPTCHA_REQUIRED shows the "complete the security check" message', async () => {
    fakeTurnstile();
    const el = await mount(SignUp, {
      captchaFlows: { signUp: TURNSTILE },
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ups'
            ? json({ errors: [{ code: 'CAPTCHA_REQUIRED', message: 'x', param: 'captcha_token' }] }, 400)
            : undefined,
      ],
    });
    // Make the widget fail so no token is sent at all.
    const ts = (window as unknown as { turnstile: { render: ReturnType<typeof vi.fn> } }).turnstile;
    await vi.waitFor(() => expect(ts.render).toHaveBeenCalled());
    const opts = ts.render.mock.calls[ts.render.mock.calls.length - 1]![1] as { 'error-callback': () => void };
    await act(async () => opts['error-callback']());

    setInput(el, 'email', 'req@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await vi.waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(EN_US['captcha.required']),
    );
  });

  it('runs an invisible widget only when the form is submitted', async () => {
    const ts = fakeTurnstile();
    ts.api.render.mockImplementation((el: HTMLElement, opts: Record<string, unknown>) => {
      ts.widgets.push({ el, opts });
      // An invisible widget solves on execute without user interaction.
      setTimeout(() => (opts.callback as (t: string) => void)('tok-inv'), 0);
      return `w${ts.widgets.length}`;
    });
    const el = await mount(SignUp, {
      captchaFlows: { signUp: { ...TURNSTILE, widget: 'invisible' } },
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ups'
            ? json({ id: 'sua_4', status: 'needs_email_verification' }, 201)
            : undefined,
      ],
    });
    await vi.waitFor(() => expect(el.querySelector('.atlas-captcha')).not.toBeNull());
    expect(ts.api.render).not.toHaveBeenCalled();

    setInput(el, 'email', 'inv@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    expect(ts.api.render.mock.calls[0]![1]).toMatchObject({ appearance: 'interaction-only' });
    expect(ts.api.execute).toHaveBeenCalledWith('w1');
    expect(posts('/v1/client/sign_ups')[0]!.body).toMatchObject({ captcha_token: 'tok-inv' });
  });
});

describe('<SignIn> captcha', () => {
  it('answers needs_captcha: draws the widget and, once solved, re-sends the identifier with the token', async () => {
    const ts = fakeTurnstile();
    const el = await mount(SignIn, {
      // Risk-triggered: the provider resolves but sign-in is not always-on.
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

    // Not always-on: the identifier step draws nothing.
    expect(el.querySelector('.atlas-captcha')).toBeNull();
    setInput(el, 'identifier', 'me@example.com');
    await submit(el);

    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    expect(el.textContent).toContain(EN_US['captcha.prompt']);

    await act(async () => ts.solve('tok-si'));
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins')).toHaveLength(2));
    expect(posts('/v1/client/sign_ins')[1]!.body).toEqual({
      identifier: 'me@example.com',
      captcha_token: 'tok-si',
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
  });

  it('a rejected token comes back as the same challenge: says so and draws a fresh widget', async () => {
    const ts = fakeTurnstile();
    const el = await mount(SignIn, {
      captchaFlows: { signIn: TURNSTILE },
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ins'
            ? json({ id: null, status: 'needs_captcha', identifier: 'me@example.com' }, 201)
            : undefined,
      ],
    });

    // Always-on: the widget is on the identifier step, and the first POST carries it.
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    setInput(el, 'identifier', 'me@example.com');
    await act(async () => ts.solve('tok-rejected'));
    await submit(el);

    await vi.waitFor(() => expect(posts('/v1/client/sign_ins')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins')[0]!.body).toEqual({
      identifier: 'me@example.com',
      captcha_token: 'tok-rejected',
    });
    await vi.waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(EN_US['captcha.failed']),
    );
    await vi.waitFor(() => expect(ts.api.render.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('email delivery', () => {
  const NO_EMAIL = { available: false, password_reset: false, password_sign_up: false };

  it('<SignUp> shows the "can\'t send email" notice instead of the form when password sign-up cannot complete', async () => {
    const el = await mount(SignUp, { emailDelivery: NO_EMAIL, routes: [] });
    await vi.waitFor(() => expect(el.textContent).toContain(EN_US['signUp.emailUnavailable']));
    expect(EN_US['signUp.emailUnavailable']).toBe(EMAIL_UNAVAILABLE_MESSAGE);
    expect(el.querySelector('input[name="password"]')).toBeNull();
    expect(el.querySelector('input[name="email"]')).toBeNull();
    expect(el.querySelector('form')).toBeNull();
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('<SignUp> keeps the form when only email is unavailable but sign-up can still complete', async () => {
    const el = await mount(SignUp, {
      emailDelivery: { available: false, password_reset: false, password_sign_up: true },
      routes: [],
    });
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance')).toBe(true));
    await act(async () => undefined);
    expect(el.querySelector('input[name="password"]')).not.toBeNull();
    expect(el.textContent).not.toContain(EN_US['signUp.emailUnavailable']);
  });

  const firstFactor = (strategies: string[]): Route => (c) =>
    c.path === '/v1/client/sign_ins'
      ? json({ id: 'sia_1', status: 'needs_first_factor', supported_first_factors: strategies }, 201)
      : undefined;

  it('<SignIn> does not offer an email-only first factor when email cannot be delivered', async () => {
    const el = await mount(SignIn, { emailDelivery: NO_EMAIL, routes: [firstFactor(['email_code', 'email_link'])] });
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance')).toBe(true));
    setInput(el, 'identifier', 'me@example.com');
    await submit(el);
    await vi.waitFor(() => expect(el.textContent).toContain(EN_US['signUp.emailUnavailable']));
    expect(el.querySelector('input[name="password"]')).toBeNull();
    expect(el.querySelector('button[type="submit"]')).toBeNull();
  });

  it('<SignIn> still collects the password when it is offered beside email code', async () => {
    const el = await mount(SignIn, { emailDelivery: NO_EMAIL, routes: [firstFactor(['password', 'email_code'])] });
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance')).toBe(true));
    setInput(el, 'identifier', 'me@example.com');
    await submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    expect(el.textContent).not.toContain(EN_US['signUp.emailUnavailable']);
  });

  it('<SignIn> leaves the first factor alone when the server says nothing about email delivery', async () => {
    const el = await mount(SignIn, { routes: [firstFactor(['email_code'])] });
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance')).toBe(true));
    setInput(el, 'identifier', 'me@example.com');
    await submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins')).toHaveLength(1));
    // Not filtered out: the offered email code is sent, and never a password box.
    await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith('/prepare_first_factor'))).toBe(true));
    expect(el.querySelector('[data-atlas-email-unavailable]')).toBeNull();
    expect(el.querySelector('input[name="password"]')).toBeNull();
  });
});

describe('<SignUp> passkey-only sign-up', () => {
  const ACCOUNT = {
    username: null,
    last_sign_in_method: false,
    email_verification: 'code',
    password_reset: 'code',
    email_second_factor: false,
    passkey_sign_up: { email: 'optional' },
  };

  function fakeWebAuthn() {
    const create = vi.fn(async () => ({
      rawId: new Uint8Array([1, 2, 3]).buffer,
      response: {
        attestationObject: new Uint8Array([4, 5, 6]).buffer,
        clientDataJSON: new Uint8Array([7, 8, 9]).buffer,
      },
    }));
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create, get: vi.fn() } });
    return create;
  }

  it('offers a passkey form (no password), then creates the passkey and the account', async () => {
    const create = fakeWebAuthn();
    const el = await mount(SignUp, {
      account: ACCOUNT,
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ups/passkey'
            ? json(
                {
                  id: 'sua_pk',
                  object: 'sign_up_attempt',
                  status: 'needs_first_factor',
                  strategy: 'passkey',
                  supported_first_factors: ['passkey'],
                  poll_secret: 'ps_1',
                },
                201,
              )
            : undefined,
        (c) =>
          c.path === '/v1/client/sign_ups/sua_pk/passkey/begin'
            ? json(
                {
                  challenge: 'Y2hhbGxlbmdl',
                  rp: { id: 'example.com', name: 'Atlas' },
                  user: { id: 'dXNlcl8x', name: 'user_1', displayName: 'user_1' },
                  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                  excludeCredentials: [],
                },
                201,
              )
            : undefined,
        (c) =>
          c.path === '/v1/client/sign_ups/sua_pk/passkey/finish'
            ? json({ id: 'sua_pk', object: 'sign_up_attempt', status: 'complete', ticket: 'tkt_pk' })
            : undefined,
      ],
    });

    const toggle = await vi.waitFor(() => {
      const button = el.querySelector('[data-atlas-sign-up-mode="passkey"]') as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => toggle.click());
    expect(el.querySelector('input[name="password"]')).toBeNull();
    expect((el.querySelector('input[name="email"]') as HTMLInputElement).required).toBe(false);

    setInput(el, 'email', 'pk@example.com');
    await submit(el);
    expect(posts('/v1/client/sign_ups/passkey')[0]!.body).toEqual({ email: 'pk@example.com', consent: true });
    expect(posts('/v1/client/sign_ups')).toHaveLength(0);

    const createButton = await vi.waitFor(() => {
      const step = el.querySelector('[data-atlas-passkey-sign-up] button') as HTMLButtonElement | null;
      expect(step).not.toBeNull();
      return step!;
    });
    await act(async () => createButton.click());
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(posts('/v1/client/sign_ups/sua_pk/passkey/begin')[0]!.body).toEqual({ poll_secret: 'ps_1' });
    expect(posts('/v1/client/sign_ups/sua_pk/passkey/finish')[0]!.body).toMatchObject({
      poll_secret: 'ps_1',
      challenge: 'Y2hhbGxlbmdl',
      attestation_object: 'BAUG',
      client_data_json: 'BwgJ',
    });
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toMatchObject({ attempt_id: 'sua_pk', ticket: 'tkt_pk' });
  });

  it('shows no passkey option when the instance does not offer it', async () => {
    fakeWebAuthn();
    const el = await mount(SignUp, { account: { ...ACCOUNT, passkey_sign_up: null }, routes: [] });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-sign-up-mode]')).toBeNull();
  });
});

describe('<SignUp> link-only verification', () => {
  it('says to open the emailed link (no code field, no submit) and finishes when the poll completes', async () => {
    let opened = false;
    const el = await mount(SignUp, {
      account: { username: null, last_sign_in_method: false, email_verification: 'link', password_reset: 'code' },
      routes: [
        (c) =>
          c.method === 'POST' && c.path === '/v1/client/sign_ups'
            ? json({ id: 'sua_l', object: 'sign_up_attempt', status: 'needs_email_verification', identifier: 'l@example.com', poll_secret: 'ps_l' }, 201)
            : undefined,
        (c) =>
          c.method === 'GET' && c.path === '/v1/client/sign_ups/sua_l'
            ? json(
                opened
                  ? { id: 'sua_l', object: 'sign_up_attempt', status: 'complete', ticket: 'tkt_l' }
                  : { id: 'sua_l', object: 'sign_up_attempt', status: 'needs_email_verification' },
              )
            : undefined,
      ],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    setInput(el, 'email', 'l@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);

    const notice = await vi.waitFor(() => {
      const p = el.querySelector('[data-atlas-link-sent]');
      expect(p).not.toBeNull();
      return p!;
    });
    expect(notice.textContent).toContain('confirmation link to l@example.com');
    expect(el.querySelector('input[name="code"]')).toBeNull();
    expect(el.querySelector('button[type="submit"]')).toBeNull();
    expect(el.querySelector('[data-atlas-resend]')?.textContent).toBe('Resend link');

    opened = true;
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1), { timeout: 6000 });
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toMatchObject({ attempt_id: 'sua_l', ticket: 'tkt_l' });
  }, 10_000);
});
