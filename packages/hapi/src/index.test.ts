import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { atlasPlugin } from './index';

const ISSUER = 'https://t.fapi.atlas.test';

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256', use: 'sig' }] };
  const options = {
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    issuer: ISSUER,
    fetchImpl: (async () => new Response(JSON.stringify(jwks))) as unknown as typeof fetch,
  };
  const token = await new SignJWT({ sid: 's1' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' })
    .setSubject('user_1')
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(privateKey);
  return { options, token };
}

function register(options: Parameters<typeof atlasPlugin.register>[1]) {
  let scheme: (() => { authenticate: (r: never, h: never) => Promise<unknown> }) | undefined;
  const calls: unknown[] = [];
  const server = {
    auth: {
      scheme: (_n: string, s: typeof scheme) => void (scheme = s),
      strategy: (...a: unknown[]) => void calls.push(['strategy', ...a]),
      default: (a: unknown) => void calls.push(['default', a]),
    },
  };
  atlasPlugin.register(server as never, options);
  const h = {
    authenticated: (d: unknown) => ({ authenticated: d }),
    unauthenticated: (e: Error) => ({ unauthenticated: e }),
  };
  return { calls, run: (headers: Record<string, string>) => scheme!().authenticate({ headers } as never, h as never) as Promise<any> };
}

describe('hapi plugin', () => {
  it('authenticates a valid bearer token into credentials', async () => {
    const { options, token } = await setup();
    const { run, calls } = register(options);
    const out = await run({ authorization: `Bearer ${token}` });
    expect(out.authenticated.credentials.userId).toBe('user_1');
    expect(calls[0]).toEqual(['strategy', 'atlas', 'atlas']);
  });

  it('answers 401 for a missing or forged token', async () => {
    const { options } = await setup();
    const { run } = register(options);
    for (const headers of [{}, { cookie: '__session=junk' }] as Record<string, string>[]) {
      const out = await run(headers);
      expect(out.unauthenticated.output.statusCode).toBe(401);
    }
  });

  it('makes the strategy the default only when asked', async () => {
    const { options } = await setup();
    expect(register({ ...options, mode: 'required' }).calls).toContainEqual(['default', { strategy: 'atlas', mode: 'required' }]);
    expect(register(options).calls.some((c) => (c as unknown[])[0] === 'default')).toBe(false);
  });
});
