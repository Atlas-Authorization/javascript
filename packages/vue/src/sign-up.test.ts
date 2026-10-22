import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, shallowRef, type App, type Component } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasClient, AuthStatus } from './plugin';
import { SignIn, SignUp } from './components';
import { EN_US } from './i18n';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser, SessionClaims } from './types';

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
    widgets,
    solve(token: string) {
      (widgets[widgets.length - 1]!.opts.callback as (t: string) => void)(token);
    },
  };
}

let calls: Call[] = [];
let wrapper: VueWrapper | null = null;
const reload = vi.fn(async () => true);

beforeEach(() => {
  calls = [];
  reload.mockClear();
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  delete (window as unknown as Record<string, unknown>).turnstile;
  vi.unstubAllGlobals();
});

function makeClient(): AtlasClient {
  return {
    publishableKey: 'pk_test_x',
    frontendApi: FAPI,
    appearance: undefined,
    catalog: EN_US,
    status: shallowRef<AuthStatus>('signed_out'),
    user: shallowRef<AtlasUser | null>(null),
    session: shallowRef<AtlasSession | null>(null),
    claims: shallowRef<SessionClaims | null>(null),
    memberships: shallowRef<AtlasOrganizationMembership[]>([]),
    pendingAttempt: null,
    getToken: async () => null,
    getProviderToken: async () => null,
    signOut: async () => ({ revoked: true }),
    setActiveOrganization: async () => undefined,
    reload,
    onSignOut: () => () => undefined,
  };
}

async function mountFlow(
  component: Component,
  opts: { captchaFlows?: Record<string, unknown>; emailDelivery?: Record<string, boolean>; routes: Route[] },
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      calls.push(call);
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
    }),
  );
  const client = makeClient();
  const Host = defineComponent({ setup: () => () => h(component) });
  wrapper = mount(Host, {
    attachTo: document.body,
    global: { plugins: [{ install: (app: App) => app.provide(ATLAS_INJECTION_KEY, client) }] },
  });
  await vi.waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance')).toBe(true));
  await flush();
  return wrapper;
}

async function flush() {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

async function setInput(w: VueWrapper, name: string, value: string) {
  const input = w.find(`input[name="${name}"]`);
  expect(input.exists(), `input[name=${name}]`).toBe(true);
  await input.setValue(value);
}

async function submit(w: VueWrapper) {
  await w.find('form').trigger('submit');
  await flush();
}

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);
const TURNSTILE = { enabled: true, provider: 'turnstile', siteKey: 'ts-site', widget: 'managed' };

describe('<SignUp> creates the account', () => {
  it('posts /v1/client/sign_ups (not sign_ins), then verifies the emailed code and exchanges the ticket', async () => {
    const w = await mountFlow(SignUp, {
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

    expect(w.find('input[name="password"]').exists()).toBe(true);
    expect(w.find('.atlas-captcha').exists()).toBe(false);

    await setInput(w, 'email', 'new@example.com');
    await setInput(w, 'password', 'blue tangerine anvil 71!');
    await submit(w);
    await vi.waitFor(() => expect(w.find('input[name="code"]').exists()).toBe(true));

    expect(posts('/v1/client/sign_ins')).toHaveLength(0);
    expect(posts('/v1/client/sign_ups')[0]!.body).toEqual({
      email: 'new@example.com',
      password: 'blue tangerine anvil 71!',
      consent: true,
    });

    await setInput(w, 'code', '424242');
    await submit(w);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups/sua_1/attempt_verification')[0]!.body).toEqual({ code: '424242' });
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toEqual({ attempt_id: 'sua_1', ticket: 'tkt_1', return_refresh_token: true });
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
  });
});

describe('<SignUp> captcha', () => {
  it('draws the configured widget and sends its token as captcha_token on create', async () => {
    const ts = fakeTurnstile();
    const w = await mountFlow(SignUp, {
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

    await setInput(w, 'email', 'cap@example.com');
    await setInput(w, 'password', 'blue tangerine anvil 71!');
    ts.solve('tok-1');
    await submit(w);

    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups')[0]!.body).toMatchObject({
      email: 'cap@example.com',
      captcha_token: 'tok-1',
    });
    await vi.waitFor(() => expect(w.find('input[name="code"]').exists()).toBe(true));
  });

  it('on CAPTCHA_FAILED shows the localized message, draws a fresh widget and sends the NEW token next time', async () => {
    const ts = fakeTurnstile();
    let tries = 0;
    const w = await mountFlow(SignUp, {
      captchaFlows: { signUp: TURNSTILE },
      routes: [
        (c) => {
          if (c.path !== '/v1/client/sign_ups') return undefined;
          tries += 1;
          return tries === 1
            ? json(
                { errors: [{ code: 'CAPTCHA_FAILED', message: 'That captcha could not be verified.', param: 'captcha_token' }] },
                400,
              )
            : json({ id: 'sua_3', status: 'needs_email_verification' }, 201);
        },
      ],
    });
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));

    await setInput(w, 'email', 'retry@example.com');
    await setInput(w, 'password', 'blue tangerine anvil 71!');
    ts.solve('tok-bad');
    await submit(w);

    await vi.waitFor(() => expect(w.find('[role="alert"]').text()).toBe(EN_US['captcha.failed']));
    expect(ts.api.remove).toHaveBeenCalledWith('w1');
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(2));
    expect((w.find('input[name="email"]').element as HTMLInputElement).value).toBe('retry@example.com');

    ts.solve('tok-good');
    await submit(w);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(2));
    expect(posts('/v1/client/sign_ups')[1]!.body).toMatchObject({ captcha_token: 'tok-good' });
  });
});

describe('<SignIn> captcha', () => {
  it('answers needs_captcha: draws the widget and, once solved, re-sends the identifier with the token', async () => {
    const ts = fakeTurnstile();
    const w = await mountFlow(SignIn, {
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

    expect(w.find('.atlas-captcha').exists()).toBe(false);
    await setInput(w, 'identifier', 'me@example.com');
    await submit(w);

    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    expect(w.text()).toContain(EN_US['captcha.prompt']);

    ts.solve('tok-si');
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins')).toHaveLength(2));
    expect(posts('/v1/client/sign_ins')[1]!.body).toEqual({
      identifier: 'me@example.com',
      captcha_token: 'tok-si',
    });
    await flush();
    await vi.waitFor(() => expect(w.find('input[name="password"]').exists()).toBe(true));
  });

  it('an always-on sign-in captcha is drawn on the identifier step and its token rides the first POST', async () => {
    const ts = fakeTurnstile();
    const w = await mountFlow(SignIn, {
      captchaFlows: { signIn: TURNSTILE },
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ins'
            ? json({ id: null, status: 'needs_captcha', identifier: 'me@example.com' }, 201)
            : undefined,
      ],
    });
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    await setInput(w, 'identifier', 'me@example.com');
    ts.solve('tok-rejected');
    await submit(w);

    await vi.waitFor(() => expect(posts('/v1/client/sign_ins')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins')[0]!.body).toEqual({
      identifier: 'me@example.com',
      captcha_token: 'tok-rejected',
    });
    await vi.waitFor(() => expect(w.find('[role="alert"]').text()).toBe(EN_US['captcha.failed']));
    await vi.waitFor(() => expect(ts.api.render.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('email delivery', () => {
  const NO_EMAIL = { available: false, password_reset: false, password_sign_up: false };
  const firstFactor = (c: Call) =>
    c.path === '/v1/client/sign_ins'
      ? json(
          { id: 'sia_9', status: 'needs_first_factor', supported_first_factors: ['password', 'email_code', 'email_link'] },
          201,
        )
      : undefined;

  it('<SignUp> shows the "can\'t send email" notice and no password field when passwordSignUp is false', async () => {
    const w = await mountFlow(SignUp, { emailDelivery: NO_EMAIL, routes: [] });
    await vi.waitFor(() => expect(w.find('[data-atlas-email-unavailable]').exists()).toBe(true));
    expect(w.find('[role="alert"]').text()).toBe(EN_US['signUp.emailUnavailable']);
    expect(EN_US['signUp.emailUnavailable']).toBe(
      "This app can't send email right now. Try another sign-in method or contact the app owner.",
    );
    expect(w.find('input[name="password"]').exists()).toBe(false);
    expect(w.find('input[name="email"]').exists()).toBe(false);
  });

  it('<SignUp> keeps the form when the server omits email_delivery (an older server)', async () => {
    const w = await mountFlow(SignUp, { routes: [] });
    expect(w.find('input[name="password"]').exists()).toBe(true);
    expect(w.find('[data-atlas-email-unavailable]').exists()).toBe(false);
  });

  it('<SignIn> hides email code / link from the first-factor choice while email is unavailable', async () => {
    const w = await mountFlow(SignIn, { emailDelivery: NO_EMAIL, routes: [firstFactor] });
    await setInput(w, 'identifier', 'me@example.com');
    await submit(w);
    await vi.waitFor(() => expect(w.find('input[name="password"]').exists()).toBe(true));
    expect(w.find('[data-strategy="email_code"]').exists()).toBe(false);
    expect(w.find('[data-strategy="email_link"]').exists()).toBe(false);
  });

  it('<SignIn> offers an emailed code when email works, and posts it as the email_code strategy', async () => {
    const w = await mountFlow(SignIn, {
      emailDelivery: { available: true, password_reset: true, password_sign_up: true },
      routes: [
        firstFactor,
        (c) => (c.path === '/v1/client/sign_ins/sia_9/prepare_first_factor' ? json({ status: 'sent' }) : undefined),
        (c) =>
          c.path === '/v1/client/sign_ins/sia_9/attempt_first_factor'
            ? json({ id: 'sia_9', status: 'complete', ticket: 'tkt_9' })
            : undefined,
      ],
    });
    await setInput(w, 'identifier', 'me@example.com');
    await submit(w);
    await vi.waitFor(() => expect(w.find('[data-strategy="email_code"]').exists()).toBe(true));
    expect(w.find('[data-strategy="email_link"]').exists()).toBe(true);

    await w.find('[data-strategy="email_code"]').trigger('click');
    await flush();
    await vi.waitFor(() => expect(w.find('input[name="code"]').exists()).toBe(true));
    expect(posts('/v1/client/sign_ins/sia_9/prepare_first_factor')[0]!.body).toEqual({ strategy: 'email_code' });

    await setInput(w, 'code', '135790');
    await submit(w);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/sia_9/attempt_first_factor')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_9/attempt_first_factor')[0]!.body).toEqual({
      strategy: 'email_code',
      code: '135790',
    });
  });
});

describe('email-code-only sign-in (no password on offer)', () => {
  it('<SignIn> emails the code by itself, never shows a password field, and the code signs in', async () => {
    const w = await mountFlow(SignIn, {
      emailDelivery: { available: true, password_reset: true, password_sign_up: true },
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ins'
            ? json(
                {
                  id: 'sia_c',
                  status: 'needs_first_factor',
                  identifier: 'me@example.com',
                  supported_first_factors: ['email_code', 'passkey'],
                },
                201,
              )
            : undefined,
        (c) => (c.path === '/v1/client/sign_ins/sia_c/prepare_first_factor' ? json({ status: 'needs_first_factor' }) : undefined),
        (c) =>
          c.path === '/v1/client/sign_ins/sia_c/attempt_first_factor'
            ? json({ id: 'sia_c', status: 'complete', ticket: 'tkt_c' })
            : undefined,
      ],
    });
    await setInput(w, 'identifier', 'me@example.com');
    await submit(w);
    await vi.waitFor(() => expect(w.find('input[name="code"]').exists()).toBe(true));
    expect(w.find('input[name="password"]').exists()).toBe(false);
    expect(posts('/v1/client/sign_ins/sia_c/prepare_first_factor')).toHaveLength(1);
    expect(posts('/v1/client/sign_ins/sia_c/prepare_first_factor')[0]!.body).toEqual({ strategy: 'email_code' });
    expect(w.find('[data-atlas-code-sent]').text()).toContain('me@example.com');
    expect(w.find('[data-atlas-resend]').exists()).toBe(true);

    await setInput(w, 'code', '135790');
    await submit(w);
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/sia_c/attempt_first_factor')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_c/attempt_first_factor')[0]!.body).toEqual({
      strategy: 'email_code',
      code: '135790',
    });
  });
});

