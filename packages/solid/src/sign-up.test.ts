import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import { useContext } from 'solid-js';
import { AtlasContext } from './context';
import type { AtlasClient } from './provider';
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

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const JWT = `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
let lastClient: AtlasClient | undefined;
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
  opts: {
    captchaFlows?: Record<string, unknown>;
    emailDelivery?: Record<string, unknown>;
    account?: Record<string, unknown>;
    signInWithAtlas?: Record<string, unknown>;
    signedIn?: () => boolean;
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
    if (call.path === '/v1/client')
      return json(opts.signedIn?.() ? { session: { id: 'sess_1', status: 'active' }, user: { id: 'user_1' }, jwt: JWT } : { session: null, user: null });
    if (call.path === '/v1/appearance') {
      return json({
        object: 'appearance',
        appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] },
        captchaFlows: opts.captchaFlows ?? {},
        ...(opts.emailDelivery ? { email_delivery: opts.emailDelivery } : {}),
        ...(opts.account ? { account: opts.account } : {}),
        ...(opts.signInWithAtlas ? { sign_in_with_atlas: opts.signInWithAtlas } : {}),
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
    h(AtlasProvider, { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl }, () => {
      lastClient = useContext(AtlasContext);
      return h(component, {});
    }),
  );
  await vi.waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance' || c.path.endsWith('/verify'))).toBe(true));
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
      // The stable device id rides on every sign-up start (accounts-per-device limit).
      device_id: expect.stringMatching(/^d_/),
    });

    setInput(el, 'code', '424242');
    submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups/sua_1/attempt_verification')[0]!.body).toEqual({ code: '424242' });
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toEqual({ attempt_id: 'sua_1', ticket: 'tkt_1', return_refresh_token: true });
  });
});

describe('<SignUp> loses a sign-up race at the code step', () => {
  it('shows the server message and a sign-in link', async () => {
    const el = await mountFlow(SignUp, {
      routes: [
        (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
        (c) =>
          c.path === '/v1/client/sign_ups/sua_1/attempt_verification'
            ? json({ errors: [{ code: 'IDENTIFIER_EXISTS', message: 'An account already uses this email address. Sign in instead.', reason: 'form_identifier_exists' }] }, 409)
            : undefined,
      ],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    setInput(el, 'email', 'new@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    setInput(el, 'code', '424242');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toContain('An account already uses this email address. Sign in instead.'));
    const link = el.querySelector('[role="alert"] a');
    expect(link?.textContent).toBe(SIGN_UP_TEXT['signIn.title']);
    expect(link?.getAttribute('href')).toContain('/hosted/sign-in');
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

describe('<SignIn> Sign in with Atlas', () => {
  it('offers "Continue with Atlas" when the instance has it on, and starts the SSO sign-in', async () => {
    const assign = vi.fn();
    const original = Object.getOwnPropertyDescriptor(window, 'location')!;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        href: 'https://app.example.com/login',
        origin: 'https://app.example.com',
        protocol: 'https:',
        host: 'app.example.com',
        hostname: 'app.example.com',
        pathname: '/login',
        search: '',
        hash: '',
        assign,
      },
    });
    try {
      const el = await mountFlow(SignIn, {
        signInWithAtlas: { enabled: true, connection_id: 'ssoc_1' },
        routes: [
          (c) =>
            c.path === '/v1/client/sign_ins/sso' ? json({ authorization_url: 'https://id.example/authorize?x=1' }) : undefined,
        ],
      });
      const button = await vi.waitFor(() => {
        const b = el.querySelector('[data-atlas-provider="atlas"]') as HTMLButtonElement | null;
        expect(b).not.toBeNull();
        return b!;
      });
      expect(button.textContent).toContain('Continue with Atlas');
      button.click();
      await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://id.example/authorize?x=1'));
      expect(posts('/v1/client/sign_ins/sso')[0]!.body).toMatchObject({
        connection_id: 'ssoc_1',
        redirect_url: 'https://app.example.com/login',
      });
    } finally {
      Object.defineProperty(window, 'location', original);
    }
  });

  it('shows no Atlas button when the instance has it off', async () => {
    const el = await mountFlow(SignIn, { signInWithAtlas: { enabled: false }, routes: [] });
    expect(el.querySelector('[data-atlas-provider="atlas"]')).toBeNull();
  });
});

describe('<SignUp> on an existing account', () => {
  it('exchanges the ticket, then holds the app on the notice until Continue', async () => {
    const el = await mountFlow(SignUp, {
      routes: [
        (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
        (c) =>
          c.path === '/v1/client/sign_ups/sua_1/attempt_verification'
            ? json({ id: 'sua_1', status: 'complete', ticket: 'tkt_1', existing_account: true })
            : undefined,
      ],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    setInput(el, 'email', 'held@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-existing-account]')).toBeNull();
    const boots = calls.filter((c) => c.path === '/v1/client').length;

    setInput(el, 'code', '424242');
    submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-existing-account]')).not.toBeNull());
    const notice = el.querySelector('[data-atlas-existing-account]')!;
    expect(notice.textContent).toContain('You already had an account. Your existing password still applies.');
    expect(notice.querySelector('a')!.getAttribute('href')).toContain('/hosted/sign-in');
    expect(calls.filter((c) => c.path === '/v1/client').length).toBe(boots);

    (notice.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-existing-account]')).toBeNull());
    await vi.waitFor(() => expect(calls.filter((c) => c.path === '/v1/client').length).toBeGreaterThan(boots));
    expect(posts('/v1/client/tickets/exchange')).toHaveLength(1);
  });
});

describe('<SignUp> on a held account: the other endings', () => {
  it('a link made no session: a neutral line and a way to sign in, nothing to submit', async () => {
    const el = await mountFlow(SignUp, {
      routes: [(c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', object: 'sign_up_attempt', status: 'needs_first_factor' }, 201) : undefined)],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    setInput(el, 'email', 'held@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-email-confirmed]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-email-confirmed]')!.textContent).toContain('Your email is confirmed. Sign in to continue.');
    expect(el.querySelector('[data-atlas-email-confirmed] a')!.getAttribute('href')).toContain('/hosted/sign-in');
    expect(el.querySelector('button[type="submit"]')).toBeNull();
  });

  it('resetPasswordUrl and signInUrl: a string overrides, null hides', async () => {
    const proved = (c: Call) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', object: 'sign_up_attempt', status: 'needs_first_factor' }, 201) : undefined);
    const custom = await mountFlow((() => h(SignUp, { signInUrl: 'https://app.example/login' })) as unknown as typeof SignUp, { routes: [proved] });
    await vi.waitFor(() => expect(custom.querySelector('input[name="password"]')).not.toBeNull());
    setInput(custom, 'email', 'held@example.com');
    setInput(custom, 'password', 'blue tangerine anvil 71!');
    submit(custom);
    await vi.waitFor(() => expect(custom.querySelector('[data-atlas-email-confirmed] a')?.getAttribute('href')).toBe('https://app.example/login'));
    cleanup();

    const held = (c: Call) =>
      c.path === '/v1/client/sign_ups'
        ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201)
        : c.path === '/v1/client/sign_ups/sua_1/attempt_verification'
          ? json({ id: 'sua_1', status: 'complete', ticket: 'tkt_1', existing_account: true })
          : undefined;
    const notice = (props: Record<string, unknown>) => mountFlow((() => h(SignUp, props)) as unknown as typeof SignUp, { routes: [held] });
    const own = await notice({ resetPasswordUrl: 'https://app.example/forgot' });
    await vi.waitFor(() => expect(own.querySelector('input[name="password"]')).not.toBeNull());
    setInput(own, 'email', 'held@example.com');
    setInput(own, 'password', 'blue tangerine anvil 71!');
    submit(own);
    await vi.waitFor(() => expect(own.querySelector('input[name="code"]')).not.toBeNull());
    setInput(own, 'code', '424242');
    submit(own);
    await vi.waitFor(() => expect(own.querySelector('[data-atlas-existing-account] a')?.getAttribute('href')).toBe('https://app.example/forgot'));
    cleanup();

    const hidden = await notice({ resetPasswordUrl: null });
    await vi.waitFor(() => expect(hidden.querySelector('input[name="password"]')).not.toBeNull());
    setInput(hidden, 'email', 'held@example.com');
    setInput(hidden, 'password', 'blue tangerine anvil 71!');
    submit(hidden);
    await vi.waitFor(() => expect(hidden.querySelector('input[name="code"]')).not.toBeNull());
    setInput(hidden, 'code', '424242');
    submit(hidden);
    await vi.waitFor(() => expect(hidden.querySelector('[data-atlas-existing-account]')).not.toBeNull());
    expect(hidden.querySelector('[data-atlas-existing-account] a')).toBeNull();
  });

  it('must enrol: the setup, then the recovery codes with the ticket already redeemed, then the notice', async () => {
    const el = await mountFlow(SignUp, {
      routes: [
        (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
        (c) =>
          c.path === '/v1/client/sign_ups/sua_1/attempt_verification'
            ? json({ id: 'sua_1', status: 'needs_mfa_enrollment', existing_account: true })
            : undefined,
        (c) => (c.path === '/v1/client/sign_ins/sua_1/prepare_mfa_enrollment' ? json({ factor_id: 'mfa_t', secret: 'ABCD', uri: 'otpauth://totp/x' }) : undefined),
        (c) =>
          c.path === '/v1/client/sign_ins/sua_1/attempt_mfa_enrollment'
            ? json({ id: 'sua_1', status: 'complete', ticket: 'tkt_1', backup_codes: ['aaaa-1111'] })
            : undefined,
      ],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    setInput(el, 'email', 'held@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    setInput(el, 'code', '424242');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="secondCode"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas="mfa-setup-key"]')!.textContent).toContain('ABCD');
    setInput(el, 'code', '111111');
    setInput(el, 'secondCode', '222222');
    submit(el);

    await vi.waitFor(() => expect(el.querySelector('[data-atlas="recovery-codes"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas="recovery-codes-list"]')!.textContent).toContain('aaaa-1111');
    expect(posts('/v1/client/sign_ins/sua_1/attempt_mfa_enrollment')[0]!.body).toEqual({ factor_id: 'mfa_t', codes: ['111111', '222222'] });
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    await vi.waitFor(() => expect((el.querySelector('[data-atlas="recovery-codes-saved"]') as HTMLButtonElement).disabled).toBe(false));
    expect(el.querySelector('[data-atlas-existing-account]')).toBeNull();

    (el.querySelector('[data-atlas="recovery-codes-saved"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-existing-account]')).not.toBeNull());
    expect(posts('/v1/client/tickets/exchange')).toHaveLength(1);
  });
});

describe('a mailed link needs a tie to the tab that started the flow', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
    window.localStorage.clear();
  });

  it('the waiting tab shows the code', async () => {
    const el = await mountFlow(SignUp, {
      routes: [
        (c) =>
          c.method === 'POST' && c.path === '/v1/client/sign_ups'
            ? json({ id: 'sia_l', object: 'sign_up_attempt', status: 'needs_email_verification', identifier: 'l@example.com', poll_secret: 'ps_l', match_code: '482113' }, 201)
            : undefined,
      ],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    setInput(el, 'email', 'l@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="link-match-code"]')?.textContent).toContain('482113'));
  });

  it('opened on another device: asks for the typed code, then says to go back', async () => {
    window.history.replaceState({}, '', '/?attempt=sia_l&token=tok');
    const el = await mountFlow(SignUp, {
      routes: [
        (c) => (c.method === 'GET' && c.path === '/v1/client/sign_ups/verify' ? json({ requires_confirmation: true }) : undefined),
        (c) => (c.path === '/v1/client/sign_ups/verify/confirm' ? json({ verified: true }) : undefined),
      ],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="match_code"]')).not.toBeNull());
    setInput(el, 'match_code', '482113');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-status="confirmed"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ups/verify/confirm')[0]!.body).toEqual({ attempt: 'sia_l', token: 'tok', match_code: '482113' });
  });

  it('opened in the browser that started it: confirms with the stored secret, no typing', async () => {
    window.history.replaceState({}, '', '/?attempt=sia_s&token=tok');
    window.localStorage.setItem('atlas_link_sia_s', 'ps_s');
    const el = await mountFlow(SignIn, {
      routes: [
        (c) => (c.method === 'GET' && c.path === '/v1/client/sign_ins/verify' ? json({ requires_confirmation: true }) : undefined),
        (c) => (c.path === '/v1/client/sign_ins/verify/confirm' ? json({ verified: true }) : undefined),
      ],
    });
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-status="confirmed"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/verify/confirm')[0]!.body).toEqual({ attempt: 'sia_s', token: 'tok', poll_secret: 'ps_s' });
  });
});

describe('<SignIn> enrolment offers every factor the app offers', () => {
  it('draws each one; a YubiKey posts its OTP', async () => {
    const el = await mountFlow(SignIn, {
      account: { username: null, email_verification: 'code', password_reset: 'code', mfa: { totp: true, sms: false, totp_codes: 1, hotp: true, yubikey: true, duo: true } },
      routes: [
        (c) => (c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status: 'needs_mfa_enrollment' }, 201) : undefined),
        (c) => (c.path === '/v1/client/sign_ins/sia_1/attempt_mfa_enrollment' ? json({ id: 'sia_1', status: 'complete', ticket: 'tkt_e', backup_codes: [] }) : undefined),
      ],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
    setInput(el, 'identifier', 'ada@example.com');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-mfa-method="yubikey"]')).not.toBeNull());
    for (const m of ['totp', 'hotp', 'duo']) expect(el.querySelector(`[data-atlas-mfa-method="${m}"]`)).not.toBeNull();
    (el.querySelector('[data-atlas-mfa-method="yubikey"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(el.querySelector('input[name="otp"]')).not.toBeNull());
    setInput(el, 'otp', 'ccccccfjkbbb');
    submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')[0]!.body).toEqual({ strategy: 'yubikey', otp: 'ccccccfjkbbb' });
  });

  it('<SignIn> draws nothing when someone is already signed in, and the form returns on sign-out', async () => {
    let held = true;
    const el = await mountFlow(SignIn, { signedIn: () => held, routes: [] });
    await lastClient!.reload();
    await vi.waitFor(() => expect(el.querySelector('form')).toBeNull());
    held = false;
    await lastClient!.reload();
    await vi.waitFor(() => expect(el.querySelector('form')).not.toBeNull());
  });

  it('<SignUp> keeps the recovery codes on screen when the session appears mid-flow', async () => {
    let held = false;
    const el = await mountFlow(SignUp, {
      signedIn: () => held,
      routes: [
        (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201) : undefined),
        (c) =>
          c.path === '/v1/client/sign_ups/sua_1/attempt_verification'
            ? json({ id: 'sua_1', status: 'needs_mfa_enrollment', existing_account: true })
            : undefined,
        (c) => (c.path === '/v1/client/sign_ins/sua_1/prepare_mfa_enrollment' ? json({ factor_id: 'mfa_t', secret: 'ABCD', uri: 'otpauth://totp/x' }) : undefined),
        (c) =>
          c.path === '/v1/client/sign_ins/sua_1/attempt_mfa_enrollment'
            ? json({ id: 'sua_1', status: 'complete', ticket: 'tkt_1', backup_codes: ['aaaa-1111'] })
            : undefined,
      ],
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    setInput(el, 'email', 'held@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    setInput(el, 'code', '424242');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="secondCode"]')).not.toBeNull());
    setInput(el, 'code', '111111');
    setInput(el, 'secondCode', '222222');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="recovery-codes"]')).not.toBeNull());
    held = true;
    await lastClient!.reload();
    await new Promise((r) => setTimeout(r, 20));
    expect(el.querySelector('[data-atlas="recovery-codes"]')).not.toBeNull();
  });
});
