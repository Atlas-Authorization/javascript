// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { SignIn } from './sign-in';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Embedded `<SignIn>` passkey sign-in, as the hosted page offers it: the
 * "Sign in with a passkey" button when the instance has passkeys on, conditional
 * (autofill) mediation on the identifier field, and the PRF results handed to
 * the app. FAPI is a scripted fetch; WebAuthn is a stubbed navigator.credentials.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const ASSERTION = {
  rawId: bytes('cred'),
  response: { authenticatorData: bytes('ad'), clientDataJSON: bytes('cd'), signature: bytes('sig') },
  getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array([1, 2]) } } }),
};

let calls: Array<{ method: string; path: string; body: unknown }> = [];
let unmount: (() => void) | null = null;
let signedIn = false;

function stubWebAuthn(opts: { conditional: boolean; get: (o: { mediation?: string }) => Promise<unknown> }) {
  vi.stubGlobal('PublicKeyCredential', { isConditionalMediationAvailable: async () => opts.conditional });
  Object.defineProperty(navigator, 'credentials', { value: { get: vi.fn(opts.get), create: vi.fn() }, configurable: true });
  return (navigator as unknown as { credentials: { get: ReturnType<typeof vi.fn> } }).credentials.get;
}

async function mount(opts: { passkey: boolean; props?: Record<string, unknown> }) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = { method: init?.method ?? 'GET', path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null };
    calls.push(call);
    if (call.path === '/v1/client') return json(signedIn ? { session: { id: 'sess_1' }, user: { id: 'user_1' } } : { session: null, user: null });
    if (call.path === '/v1/appearance') {
      return json({ object: 'appearance', appearance: {}, captchaFlows: {}, strategies: { password: true, passkey: opts.passkey } });
    }
    if (call.path === '/v1/client/sign_ins/passkey/begin') return json({ handle: 'h1', challenge: 'Y2g', rpId: 'example.com', allowCredentials: [] }, 201);
    if (call.path === '/v1/client/sign_ins/passkey/finish') {
      signedIn = true;
      return json({ object: 'sign_in_attempt', status: 'complete', created_session_id: 'sess_1' });
    }
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
        children: createElement(SignIn, opts.props ?? {}),
      }),
    );
  });
  unmount = () => act(() => root.unmount());
  return el;
}

const button = (el: HTMLElement) => el.querySelector('[data-atlas-passkey-sign-in]') as HTMLButtonElement | null;
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

beforeEach(() => {
  calls = [];
  signedIn = false;
});
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('<SignIn> passkey sign-in', () => {
  it('shows "Sign in with a passkey" when the instance has passkeys on, and completing it signs in', async () => {
    const get = stubWebAuthn({ conditional: false, get: async () => ASSERTION });
    const el = await mount({ passkey: true });
    await vi.waitFor(() => expect(button(el)).not.toBeNull());
    expect(button(el)!.textContent).toBe('Sign in with a passkey');
    const boots = calls.filter((c) => c.path === '/v1/client').length;

    await act(async () => button(el)!.click());
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/passkey/finish')).toHaveLength(1));
    expect(get).toHaveBeenCalledTimes(1);
    expect(posts('/v1/client/sign_ins/passkey/finish')[0]!.body).toMatchObject({ handle: 'h1', challenge: 'Y2g' });
    // The finish set the cookie: no ticket exchange, the app re-boots signed in.
    expect(posts('/v1/client/tickets/exchange')).toHaveLength(0);
    await vi.waitFor(() => expect(calls.filter((c) => c.path === '/v1/client').length).toBeGreaterThan(boots));
  });

  it('is not offered when the instance has passkeys off', async () => {
    stubWebAuthn({ conditional: false, get: async () => ASSERTION });
    const el = await mount({ passkey: false });
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/v1/appearance')).toBe(true));
    expect(button(el)).toBeNull();
  });

  it('arms passkey autofill on the identifier field when conditional mediation is available', async () => {
    const get = stubWebAuthn({ conditional: true, get: () => new Promise(() => undefined) });
    const el = await mount({ passkey: true });
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    expect(get.mock.calls[0]![0]).toMatchObject({ mediation: 'conditional' });
    expect(el.querySelector('input[name="identifier"]')!.getAttribute('autocomplete')).toBe('username webauthn');
  });

  it('a cancelled prompt shows the message and stays on the form', async () => {
    stubWebAuthn({ conditional: false, get: async () => { throw new Error('NotAllowedError'); } });
    const el = await mount({ passkey: true });
    await vi.waitFor(() => expect(button(el)).not.toBeNull());
    await act(async () => button(el)!.click());
    await vi.waitFor(() => expect(el.textContent).toContain("Passkey sign-in didn't finish"));
    expect(posts('/v1/client/sign_ins/passkey/finish')).toHaveLength(0);
    expect(button(el)).not.toBeNull();
  });

  it('hands the PRF results to onPasskeyExtensionResults (passkeyPrf)', async () => {
    stubWebAuthn({ conditional: false, get: async () => ASSERTION });
    const onPasskeyExtensionResults = vi.fn();
    const el = await mount({ passkey: true, props: { passkeyPrf: { eval: { first: 'salt' } }, onPasskeyExtensionResults } });
    await vi.waitFor(() => expect(button(el)).not.toBeNull());
    await act(async () => button(el)!.click());
    await vi.waitFor(() => expect(onPasskeyExtensionResults).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(posts('/v1/client/sign_ins/passkey/finish')[0]!.body)).not.toContain('prf');
  });
});
