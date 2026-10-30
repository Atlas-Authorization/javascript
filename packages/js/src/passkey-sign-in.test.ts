import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { beginPasskeySignIn, createPasskeySignInController, signInWithPasskey, startConditionalPasskeySignIn, type PasskeyCaptchaRequest } from './passkey-sign-in';

function scripted(route: (n: number, body: Record<string, unknown> | null) => { status?: number; body: unknown }) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ path: url.pathname, body });
    const out = route(calls.length, body);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://f.example', fetchImpl, referral: false }), calls };
}

const OPTIONS = { handle: 'h1', challenge: 'Y2g', rpId: 'example.com', allowCredentials: [] };
const refused = (code: string) => ({ status: 400, body: { errors: [{ code, message: 'no', param: 'captcha_token' }] } });

describe('beginPasskeySignIn', () => {
  it('without a token source posts an empty body and reports a refusal as-is', async () => {
    const { client, calls } = scripted(() => refused('CAPTCHA_REQUIRED'));
    const res = await beginPasskeySignIn(client);
    expect(calls).toEqual([{ path: '/v1/client/sign_ins/passkey/begin', body: {} }]);
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.code).toBe('CAPTCHA_REQUIRED');
  });

  it('sends the token the source already has (an always-on sign-in captcha)', async () => {
    const { client, calls } = scripted(() => ({ body: OPTIONS }));
    const source = vi.fn(async () => 'tok_1');
    const res = await beginPasskeySignIn(client, { captcha: source });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(OPTIONS);
    expect(calls[0]?.body).toEqual({ captcha_token: 'tok_1' });
    expect(source).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledWith({ retry: false });
  });

  it('on CAPTCHA_FAILED retries once with a fresh token', async () => {
    const { client, calls } = scripted((n) => (n === 1 ? refused('CAPTCHA_FAILED') : { body: OPTIONS }));
    const asks: PasskeyCaptchaRequest[] = [];
    const tokens = ['spent', 'fresh'];
    const res = await beginPasskeySignIn(client, {
      captcha: async (request) => {
        asks.push(request);
        return tokens.shift();
      },
    });
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.body)).toEqual([{ captcha_token: 'spent' }, { captcha_token: 'fresh' }]);
    expect(asks).toEqual([{ retry: false }, { retry: true, refused: 'CAPTCHA_FAILED' }]);
  });

  it('a force-challenge refusal (no token known up front) asks for one and retries', async () => {
    const { client, calls } = scripted((n) => (n === 1 ? refused('CAPTCHA_REQUIRED') : { body: OPTIONS }));
    const res = await beginPasskeySignIn(client, {
      captcha: async ({ retry }) => (retry ? 'solved' : null),
    });
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.body)).toEqual([{}, { captcha_token: 'solved' }]);
  });

  it('retries only once: a second refusal is returned', async () => {
    const { client, calls } = scripted(() => refused('CAPTCHA_FAILED'));
    const res = await beginPasskeySignIn(client, { captcha: async () => 'tok' });
    expect(calls).toHaveLength(2);
    expect(res.errors[0]?.code).toBe('CAPTCHA_FAILED');
  });

  it('does not retry other errors, nor when no fresh token comes', async () => {
    const other = scripted(() => ({ status: 422, body: { errors: [{ code: 'STRATEGY_DISABLED', message: 'off' }] } }));
    const source = vi.fn(async () => null);
    await beginPasskeySignIn(other.client, { captcha: source });
    expect(other.calls).toHaveLength(1);
    expect(source).toHaveBeenCalledTimes(1);

    const none = scripted(() => refused('CAPTCHA_REQUIRED'));
    const res = await beginPasskeySignIn(none.client, {
      captcha: async () => {
        throw new Error('provider failed');
      },
    });
    expect(none.calls).toHaveLength(1);
    expect(res.errors[0]?.code).toBe('CAPTCHA_REQUIRED');
  });
});

describe('signInWithPasskey', () => {
  const bytes = (s: string) => new TextEncoder().encode(s).buffer;
  const host = (get: () => Promise<unknown>) => ({ credentials: { get, create: vi.fn() } }) as unknown as import('./passkey').WebAuthnHost;
  const assertion = {
    rawId: bytes('cred'),
    response: { authenticatorData: bytes('ad'), clientDataJSON: bytes('cd'), signature: bytes('sig') },
    getClientExtensionResults: () => ({}),
  };

  it('begin → ceremony → finish; a complete answer has no ticket (the finish set the cookie)', async () => {
    const { client, calls } = scripted((n) =>
      n === 1 ? { status: 201, body: OPTIONS } : { body: { object: 'sign_in_attempt', status: 'complete', created_session_id: 'sess_1' } },
    );
    const next = await signInWithPasskey(client, { host: host(async () => assertion) });
    expect(calls.map((c) => c.path)).toEqual(['/v1/client/sign_ins/passkey/begin', '/v1/client/sign_ins/passkey/finish']);
    expect(calls[1]!.body).toMatchObject({ handle: 'h1', challenge: 'Y2g' });
    expect(next.attempt?.status).toBe('complete');
    expect(next.ticket).toBeNull();
    expect(next.errors).toEqual([]);
  });

  it('a cancelled prompt is PASSKEY_CANCELLED, not a throw, and nothing is finished', async () => {
    const { client, calls } = scripted(() => ({ status: 201, body: OPTIONS }));
    const next = await signInWithPasskey(client, { host: host(async () => { throw new Error('NotAllowedError'); }) });
    expect(next.errors[0]?.code).toBe('PASSKEY_CANCELLED');
    expect(calls).toHaveLength(1);
  });

  it('hands the PRF results to the app callback', async () => {
    const { client } = scripted((n) => (n === 1 ? { status: 201, body: OPTIONS } : { body: { status: 'complete' } }));
    const seen = vi.fn();
    await signInWithPasskey(client, { host: host(async () => assertion), prf: { eval: { first: 'salt' } }, onExtensionResults: seen });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('startConditionalPasskeySignIn', () => {
  it('does not arm where conditional mediation is unavailable', async () => {
    const { client, calls } = scripted(() => ({ status: 201, body: OPTIONS }));
    const onResult = vi.fn();
    const armed = await startConditionalPasskeySignIn(client, { signal: new AbortController().signal, onResult });
    expect(armed).toBe(false);
    expect(calls).toHaveLength(0);
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe('createPasskeySignInController', () => {
  it('signIn runs the ceremony, spends and resets the captcha token, and localizes a cancel', async () => {
    const { client, calls } = scripted(() => ({ status: 201, body: OPTIONS }));
    const results: unknown[] = [];
    const captcha = { needed: true, getToken: vi.fn(async () => 'tok'), reset: vi.fn() };
    const host = { credentials: { get: async () => { throw new Error('x'); }, create: vi.fn() } } as unknown as import('./passkey').WebAuthnHost;
    const c = createPasskeySignInController({ client, host, onResult: (n) => void results.push(n), captcha: () => captcha, cancelledMessage: () => 'Cancelled!' });
    await c.signIn();
    expect(calls[0]!.body).toEqual({ captcha_token: 'tok' });
    expect(captcha.reset).toHaveBeenCalledTimes(1);
    expect((results[0] as { errors: Array<{ code: string; message: string }> }).errors[0]).toEqual({ code: 'PASSKEY_CANCELLED', message: 'Cancelled!' });
  });

  it('armAutofill does nothing while an always-on captcha is needed', async () => {
    const { client, calls } = scripted(() => ({ status: 201, body: OPTIONS }));
    const c = createPasskeySignInController({ client, onResult: vi.fn(), captcha: () => ({ needed: true, getToken: async () => null, reset: () => undefined }) });
    c.armAutofill();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(0);
    c.stopAutofill();
  });
});
