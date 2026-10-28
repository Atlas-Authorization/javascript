import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { requireAccessToken, type AccessTokenClaims } from './index';

const ISSUER = 'https://auth.example.com';
const API = 'https://api.example.com';
const META = `${API}/.well-known/oauth-protected-resource`;

async function fixture(extra: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] };
  const mint = (scope: string, aud = API) =>
    new SignJWT({ scope, token_use: 'access_token', client_id: 'cli_1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setSubject('user_1')
      .setAudience(aud)
      .setExpirationTime('5m')
      .sign(privateKey);
  const app = new Hono<{ Variables: { atlasToken: { subject: string; claims: AccessTokenClaims } } }>();
  app.use('/mcp', requireAccessToken({ issuer: ISSUER, audience: API, jwks, resourceMetadataUrl: META, requiredScopes: ['tools:read'], ...extra }));
  app.get('/mcp', (c) => c.json({ sub: c.get('atlasToken').subject }));
  return { app, mint };
}

describe('requireAccessToken (hono)', () => {
  it('runs the handler with the verified token on the context', async () => {
    const { app, mint } = await fixture();
    const res = await app.request(`${API}/mcp`, { headers: { authorization: `Bearer ${await mint('tools:read')}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: 'user_1' });
  });

  it('answers no token with 401 + the resource_metadata challenge', async () => {
    const { app } = await fixture();
    const res = await app.request(`${API}/mcp`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${META}"`);
  });

  it('answers a missing scope with 403 insufficient_scope', async () => {
    const { app, mint } = await fixture();
    const res = await app.request(`${API}/mcp`, { headers: { authorization: `Bearer ${await mint('other')}` } });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(await res.json()).toMatchObject({ error: 'insufficient_scope' });
  });

  it('rejects a token minted for another API', async () => {
    const { app, mint } = await fixture();
    const res = await app.request(`${API}/mcp`, {
      headers: { authorization: `Bearer ${await mint('tools:read', 'https://other.example.com')}` },
    });
    expect(res.status).toBe(401);
  });

  it('passes the DPoP server nonce through as DPoP-Nonce, on success and refusal', async () => {
    const { app, mint } = await fixture({ dpopNonces: { current: () => 'nonce-1', valid: (n: string) => n === 'nonce-1' } });
    const ok = await app.request(`${API}/mcp`, { headers: { authorization: `Bearer ${await mint('tools:read')}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('dpop-nonce')).toBe('nonce-1');
    const refused = await app.request(`${API}/mcp`);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('dpop-nonce')).toBe('nonce-1');
  });
});
