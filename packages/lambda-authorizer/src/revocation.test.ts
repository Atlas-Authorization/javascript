import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createTestIssuer } from '@atlasauth/backend';
import { createLambdaAuthorizer, type PolicyResponse } from './index';

const ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/orders/1';
const hashOf = (sid: string) => createHash('sha256').update(sid).digest().subarray(0, 8);

async function setup(revoked: string[]) {
  const issuer = await createTestIssuer({ issuer: 'https://auth.example.com' });
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'sl', alg: 'RS256' };
  let fetches = 0;
  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith('jwks.json')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    fetches++;
    const hashes = revoked.map(hashOf).sort(Buffer.compare);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sub: 'session-status-list',
      aud: 'atlas:session-status-list',
      token_use: 'session_status_list',
      since: (now - 3600) * 1000,
      window_seconds: 3600,
      hash_bytes: 8,
      count: hashes.length,
      truncated: false,
      h: Buffer.concat(hashes).toString('base64url'),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'sl', typ: 'statuslist+jwt' })
      .setIssuer(issuer.issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .sign(privateKey);
    return new Response(JSON.stringify({ token }), { status: 200 });
  }) as unknown as typeof fetch;
  const handler = createLambdaAuthorizer({
    session: { issuer: issuer.issuer, jwks: issuer.jwks, authorizedParties: [issuer.issuer] },
    revocation: { secretKey: 'sk_x', baseUrl: 'https://api.test', jwksUrl: 'https://auth.example.com/jwks.json', issuer: issuer.issuer, fetchImpl },
  });
  return { issuer, handler, fetches: () => fetches };
}
const rest = (token: string) => ({ type: 'TOKEN', authorizationToken: `Bearer ${token}`, methodArn: ARN });

describe('createLambdaAuthorizer revocation', () => {
  it('refuses a revoked session and admits a live one', async () => {
    const { issuer, handler } = await setup(['sess_revoked']);
    const live = (await handler(rest(await issuer.mintSession({ sub: 'u', sid: 'sess_live' })))) as PolicyResponse;
    expect(live.policyDocument.Statement[0]!.Effect).toBe('Allow');
    await expect(handler(rest(await issuer.mintSession({ sub: 'u', sid: 'sess_revoked' })))).rejects.toThrow('Unauthorized');
  });

  it('checks the list on every request, even when the token result is cached', async () => {
    const { issuer, handler, fetches } = await setup([]);
    const token = await issuer.mintSession({ sub: 'u', sid: 'sess_live' });
    await handler(rest(token));
    await handler(rest(token));
    // One fetch of the signed list serves both calls: the list is checked per request, fetched per refreshMs.
    expect(fetches()).toBe(1);
  });

  it('needs a JWKS URL', () => {
    expect(() => createLambdaAuthorizer({ session: { issuer: 'https://a.test', jwks: { keys: [] } }, revocation: { secretKey: 'sk_x', issuer: 'https://a.test' } })).toThrow(/jwksUrl/);
  });
});
