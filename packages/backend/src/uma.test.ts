import { describe, expect, it } from 'vitest';
import { UmaProtectionError, createUmaProtection, umaAllows } from './uma';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function server(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('createUmaProtection', () => {
  it('fetches one PAT with client credentials, reuses it, and sends it as the bearer', async () => {
    const s = server((url) => (url.endsWith('/oauth2/token') ? json({ access_token: 'pat1', expires_in: 3600 }) : url.endsWith('/oauth2/uma/permission') ? json({ ticket: 't1' }, 201) : json({ _id: 'umar_1' }, 201)));
    const uma = createUmaProtection({ issuer: 'https://auth.example.com/', clientId: 'rs', clientSecret: 's3cret', fetch: s.fetchImpl });
    expect(await uma.resources.create({ name: 'Album', resource_scopes: ['view'], owner_approval: true })).toEqual({ _id: 'umar_1' });
    expect(await uma.requestTicket([{ resource_id: 'umar_1', resource_scopes: ['view'] }])).toBe('t1');
    const tokenCalls = s.calls.filter((c) => c.url.endsWith('/oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(String(tokenCalls[0]!.init.body)).toContain('scope=uma_protection');
    expect((tokenCalls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa('rs:s3cret')}`);
    for (const c of s.calls.filter((x) => !x.url.endsWith('/oauth2/token'))) expect((c.init.headers as Record<string, string>).authorization).toBe('Bearer pat1');
  });

  it('builds the UMA challenge and throws a typed error, dropping a rejected PAT', async () => {
    let n = 0;
    const s = server((url) => (url.endsWith('/oauth2/token') ? json({ access_token: `pat${++n}`, expires_in: 3600 }) : json({ error: 'invalid_token', error_description: 'expired' }, 401)));
    const uma = createUmaProtection({ issuer: 'https://auth.example.com', clientId: 'rs', clientSecret: 'x', fetch: s.fetchImpl });
    expect(uma.challenge('tk', 'photos')).toBe('UMA realm="photos", as_uri="https://auth.example.com", ticket="tk"');
    await expect(uma.resources.list()).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    await expect(uma.resources.list()).rejects.toBeInstanceOf(UmaProtectionError);
    expect(n).toBe(2); // the 401 cleared the cached PAT, so the second call fetched a new one
  });

  it('refuses when no PAT can be obtained', async () => {
    const s = server(() => json({ error: 'invalid_client', error_description: 'bad secret' }, 401));
    const uma = createUmaProtection({ issuer: 'https://auth.example.com', clientId: 'rs', clientSecret: 'x', fetch: s.fetchImpl });
    await expect(uma.getPat()).rejects.toMatchObject({ code: 'invalid_client' });
  });
});

describe('umaAllows', () => {
  const rpt = { active: true, exp: 2000, permissions: [{ resource_id: 'r', resource_scopes: ['view'], nbf: 100 }] };
  it('allows only a held scope on that resource of an active, current token', () => {
    expect(umaAllows(rpt, 'r', 'view', 1000)).toBe(true);
    expect(umaAllows(rpt, 'r', 'edit', 1000)).toBe(false);
    expect(umaAllows(rpt, 'other', 'view', 1000)).toBe(false);
    expect(umaAllows(rpt, 'r', 'view', 2000)).toBe(false);
    expect(umaAllows(rpt, 'r', 'view', 50)).toBe(false);
    expect(umaAllows({ active: false }, 'r', 'view')).toBe(false);
  });
});
