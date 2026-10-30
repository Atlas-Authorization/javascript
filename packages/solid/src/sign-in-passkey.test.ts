import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@solidjs/testing-library';
import { h } from './h';
import { AtlasProvider } from './provider';
import { SignIn } from './widgets';

/**
 * `<SignIn>` offers "Sign in with a passkey" when the instance turns passkey
 * sign-in on (`strategies.passkey` in /v1/appearance) and the browser has
 * WebAuthn; the button starts the usernameless ceremony at
 * /v1/client/sign_ins/passkey/begin, and the identifier field carries
 * `autocomplete="username webauthn"` for passkey autofill.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let posts: string[] = [];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountSignIn(passkey: boolean) {
  posts = [];
  // A WebAuthn-capable browser without conditional mediation (no autofill request to wait on).
  vi.stubGlobal('PublicKeyCredential', Object.assign(function PublicKeyCredential() {}, { isConditionalMediationAvailable: async () => false }));
  let appearanceLoaded = false;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === 'POST') posts.push(path);
    if (path === '/v1/client') return json({ session: null, user: null });
    if (path === '/v1/appearance') {
      appearanceLoaded = true;
      return json({
        object: 'appearance',
        appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] },
        captchaFlows: {},
        strategies: { passkey },
      });
    }
    if (path === '/v1/client/sign_ins/passkey/begin') {
      return json({ errors: [{ code: 'PASSKEY_UNAVAILABLE', message: 'No passkey sign-in right now.' }] }, 400);
    }
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  const { container } = render(() => h(AtlasProvider, { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl }, h(SignIn, {})));
  await vi.waitFor(() => expect(appearanceLoaded).toBe(true));
  await new Promise((r) => setTimeout(r, 0));
  return container as HTMLElement;
}

describe('<SignIn> passkey sign-in', () => {
  it('shows the button when the instance offers passkeys, and the button starts the ceremony', async () => {
    const el = await mountSignIn(true);
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-passkey-sign-in]')).not.toBeNull());
    const button = el.querySelector('[data-atlas-passkey-sign-in]') as HTMLButtonElement;
    expect(button.textContent).toBe('Sign in with a passkey');
    expect(button.type).toBe('button');
    expect(el.querySelector('input[name="identifier"]')?.getAttribute('autocomplete')).toBe('username webauthn');

    button.click();
    await vi.waitFor(() => expect(posts).toContain('/v1/client/sign_ins/passkey/begin'));
    // The refusal shows on the form like any sign-in error.
    await vi.waitFor(() => expect(el.textContent).toContain('No passkey sign-in right now.'));
  });

  it('has no button when passkey sign-in is off', async () => {
    const el = await mountSignIn(false);
    await vi.waitFor(() => expect(el.querySelector('input[name="identifier"]')).not.toBeNull());
    expect(el.querySelector('[data-atlas-passkey-sign-in]')).toBeNull();
  });
});
