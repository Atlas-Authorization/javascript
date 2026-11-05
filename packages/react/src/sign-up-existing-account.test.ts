// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { SignUp } from './sign-up';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A held address: the code proved an existing account, so the typed password was dropped and `<SignUp>` says so. */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setInput(el: HTMLElement, name: string, value: string) {
  const input = el.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  expect(input, `input[name=${name}]`).not.toBeNull();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const submit = (el: HTMLElement) =>
  act(async () => {
    el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

async function mount(exchange: () => Response, resetPasswordUrl?: string) {
  const paths: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === '/v1/client') return json({ session: null, user: null });
    if (path === '/v1/appearance') {
      return json({
        object: 'appearance',
        appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] },
        captchaFlows: {},
        email_delivery: { available: true, passwordSignUp: true },
      });
    }
    if (path === '/v1/client/sign_ups') return json({ id: 'sua_1', object: 'sign_up_attempt', status: 'needs_email_verification' }, 201);
    if (path === '/v1/client/sign_ups/sua_1/attempt_verification') {
      return json({ id: 'sua_1', object: 'sign_up_attempt', status: 'complete', ticket: 'tkt_1', existing_account: true });
    }
    if (path === '/v1/client/tickets/exchange') return exchange();
    return json({});
  }) as unknown as typeof fetch;
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
        children: createElement(SignUp as unknown as (props: Record<string, unknown>) => null, { afterUrl: 'https://app.example/home', ...(resetPasswordUrl ? { resetPasswordUrl } : {}) }),
      }),
    );
  });
  unmount = () => act(() => root.unmount());
  await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
  setInput(el, 'email', 'held@example.com');
  setInput(el, 'password', 'blue tangerine anvil 71!');
  await submit(el);
  await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
  expect(el.querySelector('[data-atlas-existing-account]')).toBeNull();
  return { el, paths };
}

describe('<SignUp> on an existing account', () => {
  it('exchanges the ticket, then holds the app and the redirect on the notice until Continue', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, href: 'https://app.example/sign-up', assign });
    const { el, paths } = await mount(() => json({ ok: true }));
    const boots = () => paths.filter((p) => p === '/v1/client').length;
    const before = boots();

    setInput(el, 'code', '424242');
    await submit(el);
    await vi.waitFor(() => expect((el.querySelector('[data-atlas-existing-account] button') as HTMLButtonElement | null)?.disabled).toBe(false));
    const notice = el.querySelector('[data-atlas-existing-account]')!;
    expect(notice.textContent).toContain('You already had an account. Your existing password still applies.');
    expect(notice.querySelector('a')!.getAttribute('href')).toContain('/hosted/sign-in');
    expect(paths.filter((p) => p === '/v1/client/tickets/exchange')).toHaveLength(1);
    expect(boots()).toBe(before);
    expect(assign).not.toHaveBeenCalled();

    await act(async () => {
      (notice.querySelector('button') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-existing-account]')).toBeNull());
    expect(boots()).toBeGreaterThan(before);
    expect(paths.filter((p) => p === '/v1/client/tickets/exchange')).toHaveLength(1);
  });

  it('uses the app reset page when given one', async () => {
    const { el } = await mount(() => json({ ok: true }), 'https://app.example/forgot');
    setInput(el, 'code', '424242');
    await submit(el);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-existing-account] a')).not.toBeNull());
    expect(el.querySelector('[data-atlas-existing-account] a')!.getAttribute('href')).toBe('https://app.example/forgot');
  });

  it('a refused exchange shows the not-kept message, not the notice', async () => {
    const { el } = await mount(() => json({ errors: [{ code: 'x', message: 'expired' }] }, 400));
    setInput(el, 'code', '424242');
    await submit(el);
    await vi.waitFor(() => expect(el.querySelector('[role="alert"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-existing-account]')).toBeNull();
  });
});

describe('<SignUp> on a held account: the other endings', () => {
  async function mountSignUp(routes: Record<string, unknown>, props: Record<string, unknown> = {}) {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === '/v1/client') return json({ session: null, user: null });
      if (path === '/v1/appearance') {
        return json({
          object: 'appearance',
          appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] },
          captchaFlows: {},
          email_delivery: { available: true, passwordSignUp: true },
        });
      }
      return json(routes[path] ?? {}, path === '/v1/client/sign_ups' ? 201 : 200);
    }) as unknown as typeof fetch;
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
          children: createElement(SignUp as unknown as (p: Record<string, unknown>) => null, props),
        }),
      );
    });
    unmount = () => act(() => root.unmount());
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    setInput(el, 'email', 'held@example.com');
    setInput(el, 'password', 'blue tangerine anvil 71!');
    await submit(el);
    return { el, paths };
  }
  const proved = { id: 'sua_1', object: 'sign_up_attempt', status: 'needs_first_factor', identifier: 'held@example.com' };

  it('a link made no session: a neutral line and a way to sign in, nothing to submit', async () => {
    const { el } = await mountSignUp({ '/v1/client/sign_ups': proved });
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-email-confirmed]')).not.toBeNull());
    const card = el.querySelector('[data-atlas-email-confirmed]')!;
    expect(card.textContent).toContain('Your email is confirmed. Sign in to continue.');
    expect(card.textContent).not.toContain('already');
    expect(card.querySelector('a')!.getAttribute('href')).toContain('/hosted/sign-in');
    expect(el.querySelector('button[type="submit"]')).toBeNull();
    expect(el.querySelector('input')).toBeNull();
  });

  it('signInUrl overrides that link, and null hides it', async () => {
    const custom = await mountSignUp({ '/v1/client/sign_ups': proved }, { signInUrl: 'https://app.example/login' });
    await vi.waitFor(() => expect(custom.el.querySelector('[data-atlas-email-confirmed] a')?.getAttribute('href')).toBe('https://app.example/login'));
    unmount?.();
    const hidden = await mountSignUp({ '/v1/client/sign_ups': proved }, { signInUrl: null });
    await vi.waitFor(() => expect(hidden.el.querySelector('[data-atlas-email-confirmed]')).not.toBeNull());
    expect(hidden.el.querySelector('[data-atlas-email-confirmed] a')).toBeNull();
  });

  it('must enrol: the setup, then the recovery codes with the ticket already redeemed, then the notice, then done', async () => {
    const { el, paths } = await mountSignUp({
      '/v1/client/sign_ups': { id: 'sua_1', object: 'sign_up_attempt', status: 'needs_email_verification' },
      '/v1/client/sign_ups/sua_1/attempt_verification': { id: 'sua_1', object: 'sign_up_attempt', status: 'needs_mfa_enrollment', existing_account: true },
      '/v1/client/sign_ins/sua_1/prepare_mfa_enrollment': { factor_id: 'mfa_t', secret: 'ABCD', uri: 'otpauth://totp/x' },
      '/v1/client/sign_ins/sua_1/attempt_mfa_enrollment': { id: 'sua_1', object: 'sign_in_attempt', status: 'complete', ticket: 'tkt_1', backup_codes: ['aaaa-1111'] },
      '/v1/client/tickets/exchange': { ok: true },
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    setInput(el, 'code', '424242');
    await submit(el);
    await vi.waitFor(() => expect(el.querySelector('input[name="secondCode"]')).not.toBeNull());
    setInput(el, 'code', '111111');
    setInput(el, 'secondCode', '222222');
    await submit(el);

    await vi.waitFor(() => expect((el.querySelector('[data-atlas="recovery-codes-saved"]') as HTMLButtonElement | null)?.disabled).toBe(false));
    expect(el.querySelector('[data-atlas="recovery-codes-list"]')!.textContent).toContain('aaaa-1111');
    expect(el.querySelector('[data-atlas-existing-account]')).toBeNull();
    expect(paths.filter((p) => p === '/v1/client/tickets/exchange')).toHaveLength(1);

    await act(async () => {
      (el.querySelector('[data-atlas="recovery-codes-saved"]') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-existing-account]')).not.toBeNull());
    await act(async () => {
      (el.querySelector('[data-atlas-existing-account] button') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-existing-account]')).toBeNull());
    expect(paths.filter((p) => p === '/v1/client/tickets/exchange')).toHaveLength(1);
  });
});
