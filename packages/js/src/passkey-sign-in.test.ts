import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { beginPasskeySignIn, type PasskeyCaptchaRequest } from './passkey-sign-in';

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
