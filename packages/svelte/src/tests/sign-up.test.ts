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
  opts: { captchaFlows?: Record<string, unknown>; account?: Record<string, unknown>; routes: Route[] },
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
        ...(opts.account ? { account: opts.account } : {}),
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
        (c) => (c.path === '/v1/client/sign_ins/sia_1/prepare_second_factor' ? json({ object: 'second_factor_challenge', sent_to: 'a•••@example.com' }) : undefined),
      ],
    });
    await setInput(el, 'identifier', 'ada@example.com');
    await submit(el);
    await waitFor(() => expect(el.querySelector('[data-atlas="email-second-factor"]')).not.toBeNull());
    await fireEvent.click(el.querySelector('[data-atlas="email-second-factor"]')!);
    await waitFor(() => expect(el.querySelector('[data-atlas="email-second-factor-sent"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_second_factor')[0]!.body).toEqual({ strategy: 'email_code' });
    expect(el.querySelector('[data-atlas="email-second-factor-sent"]')!.textContent).toContain('a•••@example.com');
    expect(el.querySelector('input[name="code"]')).not.toBeNull();
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

  it('recovery codes: shown once (copy, download as .txt); the ticket is exchanged only after "I\'ve saved my codes"', async () => {
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
    withCodes[2] = (c) =>
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
    expect(posts('/v1/client/tickets/exchange')).toHaveLength(0);

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
    expect(posts('/v1/client/sign_ins/sia_1/prepare_second_factor')[0]!.body).toEqual({ strategy: 'sms' });
  });
});
