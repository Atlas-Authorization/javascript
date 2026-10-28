import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { requireAccessToken } from './index';

const ISSUER = 'https://auth.example.com';
const API = 'https://api.example.com';
const META = `${API}/.well-known/oauth-protected-resource`;

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
  const app = Fastify();
  app.get(
    '/mcp',
    { preHandler: requireAccessToken({ issuer: ISSUER, audience: API, jwks, resourceMetadataUrl: META, requiredScopes: ['tools:read'], ...extra }) },
    async (request) => ({ sub: (request as unknown as { atlasToken: { subject: string } }).atlasToken.subject }),
  );
  return { app, mint };
}

describe('requireAccessToken (fastify)', () => {
  it('lets a valid token through with request.atlasToken set', async () => {
    const { app, mint } = await fixture();
    const res = await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${await mint('tools:read')}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sub: 'user_1' });
  });

  it('answers no token with 401 + challenge and never runs the handler', async () => {
    const { app } = await fixture();
    const res = await app.inject({ method: 'GET', url: '/mcp' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain(`resource_metadata="${META}"`);
  });

  it('answers a missing scope with 403 insufficient_scope', async () => {
    const { app, mint } = await fixture();
    const res = await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${await mint('x')}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'insufficient_scope' });
  });

  it('passes the DPoP server nonce through as DPoP-Nonce, on success and refusal', async () => {
    const { app, mint } = await fixture({ dpopNonces: { current: () => 'nonce-1', valid: (n: string) => n === 'nonce-1' } });
    const ok = await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${await mint('tools:read')}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['dpop-nonce']).toBe('nonce-1');
    const refused = await app.inject({ method: 'GET', url: '/mcp' });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['dpop-nonce']).toBe('nonce-1');
  });
});
