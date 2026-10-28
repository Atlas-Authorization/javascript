import { describe, expect, it } from 'vitest';
import { FapiClient, getAtlasIdIntegrationToken, getIntegrationToken } from './fapi';

function client(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }), calls };
}

describe('getIntegrationToken (getToken({ for }))', () => {
  it('POSTs to the integration_tokens route for any integration id and maps the answer', async () => {
    const { client: c, calls } = client(
      () =>
        new Response(
          JSON.stringify({ object: 'integration_token', integration: 'helpdesk', jwt: 'j.w.t', expires_in: 120, audience: 'helpdesk:acme' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const t = await getIntegrationToken(c, 'sess_1', 'helpdesk');
    expect(t).toEqual({ jwt: 'j.w.t', expiresIn: 120, integration: 'helpdesk', audience: 'helpdesk:acme' });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/sessions/sess_1/integration_tokens/helpdesk');
    expect(calls[0]!.init?.method).toBe('POST');
  });

  it('passes the forumulate space and returns the redeem URL', async () => {
    const { client: c, calls } = client(
      () =>
        new Response(
          JSON.stringify({ jwt: 'x', expires_in: 120, integration: 'forumulate', audience: 'forumulate:o', org_id: 'o', space_id: 's', redeem_url: 'https://r.example/jwt' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const t = await getIntegrationToken(c, 'sess_1', 'forumulate', { spaceId: 's' });
    expect(calls[0]!.url).toContain('?space_id=s');
    expect(t).toMatchObject({ orgId: 'o', spaceId: 's', redeemUrl: 'https://r.example/jwt' });
  });

  it('sends a per-call audience: cbid, a custom parameter or the whole audience', async () => {
    const { client: c, calls } = client(
      () =>
        new Response(JSON.stringify({ jwt: 'x', expires_in: 120, integration: 'cookiemunch', audience: 'cookiemunch:dv-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const t = await getIntegrationToken(c, 'sess_1', 'cookiemunch', { cbid: 'dv-1' });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/sessions/sess_1/integration_tokens/cookiemunch?cbid=dv-1');
    expect(t?.audience).toBe('cookiemunch:dv-1');
    await getIntegrationToken(c, 'sess_1', 'acme', { audienceParams: { tenant: 't2' } });
    expect(calls[1]!.url).toContain('/integration_tokens/acme?tenant=t2');
    await getIntegrationToken(c, 'sess_1', 'cookiemunch', { audience: 'cookiemunch:dv-2' });
    expect(calls[2]!.url).toContain('?audience=cookiemunch%3Adv-2');
  });

  it('is null when the integration is not enabled or the session is gone', async () => {
    const { client: c } = client(() => new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }), { status: 404, headers: { 'content-type': 'application/json' } }));
    expect(await getIntegrationToken(c, 'sess_1', 'nope')).toBeNull();
  });
});

describe('getAtlasIdIntegrationToken (getToken({ for, atlasIdAccessToken }))', () => {
  const answer = () =>
    new Response(
      JSON.stringify({
        object: 'integration_token',
        integration: 'helpdesk',
        jwt: 'a.b.c',
        expires_in: 120,
        audience: 'helpdesk:acme',
        issuer: 'https://atlasauth.net',
        jwks_uri: 'https://atlasauth.net/.well-known/jwks.json',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('sends the access token as Bearer, the key in the query, and no cookies', async () => {
    const { client: c, calls } = client(answer);
    const t = await getAtlasIdIntegrationToken(c, 'helpdesk', 'at_123');
    expect(t).toEqual({
      jwt: 'a.b.c',
      expiresIn: 120,
      integration: 'helpdesk',
      audience: 'helpdesk:acme',
      issuer: 'https://atlasauth.net',
      jwksUri: 'https://atlasauth.net/.well-known/jwks.json',
    });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/integrations/helpdesk/atlas_id_tokens?publishable_key=pk_test_x');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.credentials).toBe('omit');
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer at_123');
    expect((calls[0]!.init?.headers as Record<string, string>).dpop).toBeUndefined();
  });

  it('with a DPoP signer: the DPoP scheme and a proof for this exact URL', async () => {
    const { client: c, calls } = client(answer);
    const seen: unknown[] = [];
    await getAtlasIdIntegrationToken(c, 'helpdesk', 'at_9', {
      dpop: (input) => {
        seen.push(input);
        return 'proof.jws';
      },
    });
    expect(seen).toEqual([{ htm: 'POST', htu: 'https://fapi.example/v1/client/integrations/helpdesk/atlas_id_tokens', accessToken: 'at_9' }]);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('DPoP at_9');
    expect(headers.dpop).toBe('proof.jws');
  });

  it('is null on a refusal, and without a token makes no call', async () => {
    const { client: c, calls } = client(() => new Response(JSON.stringify({ errors: [{ code: 'FORBIDDEN' }] }), { status: 403, headers: { 'content-type': 'application/json' } }));
    expect(await getAtlasIdIntegrationToken(c, 'helpdesk', 'at_1')).toBeNull();
    expect(await getAtlasIdIntegrationToken(c, 'helpdesk', '')).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
