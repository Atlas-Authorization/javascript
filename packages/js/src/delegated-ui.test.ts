import { describe, expect, it, vi } from 'vitest';
import { continueDelegatedFlow, createDelegatedUiClient, readDelegatedChallenge } from './delegated-ui';

describe('delegated login/consent helpers', () => {
  it('reads the challenge from the page URL', () => {
    expect(readDelegatedChallenge('https://a.test/signin?login_challenge=abc')).toEqual({ type: 'login', challenge: 'abc' });
    expect(readDelegatedChallenge(new URL('https://a.test/c?consent_challenge=x.y'))).toEqual({ type: 'consent', challenge: 'x.y' });
    expect(readDelegatedChallenge('https://a.test/')).toBeNull();
  });

  it('calls the backend proxy with the challenge as a query parameter', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, body: init.body as string | undefined });
      return new Response(JSON.stringify({ redirect_to: 'https://op.test/x' }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createDelegatedUiClient({ baseUrl: '/atlas/oauth/', fetch: fetchImpl });
    expect((await c.acceptLogin('a b', { subject: 'usr_1', remember: true })).redirect_to).toBe('https://op.test/x');
    await c.getConsentRequest('c1');
    expect(calls[0]).toMatchObject({ url: '/atlas/oauth/login/accept?login_challenge=a%20b', method: 'POST' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ subject: 'usr_1', remember: true });
    expect(calls[1]).toMatchObject({ url: '/atlas/oauth/consent?consent_challenge=c1', method: 'GET' });
  });

  it('throws the server message on failure', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: 'Unknown or expired login challenge.' } }), { status: 404 })) as unknown as typeof fetch;
    await expect(createDelegatedUiClient({ baseUrl: '/x', fetch: fetchImpl }).getLoginRequest('z')).rejects.toThrow('expired');
  });

  it('only follows https or allowed-origin redirects', () => {
    const navigate = vi.fn();
    continueDelegatedFlow('https://op.test/a', { navigate });
    expect(navigate).toHaveBeenCalledWith('https://op.test/a');
    expect(() => continueDelegatedFlow('http://op.test/a', { navigate })).toThrow();
    expect(() => continueDelegatedFlow('https://evil.test/a', { navigate, allowedOrigins: ['https://op.test'] })).toThrow();
  });
});
