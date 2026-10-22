// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { SignIn } from './sign-in';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `<SignIn>` end to end against instances whose first factor is emailed: the
 * code (or link) is sent by the component itself, the step collects it, and the
 * sign-in completes. A password field is drawn only when the server offers one.
 * FAPI is a scripted fetch, so these run with no network.
 */

const FAPI = 'https://fapi.example';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

type Route = (call: Call) => Response | undefined;

let unmount: (() => void) | null = null;
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(opts: { routes: Route[]; locale?: string; emailDelivery?: Record<string, boolean> }) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    if (call.path === '/v1/client') return json({ session: null, user: null });
    if (call.path === '/v1/appearance') {
      return json({
        object: 'appearance',
        appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] },
        captchaFlows: {},
        email_delivery: opts.emailDelivery ?? { available: true, passwordSignUp: true },
      });
    }
    for (const route of opts.routes) {
      const res = route(call);
      if (res) return res;
    }
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);

  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const props: ComponentProps<typeof AtlasProvider> = {
    publishableKey: 'pk_test_x',
    frontendApi: FAPI,
    fetchImpl,
    appearance: { instanceDesign: false },
    children: createElement(SignIn),
  };
  if (opts.locale) props.locale = opts.locale;
  await act(async () => {
    root.render(createElement(AtlasProvider, props));
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

async function click(button: Element | null) {
  expect(button).not.toBeNull();
  await act(async () => {
    (button as HTMLButtonElement).click();
  });
}

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

const attempt = (factors: string[], extra: Record<string, unknown> = {}) => ({
  id: 'sia_1',
  object: 'sign_in_attempt',
  status: 'needs_first_factor',
  identifier: 'someone@example.com',
  supported_first_factors: factors,
  ...extra,
});

/** The identifier POST answers with an attempt offering `factors`. */
const signInRoute =
  (factors: string[]): Route =>
  (c) =>
    c.method === 'POST' && c.path === '/v1/client/sign_ins' ? json(attempt(factors), 201) : undefined;

const prepareRoute =
  (respond: (c: Call) => Response = (c) =>
    json({ object: 'sign_in_attempt', id: 'sia_1', status: 'needs_first_factor', strategy: c.body?.strategy, poll_secret: 'ps_1' })): Route =>
  (c) =>
    c.path === '/v1/client/sign_ins/sia_1/prepare_first_factor' ? respond(c) : undefined;

const attemptRoute: Route = (c) => {
  if (c.path !== '/v1/client/sign_ins/sia_1/attempt_first_factor') return undefined;
  if (c.body?.strategy === 'email_code' && c.body.code === '424242') {
    return json({ ...attempt([]), status: 'complete', created_session_id: 'sess_1', ticket: 'tkt_1' });
  }
  if (c.body?.strategy === 'password' && c.body.password === 'correct horse') {
    return json({ ...attempt([]), status: 'complete', created_session_id: 'sess_1', ticket: 'tkt_1' });
  }
  return json({ errors: [{ code: 'VERIFICATION_FAILED', message: 'That code is invalid.' }] }, 422);
};

async function enterEmail(el: HTMLElement) {
  setInput(el, 'identifier', 'someone@example.com');
  await submit(el);
}

describe('<SignIn> on an email-code-only instance (no password)', () => {
  it('emails the code by itself, collects it, and completes the sign-in', async () => {
    const el = await mount({ routes: [signInRoute(['email_code', 'passkey']), prepareRoute(), attemptRoute] });
    await enterEmail(el);

    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_first_factor')).toHaveLength(1);
    expect(posts('/v1/client/sign_ins/sia_1/prepare_first_factor')[0]!.body).toEqual({ strategy: 'email_code' });
    // Never a password box when password isn't offered.
    expect(el.querySelector('input[name="password"]')).toBeNull();
    expect(el.querySelector('[data-atlas-code-sent]')?.textContent).toContain('someone@example.com');
    const code = el.querySelector('input[name="code"]') as HTMLInputElement;
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');

    setInput(el, 'code', '424242');
    await submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/attempt_first_factor')[0]!.body).toEqual({
      strategy: 'email_code',
      code: '424242',
    });
    // No password strategy is ever posted.
    expect(posts('/v1/client/sign_ins/sia_1/attempt_first_factor').some((c) => c.body?.strategy === 'password')).toBe(false);
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toEqual({ attempt_id: 'sia_1', ticket: 'tkt_1', return_refresh_token: true });
  });

  it('sends the code once per attempt, and a wrong code keeps the code step', async () => {
    const el = await mount({ routes: [signInRoute(['email_code']), prepareRoute(), attemptRoute] });
    await enterEmail(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());

    setInput(el, 'code', '000000');
    await submit(el);
    await vi.waitFor(() => expect(el.textContent).toContain('That code is invalid.'));
    expect(el.querySelector('input[name="code"]')).not.toBeNull();
    expect(posts('/v1/client/sign_ins/sia_1/prepare_first_factor')).toHaveLength(1);
  });

  it('"Resend code" sends again, and a 429 says so and counts down instead of failing again', async () => {
    let n = 0;
    const el = await mount({
      routes: [
        signInRoute(['email_code']),
        prepareRoute((c) => {
          n += 1;
          if (n === 1) return json({ object: 'sign_in_attempt', id: 'sia_1', status: 'needs_first_factor', strategy: c.body?.strategy });
          return json(
            {
              errors: [
                { code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.', reason: 'too_many_requests', meta: { retry_after: 30 } },
              ],
            },
            429,
          );
        }),
        attemptRoute,
      ],
    });
    await enterEmail(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-resend]')).not.toBeNull());

    await click(el.querySelector('[data-atlas-resend]'));
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/sia_1/prepare_first_factor')).toHaveLength(2));
    await vi.waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toBe('Too many requests. Please try again later.'));
    const resend = el.querySelector('[data-atlas-resend]') as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toMatch(/Resend in \d+s/);
    // Still on the code step: the code already sent still works.
    expect(el.querySelector('input[name="code"]')).not.toBeNull();
  });

  it('a failed automatic send stays on the step with the reason and a way to retry', async () => {
    let n = 0;
    const el = await mount({
      routes: [
        signInRoute(['email_code']),
        prepareRoute((c) => {
          n += 1;
          if (n === 1) {
            return json({ errors: [{ code: 'EMAIL_DELIVERY_NOT_CONFIGURED', message: 'This app cannot send email.' }] }, 422);
          }
          return json({ object: 'sign_in_attempt', id: 'sia_1', status: 'needs_first_factor', strategy: c.body?.strategy });
        }),
        attemptRoute,
      ],
    });
    await enterEmail(el);
    await vi.waitFor(() => expect(el.textContent).toContain('This app cannot send email.'));
    expect(el.querySelector('input[name="password"]')).toBeNull();
    expect(el.querySelector('input[name="code"]')).toBeNull();

    await click(el.querySelector('[data-strategy="email_code"]'));
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
  });
});

describe('<SignIn> with both password and email code', () => {
  it('defaults to password, offers "Email me a code instead", and can switch back', async () => {
    const el = await mount({ routes: [signInRoute(['password', 'email_code']), prepareRoute(), attemptRoute] });
    await enterEmail(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_first_factor')).toHaveLength(0);

    const option = el.querySelector('[data-strategy="email_code"]');
    expect(option?.textContent).toBe('Email me a code instead');
    await click(option);
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    expect(el.querySelector('input[name="password"]')).toBeNull();

    await click(el.querySelector('[data-strategy="password"]'));
    expect(el.querySelector('input[name="password"]')).not.toBeNull();

    setInput(el, 'password', 'correct horse');
    await submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/attempt_first_factor')[0]!.body).toEqual({
      strategy: 'password',
      password: 'correct horse',
    });
  });

  it('completes with the emailed code when the user picks it', async () => {
    const el = await mount({ routes: [signInRoute(['password', 'email_code']), prepareRoute(), attemptRoute] });
    await enterEmail(el);
    await vi.waitFor(() => expect(el.querySelector('[data-strategy="email_code"]')).not.toBeNull());
    await click(el.querySelector('[data-strategy="email_code"]'));
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    setInput(el, 'code', '424242');
    await submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/attempt_first_factor')[0]!.body).toEqual({
      strategy: 'email_code',
      code: '424242',
    });
  });
});

describe('<SignIn> on an email-link-only instance', () => {
  it('sends the link, says so, and this tab completes when the link is opened', async () => {
    let polls = 0;
    const el = await mount({
      routes: [
        signInRoute(['email_link']),
        prepareRoute(),
        (c) => {
          if (c.method !== 'GET' || c.path !== '/v1/client/sign_ins/sia_1') return undefined;
          expect(c.search).toBe('?poll_secret=ps_1');
          polls += 1;
          return polls < 2
            ? json(attempt(['email_link']))
            : json({ ...attempt(['email_link']), status: 'complete', created_session_id: 'sess_1', ticket: 'tkt_link' });
        },
      ],
    });
    await enterEmail(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-link-sent]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_first_factor')[0]!.body).toEqual({ strategy: 'email_link' });
    expect(el.querySelector('input[name="password"]')).toBeNull();
    expect(el.querySelector('button[type="submit"]')).toBeNull();

    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1), { timeout: 8_000, interval: 100 });
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toEqual({ attempt_id: 'sia_1', ticket: 'tkt_link', return_refresh_token: true });
  }, 12_000);
});

describe('<SignIn> email code in Spanish', () => {
  it('translates the code step, its links, and sends the locale to the server', async () => {
    const el = await mount({ locale: 'es', routes: [signInRoute(['password', 'email_code']), prepareRoute(), attemptRoute] });
    await enterEmail(el);
    await vi.waitFor(() => expect(el.querySelector('[data-strategy="email_code"]')).not.toBeNull());
    expect(el.querySelector('[data-strategy="email_code"]')?.textContent).toBe('Envíame un código por correo');

    await click(el.querySelector('[data-strategy="email_code"]'));
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-code-sent]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-code-sent]')?.textContent).toBe(
      'Hemos enviado un código a someone@example.com. Introdúcelo a continuación.',
    );
    expect(el.querySelector('[data-atlas-resend]')?.textContent).toBe('Reenviar código');
    expect(el.querySelector('[data-strategy="password"]')?.textContent).toBe('Usar mi contraseña');
    expect(posts('/v1/client/sign_ins/sia_1/prepare_first_factor')[0]!.headers['accept-language']).toMatch(/^es/);
  });
});

describe('<SignIn> when the app cannot send email', () => {
  it('does not try to send a code and says why', async () => {
    const el = await mount({
      emailDelivery: { available: false, passwordSignUp: false },
      routes: [signInRoute(['email_code']), prepareRoute(), attemptRoute],
    });
    await enterEmail(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-email-unavailable]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_first_factor')).toHaveLength(0);
    expect(el.querySelector('input[name="password"]')).toBeNull();
  });
});

describe('after the sign-in completes', () => {
  const exchangeRoute: Route = (c) =>
    c.path === '/v1/client/tickets/exchange' ? json({ object: 'session', id: 'sess_1', jwt: 'x', refresh_token: 'rt_9' }) : undefined;

  async function signInWithPassword(el: HTMLElement) {
    await enterEmail(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    setInput(el, 'password', 'correct horse');
    await submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
  }

  it('says the browser did not keep the session when the boot finds none (never "signed in where you started")', async () => {
    const el = await mount({ routes: [signInRoute(['password']), attemptRoute, exchangeRoute] });
    await signInWithPassword(el);
    await vi.waitFor(() => expect(el.textContent).toContain("didn't keep the session"));
    expect(el.textContent).not.toContain('signed in where you started');
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('a development key asks for the refresh token and presents it on the next boot', async () => {
    const el = await mount({ routes: [signInRoute(['password']), attemptRoute, exchangeRoute] });
    await signInWithPassword(el);
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toMatchObject({ return_refresh_token: true });
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.path === '/v1/client').some((c) => c.headers['x-refresh-token'] === 'rt_9')).toBe(true),
    );
  });

  it('shows "No account? Sign up" on the identifier and password steps, linking to hosted sign-up', async () => {
    const el = await mount({ routes: [signInRoute(['password']), attemptRoute] });
    const prompt = () => el.querySelector('[data-atlas-sign-up-prompt] a') as HTMLAnchorElement | null;
    expect(prompt()?.getAttribute('href')).toMatch(/\/hosted\/sign-up/);
    await enterEmail(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    expect(prompt()).not.toBeNull();
  });
});
