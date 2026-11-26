import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { createAccessTokenVerifier } from './oauth-resource';

const ISSUER = 'https://i.example';
const API = 'https://api.example.com';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const mint = (claims: Record<string, unknown>) =>
    new SignJWT({ token_use: 'access_token', scope: 'a', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'at+jwt' })
      .setIssuer(ISSUER).setSubject('usr_1').setAudience(API).setIssuedAt().setExpirationTime('1h')
      .sign(privateKey);
  return { jwks: { keys: [jwk] }, mint };
}

function atlas(feed: () => unknown[]) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const body = url.endsWith('/v1/resource_servers')
      ? { data: [{ id: 'rs_1', identifier: API }] }
      : { data: feed(), has_more: false, next_cursor: null, server_time: Date.now() };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

describe('createAccessTokenVerifier({ revocation: true })', () => {
  it('rejects a token whose family or jti is on the feed, and accepts the rest', async () => {
    const { jwks, mint } = await setup();
    const feed = [{ family_id: 'oag_dead', jti: null, revoked_at: Date.now() }, { family_id: null, jti: 'jti_dead', revoked_at: Date.now() }];
    const { urls, fetchImpl } = atlas(() => feed);
    const verify = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks, revocation: true, secretKey: 'sk_test_x', fetchImpl });
    const req = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
    expect((await verify(req(await mint({ fid: 'oag_dead' })))).ok).toBe(false);
    expect((await verify(req(await mint({ jti: 'jti_dead' })))).ok).toBe(false);
    expect((await verify(req(await mint({ fid: 'oag_live', jti: 'jti_live' })))).ok).toBe(true);
    // One poll serves all three requests: no call per request.
    expect(urls.filter((u) => u.includes('/revoked_tokens'))).toHaveLength(1);
    expect(urls.some((u) => u.includes('/v1/resource_servers/rs_1/revoked_tokens'))).toBe(true);
  });

  it('rejects every token of a client on a client-kind row issued at or before its cut-off, and only those', async () => {
    const { jwks, mint } = await setup();
    const feed = [
      { kind: 'client', family_id: null, jti: null, client_id: 'client_dead', revoked_at: Date.now() + 5000 },
      { kind: 'client', family_id: null, jti: null, client_id: 'client_old', revoked_at: Date.now() - 60_000 },
    ];
    const { fetchImpl } = atlas(() => feed);
    const verify = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks, revocation: true, secretKey: 'sk_test_x', fetchImpl });
    const req = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
    // A client_credentials token has no fid: the client row alone ends it.
    expect((await verify(req(await mint({ azp: 'client_dead' })))).ok).toBe(false);
    expect((await verify(req(await mint({ azp: 'client_other' })))).ok).toBe(true);
    // Issued after the cut-off (a re-registered client): still valid.
    expect((await verify(req(await mint({ azp: 'client_old' })))).ok).toBe(true);
  });

  it('fails closed with onStale reject when the feed is unreachable', async () => {
    const { jwks, mint } = await setup();
    let t = Date.now();
    const fetchImpl = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const verify = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks, secretKey: 'sk_test_x', resourceServerId: 'rs_1', fetchImpl, now: () => t, revocation: { onStale: 'reject', staleAfterMs: 1000 } });
    t += 5000;
    const r = await verify({ headers: { authorization: `Bearer ${await mint({})}` } });
    expect(r.ok).toBe(false);
  });

  it('needs a secret key', () => {
    expect(() => createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks: { keys: [] }, revocation: true })).toThrow(/secretKey/);
  });
});
