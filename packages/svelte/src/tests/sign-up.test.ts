import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { ATLAS_KEY, createAtlasClient } from '../lib/context';
import { EN_US } from '../lib/i18n';
import SignIn from '../lib/components/SignIn.svelte';
import SignUp from '../lib/components/SignUp.svelte';

/**
 * `<SignUp>` really creates the account (POST /v1/client/sign_ups, then the
 * emailed code), draws the configured captcha, sends its token, and recovers
 * from a refused token; `<SignIn>` answers the `needs_captcha` step. The
 * provider is a fake Turnstile global, so the shared `@atlasauth/js` renderer
 * runs against it with no network; FAPI is a scripted fetch.
 */
vi.mock('@atlasauth/js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atlasauth/js')>();
  return { ...actual, readRedirectResult: () => null };
});

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
let lastClient: ReturnType<typeof createAtlasClient> | null = null;
let calls: Call[] = [];
beforeEach(() => {
  calls = [];
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).turnstile;
  vi.unstubAllGlobals();
});

async function mountFlow(
  component: typeof SignIn | typeof SignUp,
  opts: {
    captchaFlows?: Record<string, unknown>;
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
  // The flow's FAPI client uses the global fetch; the Atlas client takes fetchImpl.
  vi.stubGlobal('fetch', fetchImpl);
  const client = createAtlasClient({
    publishableKey: 'pk_test_x',
    frontendApi: FAPI,
    fetchImpl,
    manualBoot: true,
  });
  lastClient = client;
  const view = render(component, { context: new Map([[ATLAS_KEY, client]]) });
  await waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance')).toBe(true));
  return view.container as HTMLElement;
}

async function setInput(el: HTMLElement, name: string, value: string) {
  const input = el.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  expect(input, `input[name=${name}]`).not.toBeNull();
  await fireEvent.input(input, { target: { value } });
}

async function submit(el: HTMLElement) {
  await fireEvent.submit(el.querySelector('form')!);
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

    expect(el.querySelector('input[name="password"]')).not.toBeNull();
    expect(el.querySelector('.atlas-captcha')).toBeNull();

    await setInput(el, 'email', 'new@example.com');
    await setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());

    expect(posts('/v1/client/sign_ins')).toHaveLength(0);
    expect(posts('/v1/client/sign_ups')[0]!.body).toEqual({
      email: 'new@example.com',
      password: 'blue tangerine anvil 71!',
      consent: true,
      // The stable device id rides on every sign-up start (accounts-per-device limit).
      device_id: expect.stringMatching(/^d_/),
    });

    await setInput(el, 'code', '424242');
    await submit(el);
    await waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
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
    await setInput(el, 'email', 'new@example.com');
    await setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    await setInput(el, 'code', '424242');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toContain('An account already uses this email address. Sign in instead.'));
    const link = el.querySelector('[role="alert"] a');
    expect(link?.textContent).toBe(EN_US['signIn.title']);
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

    await waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    const [host, params] = ts.api.render.mock.calls[0]!;
    expect((host as HTMLElement).classList.contains('atlas-captcha')).toBe(true);
    expect(params).toMatchObject({ sitekey: 'ts-site', appearance: 'always' });

    await setInput(el, 'email', 'cap@example.com');
    await setInput(el, 'password', 'blue tangerine anvil 71!');
    ts.solve('tok-1');
    await submit(el);

    await waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups')[0]!.body).toMatchObject({
      email: 'cap@example.com',
      captcha_token: 'tok-1',
    });
    await waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
  });

  it('on CAPTCHA_FAILED shows the localized message, draws a fresh widget and sends the NEW token next time', async () => {
    const ts = fakeTurnstile();
    let tries = 0;
    const el = await mountFlow(SignUp, {
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
    await waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));

    await setInput(el, 'email', 'retry@example.com');
    await setInput(el, 'password', 'blue tangerine anvil 71!');
    ts.solve('tok-bad');
    await submit(el);

    await waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(EN_US['captcha.failed']),
    );
    expect(ts.api.remove).toHaveBeenCalledWith('w1');
    await waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(2));
    expect((el.querySelector('input[name="email"]') as HTMLInputElement).value).toBe('retry@example.com');

    ts.solve('tok-good');
    await submit(el);
    await waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(2));
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

    expect(el.querySelector('.atlas-captcha')).toBeNull();
    await setInput(el, 'identifier', 'me@example.com');
    await submit(el);

    await waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    expect(el.textContent).toContain(EN_US['captcha.prompt']);

    ts.solve('tok-si');
    await waitFor(() => expect(posts('/v1/client/sign_ins')).toHaveLength(2));
    expect(posts('/v1/client/sign_ins')[1]!.body).toEqual({
      identifier: 'me@example.com',
      captcha_token: 'tok-si',
    });
    await waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
  });

  it('an always-on sign-in captcha rides the first POST; a rejected token says so and redraws', async () => {
    const ts = fakeTurnstile();
    const el = await mountFlow(SignIn, {
      captchaFlows: { signIn: TURNSTILE },
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ins'
            ? json({ id: null, status: 'needs_captcha', identifier: 'me@example.com' }, 201)
            : undefined,
      ],
    });
    await waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    await setInput(el, 'identifier', 'me@example.com');
    ts.solve('tok-rejected');
    await submit(el);

    await waitFor(() => expect(posts('/v1/client/sign_ins')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins')[0]!.body).toEqual({
      identifier: 'me@example.com',
      captcha_token: 'tok-rejected',
    });
    await waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(EN_US['captcha.failed']),
    );
    await waitFor(() => expect(ts.api.render.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('<SignUp> passkey-only sign-up', () => {
  it('offers a passkey form (no password, optional email), then creates the passkey and the account', async () => {
    const create = vi.fn(async () => ({
      rawId: new Uint8Array([1]).buffer,
      response: { attestationObject: new Uint8Array([4, 5, 6]).buffer, clientDataJSON: new Uint8Array([7, 8, 9]).buffer },
    }));
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create, get: vi.fn() } });

    const el = await mountFlow(SignUp, {
      account: { username: null, email_verification: 'code', password_reset: 'code', passkey_sign_up: { email: 'optional' } },
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ups/passkey'
            ? json({ id: 'sua_pk', object: 'sign_up_attempt', status: 'needs_first_factor', supported_first_factors: ['passkey'], poll_secret: 'ps_1' }, 201)
            : undefined,
        (c) =>
          c.path === '/v1/client/sign_ups/sua_pk/passkey/begin'
            ? json({ challenge: 'Y2hhbGxlbmdl', rp: { id: 'example.com', name: 'Atlas' }, user: { id: 'dXNlcl8x', name: 'u', displayName: 'u' }, pubKeyCredParams: [] }, 201)
            : undefined,
        (c) =>
          c.path === '/v1/client/sign_ups/sua_pk/passkey/finish'
            ? json({ id: 'sua_pk', object: 'sign_up_attempt', status: 'complete', ticket: 'tkt_pk' })
            : undefined,
      ],
    });

    await waitFor(() => expect(el.querySelector('[data-atlas-sign-up-mode="passkey"]')).not.toBeNull());
    await fireEvent.click(el.querySelector('[data-atlas-sign-up-mode="passkey"]')!);
    await waitFor(() => expect(el.querySelector('input[name="password"]')).toBeNull());
    expect((el.querySelector('input[name="email"]') as HTMLInputElement).required).toBe(false);

    await setInput(el, 'email', 'pk@example.com');
    await submit(el);
    await waitFor(() => expect(posts('/v1/client/sign_ups/passkey')).toHaveLength(1));
    expect(posts('/v1/client/sign_ups/passkey')[0]!.body).toEqual({ email: 'pk@example.com', consent: true });

    await waitFor(() => expect(el.querySelector('[data-atlas-passkey-sign-up] button')).not.toBeNull());
    await fireEvent.click(el.querySelector('[data-atlas-passkey-sign-up] button')!);
    await waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toMatchObject({ attempt_id: 'sua_pk', ticket: 'tkt_pk' });
  });
});

describe('link-only verification and the emailed second factor', () => {
  it('<SignUp> link mode: no code field, a resend, and the poll finishes the sign-up', async () => {
    let opened = false;
    const el = await mountFlow(SignUp, {
      account: { username: null, email_verification: 'link', password_reset: 'code' },
      routes: [
        (c) =>
          c.method === 'POST' && c.path === '/v1/client/sign_ups'
            ? json({ id: 'sua_l', object: 'sign_up_attempt', status: 'needs_email_verification', identifier: 'l@example.com', poll_secret: 'ps_l' }, 201)
            : undefined,
        (c) => (c.path === '/v1/client/sign_ups/sua_l/prepare_verification' ? json({ id: 'sua_l', status: 'needs_email_verification' }) : undefined),
        (c) =>
          c.method === 'GET' && c.path === '/v1/client/sign_ups/sua_l'
            ? json(opened ? { id: 'sua_l', object: 'sign_up_attempt', status: 'complete', ticket: 'tkt_l' } : { id: 'sua_l', object: 'sign_up_attempt', status: 'needs_email_verification' })
            : undefined,
      ],
    });
    await setInput(el, 'email', 'l@example.com');
    await setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas-link-sent]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-link-sent]')!.textContent).toContain('confirmation link to l@example.com');
    expect(el.querySelector('input[name="code"]')).toBeNull();
    expect(el.querySelector('button[type="submit"]')).toBeNull();

    await fireEvent.click(el.querySelector('[data-atlas-resend]')!);
    await waitFor(() => expect(posts('/v1/client/sign_ups/sua_l/prepare_verification')).toHaveLength(1));

    opened = true;
    await waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1), { timeout: 6000 });
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toMatchObject({ attempt_id: 'sua_l', ticket: 'tkt_l' });
  }, 10_000);

  it('<SignIn> offers "Email me a code instead" at the second factor when the instance does', async () => {
    const el = await mountFlow(SignIn, {
      account: { username: null, email_verification: 'code', password_reset: 'code', email_second_factor: true },
      routes: [
        (c) => (c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status: 'needs_second_factor' }, 201) : undefined),
        (c) => (c.path === '/v1/client/sign_ins/sia_1/prepare_second_factor' ? json({ object: 'second_factor_challenge', ...(c.body?.only_way ? {} : { sent_to: 'a•••@example.com' }) }) : undefined),
      ],
    });
    await setInput(el, 'identifier', 'ada@example.com');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas="email-second-factor"]')).not.toBeNull());
    await fireEvent.click(el.querySelector('[data-atlas="email-second-factor"]')!);
    await waitFor(() => expect(el.querySelector('[data-atlas="email-second-factor-sent"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_second_factor').map((c) => c.body)).toEqual([{ strategy: 'email_code', only_way: true }, { strategy: 'email_code' }]);
    expect(el.querySelector('[data-atlas="email-second-factor-sent"]')!.textContent).toContain('a•••@example.com');
    expect(el.querySelector('input[name="code"]')).not.toBeNull();
  });

  it('<SignIn> hides what the account lacks, offers a resend, and says how long a limited send must wait', async () => {
    const account = { username: null, email_verification: 'code', password_reset: 'code', mfa: { totp: true, sms: true, passkey: true, totp_codes: 1 } };
    const route = (factors: string[], prepare: () => Response) => [
      (c: { path: string }) => (c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status: 'needs_second_factor' }, 201) : undefined),
      (c: { path: string }) => (c.path === '/v1/client/sign_ins/sia_1/second_factors' ? json({ object: 'second_factors', factors }) : undefined),
      (c: { path: string }) => (c.path === '/v1/client/sign_ins/sia_1/prepare_second_factor' ? prepare() : undefined),
    ];
    const none = await mountFlow(SignIn, { account, routes: route(['totp'], () => json({ object: 'second_factor_challenge', sent_to: null })) });
    await setInput(none, 'identifier', 'ada@example.com');
    await submit(none);
    await waitFor(() => expect(none.querySelector('input[name="code"]')).not.toBeNull());
    await waitFor(() => expect(none.querySelector('[data-atlas="sms-second-factor"]')).toBeNull());
    expect(none.querySelector('[data-atlas="passkey-second-factor"]')).toBeNull();

    const sent = await mountFlow(SignIn, { account, routes: route(['sms'], () => json({ object: 'second_factor_challenge', sent_to: '+1•••0101' })) });
    await setInput(sent, 'identifier', 'ada@example.com');
    await submit(sent);
    await waitFor(() => expect(sent.querySelector('[data-atlas="sms-second-factor-resend"]')?.textContent?.trim()).toBe('Resend code'));

    const limited = await mountFlow(SignIn, { account, routes: route(['sms'], () => json({ errors: [{ code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.', meta: { retry_after: 30 } }] }, 429)) });
    await setInput(limited, 'identifier', 'ada@example.com');
    await submit(limited);
    await waitFor(() => expect(limited.textContent).toContain('another code in 30 seconds'));
    expect(limited.querySelector('[data-atlas="sms-second-factor"]')?.textContent?.trim()).toBe('Resend code');
  });

  it('<SignIn> emails the code on arrival at the second factor and shows where it went', async () => {
    const el = await mountFlow(SignIn, {
      account: { username: null, email_verification: 'code', password_reset: 'code', email_second_factor: true },
      routes: [
        (c) => (c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status: 'needs_second_factor' }, 201) : undefined),
        (c) => (c.path === '/v1/client/sign_ins/sia_1/prepare_second_factor' ? json({ object: 'second_factor_challenge', sent_to: 'a•••@example.com' }) : undefined),
      ],
    });
    await setInput(el, 'identifier', 'ada@example.com');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas="email-second-factor-sent"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_second_factor').map((c) => c.body)).toEqual([{ strategy: 'email_code', only_way: true }]);
    expect(el.querySelector('[data-atlas="email-second-factor"]')).toBeNull();
  });

  it('<SignIn> does not offer it when the instance does not', async () => {
    const el = await mountFlow(SignIn, {
      routes: [(c) => (c.path === '/v1/client/sign_ins' ? json({ id: 'sia_2', status: 'needs_second_factor' }, 201) : undefined)],
    });
    await setInput(el, 'identifier', 'ada@example.com');
    await submit(el);
    await waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas="email-second-factor"]')).toBeNull();
  });
});

describe('<SignIn> MFA enrolment and the texted second factor', () => {
  const TOTP_SETUP = { object: 'mfa_enrollment', strategy: 'totp', factor_id: 'mfa_t', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x', qr_code: 'data:image/gif;base64,R0lG' };
  const SMS_ACCOUNT = { username: null, email_verification: 'code', password_reset: 'code', mfa: { totp: true, sms: true, totp_codes: 1 } };
  const routes = (status: string): Route[] => [
    // On arrival the server sends nothing unless this channel is the only way.
    (c) => (c.path === '/v1/client/sign_ins/sia_1/prepare_second_factor' && c.body?.only_way ? json({ object: 'second_factor_challenge', sent_to: null }) : undefined),
    (c) => (c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status }, 201) : undefined),
    (c) =>
      c.path === '/v1/client/sign_ins/sia_1/prepare_mfa_enrollment'
        ? json(c.body?.strategy === 'phone_code' ? { object: 'mfa_enrollment', strategy: 'phone_code', factor_id: 'mfa_s', phone: '+1•••0101' } : TOTP_SETUP, 201)
        : undefined,
    (c) => (c.path === '/v1/client/sign_ins/sia_1/attempt_mfa_enrollment' ? json({ id: 'sia_1', status: 'complete', ticket: 'tkt_e', backup_codes: [] }) : undefined),
    (c) =>
      c.path === '/v1/client/sign_ins/sia_1/prepare_second_factor' ? json({ object: 'second_factor_challenge', strategy: c.body?.strategy, sent_to: '+1•••0101' }, 201) : undefined,
  ];

  it('authenticator app: shows the QR code and setup key, then confirms', async () => {
    const el = await mountFlow(SignIn, { routes: routes('needs_mfa_enrollment') });
    await setInput(el, 'identifier', 'ada@example.com');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas="mfa-qr"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas="mfa-qr"]')!.getAttribute('src')).toBe(TOTP_SETUP.qr_code);
    expect(el.querySelector('[data-atlas="mfa-setup-key"]')!.textContent).toContain('JBSW Y3DP EHPK 3PXP');
    expect(el.querySelector('[data-atlas-mfa-method="phone_code"]')).toBeNull();
    await setInput(el, 'code', '111111');
    await setInput(el, 'secondCode', '222222');
    await submit(el);
    await waitFor(() => expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')[0]!.body).toEqual({ factor_id: 'mfa_t', codes: ['111111', '222222'] });
  });

  it('text messages where the app can text: number, texted code, confirm', async () => {
    const el = await mountFlow(SignIn, { account: SMS_ACCOUNT, routes: routes('needs_mfa_enrollment') });
    await setInput(el, 'identifier', 'ada@example.com');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas-mfa-method="phone_code"]')).not.toBeNull());
    await fireEvent.click(el.querySelector('[data-atlas-mfa-method="phone_code"]')!);
    await waitFor(() => expect(el.querySelector('input[name="phone"]')).not.toBeNull());
    await setInput(el, 'phone', '+14155550101');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas="mfa-code-texted"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_mfa_enrollment')[0]!.body).toEqual({ strategy: 'phone_code', phone: '+14155550101' });
    await setInput(el, 'code', '654321');
    await submit(el);
    await waitFor(() => expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')[0]!.body).toEqual({ factor_id: 'mfa_s', code: '654321' });
  });

  it('recovery codes: shown once (copy, download as .txt); the ticket is redeemed while they show (it dies in 60 seconds), and "I\'ve saved my codes" finishes', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // jsdom has no blob URLs: give URL the two statics so they can be spied on.
    for (const k of ['createObjectURL', 'revokeObjectURL'] as const) {
      if (typeof URL[k] !== 'function') Object.defineProperty(URL, k, { value: () => '', configurable: true, writable: true });
    }
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:codes');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const withCodes = routes('needs_mfa_enrollment');
    withCodes[3] = (c) =>
      c.path === '/v1/client/sign_ins/sia_1/attempt_mfa_enrollment'
        ? json({ id: 'sia_1', status: 'complete', ticket: 'tkt_e', backup_codes: ['aaaa-1111', 'bbbb-2222'] })
        : undefined;
    const el = await mountFlow(SignIn, { account: { ...SMS_ACCOUNT, mfa: { totp: true, sms: false, totp_codes: 1 } }, routes: withCodes });
    await setInput(el, 'identifier', 'ada@example.com');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas="mfa-qr"]')).not.toBeNull());
    await setInput(el, 'code', '111111');
    await submit(el);

    await waitFor(() => expect(el.querySelector('[data-atlas="recovery-codes"]')).not.toBeNull());
    expect([...el.querySelectorAll('[data-atlas="recovery-codes-list"] li')].map((li) => li.textContent)).toEqual(['aaaa-1111', 'bbbb-2222']);
    expect(el.querySelector('form')).toBeNull();
    await waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    await waitFor(() => expect((el.querySelector('[data-atlas="recovery-codes-saved"]') as HTMLButtonElement).disabled).toBe(false));

    await fireEvent.click(el.querySelector('[data-atlas="recovery-codes-copy"]')!);
    expect(writeText).toHaveBeenCalledWith('aaaa-1111\nbbbb-2222');
    await waitFor(() => expect(el.querySelector('[data-atlas="recovery-codes-copied"]')).not.toBeNull());
    await fireEvent.click(el.querySelector('[data-atlas="recovery-codes-download"]')!);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);

    await fireEvent.click(el.querySelector('[data-atlas="recovery-codes-saved"]')!);
    await waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toMatchObject({ attempt_id: 'sia_1', ticket: 'tkt_e' });
    await waitFor(() => expect(el.querySelector('[data-atlas="recovery-codes"]')).toBeNull());
    vi.restoreAllMocks();
  });

  it('"Text me a code instead" at the second factor where the app can text', async () => {
    const el = await mountFlow(SignIn, { account: SMS_ACCOUNT, routes: routes('needs_second_factor') });
    await setInput(el, 'identifier', 'ada@example.com');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas="sms-second-factor"]')).not.toBeNull());
    await fireEvent.click(el.querySelector('[data-atlas="sms-second-factor"]')!);
    await waitFor(() => expect(el.querySelector('[data-atlas="sms-second-factor-sent"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_second_factor').at(-1)!.body).toEqual({ strategy: 'sms' });
  });

  it('keeps the recovery codes on screen when the session appears mid-flow', async () => {
    let held = false;
    const withCodes = routes('needs_mfa_enrollment');
    withCodes[3] = (c) =>
      c.path === '/v1/client/sign_ins/sia_1/attempt_mfa_enrollment'
        ? json({ id: 'sia_1', status: 'complete', ticket: 'tkt_e', backup_codes: ['aaaa-1111'] })
        : undefined;
    const el = await mountFlow(SignIn, {
      account: { ...SMS_ACCOUNT, mfa: { totp: true, sms: false, totp_codes: 1 } },
      signedIn: () => held,
      routes: withCodes,
    });
    await setInput(el, 'identifier', 'ada@example.com');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas="mfa-qr"]')).not.toBeNull());
    await setInput(el, 'code', '111111');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas="recovery-codes"]')).not.toBeNull());
    held = true;
    await lastClient!.reload();
    await waitFor(() => expect(el.querySelector('[data-atlas="recovery-codes"]')).not.toBeNull());
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
      const button = await waitFor(() => {
        const b = el.querySelector('[data-atlas-provider="atlas"]') as HTMLButtonElement | null;
        expect(b).not.toBeNull();
        return b!;
      });
      expect(button.textContent).toContain('Continue with Atlas');
      await fireEvent.click(button);
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://id.example/authorize?x=1'));
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
    await setInput(el, 'email', 'held@example.com');
    await setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-existing-account]')).toBeNull();
    const boots = calls.filter((c) => c.path === '/v1/client').length;

    await setInput(el, 'code', '424242');
    await submit(el);
    await waitFor(() => expect((el.querySelector('[data-atlas-existing-account] button') as HTMLButtonElement | null)?.disabled).toBe(false));
    expect(posts('/v1/client/tickets/exchange')).toHaveLength(1);
    const notice = el.querySelector('[data-atlas-existing-account]')!;
    expect(notice.textContent).toContain('You already had an account. Your existing password still applies.');
    expect(notice.querySelector('a')!.getAttribute('href')).toContain('/hosted/sign-in');
    expect(calls.filter((c) => c.path === '/v1/client').length).toBe(boots);

    await fireEvent.click(notice.querySelector('button')!);
    await waitFor(() => expect(el.querySelector('[data-atlas-existing-account]')).toBeNull());
    expect(calls.filter((c) => c.path === '/v1/client').length).toBeGreaterThan(boots);
    expect(posts('/v1/client/tickets/exchange')).toHaveLength(1);
  });
});

describe('<SignUp> on a held account: the other endings', () => {
  it('a link made no session: a neutral line and a way to sign in, nothing to submit', async () => {
    const el = await mountFlow(SignUp, {
      routes: [(c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_1', object: 'sign_up_attempt', status: 'needs_first_factor' }, 201) : undefined)],
    });
    await setInput(el, 'email', 'held@example.com');
    await setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas-email-confirmed]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-email-confirmed]')!.textContent).toContain('Your email is confirmed. Sign in to continue.');
    expect(el.querySelector('[data-atlas-email-confirmed] a')!.getAttribute('href')).toContain('/hosted/sign-in');
    expect(el.querySelector('button[type="submit"]')).toBeNull();
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
    await setInput(el, 'email', 'held@example.com');
    await setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    await setInput(el, 'code', '424242');
    await submit(el);
    await waitFor(() => expect(el.querySelector('input[name="secondCode"]')).not.toBeNull());
    await setInput(el, 'code', '111111');
    await setInput(el, 'secondCode', '222222');
    await submit(el);

    await waitFor(() => expect((el.querySelector('[data-atlas="recovery-codes-saved"]') as HTMLButtonElement | null)?.disabled).toBe(false));
    expect(posts('/v1/client/tickets/exchange')).toHaveLength(1);
    expect(el.querySelector('[data-atlas-existing-account]')).toBeNull();

    await fireEvent.click(el.querySelector('[data-atlas="recovery-codes-saved"]')!);
    await waitFor(() => expect(el.querySelector('[data-atlas-existing-account]')).not.toBeNull());
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
      account: { username: null, email_verification: 'link', password_reset: 'code' },
      routes: [
        (c) =>
          c.method === 'POST' && c.path === '/v1/client/sign_ups'
            ? json({ id: 'sia_l', object: 'sign_up_attempt', status: 'needs_email_verification', identifier: 'l@example.com', poll_secret: 'ps_l', match_code: '482113' }, 201)
            : undefined,
      ],
    });
    await setInput(el, 'email', 'l@example.com');
    await setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas="link-match-code"]')?.textContent).toContain('482113'));
  });

  it('opened on another device: asks for the typed code, then says to go back', async () => {
    window.history.replaceState({}, '', '/?attempt=sia_l&token=tok');
    const el = await mountFlow(SignUp, {
      routes: [
        (c) => (c.method === 'GET' && c.path === '/v1/client/sign_ups/verify' ? json({ requires_confirmation: true }) : undefined),
        (c) => (c.path === '/v1/client/sign_ups/verify/confirm' ? json({ verified: true }) : undefined),
      ],
    });
    await waitFor(() => expect(el.querySelector('input[name="match_code"]')).not.toBeNull());
    await setInput(el, 'match_code', '482113');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas-status="confirmed"]')).not.toBeNull());
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
    await waitFor(() => expect(el.querySelector('[data-atlas-status="confirmed"]')).not.toBeNull());
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
    await setInput(el, 'identifier', 'ada@example.com');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas-mfa-method="yubikey"]')).not.toBeNull());
    for (const m of ['totp', 'hotp', 'duo']) expect(el.querySelector(`[data-atlas-mfa-method="${m}"]`)).not.toBeNull();
    await fireEvent.click(el.querySelector('[data-atlas-mfa-method="yubikey"]')!);
    await waitFor(() => expect(el.querySelector('input[name="otp"]')).not.toBeNull());
    await setInput(el, 'otp', 'ccccccfjkbbb');
    await submit(el);
    await waitFor(() => expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')[0]!.body).toEqual({ strategy: 'yubikey', otp: 'ccccccfjkbbb' });
  });

  it('draws nothing when someone is already signed in, and the form returns on sign-out', async () => {
    let held = true;
    const el = await mountFlow(SignIn, { signedIn: () => held, routes: [] });
    await lastClient!.reload();
    await waitFor(() => expect(el.querySelector('form')).toBeNull());
    held = false;
    await lastClient!.reload();
    await waitFor(() => expect(el.querySelector('form')).not.toBeNull());
  });
});
