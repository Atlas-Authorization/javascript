import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AtlasBackend } from '@atlasauth/backend';
import { resolveAuth } from './middleware';
import {
  atlasClient,
  backendConfigFromEnv,
  buildEdgeRequest,
  configFromEnv,
} from './server';

/**
 * `next/headers` needs a request context we can't create in a unit test, so we
 * test the two pure pieces the ambient `auth()` is composed from: the env-config
 * resolution and the request-building helper (fed fake cookie/header stores).
 */

describe('configFromEnv', () => {
  it('reads the server-only names', () => {
    const options = configFromEnv({
      ATLAS_JWKS_URL: 'https://fox.fapi.atlas.test/.well-known/jwks.json',
      ATLAS_ISSUER: 'https://fox.fapi.atlas.test',
    });
    expect(options.jwksUrl).toBe('https://fox.fapi.atlas.test/.well-known/jwks.json');
    expect(options.issuer).toBe('https://fox.fapi.atlas.test');
  });

  it('falls back to the NEXT_PUBLIC_ names when the server-only ones are absent', () => {
    const options = configFromEnv({
      NEXT_PUBLIC_ATLAS_JWKS_URL: 'https://pub.fapi.atlas.test/jwks',
      NEXT_PUBLIC_ATLAS_ISSUER: 'https://pub.fapi.atlas.test',
    });
    expect(options.jwksUrl).toBe('https://pub.fapi.atlas.test/jwks');
    expect(options.issuer).toBe('https://pub.fapi.atlas.test');
  });

  it('prefers the server-only name over its NEXT_PUBLIC_ fallback', () => {
    const options = configFromEnv({
      ATLAS_JWKS_URL: 'https://server/jwks',
      NEXT_PUBLIC_ATLAS_JWKS_URL: 'https://public/jwks',
      ATLAS_ISSUER: 'https://server',
    });
    expect(options.jwksUrl).toBe('https://server/jwks');
  });

  it('splits ATLAS_AUTHORIZED_PARTIES into a trimmed list', () => {
    const options = configFromEnv({
      ATLAS_JWKS_URL: 'https://x/jwks',
      ATLAS_ISSUER: 'https://x',
      ATLAS_AUTHORIZED_PARTIES: 'https://a.test, https://b.test ,,https://c.test',
    });
    expect(options.authorizedParties).toEqual(['https://a.test', 'https://b.test', 'https://c.test']);
  });

  it('carries the publishable key through when present', () => {
    const options = configFromEnv({
      ATLAS_JWKS_URL: 'https://x/jwks',
      ATLAS_ISSUER: 'https://x',
      NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY: 'pk_test_abc',
    });
    expect(options.publishableKey).toBe('pk_test_abc');
  });

  it('throws with an actionable message when the JWKS URL is missing', () => {
    expect(() => configFromEnv({ ATLAS_ISSUER: 'https://x' })).toThrow(/ATLAS_JWKS_URL/);
  });

  it('throws when the issuer is missing', () => {
    expect(() => configFromEnv({ ATLAS_JWKS_URL: 'https://x/jwks' })).toThrow(/ATLAS_ISSUER/);
  });

  it('treats an empty-string env var as absent', () => {
    expect(() => configFromEnv({ ATLAS_JWKS_URL: '', ATLAS_ISSUER: 'https://x' })).toThrow(
      /ATLAS_JWKS_URL/,
    );
  });
});

describe('backendConfigFromEnv / atlasClient', () => {
  it('reads the secret key and optional API URL', () => {
    const cfg = backendConfigFromEnv({ ATLAS_SECRET_KEY: 'sk_test_1', ATLAS_API_URL: 'https://api.x' });
    expect(cfg.secretKey).toBe('sk_test_1');
    expect(cfg.apiUrl).toBe('https://api.x');
  });

  it('has no NEXT_PUBLIC_ fallback for the secret key', () => {
    expect(() => backendConfigFromEnv({ NEXT_PUBLIC_ATLAS_SECRET_KEY: 'sk_leak' } as never)).toThrow(
      /ATLAS_SECRET_KEY/,
    );
  });

  it('builds a configured backend client whose resource namespaces are present', () => {
    const client = atlasClient({ secretKey: 'sk_test_1' });
    expect(typeof client.users.get).toBe('function');
    expect(typeof client.organizations.list).toBe('function');
  });
});

describe('buildEdgeRequest', () => {
  const cookieStore = (entries: Array<{ name: string; value: string }>) => ({
    getAll: () => entries,
  });
  const headerStore = (headers: Record<string, string>) => ({
    get: (name: string) => headers[name.toLowerCase()] ?? null,
  });

  it('reconstructs a cookie header from the cookie store', () => {
    const req = buildEdgeRequest(
      cookieStore([
        { name: '__session', value: 'jwt_here' },
        { name: '__atlas_rt', value: 'refresh_here' },
      ]),
      headerStore({}),
    );
    expect(req.headers.get('cookie')).toBe('__session=jwt_here; __atlas_rt=refresh_here');
  });

  it('exposes the authorization header', () => {
    const req = buildEdgeRequest(cookieStore([]), headerStore({ authorization: 'Bearer tok' }));
    expect(req.headers.get('authorization')).toBe('Bearer tok');
    expect(req.headers.get('Authorization')).toBe('Bearer tok');
  });

  it('falls back to the raw cookie header when the store is empty', () => {
    const req = buildEdgeRequest(cookieStore([]), headerStore({ cookie: '__session=raw' }));
    expect(req.headers.get('cookie')).toBe('__session=raw');
  });

  it('returns null for a cookie header when nothing carries one', () => {
    const req = buildEdgeRequest(cookieStore([]), headerStore({}));
    expect(req.headers.get('cookie')).toBeNull();
    expect(req.headers.get('authorization')).toBeNull();
  });

  /**
   * The built request must be verifiable by the exact same core the factory
   * helpers use — this is what proves the subpath reuses `resolveAuth` rather
   * than reimplementing anything.
   */
  it('produces a request the shared resolveAuth core can verify', async () => {
    const ISSUER = 'https://fox.fapi.atlas.test';
    const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'RS256', use: 'sig' };
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as unknown as typeof fetch,
    });

    const jwt = await new SignJWT({ sid: 'sess_1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1' })
      .setSubject('user_1')
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(privateKey);

    const req = buildEdgeRequest(
      cookieStore([{ name: '__session', value: jwt }]),
      headerStore({}),
    );
    const state = await resolveAuth(backend, req);
    expect(state.userId).toBe('user_1');
    expect(state.sessionId).toBe('sess_1');
  });
});
