import { describe, expect, it } from 'vitest';
import { startEmulatorServer } from './server';
import { KEY, snapshot } from './test-support';

describe('emulator server', () => {
  it('serves the engine over HTTP, discovery points at its own origin, and the JWKS is published', async () => {
    const s = await startEmulatorServer({ openapi: snapshot(), webhookRetryDelaysMs: [] });
    try {
      const created = await fetch(`${s.url}/v1/users`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ email_address: 'http@example.com' }) });
      expect(created.status).toBe(201);
      const disco = (await (await fetch(`${s.url}/.well-known/openid-configuration`)).json()) as { issuer: string; jwks_uri: string };
      expect(disco.issuer).toBe(s.url);
      const jwks = (await (await fetch(disco.jwks_uri)).json()) as { keys: unknown[] };
      expect(jwks.keys.length).toBe(1);
      expect((await fetch(`${s.url}/v1/users`)).status).toBe(401);
      expect((await fetch(`${s.url}/v1/users`, { method: 'OPTIONS' })).status).toBe(204);
    } finally {
      await s.close();
    }
  });
});
