import { describe, expect, it, vi } from 'vitest';
import { presentToVerifier, walletPresentationSupported, type DcApiRequest } from './wallet-verifier';

const request: DcApiRequest = {
  protocol: 'openid4vp-v1-unsigned',
  data: { response_type: 'vp_token', nonce: 'n1' },
  response_endpoint: 'https://fapi.example.test/vp/dc_api/vpr_1',
};

const answering = (data: unknown) => ({ get: vi.fn(async () => ({ data })) });
const fetchOk = () => vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

describe('presentToVerifier', () => {
  it('asks the wallet with the protocol and data, then posts the answer to the response endpoint', async () => {
    const credentials = answering({ vp_token: { cred: ['x'] } });
    const fetchImpl = fetchOk();
    expect(await presentToVerifier(request, { credentials, fetchImpl })).toEqual({ ok: true });
    expect(credentials.get).toHaveBeenCalledWith({ digital: { requests: [{ protocol: 'openid4vp-v1-unsigned', data: request.data }] } });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(request.response_endpoint);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ data: { vp_token: { cred: ['x'] } } });
  });

  it('parses a wallet answer that comes back as a JSON string', async () => {
    const fetchImpl = fetchOk();
    await presentToVerifier(request, { credentials: answering('{"response":"jwt"}'), fetchImpl });
    expect(JSON.parse(String(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body))).toEqual({ data: { response: 'jwt' } });
  });

  it('reports a closed prompt as cancelled and any other wallet failure as wallet_error, without posting', async () => {
    const fetchImpl = fetchOk();
    const closed = { get: vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); }) };
    expect(await presentToVerifier(request, { credentials: closed, fetchImpl })).toMatchObject({ ok: false, error: 'cancelled' });
    const broken = { get: vi.fn(async () => { throw new Error('no wallet'); }) };
    expect(await presentToVerifier(request, { credentials: broken, fetchImpl })).toMatchObject({ ok: false, error: 'wallet_error', message: 'no wallet' });
    expect(await presentToVerifier(request, { credentials: answering(undefined), fetchImpl })).toMatchObject({ ok: false, error: 'wallet_error' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports Atlas refusing the answer with its description, and a network failure as rejected', async () => {
    const refuse = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_request', error_description: 'Nonce mismatch.' }), { status: 400 })) as unknown as typeof fetch;
    expect(await presentToVerifier(request, { credentials: answering({}), fetchImpl: refuse })).toEqual({ ok: false, error: 'rejected', message: 'Nonce mismatch.' });
    const down = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect(await presentToVerifier(request, { credentials: answering({}), fetchImpl: down })).toMatchObject({ ok: false, error: 'rejected' });
  });

  it('is unsupported where there is no credentials container', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
    try {
      expect(await presentToVerifier(request)).toMatchObject({ ok: false, error: 'unsupported' });
      expect(walletPresentationSupported(undefined)).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
    }
  });
});
