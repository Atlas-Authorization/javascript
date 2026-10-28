import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { Request, Response } from 'express';
import { requireAccessToken } from './index';

const ISSUER = 'https://auth.example.com';
const API = 'https://api.example.com';
const META = `${API}/.well-known/oauth-protected-resource`;

async function fixture(extra: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] };
  const mint = (scope: string) =>
    new SignJWT({ scope, token_use: 'access_token', client_id: 'cli_1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setSubject('user_1')
      .setAudience(API)
      .setExpirationTime('5m')
      .sign(privateKey);
  const gate = requireAccessToken({ issuer: ISSUER, audience: API, jwks, resourceMetadataUrl: META, requiredScopes: ['tools:read'], ...extra });
  return { gate, mint };
}

function call(gate: ReturnType<typeof requireAccessToken>, authorization?: string) {
  const req = {
    method: 'GET',
    protocol: 'https',
    originalUrl: '/mcp',
    headers: authorization ? { authorization } : {},
    get: (n: string) => (n.toLowerCase() === 'host' ? 'api.example.com' : undefined),
  } as unknown as Request;
  const out: { status?: number; headers: Record<string, string>; body?: unknown; next: boolean } = { headers: {}, next: false };
  const res = {
    status(c: number) {
      out.status = c;
      return res;
    },
    set(k: string, v: string) {
      out.headers[k.toLowerCase()] = v;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  } as unknown as Response;
  return new Promise<typeof out & { req: Request }>((resolve) => {
    const done = () => resolve({ ...out, req });
    void Promise.resolve(
      gate(req, res, () => {
        out.next = true;
        done();
      }),
    ).then(() => setTimeout(done, 0));
  });
}

describe('requireAccessToken (express)', () => {
  it('calls next with req.atlasToken set for a valid token', async () => {
    const { gate, mint } = await fixture();
    const r = await call(gate, `Bearer ${await mint('tools:read')}`);
    expect(r.next).toBe(true);
    expect(r.req.atlasToken).toMatchObject({ subject: 'user_1', clientId: 'cli_1', scopes: ['tools:read'] });
  });

  it('answers no token with 401 + the resource_metadata challenge', async () => {
    const { gate } = await fixture();
    const r = await call(gate);
    expect(r.next).toBe(false);
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain(`resource_metadata="${META}"`);
  });

  it('answers a missing scope with 403 insufficient_scope', async () => {
    const { gate, mint } = await fixture();
    const r = await call(gate, `Bearer ${await mint('nope')}`);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'insufficient_scope' });
  });

  it('passes the DPoP server nonce through as DPoP-Nonce, on success and refusal', async () => {
    const { gate, mint } = await fixture({ dpopNonces: { current: () => 'nonce-1', valid: (n: string) => n === 'nonce-1' } });
    const ok = await call(gate, `Bearer ${await mint('tools:read')}`);
    expect(ok.next).toBe(true);
    expect(ok.headers['dpop-nonce']).toBe('nonce-1');
    const refused = await call(gate);
    expect(refused.status).toBe(401);
    expect(refused.headers['dpop-nonce']).toBe('nonce-1');
  });
});
