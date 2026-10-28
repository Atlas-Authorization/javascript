import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createTestIssuer } from '@atlasauth/backend';
import { createLambdaAuthorizer, extractToken, type PolicyResponse, type SimpleResponse } from './index';

const ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/orders/1';
const API = 'https://api.example.com';

async function setup(extra: Record<string, unknown> = {}) {
  const issuer = await createTestIssuer({ issuer: 'https://auth.example.com' });
  const handler = createLambdaAuthorizer({ session: { issuer: issuer.issuer, jwks: issuer.jwks, authorizedParties: [issuer.issuer] }, ...extra });
  return { issuer, handler };
}
const rest = (token: string) => ({ type: 'TOKEN', authorizationToken: `Bearer ${token}`, methodArn: ARN });
const v2 = (headers: Record<string, string>, cookies?: string[]) => ({ version: '2.0', type: 'REQUEST', routeArn: ARN, headers, cookies });
const effect = (r: unknown) => (r as PolicyResponse).policyDocument.Statement[0]!.Effect;

describe('createLambdaAuthorizer', () => {
  it('allows a valid session on a REST TOKEN authorizer and passes context', async () => {
    const { issuer, handler } = await setup();
    const r = (await handler(rest(await issuer.mintSession({ sub: 'user_1', sid: 'sess_1', org_id: 'org_1' })))) as PolicyResponse;
    expect(effect(r)).toBe('Allow');
    expect(r.principalId).toBe('user_1');
    expect(r.policyDocument.Statement[0]!.Resource).toBe(ARN);
    expect(r.context).toMatchObject({ userId: 'user_1', sessionId: 'sess_1', orgId: 'org_1', tokenKind: 'session' });
  });

  it('throws Unauthorized on REST for missing, garbage, expired, foreign-key and wrong-issuer tokens', async () => {
    const { issuer, handler } = await setup();
    await expect(handler({ type: 'TOKEN', methodArn: ARN, authorizationToken: '' })).rejects.toThrow('Unauthorized');
    await expect(handler(rest('not.a.jwt'))).rejects.toThrow('Unauthorized');
    for (const tamper of ['expired', 'foreign_key', 'wrong_iss', 'alg_none'] as const) {
      await expect(handler(rest(await issuer.mintSession({}, { tamper })))).rejects.toThrow('Unauthorized');
    }
  });

  it('refuses a token minted for an unlisted authorized party', async () => {
    const { issuer, handler } = await setup();
    await expect(handler(rest(await issuer.mintSession({ azp: 'https://evil.example.com' })))).rejects.toThrow('Unauthorized');
  });

  it('reads the token from headers (any case), the cookie header and the v2 cookies array', async () => {
    const { issuer, handler } = await setup();
    const t = await issuer.mintSession({ sub: 'u' });
    expect(effect(await handler({ type: 'REQUEST', methodArn: ARN, headers: { Authorization: `bearer ${t}` } }))).toBe('Allow');
    expect(effect(await handler(v2({ cookie: `a=b; __session=${t}` })))).toBe('Allow');
    expect(effect(await handler(v2({}, ['x=1', `__session=${t}`])))).toBe('Allow');
    expect(extractToken(v2({}))).toBeNull();
  });

  it('HTTP API v2: Deny policy by default, simple response when asked, never throws', async () => {
    const { issuer, handler } = await setup();
    expect(effect(await handler(v2({})))).toBe('Deny');
    const simple = createLambdaAuthorizer({ session: { issuer: issuer.issuer, jwks: issuer.jwks, authorizedParties: [issuer.issuer] }, httpApiResponse: 'simple' });
    expect(await simple(v2({}))).toEqual({ isAuthorized: false });
    const ok = (await simple(v2({ authorization: `Bearer ${await issuer.mintSession({ sub: 'u2' })}` }))) as SimpleResponse;
    expect(ok.isAuthorized).toBe(true);
    expect(ok.context).toMatchObject({ userId: 'u2' });
  });

  it('stage scope widens the Allow resource to the whole stage', async () => {
    const { issuer, handler } = await setup({ policyScope: 'stage' });
    const r = (await handler(rest(await issuer.mintSession({})))) as PolicyResponse;
    expect(r.policyDocument.Statement[0]!.Resource).toBe('arn:aws:execute-api:us-east-1:123456789012:abc123/prod/*/*');
  });

  it('answers Deny (403) when the session fails the condition', async () => {
    const { issuer, handler } = await setup({ condition: { permission: 'org:billing:read' } });
    expect(effect(await handler(rest(await issuer.mintSession({}))))).toBe('Deny');
    expect(effect(await handler(rest(await issuer.mintSession({ org_id: 'o', org_role: 'admin', org_permissions: ['org:billing:read'] }))))).toBe('Allow');
  });

  it('fails closed on an unknown event shape and when the key set cannot be fetched', async () => {
    const { handler } = await setup();
    await expect(handler({} as never)).rejects.toThrow('Unauthorized');
    await expect(handler({ type: 'TOKEN', authorizationToken: 'Bearer x' })).rejects.toThrow('Unauthorized');
    const down = createLambdaAuthorizer({
      session: { issuer: 'https://auth.example.com', jwksUrl: 'https://auth.example.com/jwks', fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch },
    });
    const issuer = await createTestIssuer({ issuer: 'https://auth.example.com' });
    await expect(down(rest(await issuer.mintSession({})))).rejects.toThrow('Unauthorized');
  });

  it('caches a verified token, never past exp, and does not cache refusals', async () => {
    let t = 1_000_000_000_000;
    const issuer = await createTestIssuer({ issuer: 'https://auth.example.com', now: () => t, ttlSeconds: 60 });
    let calls = 0;
    const handler = createLambdaAuthorizer({
      session: { issuer: issuer.issuer, jwks: issuer.jwks, authorizedParties: [issuer.issuer], now: () => { calls++; return t; } },
      now: () => t,
      cacheTtlSeconds: 30,
    });
    const token = await issuer.mintSession({});
    await handler(rest(token));
    const afterFirst = calls;
    await handler(rest(token));
    expect(calls).toBe(afterFirst); // second call served from the cache
    t += 31_000;
    await handler(rest(token));
    expect(calls).toBeGreaterThan(afterFirst); // TTL elapsed: verified again
    t += 40_000; // past exp (60 s)
    await expect(handler(rest(token))).rejects.toThrow('Unauthorized');
  });
});

describe('access tokens', () => {
  async function fixture() {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] };
    const mint = (scope: string, aud = API) =>
      new SignJWT({ scope, token_use: 'access_token', client_id: 'cli_1' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://auth.example.com')
        .setSubject('user_1')
        .setAudience(aud)
        .setExpirationTime('5m')
        .sign(privateKey);
    const handler = createLambdaAuthorizer({ accessToken: { issuer: 'https://auth.example.com', audience: API, jwks, requiredScopes: ['orders:read'] } });
    return { mint, handler };
  }

  it('allows a token with the scope and exposes client and scopes', async () => {
    const { mint, handler } = await fixture();
    const r = (await handler(rest(await mint('orders:read orders:write')))) as PolicyResponse;
    expect(effect(r)).toBe('Allow');
    expect(r.context).toMatchObject({ tokenKind: 'access_token', clientId: 'cli_1', scopes: 'orders:read orders:write' });
  });

  it('Deny for a missing scope, Unauthorized for another audience', async () => {
    const { mint, handler } = await fixture();
    expect(effect(await handler(rest(await mint('other'))))).toBe('Deny');
    await expect(handler(rest(await mint('orders:read', 'https://other.example.com')))).rejects.toThrow('Unauthorized');
  });

  it('a session verifier rejects access tokens (no token confusion)', async () => {
    const { mint } = await fixture();
    const { handler } = await setup();
    await expect(handler(rest(await mint('orders:read')))).rejects.toThrow('Unauthorized');
  });

  it('requires at least one verifier', () => {
    expect(() => createLambdaAuthorizer({})).toThrow();
  });
});
