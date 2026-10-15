import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { EMAIL_UNAVAILABLE_MESSAGE } from '@atlasauth/js';
import { ATLAS_KEY, createAtlasClient } from '../lib/context';
import { EN_US } from '../lib/i18n';
import SignIn from '../lib/components/SignIn.svelte';
import SignUp from '../lib/components/SignUp.svelte';

/**
 * An app that cannot deliver email (`email_delivery` on `/v1/appearance`):
 * `<SignUp>` shows a "can't send email" state instead of an email + password
 * form it could never verify, and `<SignIn>` stops offering an emailed code /
 * link. The server refuses those regardless; this says so up front.
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

let calls: Call[] = [];
beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountFlow(
  component: typeof SignIn | typeof SignUp,
  emailDelivery: Record<string, boolean> | undefined,
  firstFactors: string[] = ['password', 'email_code'],
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
        captchaFlows: {},
        ...(emailDelivery ? { email_delivery: emailDelivery } : {}),
      });
    }
    if (call.path === '/v1/client/sign_ins') {
      return json({ id: 'sia_1', status: 'needs_first_factor', supported_first_factors: firstFactors }, 201);
    }
    if (call.path === '/v1/client/sign_ins/sia_1/prepare_first_factor') return json({ id: 'sia_1' });
    return json({});
  }) as unknown as typeof fetch;
  // The flow's FAPI client uses the global fetch; the Atlas client takes fetchImpl.
  vi.stubGlobal('fetch', fetchImpl);
  const client = createAtlasClient({ publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, manualBoot: true });
  const view = render(component, { context: new Map([[ATLAS_KEY, client]]) });
  await waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance')).toBe(true));
  return view.container as HTMLElement;
}

/** Submit an identifier and wait for the first-factor step. */
async function toFirstFactor(el: HTMLElement) {
  const input = el.querySelector('input[name="identifier"]') as HTMLInputElement;
  await fireEvent.input(input, { target: { value: 'me@example.com' } });
  await fireEvent.submit(el.querySelector('form')!);
  await waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
}

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

describe('<SignUp> when the app cannot send email', () => {
  it('shows the unavailable notice and no password field', async () => {
    const el = await mountFlow(SignUp, { available: false, password_reset: false, password_sign_up: false });
    await waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toBe(EMAIL_UNAVAILABLE_MESSAGE));
    expect(EN_US['signUp.emailUnavailable']).toBe(EMAIL_UNAVAILABLE_MESSAGE);
    expect(el.querySelector('input[name="password"]')).toBeNull();
    expect(el.querySelector('input[name="email"]')).toBeNull();
    expect(el.querySelector('form')).toBeNull();
  });

  it('uses the localized `signUp.emailUnavailable` text', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      calls.push({ method: 'GET', path, body: null });
      if (path === '/v1/appearance') return json({ email_delivery: { password_sign_up: false } });
      return json({ session: null, user: null });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const client = createAtlasClient({
      publishableKey: 'pk_test_x',
      frontendApi: FAPI,
      fetchImpl,
      manualBoot: true,
      localization: { 'signUp.emailUnavailable': 'Courriel indisponible.' },
    });
    const el = render(SignUp, { context: new Map([[ATLAS_KEY, client]]) }).container as HTMLElement;
    await waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toBe('Courriel indisponible.'));
  });

  it('keeps the email + password form when email can be delivered (or the server does not say)', async () => {
    const el = await mountFlow(SignUp, undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector('input[name="password"]')).not.toBeNull();
    expect(el.textContent).not.toContain(EMAIL_UNAVAILABLE_MESSAGE);
  });
});

describe('<SignIn> first-factor choice', () => {
  it('hides the email-code option when email cannot be delivered', async () => {
    const el = await mountFlow(SignIn, { available: false, password_reset: false, password_sign_up: false });
    await toFirstFactor(el);
    expect(el.querySelector('[data-strategy="email_code"]')).toBeNull();
    expect(el.querySelector('[data-strategy="email_link"]')).toBeNull();
    expect(el.textContent).not.toContain(EN_US['signIn.emailCodeOption']);
  });

  it('offers the email code when email can be delivered: sends it, then posts the code', async () => {
    const el = await mountFlow(SignIn, { available: true, password_reset: true, password_sign_up: true });
    await toFirstFactor(el);
    const option = el.querySelector('[data-strategy="email_code"]') as HTMLButtonElement;
    expect(option?.textContent?.trim()).toBe(EN_US['signIn.emailCodeOption']);

    await fireEvent.click(option);
    await waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    expect(posts('/v1/client/sign_ins/sia_1/prepare_first_factor')[0]!.body).toEqual({ strategy: 'email_code' });
    expect(el.querySelector('input[name="password"]')).toBeNull();

    await fireEvent.input(el.querySelector('input[name="code"]')!, { target: { value: '123456' } });
    await fireEvent.submit(el.querySelector('form')!);
    await waitFor(() => expect(posts('/v1/client/sign_ins/sia_1/attempt_first_factor')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins/sia_1/attempt_first_factor')[0]!.body).toEqual({
      strategy: 'email_code',
      code: '123456',
    });
  });

  it('keeps the password field when only emailed factors were offered and email cannot be delivered', async () => {
    const el = await mountFlow(SignIn, { available: false }, ['email_code', 'email_link']);
    await toFirstFactor(el);
    expect(el.querySelector('[data-strategy]')).toBeNull();
  });
});
