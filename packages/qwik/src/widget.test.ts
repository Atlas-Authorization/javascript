import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountSignIn, mountSignUp } from '@atlasauth/embed';
import { EMAIL_UNAVAILABLE_MESSAGE } from '@atlasauth/js';
import { mountAtlasWidget } from './widget';

/**
 * The mountable `<SignIn>`/`<SignUp>` mount the `@atlasauth/embed` DOM widget
 * into a ref'd element from a `useVisibleTask$` and tear it down on cleanup.
 * The mount function is injected here, so the helper is exercised without the
 * real widget or a network — the spec's "unit-test the mount/cleanup helper
 * functions directly" path.
 */

describe('mountAtlasWidget', () => {
  it('mounts into the given host with the instance overrides', () => {
    const host = document.createElement('div');
    const mounter = vi.fn();

    mountAtlasWidget(host, 'sign-in', {
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      redirect: '/after',
      mounter,
    });

    expect(mounter).toHaveBeenCalledTimes(1);
    const [calledHost, overrides] = mounter.mock.calls[0]!;
    expect(calledHost).toBe(host);
    expect(overrides).toEqual({
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      redirect: '/after',
    });
  });

  it('omits an unset redirect', () => {
    const host = document.createElement('div');
    const mounter = vi.fn();

    mountAtlasWidget(host, 'sign-up', {
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      mounter,
    });

    const overrides = mounter.mock.calls[0]![1] as Record<string, unknown>;
    expect(overrides).not.toHaveProperty('redirect');
  });

  it('cleanup clears the host it rendered into', () => {
    const host = document.createElement('div');
    // Simulate the widget having rendered a panel into the host.
    const mounter = vi.fn((h: HTMLElement) => {
      h.appendChild(document.createElement('form'));
    });

    const teardown = mountAtlasWidget(host, 'sign-in', {
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      mounter,
    });

    expect(host.childElementCount).toBe(1);
    teardown();
    expect(host.childElementCount).toBe(0);
    // Idempotent: a second cleanup (e.g. after the host detached) is a no-op.
    expect(() => teardown()).not.toThrow();
  });
});

/**
 * Item: email delivery. `<SignIn>` / `<SignUp>` mount the real `@atlasauth/embed`
 * widget, which reads `email_delivery` from the instance settings it loads
 * (`GET /v1/appearance`). These drive the real widget through
 * `mountAtlasWidget` against a mocked Frontend API, so a Qwik app gets the
 * "can't send email" behaviour without any Qwik-side strings of its own.
 */
describe('mountAtlasWidget honours the instance email delivery', () => {
  const appearance = {
    applicationName: 'Acme',
    logoUrl: null,
    colorPrimary: '#5b5bd6',
    colorBackground: '#ffffff',
    colorText: '#1c1c1f',
    colorAccent: '#5b5bd6',
    colorCard: '#ffffff',
    colorBorder: '#e4e4e9',
    borderRadius: '10px',
    theme: 'light',
    fontStack: 'system-ui',
    layout: 'centered',
    headline: null,
    subheadline: null,
    footer: null,
    providerOrder: [],
    providerHidden: [],
  };
  const settings = (emailDelivery?: Record<string, boolean>) => ({
    object: 'appearance',
    appearance,
    providers: [],
    strategies: {
      password: true,
      emailCode: !emailDelivery,
      emailLink: !emailDelivery,
      passkey: false,
      phoneCode: false,
      siwe: false,
    },
    ...(emailDelivery ? { email_delivery: emailDelivery } : {}),
  });
  const noEmail = { available: false, password_reset: false, password_sign_up: false };

  const fapi = (body: unknown) => {
    const paths: string[] = [];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`);
      if (url.pathname === '/v1/appearance') {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ code: 'NO_ROUTE', message: 'no route' }] }), { status: 404 });
    }) as unknown as typeof fetch;
    return { impl, paths };
  };
  const flush = async (times = 8): Promise<void> => {
    for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const hasForgot = (root: HTMLElement) =>
    Array.from(root.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('Forgot'));

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('sign-up shows the "can\'t send email" notice and no password field when passwordSignUp is false', async () => {
    const { impl, paths } = fapi(settings(noEmail));
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountAtlasWidget(host, 'sign-up', {
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      mounter: (h, overrides) => mountSignUp(h, { ...overrides, fetchImpl: impl }),
    });
    await flush();

    expect(host.textContent).toContain(EMAIL_UNAVAILABLE_MESSAGE);
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(paths).not.toContain('POST /v1/client/sign_ups');
  });

  it('sign-up draws the email + password form when the server omits the block', async () => {
    const { impl } = fapi(settings());
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountAtlasWidget(host, 'sign-up', {
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      mounter: (h, overrides) => mountSignUp(h, { ...overrides, fetchImpl: impl }),
    });
    await flush();

    expect(host.querySelector('input[type="password"]')).toBeTruthy();
    expect(host.textContent).not.toContain(EMAIL_UNAVAILABLE_MESSAGE);
  });

  it('sign-in hides "Forgot password?" when the reset email cannot be delivered', async () => {
    const { impl } = fapi(settings(noEmail));
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountAtlasWidget(host, 'sign-in', {
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      mounter: (h, overrides) => mountSignIn(h, { ...overrides, fetchImpl: impl }),
    });
    await flush();

    expect(host.querySelector('input[name="password"]')).toBeTruthy();
    expect(hasForgot(host)).toBe(false);
  });

  it('sign-in keeps "Forgot password?" when email can be delivered', async () => {
    const { impl } = fapi(settings());
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountAtlasWidget(host, 'sign-in', {
      publishableKey: 'pk_test',
      frontendApi: 'https://fapi.example',
      mounter: (h, overrides) => mountSignIn(h, { ...overrides, fetchImpl: impl }),
    });
    await flush();

    expect(hasForgot(host)).toBe(true);
  });
});
