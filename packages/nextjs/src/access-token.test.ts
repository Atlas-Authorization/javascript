import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { withAccessToken } from './access-token';

const ISSUER = 'https://auth.example.com';
const API = 'https://api.example.com';

async function fixture(extra: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] };
  const mint = (scope: string) =>
    new SignJWT({ scope, token_use: 'access_token' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setSubject('user_1')
      .setAudience(API)
      .setExpirationTime('5m')
      .sign(privateKey);
  const GET = withAccessToken(
    { issuer: ISSUER, audience: API, jwks, requiredScopes: ['tools:read'], resourceMetadataUrl: `${API}/.well-known/oauth-protected-resource`, ...extra },
    (_req, token) => Response.json({ sub: token.subject, scopes: token.scopes }),
  );
  return { GET, mint };
}

describe('withAccessToken (next route handler)', () => {
  it('runs the handler for a valid token', async () => {
    const { GET, mint } = await fixture();
    const res = await GET(new Request(`${API}/api/mcp`, { headers: { authorization: `Bearer ${await mint('tools:read')}` } }), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: 'user_1', scopes: ['tools:read'] });
  });

  it('answers 401 with the challenge when no token is sent', async () => {
    const { GET } = await fixture();
    const res = await GET(new Request(`${API}/api/mcp`), {});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer .*resource_metadata=/);
  });

  it('answers 403 insufficient_scope', async () => {
    const { GET, mint } = await fixture();
    const res = await GET(new Request(`${API}/api/mcp`, { headers: { authorization: `Bearer ${await mint('x')}` } }), {});
    expect(res.status).toBe(403);
  });

  it('passes the DPoP server nonce through as DPoP-Nonce, on success and refusal', async () => {
    const { GET, mint } = await fixture({ dpopNonces: { current: () => 'nonce-1', valid: (n: string) => n === 'nonce-1' } });
    const ok = await GET(new Request(`${API}/api/mcp`, { headers: { authorization: `Bearer ${await mint('tools:read')}` } }), {});
    expect(ok.status).toBe(200);
    expect(ok.headers.get('dpop-nonce')).toBe('nonce-1');
    const refused = await GET(new Request(`${API}/api/mcp`), {});
    expect(refused.status).toBe(401);
    expect(refused.headers.get('dpop-nonce')).toBe('nonce-1');
  });
});
