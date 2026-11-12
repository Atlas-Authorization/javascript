import { describe, expect, it, vi } from 'vitest';
import { DeveloperPortalError, createDeveloperPortal } from './developer-portal';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function portal(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { portal: createDeveloperPortal({ issuer: 'https://auth.example.com/', fetchImpl }), calls };
}

describe('developer portal kit', () => {
  it('registers with the developer token and manages the app with its registration token', async () => {
    const { portal: p, calls } = portal((url) => (url.endsWith('/secret') ? json(200, { client_id: 'c', client_secret: 's', client_secret_expires_at: 0 }) : json(200, { client_id: 'c', redirect_uris: ['https://a.example/cb'] })));
    await p.registerApp('oiat_dev', { client_name: 'App', redirect_uris: ['https://a.example/cb'] });
    await p.setRedirectUris('c', 'oarat_x', ['https://a.example/cb']);
    await p.requestScopes('c', 'oarat_x', ['openid', 'email']);
    await p.rotateSecret('c', 'oarat_x');
    await p.getUsage('c', 'oarat_x', 7);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'POST https://auth.example.com/oauth2/register',
      'PUT https://auth.example.com/oauth2/register/c',
      'PUT https://auth.example.com/oauth2/register/c',
      'POST https://auth.example.com/oauth2/register/c/secret',
      'GET https://auth.example.com/oauth2/register/c/usage?days=7',
    ]);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer oiat_dev');
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ scope: 'openid email' });
  });

  it('throws a typed error carrying the OAuth error code', async () => {
    const { portal: p } = portal(() => json(400, { error: 'invalid_redirect_uri', error_description: 'It must use https.' }));
    await expect(p.setRedirectUris('c', 't', ['http://x'])).rejects.toMatchObject({ name: 'DeveloperPortalError', status: 400, error: 'invalid_redirect_uri' });
    await expect(p.setRedirectUris('c', 't', ['http://x'])).rejects.toBeInstanceOf(DeveloperPortalError);
  });
});
