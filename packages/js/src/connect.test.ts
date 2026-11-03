import { describe, expect, it, vi } from 'vitest';
import { connectExternalAccount } from './connect';

const base = (fetchImpl: typeof fetch) => ({
  api: 'https://accounts.acme.com',
  publishableKey: 'pk_test',
  redirectUrl: 'https://app.acme.com/settings',
  fetchImpl,
});

const ok = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('connectExternalAccount', () => {
  it('POSTs provider + redirect with the session cookie and returns the authorize URL', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return ok({
        provider: 'github',
        attempt_id: 'sia_1',
        authorization_url: 'https://github.com/login/oauth/authorize?client_id=x',
        scopes: ['read:user'],
      });
    }) as unknown as typeof fetch;

    const res = await connectExternalAccount('github', base(fetchImpl));
    expect(res.authorizationUrl).toContain('github.com/login/oauth/authorize');
    expect(res.attemptId).toBe('sia_1');
    expect(res.scopes).toEqual(['read:user']);

    const { url, init } = calls[0]!;
    expect(url).toBe('https://accounts.acme.com/v1/client/me/external_accounts/connect');
    expect(init.method).toBe('POST');
    // Must send the browser session cookie — this is a signed-in action.
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['x-publishable-key']).toBe('pk_test');
    expect(JSON.parse(init.body as string)).toMatchObject({
      provider: 'github',
      redirect_url: 'https://app.acme.com/settings',
    });
  });

  it('forwards additionalScopes', async () => {
    let body: { additional_scopes?: string[] } = {};
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(init!.body as string);
      return ok({ provider: 'github', attempt_id: 'a', authorization_url: 'https://x', scopes: [] });
    }) as unknown as typeof fetch;

    await connectExternalAccount('github', { ...base(fetchImpl), additionalScopes: ['repo'] });
    expect(body.additional_scopes).toEqual(['repo']);
  });

  it('throws with the server code on failure (e.g. already linked)', async () => {
    const fetchImpl = vi.fn(async () =>
      ok(
        { errors: [{ code: 'IDENTITY_ALREADY_LINKED', message: 'This provider is already connected to your account.' }] },
        409,
      ),
    ) as unknown as typeof fetch;

    await expect(connectExternalAccount('github', base(fetchImpl))).rejects.toMatchObject({
      code: 'IDENTITY_ALREADY_LINKED',
    });
  });
});
