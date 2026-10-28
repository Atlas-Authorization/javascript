// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { SignIn } from './sign-in';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `<SignIn>`'s MFA steps end to end: setting up a second factor mid-sign-in
 * (authenticator app with its QR code, or a texted code where the app can
 * text) and "Text me a code instead" at the second-factor step. FAPI is a
 * scripted fetch, so these run with no network.
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

async function mount(opts: { routes: Route[]; locale?: string; emailDelivery?: Record<string, boolean>; account?: Record<string, unknown> }) {
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
        ...(opts.account ? { account: opts.account } : {}),
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

/** Email, then password, landing on whatever `status` the password answers with. */
const passwordRoute =
  (status: string): Route =>
  (c) =>
    c.path === '/v1/client/sign_ins/sia_1/attempt_first_factor' ? json({ ...attempt([]), status }) : undefined;

async function signInTo(el: HTMLElement) {
  setInput(el, 'identifier', 'someone@example.com');
  await submit(el);
  await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
  setInput(el, 'password', 'correct horse');
  await submit(el);
}

const TOTP_SETUP = {
  object: 'mfa_enrollment',
  strategy: 'totp',
  factor_id: 'mfa_t',
  secret: 'JBSWY3DPEHPK3PXP',
  uri: 'otpauth://totp/acme',
  qr_code: 'data:image/gif;base64,R0lGODlh',
};
const prepareEnrolRoute: Route = (c) => {
  if (c.path !== '/v1/client/sign_ins/sia_1/prepare_mfa_enrollment') return undefined;
  return c.body?.strategy === 'phone_code'
    ? json({ object: 'mfa_enrollment', strategy: 'phone_code', factor_id: 'mfa_s', phone: '+1•••••0101' }, 201)
    : json(TOTP_SETUP, 201);
};
const confirmEnrolRoute: Route = (c) =>
  c.path === '/v1/client/sign_ins/sia_1/attempt_mfa_enrollment'
    ? json({ ...attempt([]), status: 'complete', created_session_id: 'sess_1', ticket: 'tkt_1', backup_codes: ['a', 'b'] })
    : undefined;

/** The recovery codes are on screen, the ticket not yet exchanged; "I've saved my codes" finishes. */
async function saveRecoveryCodes(el: HTMLElement) {
  await vi.waitFor(() => expect(el.querySelector('[data-atlas="recovery-codes"]')).not.toBeNull());
  expect(posts('/v1/client/tickets/exchange')).toHaveLength(0);
  await click(el.querySelector('[data-atlas="recovery-codes-saved"]'));
}

describe('<SignIn> MFA enrolment mid-sign-in', () => {
  it('authenticator app only (a server that does not say): shows the QR code and setup key, then confirms', async () => {
    const el = await mount({
      routes: [signInRoute(['password']), passwordRoute('needs_mfa_enrollment'), prepareEnrolRoute, confirmEnrolRoute],
    });
    await signInTo(el);

    await vi.waitFor(() => expect(el.querySelector('[data-atlas="mfa-qr"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_mfa_enrollment')[0]!.body).toEqual({ strategy: 'totp' });
    expect(el.querySelector('[data-atlas="mfa-qr"]')!.getAttribute('src')).toBe(TOTP_SETUP.qr_code);
    expect(el.querySelector('[data-atlas="mfa-setup-key"]')!.textContent).toContain('JBSW Y3DP EHPK 3PXP');
    // No texted option when the app has not said it can text.
    expect(el.querySelector('[data-atlas-mfa-method="phone_code"]')).toBeNull();
    expect(el.querySelector('input[name="secondCode"]')).not.toBeNull();

    setInput(el, 'code', '111111');
    setInput(el, 'secondCode', '222222');
    await submit(el);
    await saveRecoveryCodes(el);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')[0]!.body).toEqual({
      factor_id: 'mfa_t',
      codes: ['111111', '222222'],
    });
  });

  it('where the app can text: choose text messages, send the number, confirm with the texted code', async () => {
    const el = await mount({
      account: { mfa: { totp: true, sms: true, totp_codes: 1 } },
      routes: [signInRoute(['password']), passwordRoute('needs_mfa_enrollment'), prepareEnrolRoute, confirmEnrolRoute],
    });
    await signInTo(el);

    await vi.waitFor(() => expect(el.querySelector('[data-atlas-mfa-method="phone_code"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-mfa-method="totp"]')).not.toBeNull();
    expect(posts('/v1/client/sign_ins/sia_1/prepare_mfa_enrollment')).toHaveLength(0);

    await click(el.querySelector('[data-atlas-mfa-method="phone_code"]'));
    await vi.waitFor(() => expect(el.querySelector('input[name="phone"]')).not.toBeNull());
    expect(el.querySelector('input[name="phone"]')!.getAttribute('type')).toBe('tel');
    setInput(el, 'phone', '+14155550101');
    await submit(el);

    await vi.waitFor(() => expect(el.querySelector('[data-atlas="mfa-code-texted"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_mfa_enrollment')[0]!.body).toEqual({ strategy: 'phone_code', phone: '+14155550101' });
    expect(el.querySelector('[data-atlas="mfa-code-texted"]')!.textContent).toContain('+1•••••0101');

    setInput(el, 'code', '654321');
    await submit(el);
    await saveRecoveryCodes(el);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')[0]!.body).toEqual({ factor_id: 'mfa_s', code: '654321' });
  });

  it('one authenticator code where the app asks for one', async () => {
    const el = await mount({
      account: { mfa: { totp: true, sms: false, totp_codes: 1 } },
      routes: [signInRoute(['password']), passwordRoute('needs_mfa_enrollment'), prepareEnrolRoute, confirmEnrolRoute],
    });
    await signInTo(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="mfa-qr"]')).not.toBeNull());
    expect(el.querySelector('input[name="code"]')).not.toBeNull();
    expect(el.querySelector('input[name="secondCode"]')).toBeNull();
  });
});

describe('<SignIn> recovery codes after enrolment', () => {
  it('shows the codes once (copy, download as .txt) and finishes only after "I\'ve saved my codes"', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:codes');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const el = await mount({
      account: { mfa: { totp: true, sms: false, totp_codes: 1 } },
      routes: [signInRoute(['password']), passwordRoute('needs_mfa_enrollment'), prepareEnrolRoute, confirmEnrolRoute],
    });
    await signInTo(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="mfa-qr"]')).not.toBeNull());
    setInput(el, 'code', '111111');
    await submit(el);

    await vi.waitFor(() => expect(el.querySelector('[data-atlas="recovery-codes"]')).not.toBeNull());
    const listed = [...el.querySelectorAll('[data-atlas="recovery-codes-list"] li')].map((li) => li.textContent);
    expect(listed).toEqual(['a', 'b']);
    expect(el.querySelector('form')).toBeNull();
    expect(posts('/v1/client/tickets/exchange')).toHaveLength(0);

    await click(el.querySelector('[data-atlas="recovery-codes-copy"]'));
    expect(writeText).toHaveBeenCalledWith('a\nb');
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="recovery-codes-copied"]')).not.toBeNull());

    await click(el.querySelector('[data-atlas="recovery-codes-download"]'));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);

    await click(el.querySelector('[data-atlas="recovery-codes-saved"]'));
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toMatchObject({ attempt_id: 'sia_1', ticket: 'tkt_1' });
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="recovery-codes"]')).toBeNull());
  });

  it('a completion with no recovery codes finishes straight away', async () => {
    const el = await mount({
      account: { mfa: { totp: true, sms: false, totp_codes: 1 } },
      routes: [
        signInRoute(['password']),
        passwordRoute('needs_mfa_enrollment'),
        prepareEnrolRoute,
        (c) =>
          c.path === '/v1/client/sign_ins/sia_1/attempt_mfa_enrollment'
            ? json({ ...attempt([]), status: 'complete', created_session_id: 'sess_1', ticket: 'tkt_1', backup_codes: [] })
            : undefined,
      ],
    });
    await signInTo(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="mfa-qr"]')).not.toBeNull());
    setInput(el, 'code', '111111');
    await submit(el);
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1));
    expect(el.querySelector('[data-atlas="recovery-codes"]')).toBeNull();
  });
});

describe('<SignIn> second-factor alternatives', () => {
  it('offers "Text me a code instead" and "Email me a code instead" where the app does', async () => {
    const el = await mount({
      account: { email_second_factor: true, mfa: { totp: true, sms: true, totp_codes: 1 } },
      routes: [
        signInRoute(['password']),
        passwordRoute('needs_second_factor'),
        (c) =>
          c.path === '/v1/client/sign_ins/sia_1/prepare_second_factor'
            ? json({ object: 'second_factor_challenge', strategy: c.body?.strategy, sent_to: c.body?.strategy === 'sms' ? '+1•••0101' : 's•••@example.com' }, 201)
            : undefined,
      ],
    });
    await signInTo(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="sms-second-factor"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas="email-second-factor"]')).not.toBeNull();

    await click(el.querySelector('[data-atlas="sms-second-factor"]'));
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="sms-second-factor-sent"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_second_factor')[0]!.body).toEqual({ strategy: 'sms' });
    expect(el.querySelector('[data-atlas="sms-second-factor-sent"]')!.textContent).toContain('+1•••0101');
  });

  it('offers "Use Duo instead" and polls the sign-in until Duo approves it', async () => {
    const opened = vi.fn(() => ({ location: { href: '' }, close: vi.fn() }));
    vi.stubGlobal('open', opened);
    let approved = false;
    const el = await mount({
      account: { mfa: { totp: true, sms: false, totp_codes: 1, duo: true } },
      routes: [
        signInRoute(['password']),
        passwordRoute('needs_second_factor'),
        (c) =>
          c.path === '/v1/client/sign_ins/sia_1/prepare_second_factor'
            ? json({ object: 'second_factor_challenge', strategy: 'duo', authorization_url: 'https://api-1.duosecurity.com/oauth/v1/authorize?x=1' }, 201)
            : undefined,
        (c) =>
          c.path === '/v1/client/sign_ins/sia_1/attempt_second_factor' && c.body?.strategy === 'duo'
            ? json(approved ? { ...attempt([]), status: 'complete', created_session_id: 'sess_1', ticket: 'tkt_1' } : { ...attempt([]), status: 'needs_second_factor' })
            : undefined,
      ],
    });
    await signInTo(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="duo-second-factor"]')).not.toBeNull());
    await click(el.querySelector('[data-atlas="duo-second-factor"]'));
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="duo-waiting"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_second_factor')[0]!.body).toEqual({ strategy: 'duo' });
    expect(opened).toHaveBeenCalled();
    approved = true;
    await vi.waitFor(() => expect(posts('/v1/client/tickets/exchange')).toHaveLength(1), { timeout: 6000 });
    expect(posts('/v1/client/sign_ins/sia_1/attempt_second_factor').some((c) => c.body?.strategy === 'duo')).toBe(true);
  }, 15_000);

  it('no Duo option unless the app offers it', async () => {
    const el = await mount({ routes: [signInRoute(['password']), passwordRoute('needs_second_factor')] });
    await signInTo(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas="duo-second-factor"]')).toBeNull();
  });

  it('no texted option where the app has not said it can text', async () => {
    const el = await mount({ routes: [signInRoute(['password']), passwordRoute('needs_second_factor')] });
    await signInTo(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas="sms-second-factor"]')).toBeNull();
  });
});
