import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import { h } from './h';
import { AtlasProvider } from './provider';
import { SignIn } from './widgets';

/**
 * A held password's refusal (`password_not_yet_usable`) offers the emailed proof even
 * where email code sign-in is off; it goes through the sign-up verification routes,
 * and proving it brings the password back with the "you can sign in" message.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<SignIn> password hold', () => {
  it('offers the emailed proof after the refusal, and proving it brings the password back', async () => {
    const posts: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === 'POST') posts.push(path);
      if (path === '/v1/client') return json({ session: null, user: null });
      if (path === '/v1/client/sign_ins') {
        return json({ id: 'sia_1', status: 'needs_first_factor', identifier: 'held@example.com', supported_first_factors: ['password'] }, 201);
      }
      if (path === '/v1/client/sign_ins/sia_1/attempt_first_factor') {
        return json({ errors: [{ code: 'password_not_yet_usable', message: 'Verify your email first.', meta: { verification_attempt_id: 'sua_9' } }] }, 403);
      }
      if (path === '/v1/client/sign_ups/sua_9/prepare_verification') return json({ identifier: 'held@example.com' });
      return json({});
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const el = render(() => h(AtlasProvider, { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl }, h(SignIn, {}))).container as HTMLElement;
    const send = (name: string, value: string) => {
      (el.querySelector(`input[name="${name}"]`) as HTMLInputElement).value = value;
      el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };
    const proofButton = () => Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Email me a code');

    await vi.waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
    send('identifier', 'held@example.com');
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    expect(proofButton()).toBeUndefined();

    send('password', 'the-right-password');
    await vi.waitFor(() => expect(proofButton()).toBeDefined());

    proofButton()!.click();
    await vi.waitFor(() => expect(posts).toContain('/v1/client/sign_ups/sua_9/prepare_verification'));
    expect(posts).not.toContain('/v1/client/sign_ins/sia_1/prepare_first_factor');

    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    send('code', '123456');
    await vi.waitFor(() => expect(posts).toContain('/v1/client/sign_ups/sua_9/attempt_verification'));
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-password-released]')).not.toBeNull());
    expect(el.querySelector('input[name="password"]')).not.toBeNull();
  });
});

describe('<SignIn> second factor', () => {
  it('texts on arrival where SMS is the only way, says where, and hides "Use a passkey" from an account with none', async () => {
    const prepared: unknown[] = [];
    let environmentAsked = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/client') return json({ session: null, user: null });
      if (path === '/v1/client/environment' || path === '/v1/appearance') {
        environmentAsked = true;
        return json({ account: { mfa: { totp: false, sms: true, passkey: true, totp_codes: 1, passkey_ceremony: { rp_id: 'x.example', origins: [], hosted_sign_in_url: 'https://x.example/hosted/sign-in' } } } });
      }
      if (path === '/v1/client/sign_ins') {
        return json({ id: 'sia_1', status: 'needs_first_factor', identifier: 'a@example.com', supported_first_factors: ['password'] }, 201);
      }
      if (path === '/v1/client/sign_ins/sia_1/attempt_first_factor') return json({ id: 'sia_1', status: 'needs_second_factor', identifier: 'a@example.com' });
      if (path === '/v1/client/sign_ins/sia_1/second_factors') return json({ object: 'second_factors', factors: ['sms'] });
      if (path === '/v1/client/sign_ins/sia_1/prepare_second_factor') {
        prepared.push(JSON.parse(String(init?.body)));
        return json({ object: 'second_factor_challenge', strategy: 'sms', sent_to: '+1•••0101' }, 201);
      }
      return json({});
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const el = render(() => h(AtlasProvider, { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl }, h(SignIn, {}))).container as HTMLElement;
    const send = (name: string, value: string) => {
      (el.querySelector(`input[name="${name}"]`) as HTMLInputElement).value = value;
      el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };
    await vi.waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
    await vi.waitFor(() => expect(environmentAsked).toBe(true));
    send('identifier', 'a@example.com');
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
    send('password', 'the-right-password');
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="sms-second-factor-sent"]')?.textContent).toContain('+1•••0101'));
    expect(prepared).toEqual([{ strategy: 'sms', only_way: true }]);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="passkey-second-factor"]')).toBeNull());
  });

  const reach = async (factors: string[], prepare: () => Response) => {
    let environmentAsked = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/client') return json({ session: null, user: null });
      if (path === '/v1/client/environment' || path === '/v1/appearance') {
        environmentAsked = true;
        return json({ account: { mfa: { totp: true, sms: true, totp_codes: 1 } } });
      }
      if (path === '/v1/client/sign_ins') return json({ id: 'sia_1', status: 'needs_second_factor' }, 201);
      if (path === '/v1/client/sign_ins/sia_1/second_factors') return json({ object: 'second_factors', factors });
      if (path === '/v1/client/sign_ins/sia_1/prepare_second_factor') return prepare();
      return json({});
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const el = render(() => h(AtlasProvider, { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl }, h(SignIn, {}))).container as HTMLElement;
    await vi.waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
    await vi.waitFor(() => expect(environmentAsked).toBe(true));
    (el.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'a@example.com';
    el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
    return el;
  };

  it('hides the texted option from an account with no phone', async () => {
    const el = await reach(['totp'], () => json({ object: 'second_factor_challenge', sent_to: null }));
    await vi.waitFor(() => expect(el.querySelector('[data-atlas="sms-second-factor"]')).toBeNull());
  });

  it('offers a resend after the arrival send, and says how long a limited send must wait', async () => {
    const sent = await reach(['sms'], () => json({ object: 'second_factor_challenge', sent_to: '+1•••0101' }, 201));
    await vi.waitFor(() => expect(sent.querySelector('[data-atlas="sms-second-factor-resend"]')?.textContent).toBe('Resend code'));
    const limited = await reach(['sms'], () => json({ errors: [{ code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.', meta: { retry_after: 30 } }] }, 429));
    await vi.waitFor(() => expect(limited.textContent).toContain('another code in 30 seconds'));
    expect(limited.querySelector('[data-atlas="sms-second-factor"]')?.textContent).toBe('Resend code');
  });
});
